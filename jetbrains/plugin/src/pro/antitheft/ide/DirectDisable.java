package pro.antitheft.ide;

import com.intellij.ide.plugins.IdeaPluginDescriptor;
import com.intellij.ide.plugins.PluginEnabler;
import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.openapi.extensions.PluginId;

import java.util.List;

/**
 * Disables a plugin from an alert, at once. This is the copy antitheft installs itself (`build.sh`): `PluginEnabler`
 * and `PluginManagerCore.getPlugin` are internal IDE API, so the store build (`build.sh --store`) compiles
 * `plugin/store/.../DirectDisable.java` in its place, which has neither and sends the person to Settings > Plugins.
 * Keep both copies' signatures the same.
 */
final class DirectDisable {
    private DirectDisable() {}

    static final boolean AVAILABLE = true;

    /** True: stopped now; false: stops after a restart; null: the IDE does not know this plugin. */
    static Boolean disable(String id) {
        IdeaPluginDescriptor d = PluginManagerCore.getPlugin(PluginId.getId(id));
        if (d == null) return null;
        return PluginEnabler.getInstance().disable(List.of(d));
    }
}
