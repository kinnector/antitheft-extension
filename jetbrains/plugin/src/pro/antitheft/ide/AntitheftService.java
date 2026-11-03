package pro.antitheft.ide;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.ide.plugins.IdeaPluginDescriptor;
import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.notification.Notification;
import com.intellij.notification.NotificationAction;
import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationInfo;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.PathManager;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.extensions.PluginId;
import com.intellij.util.concurrency.AppExecutorUtil;

import javax.swing.Icon;
import javax.swing.ImageIcon;
import java.awt.Image;
import java.io.File;
import java.lang.reflect.Method;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * This IDE's connection to antitheft: checks the standing and, once protected, says hello, attaches the guard to
 * the IDE's own JVM, runs the self-check, sends the heartbeat and the guard's reports, and follows antitheft's
 * alert stream. Nothing runs before "protected".
 */
@Service(Service.Level.APP)
public final class AntitheftService implements Disposable {
    static final String OWN_ID = "pro.antitheft";

    /** NO_ACCESS: installed and running, but this login may not use the socket yet (the installer added the person to
     *  its group, which takes effect at their next login). */
    enum Standing { CHECKING, NOT_INSTALLED, NO_ACCESS, NOT_RUNNING, PAUSED, PROTECTED }

    volatile Standing standing = Standing.CHECKING;
    volatile boolean systemLevel = true;
    volatile String pausedBy;
    volatile String version;
    volatile String ideId;
    volatile Map<String, String> hooks = Map.of();
    volatile List<Model.Item> items = List.of();
    /** The computer's vaults as antitheft lists them (names and states, never a path); null until read. */
    volatile Model.Vaults vaults;
    private volatile long vaultsReadAt;
    /** The vaults antitheft last named, kept while paused so a resume needs no new hello. */
    private JsonObject prefixes;
    volatile boolean guardAvailable;

    private final List<Runnable> listeners = new CopyOnWriteArrayList<>();
    private final Map<String, Icon> icons = new ConcurrentHashMap<>();
    private final Set<String> seen = new HashSet<>();
    private boolean primed;
    private final Map<String, Long> lastNotified = new ConcurrentHashMap<>();
    private final Map<String, Long> lastLaunch = new ConcurrentHashMap<>();
    private ScheduledFuture<?> heartbeat;
    private ScheduledFuture<?> drain;
    private ScheduledFuture<?> retry;
    private long retryDelay = 2000;
    private volatile boolean disposed;
    private Thread streamThread;
    private String rev = "";
    private final Gson gson = new Gson();

    static AntitheftService get() {
        return ApplicationManager.getApplication().getService(AntitheftService.class);
    }

    void onChange(Runnable r) {
        listeners.add(r);
    }

    void removeListener(Runnable r) {
        listeners.remove(r);
    }

    /** The tool window opens on its Alerts tab next time it draws (the status bar's click). */
    volatile boolean alertsNext;

    void showAlerts() {
        alertsNext = true;
        changed();
    }

    private void changed() {
        for (Runnable r : listeners) ApplicationManager.getApplication().invokeLater(r);
    }

    String ideName() {
        return ApplicationInfo.getInstance().getVersionName();
    }

    void start() {
        AppExecutorUtil.getAppExecutorService().submit(this::recheck);
    }

    synchronized void recheck() {
        if (disposed) return;
        Standing before = standing;
        Daemon.Response r = Daemon.request("GET", "/api/v1/status", null);
        JsonObject status = r != null && r.status() == 200 ? JsonParser.parseString(r.text()).getAsJsonObject() : null;
        if (status == null) {
            boolean registered = Dev.assumeService() || serviceRegistered();
            standing = !registered ? Standing.NOT_INSTALLED : socketRefused() ? Standing.NO_ACCESS : Standing.NOT_RUNNING;
        } else {
            boolean paused = status.has("enforcement_paused") && status.get("enforcement_paused").getAsBoolean() && !Dev.pausedIsProtected();
            standing = paused ? Standing.PAUSED : Standing.PROTECTED;
            systemLevel = !status.has("protection_source_active") || status.get("protection_source_active").getAsBoolean();
            pausedBy = paused ? str(status, "enforcement_paused_source", str(status, "paused_source", "user")) : null;
            version = str(status, "version", null);
        }
        // Paused is connected too (as in VS Code): the screens, the alerts and the plugin controls work, and a resume
        // or a licence arriving comes in on the alerts stream (`event: protection`). Only the guard refuses nothing.
        if (standing == Standing.PROTECTED || standing == Standing.PAUSED) {
            if (ideId == null) connect();
            else applyStanding();
        } else {
            disconnect();
            scheduleRetry();
        }
        if (before != standing) {
            vaultsReadAt = 0;
            if (ideId != null) readVaults();
            changed();
        }
    }

