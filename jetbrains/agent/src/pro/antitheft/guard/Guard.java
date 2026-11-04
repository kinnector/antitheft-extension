package pro.antitheft.guard;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * antitheft's guard inside a JetBrains IDE: refuses any code in the IDE (a plugin, the IDE itself) a read of
 * a vault before it happens, and names the plugin behind it. Called from the JDK's own file and process entry
 * points, which the agent instruments; loaded by the boot loader, so it uses nothing but java.base.
 *
 * Vault knowledge is antitheft's salted hashes only, never paths: every plugin shares this JVM. Events go into
 * a bounded queue the plugin drains and reports.
 */
public final class Guard {
    private Guard() {}

    private static volatile byte[] salt = new byte[0];
    private static volatile Set<String> dirs = Set.of();
    private static volatile Set<String> files = Set.of();
    private static volatile String[] decoys = new String[0];
    private static final ConcurrentHashMap<String, Boolean> DIR_CACHE = new ConcurrentHashMap<>();
    private static final ConcurrentLinkedQueue<String[]> EVENTS = new ConcurrentLinkedQueue<>();
    private static final int MAX_EVENTS = 512;
    private static final ThreadLocal<Boolean> BUSY = new ThreadLocal<>();
    private static final boolean WINDOWS = File.separatorChar == '\\';
    /** This plugin's id: never named as the culprit. */
    private static volatile String ownId = "pro.antitheft";
    private static volatile boolean installed;

    // ---- set by the plugin -----------------------------------------------------------------------

    public static void update(String saltHex, String[] d, String[] f) {
        byte[] s = new byte[saltHex.length() / 2];
        for (int i = 0; i < s.length; i++) s[i] = (byte) Integer.parseInt(saltHex.substring(i * 2, i * 2 + 2), 16);
        salt = s;
        dirs = Set.of(d);
        files = Set.of(f);
        DIR_CACHE.clear();
    }

    public static void setDecoys(String[] d) {
        String[] k = new String[d.length];
        for (int i = 0; i < d.length; i++) k[i] = key(new File(d[i]).getAbsolutePath());
        decoys = k;
    }

    public static void setOwnId(String id) {
        ownId = id;
    }

    public static void markInstalled() {
        installed = true;
    }

    public static boolean installed() {
        return installed;
    }

    /** Events since the last call: {kind, pluginId, builtin, op, path, pid, command, decoy}. */
    public static List<String[]> drain() {
        List<String[]> out = new ArrayList<>();
        String[] e;
        while ((e = EVENTS.poll()) != null) out.add(e);
        return out;
    }

    // ---- called from instrumented JDK code ---------------------------------------------------------

    public static void checkFile(File f, String op) {
        if (f != null) check(f.getPath(), op);
    }

    public static void checkObj(Object p, String op) {
        if (p != null) check(String.valueOf(p), op);
    }

    /** `antitheft-cli` while the plugin is connected to antitheft (null otherwise): the ACP bridge's program. */
    private static volatile String bridge;

    public static void setBridge(String cli) {
        bridge = cli == null || cli.isEmpty() ? null : cli;
    }

    /** A class of the IDE's agent code: Android Studio's (com.google.studiobot.agentsdk.acp, com.google.aiplugin.acp),
     *  the ACP SDK's (com.agentclientprotocol), JetBrains AI Assistant's ACP agents. */
    private static final java.util.regex.Pattern ACP_CLASS = java.util.regex.Pattern.compile("(^|\\.)acp(\\.|$)|^com\\.agentclientprotocol\\.|[.$]Acp[A-Z]");

