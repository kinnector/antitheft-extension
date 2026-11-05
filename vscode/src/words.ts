// What antitheft does to a program that reaches for a vault, in the words of the computer it runs on. Only Linux
// refuses the read before the file opens (in the kernel): there a read is blocked, refused or denied and a vault is
// locked. On Windows and macOS antitheft stops the program that reached for a vault, and nothing may say a read was
// blocked, refused or denied there, or that a vault is locked.
//
// The guard's own refusal of a read inside the editor is a real refusal on every system: its words stay.
// Pure (the webview bundles it too). The platform is the editor's (`process.platform`), which is antitheft's: the
// extension only talks to the antitheft of the computer it runs on.

export interface StopWords {
  /** The kernel refuses the open before the file opens (Linux). */
  locks: boolean;
  /** An alert's result: "blocked" | "stopped". */
  blocked: string;
  /** The same, while paused: "would be blocked" | "would be stopped". */
  wouldBe: string;
  /** The severity word: "Blocked" | "Stopped". */
  severity: string;
  /** The feed label of an alert antitheft acted on: "BLOCKED" | "STOPPED". */
  label: string;
  /** "WOULD BE BLOCKED" | "WOULD BE STOPPED". */
  wouldLabel: string;
  /** "blocks" | "stops" ("blocks none of them"). */
  blocks: string;
  /** A vault antitheft enforces: "locked" | "protected". */
  locked: string;
  /** A read antitheft acted on, counted: "denied" | "stopped". */
  denied: string;
}

const LOCKING: StopWords = {
  locks: true,
  blocked: "blocked",
  wouldBe: "would be blocked",
  severity: "Blocked",
  label: "BLOCKED",
  wouldLabel: "WOULD BE BLOCKED",
  blocks: "blocks",
  locked: "locked",
  denied: "denied",
};

const STOPPING: StopWords = {
  locks: false,
  blocked: "stopped",
  wouldBe: "would be stopped",
  severity: "Stopped",
  label: "STOPPED",
  wouldLabel: "WOULD BE STOPPED",
  blocks: "stops",
  locked: "protected",
  denied: "stopped",
};

/** Node's `process.platform` or antitheft's own word ("linux", "windows", "macos"). Anything but Linux stops. */
export function stopWords(platform: string | null | undefined): StopWords {
  return platform === "linux" ? LOCKING : STOPPING;
}
