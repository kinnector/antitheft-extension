// dist/guard.js: the guard on its own, for a worker an extension starts (its boot code calls `boot(state)`)
// and for a Node program an extension launches (`NODE_OPTIONS=--require guard.js` plus
// `ANTITHEFT_GUARD_STATE`). A worker reports to the extension host over a BroadcastChannel; a child
// process reports straight to antitheft, as the IDE (antitheft checks it is one).

import * as http from "http";
import { isMainThread, BroadcastChannel } from "worker_threads";
import { Matcher } from "./matcher";
import { CulpritFinder } from "./culprit";
import { installGuard, type GuardEvent } from "./core";
import { CHANNEL, type GuardState } from "./state";

const BOOTED = Symbol.for("antitheft.guard.booted");

export function boot(stateJson?: string): boolean {
  const g = globalThis as unknown as Record<symbol, boolean>;
  if (g[BOOTED]) return true;
  const raw = stateJson ?? process.env.ANTITHEFT_GUARD_STATE;
  if (!raw) return false;
  let state: GuardState;
  try {
    state = JSON.parse(raw) as GuardState;
  } catch {
    return false;
  }
  g[BOOTED] = true;
  const matcher = new Matcher(state.prefixes, state.windows, state.decoys);
  const finder = new CulpritFinder(state.roots, state.ownId, state.windows);
  const report = isMainThread ? childReporter(state) : workerReporter();
  installGuard({
    matcher,
    culprit: (stack) => finder.fromStack(stack) ?? state.creator ?? null,
    report,
    guardFile: __filename,
    childState: (creator) => JSON.stringify({ ...state, creator: creator ?? state.creator ?? null }),
    home: state.home,
  });
  return true;
}

function workerReporter(): (e: GuardEvent) => void {
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(CHANNEL);
    (ch as unknown as { unref?: () => void }).unref?.();
  } catch {
    ch = null;
  }
  return (e) => ch?.postMessage(e);
}

/** A child process sends its own report, one request per event, and does not wait for it. */
function childReporter(state: GuardState): (e: GuardEvent) => void {
  return (e) => {
    if (!state.ideId || !state.socket || e.decoy) return;
    const body = JSON.stringify({
      ide_id: state.ideId,
      items: [{ kind: e.kind, extension_id: e.extensionId, op: e.op, path: e.path, pid: e.pid, command: e.command }],
    });
    try {
      const req = http.request({ socketPath: state.socket, path: "/api/v1/ide/report", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" } });
      req.on("error", () => undefined);
      req.end(body);
      (req as unknown as { socket?: { unref?: () => void } }).socket?.unref?.();
    } catch {
      /* best effort */
    }
  };
}

// Loaded by `--require` in a Node child: boot from the environment.
if (process.env.ANTITHEFT_GUARD_STATE) boot();