    private static String str(JsonObject o, String k, String fallback) {
        return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsString() : fallback;
    }

    /** The socket file is there but this process may not use it. On Unix `Files.isWritable` asks `access(2)`, which
     *  checks this process's own groups, so it tells "not in the group yet" from "nothing listening". Never true on
     *  Windows (a named pipe). */
    static boolean socketRefused() {
        if (Daemon.WINDOWS) return false;
        java.nio.file.Path p = java.nio.file.Path.of(Daemon.socket());
        return java.nio.file.Files.exists(p) && !(java.nio.file.Files.isReadable(p) && java.nio.file.Files.isWritable(p));
    }

    static boolean serviceRegistered() {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (os.contains("mac")) return new File("/Library/LaunchDaemons/com.antitheft.antitheftd.plist").exists();
        if (os.contains("win")) {
            try {
                Process p = new ProcessBuilder("reg.exe", "query", "HKLM\\SYSTEM\\CurrentControlSet\\Services\\antitheftd").start();
                return p.waitFor(5, TimeUnit.SECONDS) && p.exitValue() == 0;
            } catch (Exception e) {
                return false;
            }
        }
        for (String f : new String[] {"/etc/systemd/system/antitheftd.service", "/lib/systemd/system/antitheftd.service", "/usr/lib/systemd/system/antitheftd.service"}) {
            if (new File(f).exists()) return true;
        }
        return false;
    }

    private void connect() {
        JsonObject body = new JsonObject();
        body.addProperty("app", ideName());
        body.addProperty("app_version", ApplicationInfo.getInstance().getFullVersion());
        body.addProperty("extension_version", ownVersion());
        Daemon.Response r = Daemon.request("POST", "/api/v1/ide/hello", gson.toJson(body));
        if (r == null || r.status() != 200) {
            standing = Standing.NOT_RUNNING;
            scheduleRetry();
            return;
        }
        JsonObject hello = JsonParser.parseString(r.text()).getAsJsonObject();
        ideId = hello.get("ide_id").getAsString();
        retryDelay = 2000;
        guardAvailable = attachGuard();
        applyPrefixes(hello.getAsJsonObject("prefixes"));
        applyStanding();
        hooks = SelfCheck.run(guardAvailable);
        sendHeartbeat();
        long every = Math.max(15, hello.has("heartbeat_secs") ? hello.get("heartbeat_secs").getAsLong() : 60);
        heartbeat = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(this::sendHeartbeat, every, every, TimeUnit.SECONDS);
        drain = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(this::drainAndReport, 1, 1, TimeUnit.SECONDS);
        followAlerts();
        refresh();
    }

    private void disconnect() {
        guardCall("update", new Class<?>[] {String.class, String[].class, String[].class}, "", new String[0], new String[0]);
        ideId = null;
        if (heartbeat != null) heartbeat.cancel(false);
        if (drain != null) drain.cancel(false);
        heartbeat = drain = null;
    }

    private String ownVersion() {
        IdeaPluginDescriptor d = PluginManagerCore.getPlugin(PluginId.getId(OWN_ID));
        return d == null ? "" : d.getVersion();
    }

    /** Attaches the guard to this IDE's own JVM (PyCharm and the other IDEs allow attaching to themselves). */
    private boolean attachGuard() {
        if (guardCall("installed", new Class<?>[0]) == Boolean.TRUE) return true;
        try {
            IdeaPluginDescriptor self = PluginManagerCore.getPlugin(PluginId.getId(OWN_ID));
            if (self == null) throw new IllegalStateException("this plugin is not registered");
            Path jar = self.getPluginPath().resolve("lib").resolve("antitheft-agent.jar");
            com.sun.tools.attach.VirtualMachine vm = com.sun.tools.attach.VirtualMachine.attach(String.valueOf(ProcessHandle.current().pid()));
            try {
                vm.loadAgent(jar.toString(), OWN_ID);
            } finally {
                vm.detach();
            }
        } catch (Throwable t) {
            LOG.warn("antitheft: the IDE guard could not be attached", t);
            return false;
        }
        boolean ok = guardCall("installed", new Class<?>[0]) == Boolean.TRUE;
        if (!ok) LOG.warn("antitheft: the IDE guard was attached but did not install (this JDK may be older than 24)");
        return ok;
    }

