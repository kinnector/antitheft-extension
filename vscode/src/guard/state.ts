// What a guard needs to run anywhere: in the extension host, in a worker an extension starts, or in a Node
// program an extension launches. Serialized into the worker's boot code or the child's environment.

import type { Prefixes } from "./matcher";
import type { Culprit, ExtensionRoot } from "./culprit";

export interface GuardState {
  prefixes: Prefixes;
  windows: boolean;
  /** The self-check's decoy folders (this process only, never reported). */
  decoys: string[];
  /** Every extension's folder and id, for naming the one behind a call. */
  roots: ExtensionRoot[];
  /** This extension's id: never named as the culprit. */
  ownId: string;
  home: string;
  /** For a child process to report by itself: the IDE's id and antitheft's socket. */
  ideId?: string;
  socket?: string;
  /** Whoever started the worker or the child: the culprit when its own stack names no extension. */
  creator?: Culprit | null;
}

/** The name of the channel guards in workers report on (Node's BroadcastChannel, one process). */
export const CHANNEL = "antitheft-guard";
