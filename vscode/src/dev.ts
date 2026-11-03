// Development switches, read from the environment in a development build only. A release build compiles
// them out (`__DEV__` is false), so nothing here can change how a published extension behaves.
//
//   ANTITHEFT_SOCKET=<path>          talk to another antitheft socket (a test daemon)
//   ANTITHEFT_DEV_PAUSED_OK=1        treat the dev stack's permanent pause as protected
//   ANTITHEFT_DEV_ASSUME_SERVICE=1   a dev-stack daemon has no service unit: stopped reads "not running"

declare const __DEV__: boolean;

export const dev = {
  enabled: (): boolean => __DEV__,
  socket: (): string | null => (__DEV__ ? process.env.ANTITHEFT_SOCKET || null : null),
  pausedIsProtected: (): boolean => __DEV__ && process.env.ANTITHEFT_DEV_PAUSED_OK === "1",
  assumeService: (): boolean => __DEV__ && process.env.ANTITHEFT_DEV_ASSUME_SERVICE === "1",
};