    private static final com.intellij.openapi.diagnostic.Logger LOG = com.intellij.openapi.diagnostic.Logger.getInstance(AntitheftService.class);

    /** A static method of the guard, which lives in the JDK's boot loader once attached. */
    static Object guardCall(String name, Class<?>[] types, Object... args) {
        try {
            Class<?> g = Class.forName("pro.antitheft.guard.Guard", true, null);
            Method m = g.getMethod(name, types);
            return m.invoke(null, args);
        } catch (Throwable t) {
            return null;
        }
    }

    private void applyPrefixes(JsonObject p) {
        if (p == null) return;
        prefixes = p;
        rev = str(p, "rev", "");
        if (standing != Standing.PROTECTED) return;
        String[] dirs = gson.fromJson(p.getAsJsonArray("dirs"), String[].class);
        String[] files = gson.fromJson(p.getAsJsonArray("files"), String[].class);
        guardCall("update", new Class<?>[] {String.class, String[].class, String[].class}, str(p, "salt", ""), dirs, files);
    }

    /** The guard refuses vaults only while antitheft protects; paused, it knows none. */
    private void applyStanding() {
        if (standing == Standing.PROTECTED && prefixes != null) applyPrefixes(prefixes);
        else guardCall("update", new Class<?>[] {String.class, String[].class, String[].class}, "", new String[0], new String[0]);
    }

    private void sendHeartbeat() {
        String id = ideId;
        if (id == null) return;
        JsonObject body = new JsonObject();
        body.addProperty("ide_id", id);
        body.add("hooks", gson.toJsonTree(hooks));
        body.addProperty("extension_version", ownVersion());
        Daemon.Response r = Daemon.request("POST", "/api/v1/ide/health", gson.toJson(body));
        if (r == null || r.status() == 404 || r.status() == 403) {
            disconnect();
            recheck();
            return;
        }
        JsonObject a = JsonParser.parseString(r.text()).getAsJsonObject();
        String newRev = str(a, "rev", "");
        if (!newRev.isEmpty() && !newRev.equals(rev)) {
            Daemon.Response p = Daemon.request("GET", "/api/v1/ide/vault-prefixes?ide_id=" + id, null);
            if (p != null && p.status() == 200) applyPrefixes(JsonParser.parseString(p.text()).getAsJsonObject());
        }
        JsonObject prot = a.has("protection") ? a.getAsJsonObject("protection") : null;
        if (prot != null && prot.has("paused") && prot.get("paused").getAsBoolean() != (standing == Standing.PAUSED)) recheck();
    }

    @SuppressWarnings("unchecked")
    private void drainAndReport() {
        Object got = guardCall("drain", new Class<?>[0]);
        if (!(got instanceof List<?> list) || list.isEmpty() || ideId == null) return;
        JsonArray items = new JsonArray();
        for (Object o : list) {
            String[] e = (String[]) o;
            if ("true".equals(e[7])) continue; // the self-check's decoy
            if ("spawn".equals(e[0])) {
                // the same program launched again and again by the same plugin: the first launch a minute
                String key = e[1] + "\u0000" + (e[6] == null ? "" : Model.programOf(e[6]));
                long now = System.currentTimeMillis();
                if (now - lastLaunch.getOrDefault(key, 0L) < 60_000) continue;
                if (lastLaunch.size() > 2000) lastLaunch.clear();
                lastLaunch.put(key, now);
            }
            JsonObject it = new JsonObject();
            it.addProperty("kind", e[0]);
            it.addProperty("extension_id", e[1]);
            if (e[3] != null) it.addProperty("op", e[3]);
            if (e[4] != null) it.addProperty("path", e[4]);
            if (e[5] != null) it.addProperty("pid", Long.parseLong(e[5]));
            if (e[6] != null) it.addProperty("command", e[6]);
            items.add(it);
            if (items.size() == 64) break;
        }
        if (items.isEmpty()) return;
        JsonObject body = new JsonObject();
        body.addProperty("ide_id", ideId);
        body.add("items", items);
        Daemon.request("POST", "/api/v1/ide/report", gson.toJson(body));
        refresh();
    }

