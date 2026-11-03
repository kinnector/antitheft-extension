package pro.antitheft.ide;

import com.intellij.ide.plugins.IdeaPluginDescriptor;
import com.intellij.ide.plugins.PluginEnabler;
import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.extensions.PluginId;
import com.intellij.openapi.options.ShowSettingsUtil;
import com.intellij.openapi.ui.Messages;

import java.util.List;

/**
 * Disable or remove a plugin: the IDE's own plugin management, only on the person's click, after a
 * confirmation naming the plugin. The IDE's actions, not antitheft's decisions.
 */
final class PluginActions {
    private PluginActions() {}

    static void disable(String id) {
        IdeaPluginDescriptor d = PluginManagerCore.getPlugin(PluginId.getId(id));
        if (d == null) return;
        if (Messages.showYesNoDialog("Disable " + d.getName() + "? It stops running until you enable it again.", "antitheft", "Disable", "Cancel", Messages.getWarningIcon()) != Messages.YES) return;
        boolean done = PluginEnabler.getInstance().disable(List.of(d));
        if (!done && Messages.showYesNoDialog(d.getName() + " is disabled after a restart. Restart now?", "antitheft", "Restart", "Later", null) == Messages.YES) {
            ApplicationManager.getApplication().restart();
        }
    }

    /** Removing a plugin happens in Settings > Plugins, where the IDE asks itself. */
    static void uninstall(String id) {
        IdeaPluginDescriptor d = PluginManagerCore.getPlugin(PluginId.getId(id));
        Messages.showInfoMessage("Find " + (d == null ? id : d.getName()) + " under Installed and choose Uninstall.", "antitheft");
        ShowSettingsUtil.getInstance().showSettingsDialog(null, "Plugins");
    }
}