    /**
     * An ACP agent the IDE starts (its own Claude Agent, Codex, Gemini, Antigravity, or any other) runs behind
     * `antitheft-cli acp`, transparently: the same entry, the same program, only the bridge in front of it, which checks
     * the files the agent asks the IDE to read and the commands it asks it to run, and refuses a vault with the reason.
     * Only when the IDE's agent code starts it AND the command is an ACP agent's, so nothing else the IDE runs (a
     * terminal command, a build) changes.
     */
    static void bridgeAcpAgent(ProcessBuilder pb) {
        String cli = bridge;
        if (cli == null) return;
        List<String> cmd = pb.command();
        if (cmd.isEmpty() || cmd.get(0).equals(cli)) return;
        String agent = acpAgentOf(cmd);
        if (agent == null || !fromAcpCode()) return;
        List<String> wrapped = new java.util.ArrayList<>(List.of(cli, "acp", "--agent", agent, "--"));
        wrapped.addAll(cmd);
        pb.command(wrapped);
    }

    /** Which agent an ACP launch is, for the check's `agent` field; null when the command is not an ACP agent's. */
    static String acpAgentOf(List<String> cmd) {
        String all = String.join(" ", cmd).toLowerCase(java.util.Locale.ROOT);
        if (all.contains("claude-agent-acp") || all.contains("claude-code-acp")) return "claude-code";
        if (all.contains("codex-acp")) return "codex";
        if (all.contains("agy_acp") || all.contains("agy-acp")) return "antigravity";
        if (all.contains("gemini") && (cmd.contains("--acp") || cmd.contains("--experimental-acp"))) return "gemini";
        for (String w : cmd) {
            String n = new File(w).getName().toLowerCase(java.util.Locale.ROOT);
            if (n.equals("acp") || n.equals("--acp") || n.endsWith("-acp") || n.contains("-acp@") || n.startsWith("acp-") || n.endsWith("_acp")) return "acp";
        }
        return null;
    }

    private static boolean fromAcpCode() {
        try {
            return StackWalker.getInstance().walk(s -> s.map(StackWalker.StackFrame::getClassName)
                .anyMatch(c -> !c.startsWith("pro.antitheft.") && ACP_CLASS.matcher(c).find()));
        } catch (Throwable t) {
            return false;
        }
    }

    /** ProcessBuilder.start: a command naming a vault is refused; an ACP agent goes behind the bridge. */
    public static void checkStart(Object pb) {
        if (BUSY.get() != null) return;
        try {
            bridgeAcpAgent((ProcessBuilder) pb);
        } catch (Throwable ignored) {
            // never in the way of a launch
        }
        if (empty()) return;
        List<String> cmd = ((ProcessBuilder) pb).command();
        File dir = ((ProcessBuilder) pb).directory();
        for (String w : cmd) {
            for (String p : words(w)) {
                String abs = dir != null && !new File(p).isAbsolute() ? new File(dir, p).getPath() : p;
                if (isProtected(abs)) refuse("ProcessBuilder.start", abs, IOException.class);
            }
        }
    }

    /** After ProcessBuilder.start: a launch by a third-party plugin is reported (attribution, with its pid). */
    public static void afterStart(Process proc, Object pb) {
        if (BUSY.get() != null) return;
        String[] c = culprit();
        if (c == null || "true".equals(c[1])) return;
        event("spawn", c, null, null, String.valueOf(proc.pid()), commandLine(((ProcessBuilder) pb).command()), false);
    }

    private static final java.util.regex.Pattern SHELL = java.util.regex.Pattern.compile("sh|bash|zsh|dash|ksh|fish|cmd|powershell|pwsh");
    private static final java.util.regex.Pattern SCRIPT_FLAG = java.util.regex.Pattern.compile("(?i)[-/]c|-command|-file");