    private void followAlerts() {
        if (streamThread != null && streamThread.isAlive()) return;
        streamThread = new Thread(() -> {
            while (!disposed && ideId != null) {
                Daemon.stream("/api/v1/alerts/stream", (name, data) -> {
                    if (name.equals("alert") || name.equals("resync")) refresh();
                    // paused, resumed, or the licence came or went
                    if (name.equals("protection") || name.equals("resync")) recheck();
                });
                try {
                    Thread.sleep(3000);
                } catch (InterruptedException e) {
                    return;
                }
                recheck();
            }
        }, "antitheft alerts");
        streamThread.setDaemon(true);
        streamThread.start();
    }

    /** Re-read this IDE's events and alerts. */
    void refresh() {
        String id = ideId;
        if (id == null) return;
        Daemon.Response r = Daemon.request("GET", "/api/v1/ide/events?ide_id=" + id + "&since=0", null);
        if (r == null || r.status() != 200) return;
        JsonObject a = JsonParser.parseString(r.text()).getAsJsonObject();
        java.util.Set<String> dismissed = reviewedKeys();
        items = Model.feed(a.getAsJsonArray("events"), a.getAsJsonArray("alerts"), AntitheftService::pluginName, ideName()).stream()
            .map(i -> i.needsYou() && i.alertId() == null && dismissed.contains(i.key()) ? i.reviewed() : i).toList();
        List<Model.Item> fresh = new ArrayList<>();
        synchronized (seen) {
            for (Model.Item i : items) if (seen.add(i.key()) && primed && i.needsYou()) fresh.add(i);
            primed = true;
        }
        for (Model.Item i : fresh) notify(i);
        if (System.currentTimeMillis() - vaultsReadAt > 20_000) readVaults();
        changed();
    }

    /** Re-read the vault list (on connect, a change of standing, and alerts, at most every 20 s; never on a timer). */
    private void readVaults() {
        String id = ideId;
        if (id == null) return;
        vaultsReadAt = System.currentTimeMillis();
        Daemon.Response r = Daemon.request("GET", "/api/v1/ide/vaults?ide_id=" + id, null);
        // an older antitheft has no such route: the tool window leaves the vaults out
        if (r == null || r.status() != 200) return;
        try {
            vaults = Model.vaults(JsonParser.parseString(r.text()).getAsJsonObject());
        } catch (RuntimeException e) {
            LOG.warn("antitheft: could not read the vault list", e);
        }
    }

    private static final String REVIEWED = "antitheft.reviewed";

    /** The IDE's own refusals marked reviewed: they have no record in antitheft, so the plugin remembers them. */
    private static java.util.Set<String> reviewedKeys() {
        String[] v = com.intellij.ide.util.PropertiesComponent.getInstance().getList(REVIEWED) == null ? new String[0]
            : com.intellij.ide.util.PropertiesComponent.getInstance().getList(REVIEWED).toArray(new String[0]);
        return new java.util.HashSet<>(java.util.Arrays.asList(v));
    }

    private static final String CLEARED = "antitheft.activityClearedAt";

    /** Activity cleared up to this time (unix seconds): the Activity tab leaves out what came before it. */
    long activityClearedAt() {
        return com.intellij.ide.util.PropertiesComponent.getInstance().getLong(CLEARED, 0);
    }

    void clearActivity() {
        long newest = items.stream().mapToLong(Model.Item::at).max().orElse(0);
        com.intellij.ide.util.PropertiesComponent.getInstance().setValue(CLEARED, String.valueOf(Math.max(System.currentTimeMillis() / 1000, newest)));
        changed();
    }

    /** Marks these reviewed: alerts in antitheft (the app sees it too), the IDE's own refusals here. Then re-reads. */
    void review(List<Model.Item> those) {
        AppExecutorUtil.getAppExecutorService().submit(() -> {
            List<Long> ids = new ArrayList<>();
            List<String> keys = new ArrayList<>();
            for (Model.Item i : those) {
                if (i.alertId() != null) ids.add(i.alertId());
                else keys.add(i.key());
            }
            if (!keys.isEmpty()) {
                List<String> kept = new ArrayList<>(reviewedKeys());
                kept.removeAll(keys);
                kept.addAll(keys);
                com.intellij.ide.util.PropertiesComponent.getInstance().setList(REVIEWED, kept.subList(Math.max(0, kept.size() - 500), kept.size()));
            }
            if (ids.size() == 1) Daemon.request("POST", "/api/v1/alerts/" + ids.get(0) + "/reviewed", null);
            else if (!ids.isEmpty()) Daemon.request("POST", "/api/v1/alerts/reviewed", gson.toJson(Map.of("ids", ids)));
            refresh();
        });
    }

