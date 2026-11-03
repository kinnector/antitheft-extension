package pro.antitheft.ide;

/**
 * Development switches. `ENABLED` is a compile-time constant the build sets (`build.sh --dev` writes it true):
 * a release build compiles every use out, so nothing here can change how a published plugin behaves.
 *
 *   -Dantitheft.dev.socket=<path> or ANTITHEFT_SOCKET     another antitheft socket (a test daemon)
 *   ANTITHEFT_DEV_PAUSED_OK=1                              the dev stack's permanent pause counts as protected
 *   ANTITHEFT_DEV_ASSUME_SERVICE=1                         a dev-stack daemon has no service unit
 */
final class Dev {
    private Dev() {}

    static final boolean ENABLED = false;

    static boolean pausedIsProtected() {
        return ENABLED && "1".equals(System.getenv("ANTITHEFT_DEV_PAUSED_OK"));
    }

    static boolean assumeService() {
        return ENABLED && "1".equals(System.getenv("ANTITHEFT_DEV_ASSUME_SERVICE"));
    }
}