    /**
     * A launch as one readable command line, quoted where a word has spaces. A shell running a script (sh -c,
     * cmd /c, powershell -Command) is shown as the script: the program that matters is the one the shell runs.
     * The same rules as the VS Code extension's commandLine.ts.
     */
    static String commandLine(List<String> argv) {
        if (argv.isEmpty()) return "";
        String file = argv.get(0);
        List<String> rest = argv.subList(1, argv.size());
        String shell = new File(file.replace('\\', '/')).getName().toLowerCase().replaceAll("\\.exe$", "");
        if (SHELL.matcher(shell).matches()) {
            int i = -1;
            for (int n = 0; n < rest.size() && i < 0; n++) if (SCRIPT_FLAG.matcher(rest.get(n)).matches()) i = n;
            List<String> tail = i >= 0 ? rest.subList(i + 1, rest.size()) : List.of();
            String flag = i >= 0 ? rest.get(i) : "";
            String script;
            if (shell.equals("cmd")) script = quoteAll(tail);
            else if (shell.equals("powershell") || shell.equals("pwsh")) script = flag.equalsIgnoreCase("-file") || tail.size() > 1 ? quoteAll(tail) : tail.isEmpty() ? "" : tail.get(0);
            else script = tail.isEmpty() ? "" : tail.get(0); // sh -c takes one script; later arguments are $0, $1
            if (!script.isBlank()) return cap(script);
        }
        return cap(quoteAll(argv));
    }

    private static String quoteAll(List<String> words) {
        StringBuilder sb = new StringBuilder();
        for (String w : words) {
            if (sb.length() > 0) sb.append(' ');
            sb.append((w.matches(".*[\\s\"].*") && !w.matches("^\".*\"$")) ? "\"" + w.replace("\"", "\\\"") + "\"" : w);
        }
        return sb.toString();
    }

    private static String cap(String s) {
        return s.length() > 400 ? s.substring(0, 400) : s;
    }

    /** A file made executable by a third-party plugin (download-then-run). */
    public static void madeExecutable(Object path, boolean executable) {
        if (!executable || BUSY.get() != null) return;
        String[] c = culprit();
        if (c != null && !"true".equals(c[1])) event("write", c, null, new File(String.valueOf(path)).getAbsolutePath(), null, null, false);
    }

    /** A program written on Windows (a runnable name) by a third-party plugin. */
    public static void writing(File f) {
        if (!WINDOWS || f == null || BUSY.get() != null) return;
        String n = f.getName().toLowerCase();
        if (!n.matches(".*\\.(exe|dll|ps1|bat|cmd|vbs|vbe|wsf|scr|msi|com|hta)")) return;
        String[] c = culprit();
        if (c != null && !"true".equals(c[1])) event("write", c, null, f.getAbsolutePath(), null, null, false);
    }

    // ---- the test --------------------------------------------------------------------------------

    static boolean empty() {
        return dirs.isEmpty() && files.isEmpty() && decoys.length == 0;
    }

    static String key(String p) {
        return WINDOWS ? p.replace('/', '\\').toLowerCase() : p;
    }

