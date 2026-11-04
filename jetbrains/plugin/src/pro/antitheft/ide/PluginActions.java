package pro.antitheft.ide;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.options.ShowSettingsUtil;
import com.intellij.openapi.ui.Messages;

/**
 * Disable or remove a plugin: the IDE's own plugin management, only on the person's click, after a
 * confirmation naming the plugin. The IDE's actions, not antitheft's decisions. Disabling at once needs internal
 * IDE API, so only the copy antitheft installs does it (`DirectDisable`); the store build opens Settings > Plugins,
 * as removing always does.
 */
final class PluginActions {
    private PluginActions() {}

    static void disable(String id) {
        Plugins.Info d = Plugins.find(id);
        String name = d == null ? id : d.name();
        if (!DirectDisable.AVAILABLE) {
            Messages.showInfoMessage("Find " + name + " under Installed and choose Disable.", "antitheft");
            ShowSettingsUtil.getInstance().showSettingsDialog(null, "Plugins");
            return;
        }
        if (Messages.showYesNoDialog("Disable " + name + "? It stops running until you enable it again.", "antitheft", "Disable", "Cancel", Messages.getWarningIcon()) != Messages.YES) return;
        Boolean done = DirectDisable.disable(id);
        if (done == null) return; // not a plugin the IDE knows any more
        if (!done && Messages.showYesNoDialog(name + " is disabled after a restart. Restart now?", "antitheft", "Restart", "Later", null) == Messages.YES) {
            ApplicationManager.getApplication().restart();
        }
    }

    /** Removing a plugin happens in Settings > Plugins, where the IDE asks itself. */
    static void uninstall(String id) {
        Plugins.Info d = Plugins.find(id);
        Messages.showInfoMessage("Find " + (d == null ? id : d.name()) + " under Installed and choose Uninstall.", "antitheft");
        ShowSettingsUtil.getInstance().showSettingsDialog(null, "Plugins");
    }
}
