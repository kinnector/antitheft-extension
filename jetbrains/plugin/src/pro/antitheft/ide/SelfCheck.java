package pro.antitheft.ide;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Proves each hook of the guard works, every time it is attached: a JDK or IDE update can move what it hooks.
 * Uses a decoy folder under the IDE's own system folder, treated as a vault by the guard only during the check
 * (never a real vault; its hits are never reported). The result goes out with every heartbeat.
 */
final class SelfCheck {
    private SelfCheck() {}

    static Map<String, String> run(boolean attached) {
        Map<String, String> hooks = new LinkedHashMap<>();
        if (!attached) {
            hooks.put("agent", "missing");
            return hooks;
        }
        File dir = AntitheftService.decoyDir();
        File file = new File(dir, "secret.txt");
        try {
            dir.mkdirs();
            Files.writeString(file.toPath(), "decoy");
        } catch (IOException e) {
            hooks.put("decoy", "missing");
            return hooks;
        }
        AntitheftService.guardCall("setDecoys", new Class<?>[] {String[].class}, (Object) new String[] {dir.getAbsolutePath()});
        try {
            hooks.put("java_io", refused(() -> new FileInputStream(file).close()));
            hooks.put("random_access", refused(() -> new RandomAccessFile(file, "r").close()));
            hooks.put("nio", refused(() -> Files.readAllBytes(file.toPath())));
            hooks.put("copy", refused(() -> Files.copy(file.toPath(), new File(dir.getParentFile(), "copy.txt").toPath(), StandardCopyOption.REPLACE_EXISTING)));
            String[] cmd = Daemon.WINDOWS ? new String[] {"cmd.exe", "/c", "type", file.getAbsolutePath()} : new String[] {"cat", file.getAbsolutePath()};
            hooks.put("launch", refused(() -> new ProcessBuilder(cmd).start().waitFor()));
        } finally {
            AntitheftService.guardCall("setDecoys", new Class<?>[] {String[].class}, (Object) new String[0]);
        }
        return hooks;
    }

    interface Attempt {
        void run() throws Exception;
    }

    private static String refused(Attempt a) {
        try {
            a.run();
            return "missing";
        } catch (Exception e) {
            return String.valueOf(e.getMessage()).contains("antitheft") ? "ok" : "missing";
        }
    }
}