    static String hash(String key) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(salt);
            byte[] d = md.digest(key.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(32);
            for (int i = 0; i < 16; i++) sb.append(String.format("%02x", d[i] & 0xff));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    static String absolute(String p) {
        if (WINDOWS && p.startsWith("\\\\?\\")) p = p.substring(4);
        return new File(p).getAbsoluteFile().toPath().normalize().toString();
    }

    public static boolean isProtected(String p) {
        if (p == null || p.isEmpty() || empty()) return false;
        BUSY.set(Boolean.TRUE);
        try {
            String abs = absolute(p);
            String k = key(abs);
            for (String d : decoys) if (k.equals(d) || k.startsWith(d + File.separator)) return true;
            String h = hash(k);
            if (files.contains(h) || dirs.contains(h)) return true;
            String parent = new File(abs).getParent();
            return parent != null && underDir(parent);
        } catch (RuntimeException e) {
            return false;
        } finally {
            BUSY.remove();
        }
    }

    static boolean isDecoy(String p) {
        String k = key(absolute(p));
        for (String d : decoys) if (k.equals(d) || k.startsWith(d + File.separator)) return true;
        return false;
    }

    private static boolean underDir(String dir) {
        Boolean c = DIR_CACHE.get(dir);
        if (c != null) return c;
        boolean r = dirs.contains(hash(key(dir)));
        if (!r) {
            String parent = new File(dir).getParent();
            r = parent != null && underDir(parent);
        }
        if (DIR_CACHE.size() > 20000) DIR_CACHE.clear();
        DIR_CACHE.put(dir, r);
        return r;
    }

    /** Path-like words of a command line (a vault path hidden inside a shell command). */
    static List<String> words(String s) {
        List<String> out = new ArrayList<>();
        for (String w : s.split("[\\s\"'`;|&<>()=,]+")) {
            if (w.isEmpty()) continue;
            if (w.startsWith("~/")) out.add(System.getProperty("user.home") + w.substring(1));
            else if (w.startsWith("/") || w.contains(File.separator) || (WINDOWS && w.matches("^[a-zA-Z]:[\\\\/].*"))) out.add(w);
        }
        return out;
    }

    // ---- refusing and reporting --------------------------------------------------------------------

    static void check(String p, String op) {
        if (BUSY.get() != null) return;
        if (isProtected(p)) refuse(op, p, FileNotFoundException.class);
    }

    private static void refuse(String op, String p, Class<? extends IOException> kind) {
        String[] c = culprit();
        event("blocked", c, op, absolute(p), null, null, isDecoy(p));
        // An agent in the IDE (Android Studio's and the JetBrains AI Assistant's agents read through the IDE's own
        // tools) gets this text as the tool's error, so it says what happened and what to do instead. No access can
        // be granted to a read the IDE makes, so it never suggests asking for one.
        String msg = p + " (antitheft refused this read: the file is a vault that only its own app may open. "
            + "Do not try to read it another way: another program that tries is refused too and is ended. "
            + "Leave this file out of the task, or tell the user it is protected by antitheft.)";
        sneaky(kind == FileNotFoundException.class ? new FileNotFoundException(msg) : new IOException(msg));
    }

    /** The plugin's "an event is waiting" call (`onEvent`): it reports at once instead of waiting for its next look. */
    private static volatile Runnable listener;

    public static void onEvent(Runnable r) {
        listener = r;
    }

    private static void event(String kind, String[] culprit, String op, String path, String pid, String command, boolean decoy) {
        if (EVENTS.size() >= MAX_EVENTS) return;
        String id = culprit == null ? "unknown" : culprit[0];
        String builtin = culprit == null ? "false" : culprit[1];
        EVENTS.add(new String[] {kind, id, builtin, op, path, pid, command, String.valueOf(decoy)});
        Runnable r = listener;
        if (r != null) {
            try {
                r.run();
            } catch (Throwable ignored) {
                // never in the way of what the IDE was doing
            }
        }
    }

    /** The plugin behind the current call: {id, builtin}, or null (the IDE itself, the JDK). */
    static String[] culprit() {
        BUSY.set(Boolean.TRUE);
        try {
            return StackWalker.getInstance(StackWalker.Option.RETAIN_CLASS_REFERENCE).walk(s -> s
                .map(f -> f.getDeclaringClass().getClassLoader())
                .filter(l -> l != null && l.getClass().getName().endsWith("PluginClassLoader"))
                .map(Guard::pluginOf)
                .filter(c -> c != null && !ownId.equals(c[0]))
                .findFirst()
                .orElse(null));
        } catch (Throwable t) {
            return null;
        } finally {
            BUSY.remove();
        }
    }

    private static String[] pluginOf(ClassLoader l) {
        try {
            Object id = l.getClass().getMethod("getPluginId").invoke(l);
            boolean bundled = false;
            try {
                Object d = l.getClass().getMethod("getPluginDescriptor").invoke(l);
                bundled = Boolean.TRUE.equals(d.getClass().getMethod("isBundled").invoke(d));
            } catch (Throwable ignored) {
                // an older platform: not known, treated as third-party
            }
            return new String[] {String.valueOf(id), String.valueOf(bundled)};
        } catch (Throwable t) {
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private static <T extends Throwable> void sneaky(Throwable t) throws T {
        throw (T) t;
    }
}
