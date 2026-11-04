package pro.antitheft.ide;

/**
 * The store build's stand-in (`build.sh --store` copies this over `plugin/src/.../DirectDisable.java`): no internal IDE
 * API, so nothing disables a plugin directly. `PluginActions.disable` sends the person to Settings > Plugins instead.
 * Keep the same signatures as the other copy.
 */
final class DirectDisable {
    private DirectDisable() {}

    static final boolean AVAILABLE = false;

    static Boolean disable(String id) {
        return null;
    }
}
