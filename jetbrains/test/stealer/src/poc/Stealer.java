package poc;

import com.intellij.ide.AppLifecycleListener;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.RandomAccessFile;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.concurrent.Callable;

/** Fake stealer plugin: tries to read the decoy wallet many ways. */
public final class Stealer implements AppLifecycleListener {
    static final String W = System.getProperty("poc.wallet");
    static final String LOG = System.getProperty("poc.log");

    @Override
    public void appStarted() { new Thread(Stealer::run, "poc-stealer").start(); }

    static void log(String m) {
        try (FileOutputStream o = new FileOutputStream(LOG, true)) { o.write(("[stealer] " + m + "\n").getBytes(StandardCharsets.UTF_8)); } catch (Exception e) { }
    }

    static void t(String name, Callable<Object> f) {
        try { String r = String.valueOf(f.call()).trim(); log("READ  " + name + " -> " + (r.length() > 40 ? r.substring(0, 40) : r)); }
        catch (Throwable e) { String m = String.valueOf(e.getMessage()); log("FAIL  " + name + " -> " + e.getClass().getSimpleName() + " " + (m.length() > 70 ? m.substring(0, 70) : m)); }
    }

    static String out(Process p) throws Exception { String s = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8); p.waitFor(); return s.isEmpty() ? "(empty, exit " + p.exitValue() + ")" : s; }

    static void run() {
        try { Thread.sleep(5000); } catch (InterruptedException e) { return; }
        log("running in pid " + ProcessHandle.current().pid() + ", loader " + Stealer.class.getClassLoader().getClass().getName());
        t("Files.readString", () -> Files.readString(Path.of(W)));
        t("Files.readAllBytes", () -> new String(Files.readAllBytes(Path.of(W))));
        t("FileChannel.open", () -> { try (FileChannel c = FileChannel.open(Path.of(W))) { return c.size() + " bytes open"; } });
        t("new FileInputStream", () -> { try (FileInputStream i = new FileInputStream(W)) { return new String(i.readAllBytes()); } });
        t("new FileReader", () -> { try (FileReader r = new FileReader(W)) { char[] c = new char[64]; return new String(c, 0, r.read(c)); } });
        t("new RandomAccessFile", () -> { try (RandomAccessFile r = new RandomAccessFile(W, "r")) { return r.readLine(); } });
        t("IntelliJ VFS contentsToByteArray", () -> new String(com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByPath(W).contentsToByteArray()));
        boolean win = System.getProperty("os.name", "").toLowerCase().contains("win");
        t("ProcessBuilder cat <path>", () -> out(win ? new ProcessBuilder("cmd.exe", "/c", "type", W).start() : new ProcessBuilder("cat", W).start()));
        if (win) {
            String ps = "Get-Content -Raw ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Base64.getEncoder().encodeToString(W.getBytes(StandardCharsets.UTF_8)) + "')))";
            String enc = Base64.getEncoder().encodeToString(ps.getBytes(StandardCharsets.UTF_16LE));
            t("ProcessBuilder shell obfuscated", () -> out(new ProcessBuilder("powershell.exe", "-NoProfile", "-EncodedCommand", enc).start()));
        } else {
            t("ProcessBuilder shell obfuscated", () -> out(new ProcessBuilder("sh", "-c", "cat \"$(echo " + Base64.getEncoder().encodeToString(W.getBytes()) + " | base64 -d)\"").start()));
        }
        t("Runtime.exec cat <path>", () -> out(Runtime.getRuntime().exec(win ? new String[] {"cmd.exe", "/c", "type", W} : new String[] {"cat", W})));
        try { Thread.sleep(8000); } catch (InterruptedException e) { return; }
        probe();
        log("DONE");
    }

    /** Opens antitheft's tool window in the open project and logs what is on screen, from the component tree. */
    static void probe() {
        try {
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeAndWait(() -> {
                for (java.awt.Window w : java.awt.Window.getWindows()) {
                    if (w.isShowing() && w instanceof java.awt.Dialog d) log("PROBE dialog open \"" + d.getTitle() + "\"");
                }
                com.intellij.openapi.project.Project[] open = com.intellij.openapi.project.ProjectManager.getInstance().getOpenProjects();
                if (open.length == 0) { log("PROBE no open project"); return; }
                com.intellij.openapi.project.Project p = open[0];
                com.intellij.openapi.wm.ToolWindow tw = com.intellij.openapi.wm.ToolWindowManager.getInstance(p).getToolWindow("antitheft");
                if (tw == null) { log("PROBE no antitheft tool window"); return; }
                tw.show();
                log("PROBE tool window icon " + (tw.getIcon() != null));
                com.intellij.openapi.wm.StatusBar bar = com.intellij.openapi.wm.WindowManager.getInstance().getStatusBar(p);
                com.intellij.openapi.wm.StatusBarWidget w = bar == null ? null : bar.getWidget("antitheft");
                if (w != null && w.getPresentation() instanceof com.intellij.openapi.wm.StatusBarWidget.TextPresentation tp) log("PROBE status bar \"" + tp.getText() + "\"");
                else log("PROBE status bar widget missing");
            }, com.intellij.openapi.application.ModalityState.any());
            Thread.sleep(2000);
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeAndWait(() -> {
                com.intellij.openapi.project.Project p = com.intellij.openapi.project.ProjectManager.getInstance().getOpenProjects()[0];
                com.intellij.openapi.wm.ToolWindow tw = com.intellij.openapi.wm.ToolWindowManager.getInstance(p).getToolWindow("antitheft");
                java.awt.Component root = tw.getContentManager().getContent(0).getComponent();
                walk(root);
                // every tab, each laid out and walked
                for (java.awt.Component c : all(root)) {
                    if (c instanceof javax.swing.JTabbedPane tabs) {
                        for (int i = 0; i < tabs.getTabCount(); i++) {
                            tabs.setSelectedIndex(i);
                            log("PROBE tab \"" + tabs.getTitleAt(i) + "\"");
                            walk(tabs.getComponentAt(i));
                        }
                    }
                }
            }, com.intellij.openapi.application.ModalityState.any());
        } catch (Throwable t) {
            log("PROBE failed " + t);
        }
    }

    static java.util.List<java.awt.Component> all(java.awt.Component c) {
        java.util.List<java.awt.Component> out = new java.util.ArrayList<>();
        out.add(c);
        if (c instanceof java.awt.Container k) for (java.awt.Component x : k.getComponents()) out.addAll(all(x));
        return out;
    }

    static void walk(java.awt.Component root) {
        for (java.awt.Component c : all(root)) {
            if (c.getName() != null && c.getName().startsWith("antitheft-emblem-")) log("PROBE emblem " + c.getName().substring(17));
            if (c instanceof javax.swing.JLabel l && (l.getText() != null && !l.getText().isEmpty() || l.getIcon() != null)) {
                String t = l.getText() == null ? "" : l.getText().replaceAll("<[^>]+>", "");
                log("PROBE label \"" + t + "\"" + (l.getIcon() != null ? " +icon" : ""));
            } else if (c instanceof javax.swing.AbstractButton b && b.getText() != null && !b.getText().isEmpty()) {
                log("PROBE button \"" + b.getText() + "\"");
            }
        }
    }
}