    static String pluginName(String id) {
        try {
            IdeaPluginDescriptor d = PluginManagerCore.getPlugin(PluginId.getId(id));
            return d == null ? null : d.getName();
        } catch (Throwable t) {
            return null;
        }
    }

    private void notify(Model.Item i) {
        String who = i.pluginId() == null ? "?" : i.pluginId();
        long now = System.currentTimeMillis();
        if (now - lastNotified.getOrDefault(who, 0L) < 5 * 60 * 1000) return;
        lastNotified.put(who, now);
        ApplicationManager.getApplication().invokeLater(() -> {
            Notification n = NotificationGroupManager.getInstance().getNotificationGroup("antitheft")
                .createNotification("antitheft", i.title() + ". " + i.detail(), NotificationType.WARNING);
            n.addAction(NotificationAction.createSimpleExpiring("Show", () -> ToolWindowOpener.open()));
            if (i.pluginId() != null && !"unknown".equals(i.pluginId())) n.addAction(NotificationAction.createSimpleExpiring("Disable plugin", () -> PluginActions.disable(i.pluginId())));
            n.notify(null);
        });
    }

    /** Bring the antitheft app forward on one of its pages: through antitheft's service when connected, else by
     *  starting the installed app with {@code --open <page>} (not connected yet, protection paused, or no app
     *  running to hear the service). A copy already running takes the page from the new one. */
    boolean openApp(String route) {
        if (!isAppRoute(route)) return false;
        if (ideId != null) {
            JsonObject body = new JsonObject();
            body.addProperty("ide_id", ideId);
            body.addProperty("route", route);
            Daemon.Response r = Daemon.request("POST", "/api/v1/ide/open-app", gson.toJson(body));
            if (r != null && r.status() == 200 && appIsRunning()) return true;
        }
        return launchApp(route);
    }

    private static final String[] OPENABLE = {"/alerts", "/activity", "/decisions", "/vaults", "/settings", "/"};

    /** Only antitheft's own pages (the list antitheft's service accepts). */
    static boolean isAppRoute(String route) {
        if (route == null || !route.startsWith("/") || route.startsWith("//") || route.length() > 128 || !route.matches("[A-Za-z0-9/_?=&-]+")) return false;
        for (String p : OPENABLE) {
            if (route.equals(p)) return true;
            if (p.length() > 1 && route.startsWith(p) && route.length() > p.length() && "/?".indexOf(route.charAt(p.length())) >= 0) return true;
        }
        return false;
    }

    /** Linux: the app among this user's processes. Elsewhere antitheft's service is trusted to reach it. */
    private static boolean appIsRunning() {
        if (!System.getProperty("os.name", "").toLowerCase().contains("linux")) return true;
        java.io.File[] procs = new java.io.File("/proc").listFiles((d, n) -> n.chars().allMatch(Character::isDigit));
        if (procs == null) return true;
        for (java.io.File p : procs) {
            try {
                String exe = java.nio.file.Files.readSymbolicLink(new java.io.File(p, "exe").toPath()).toString();
                if (exe.equals("/usr/lib/antitheft/current/antitheft") || exe.matches("/usr/lib/antitheft/versions/[^/]+/antitheft")) return true;
            } catch (Exception ignored) {
                // not ours to read, or gone
            }
        }
        return false;
    }

