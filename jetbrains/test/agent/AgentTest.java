import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

/**
 * The agent on a plain JVM, no IDE: started with -javaagent, it must rewrite the JDK with whichever rewriter
 * this JDK supports, refuse every route to a vault (known by its salted hash, as antitheft sends it) and leave
 * other files alone. Run by test/agent.sh on a JDK 21 (ASM) and a JDK 24+ (java.lang.classfile).
 */
public final class AgentTest {
    static final List<String> failures = new ArrayList<>();

    interface Route {
        void run() throws Exception;
    }

    public static void main(String[] args) throws Exception {
        File dir = Files.createTempDirectory("antitheft-agent-test").toFile().getCanonicalFile();
        File vault = new File(dir, "vault");
        File secret = new File(vault, "wallet.dat");
        File other = new File(dir, "notes.txt");
        vault.mkdirs();
        Files.writeString(secret.toPath(), "decoy-seed-phrase");
        Files.writeString(other.toPath(), "fine");

        Class<?> g = Class.forName("pro.antitheft.guard.Guard", true, null);
        String rewriter = has("java.lang.classfile.ClassFile") ? "java.lang.classfile" : "ASM in java.base";
        System.out.println("java " + Runtime.version() + ", rewriter: " + rewriter);
        if (!(boolean) g.getMethod("installed").invoke(null)) {
            System.out.println("FAILED: the guard is not installed");
            System.exit(1);
        }
        String salt = "00112233445566778899aabbccddeeff";
        Method update = g.getMethod("update", String.class, String[].class, String[].class);
        update.invoke(null, salt, new String[] {hash(salt, vault.getPath())}, new String[0]);

        boolean windows = File.separatorChar == '\\';
        refused("FileInputStream", () -> new FileInputStream(secret).close());
        refused("RandomAccessFile", () -> new RandomAccessFile(secret, "r").close());
        refused("FileOutputStream", () -> new FileOutputStream(secret, true).close());
        refused("Files.readAllBytes", () -> Files.readAllBytes(secret.toPath()));
        refused("Files.newBufferedReader", () -> Files.newBufferedReader(secret.toPath()).close());
        refused("Files.copy", () -> Files.copy(secret.toPath(), new File(dir, "copy").toPath(), StandardCopyOption.REPLACE_EXISTING));
        refused("Files.move", () -> Files.move(secret.toPath(), new File(dir, "moved").toPath()));
        refused("ProcessBuilder.start", () -> (windows ? new ProcessBuilder("cmd.exe", "/c", "type " + secret.getPath()) : new ProcessBuilder("sh", "-c", "cat " + secret.getPath())).start().waitFor());

        allowed("an ordinary file", () -> Files.readAllBytes(other.toPath()));
        allowed("an ordinary FileInputStream", () -> new FileInputStream(other).close());
        allowed("an ordinary launch", () -> (windows ? new ProcessBuilder("cmd.exe", "/c", "echo ok") : new ProcessBuilder("true")).start().waitFor());

        @SuppressWarnings("unchecked")
        List<String[]> events = (List<String[]>) g.getMethod("drain").invoke(null);
        long blocked = events.stream().filter(e -> e[0].equals("blocked")).count();
        System.out.println("blocked events: " + blocked);
        if (blocked < 8) failures.add("expected a blocked event for each refusal, got " + blocked);
        // the vault is untouched (checked with the guard told of no vaults)
        update.invoke(null, salt, new String[0], new String[0]);
        if (!secret.exists() || !Files.readString(secret.toPath(), StandardCharsets.UTF_8).equals("decoy-seed-phrase")) failures.add("the vault file was moved or changed");

        System.out.println(failures.isEmpty() ? "PASSED" : "FAILED:\n  " + String.join("\n  ", failures));
        System.exit(failures.isEmpty() ? 0 : 1);
    }

    static void refused(String name, Route r) {
        try {
            r.run();
            failures.add(name + ": not refused");
            System.out.println("  READ  " + name);
        } catch (Exception e) {
            boolean ours = String.valueOf(e.getMessage()).contains("antitheft");
            if (!ours) failures.add(name + ": failed for another reason: " + e);
            System.out.println("  " + (ours ? "FAIL " : "ERROR") + " " + name + " -> " + e.getClass().getSimpleName());
        }
    }

    static void allowed(String name, Route r) {
        try {
            r.run();
            System.out.println("  ok    " + name);
        } catch (Exception e) {
            failures.add(name + ": refused: " + e);
        }
    }

    static boolean has(String cls) {
        try {
            Class.forName(cls, false, null);
            return true;
        } catch (ClassNotFoundException e) {
            return false;
        }
    }

    /** As antitheft computes a vault's key: SHA-256 of salt + path, first 16 bytes, hex. */
    static String hash(String saltHex, String path) throws Exception {
        byte[] s = new byte[saltHex.length() / 2];
        for (int i = 0; i < s.length; i++) s[i] = (byte) Integer.parseInt(saltHex.substring(i * 2, i * 2 + 2), 16);
        String key = File.separatorChar == '\\' ? path.replace('/', '\\').toLowerCase() : path;
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        md.update(s);
        byte[] d = md.digest(key.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 16; i++) sb.append(String.format("%02x", d[i] & 0xff));
        return sb.toString();
    }
}