    /** Starts the installed app on {@code route}, detached. False when it is not installed where antitheft puts it. */
    private static boolean launchApp(String route) {
        String os = System.getProperty("os.name", "").toLowerCase();
        java.util.List<String> cmd = new java.util.ArrayList<>();
        if (os.contains("mac")) {
            if (!new java.io.File("/Applications/Antitheft.app").exists()) return false;
            cmd.addAll(java.util.List.of("/usr/bin/open", "-a", "/Applications/Antitheft.app", "--args"));
        } else if (os.contains("win")) {
            String pf = System.getenv("ProgramW6432") != null ? System.getenv("ProgramW6432") : System.getenv().getOrDefault("ProgramFiles", "C:\\Program Files");
            String exe = pf + "\\Antitheft\\antitheft.exe";
            if (!new java.io.File(exe).exists()) return false;
            cmd.add(exe);
        } else {
            String exe = new java.io.File("/usr/local/bin/antitheft").exists() ? "/usr/local/bin/antitheft" : "/usr/lib/antitheft/current/antitheft";
            if (!new java.io.File(exe).exists()) return false;
            cmd.add(exe);
        }
        cmd.add("--open");
        cmd.add(route);
        try {
            new ProcessBuilder(cmd).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** antitheft's icon for a vault or a program, 24 px, fetched once. */
    /** An icon for `vault:<id>|<category>` (the vault's own, else its app's brand mark, else its category's, as the app's
     *  `ActorIcon` finds it) or `actor:<image>`; null until it has loaded, then `whenLoaded` runs. */
    Icon icon(String key, Runnable whenLoaded) {
        Icon cached = icons.get(key);
        if (cached != null) return cached == EMPTY ? null : cached;
        icons.put(key, EMPTY);
        AppExecutorUtil.getAppExecutorService().submit(() -> {
            List<String> paths = new ArrayList<>();
            if (key.startsWith("vault:")) {
                String rest = key.substring(6);
                int bar = rest.lastIndexOf('|');
                String id = bar < 0 ? rest : rest.substring(0, bar), category = bar < 0 ? "" : rest.substring(bar + 1);
                paths.add("/api/v1/icon/" + enc(id));
                if (!id.contains(":")) paths.add("/api/v1/icon/actor?title=" + enc(id));
                if (!category.isEmpty()) paths.add("/api/v1/icon/category/" + enc(category));
            } else {
                paths.add("/api/v1/icon/actor?image=" + enc(key.substring(6)));
            }
            for (String path : paths) {
                Icon got = fetchIcon(path);
                if (got != null) {
                    icons.put(key, got);
                    ApplicationManager.getApplication().invokeLater(whenLoaded);
                    return;
                }
            }
        });
        return null;
    }

    /** antitheft's icon routes answer `{content_type, data_base64}` (PNG or SVG); a raw image is taken too. 24 px. */
    private Icon fetchIcon(String path) {
        Daemon.Response r = Daemon.request("GET", path, null);
        if (r == null || r.status() != 200) return null;
        String type = r.contentType().toLowerCase();
        byte[] bytes = r.body();
        if (type.startsWith("application/json")) {
            try {
                JsonObject j = JsonParser.parseString(r.text()).getAsJsonObject();
                type = str(j, "content_type", "").toLowerCase();
                bytes = java.util.Base64.getDecoder().decode(str(j, "data_base64", ""));
            } catch (RuntimeException e) {
                return null;
            }
        }
        try {
            int size = com.intellij.util.ui.JBUI.scale(24);
            if (type.startsWith("image/svg")) {
                // the IDE draws SVG through its own loader, from a file: one per icon, under the IDE's system folder
                File dir = new File(PathManager.getSystemPath(), "antitheft-icons");
                if (!dir.isDirectory() && !dir.mkdirs()) return null;
                File f = new File(dir, Integer.toHexString(java.util.Arrays.hashCode(bytes)) + ".svg");
                if (!f.exists()) java.nio.file.Files.write(f.toPath(), bytes);
                Icon svg = com.intellij.openapi.util.IconLoader.findIcon(f.toURI().toURL());
                if (svg == null || svg.getIconWidth() <= 0) return null;
                return com.intellij.util.IconUtil.scale(svg, null, size / (float) svg.getIconWidth());
            }
            if (type.startsWith("image/")) {
                Image img = new ImageIcon(bytes).getImage();
                if (img.getWidth(null) <= 0) return null;
                return new ImageIcon(img.getScaledInstance(size, size, Image.SCALE_SMOOTH));
            }
        } catch (Exception e) {
            return null;
        }
        return null;
    }

    private static final Icon EMPTY = new ImageIcon(new byte[0]);

    private static String enc(String s) {
        return java.net.URLEncoder.encode(s, java.nio.charset.StandardCharsets.UTF_8);
    }

    private void scheduleRetry() {
        if (disposed || (retry != null && !retry.isDone())) return;
        retry = AppExecutorUtil.getAppScheduledExecutorService().schedule(this::recheck, retryDelay, TimeUnit.MILLISECONDS);
        retryDelay = Math.min(retryDelay * 2, 60000);
    }

    /** The self-check's decoy folder, under the IDE's own system folder. */
    static File decoyDir() {
        return new File(PathManager.getSystemPath(), "antitheft-selfcheck/decoy-vault");
    }

    Map<String, String> hooksView() {
        return new LinkedHashMap<>(hooks);
    }

    @Override
    public void dispose() {
        disposed = true;
        disconnect();
        if (streamThread != null) streamThread.interrupt();
    }
}
