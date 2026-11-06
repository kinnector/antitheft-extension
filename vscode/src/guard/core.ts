// The in-process guard: refuses any code in this process (another extension, a worker it started, code it
// compiled at run time) a read of a vault, before the read happens, and names the extension that tried.
//
// Where it hooks, and why there:
// - Node's internal file layer (`process.binding('fs')`): one object shared by `fs`, `fs/promises`,
//   `original-fs`, ESM `import('node:fs')` and the editor's own file code (`vscode.workspace.fs` reads in
//   this process), so references taken before the guard loaded are covered too.
// - Process launches at their two choke points (`ChildProcess.prototype.spawn`, `process.binding('spawn_sync')`):
//   a command naming a vault is refused; a launch by a third-party extension is reported (attribution), and a
//   Node child gets this guard too (`--require`).
// - `worker_threads.Worker`: every worker loads this guard first.
// - `JSON.stringify` inside the editor's RPC (`serializeRequest`): a request asking the main process to open
//   a vault (`openTextDocument`, `vscode.open`) is refused while the caller is still on the stack.
//
// What it cannot do: stop a separate program (a downloaded beacon, a shell) from reading by itself. That is
// antitheft's job at the operating-system level; the guard only says which extension started it.

import * as path from "path";
import type { Matcher } from "./matcher";
import { pathCandidates, pathOf, uriPathsIn } from "./matcher";
import type { Culprit } from "./culprit";
import { commandLine } from "../commandLine";

export interface GuardEvent {
  kind: "blocked" | "spawn" | "write";
  /** The extension behind it (`publisher.name`), or `unknown`. */
  extensionId: string;
  builtin: boolean;
  op?: string;
  path?: string;
  pid?: number;
  command?: string;
  /** The self-check's decoy: never reported to antitheft. */
  decoy?: boolean;
}

export interface GuardOptions {
  matcher: Matcher;
  /** The extension behind the current call (from a stack), or a worker's creator. */
  culprit(stack: string): Culprit | null;
  report(e: GuardEvent): void;
  /** This guard's own file, loaded first in workers and Node children. */
  guardFile: string;
  /** What a worker or a Node child needs to start its own guard (JSON). */
  childState(creator: Culprit | null): string;
  /** The user's home folder, for `~/` in commands. */
  home: string;
  /** Code loaded from outside its extension's folder becomes that extension's (`CulpritFinder.adopt`). */
  adopt?(file: string, by: Culprit): void;
  /** Whether a file is an extension's or the editor's own (never adopted). */
  owned?(file: string): boolean;
}

export interface Installed {
  fsBinding: boolean;
  spawn: boolean;
  spawnSync: boolean;
  worker: boolean;
  rpc: boolean;
  /** Callbacks keep the extension that scheduled them (timers, immediates, nextTick, microtasks). */
  async: boolean;
}

const MARK = Symbol.for("antitheft.guard.installed");

/** Binding functions that open, read, copy, move, link or remove by path, and which arguments are paths. */
const PATH_FNS: Record<string, number[]> = {
  open: [0],
  openFileHandle: [0],
  readFileUtf8: [0],
  writeFileUtf8: [0],
  copyFile: [0, 1],
  cpSyncCopyDir: [0, 1],
  cpSyncFile: [0, 1],
  cpSyncOverrideFile: [0, 1],
  readdir: [0],
  opendir: [0],
  link: [0, 1],
  symlink: [0, 1],
  rename: [0, 1],
  unlink: [0],
  rmdir: [0],
  rmSync: [0],
  truncate: [0],
  utimes: [0],
  chmod: [0],
  chown: [0],
};

/** Windows files that run by their name alone: a write of one by a third-party extension is reported
 * (download-then-run). Elsewhere a program needs its executable bits, which `chmod`/`open` show. A script
 * started through an interpreter is attributed by its launch instead. */
const RUNNABLE_ON_WINDOWS = /\.(exe|dll|ps1|bat|cmd|vbs|vbe|wsf|scr|msi|com|hta)$/i;

function eacces(syscall: string, p: string, windows: boolean): NodeJS.ErrnoException {
  const e = new Error(`EACCES: permission denied, ${syscall} '${p}' (antitheft: this file belongs to a protected app)`) as NodeJS.ErrnoException;
  e.code = "EACCES";
  e.errno = windows ? -4092 : -13;
  e.syscall = syscall;
  e.path = p;
  return e;
}

/** The async hooks are still in place (no one has replaced the timers or `then` since). */
export function asyncHooksInPlace(): boolean {
  const marked = (f: unknown): boolean => typeof f === "function" && (f as unknown as Record<symbol, boolean>)[MARK] === true;
  return marked(globalThis.setTimeout) && marked(globalThis.setImmediate) && marked(process.nextTick) && marked(globalThis.queueMicrotask);
}

export function installGuard(o: GuardOptions): Installed {
  const g = globalThis as unknown as Record<symbol, Installed | undefined>;
  if (g[MARK]) return g[MARK]!;
  const windows = o.matcher.windows;
  const installed: Installed = { fsBinding: false, spawn: false, spawnSync: false, worker: false, rpc: false, async: false };
  let reporting = false;

  // A callback that is not an extension's own code (fs.readFileSync handed to setTimeout, a bound function,
  // `.then(fs.readFileSync)`) runs with no extension on the stack. Each scheduling call keeps where it was
  // made: a stack captured unformatted, read only when a refusal happens inside that callback, and chained
  // through the hops before it.
  type Origin = { at: { stack?: string }; parent: Origin | null; depth: number };
  let current: Origin | null = null;
  const MAX_HOPS = 16;
  const capture = (): Origin | null => {
    if (current && current.depth >= MAX_HOPS) return current;
    const at: { stack?: string } = {};
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 24;
    Error.captureStackTrace(at, capture);
    Error.stackTraceLimit = limit;
    return { at, parent: current, depth: (current?.depth ?? 0) + 1 };
  };
  const culpritNow = (): Culprit | null => {
    const stack = new Error().stack ?? "";
    const c = o.culprit(stack);
    if (c) return c;
    for (let x = current; x; x = x.parent) {
      const from = o.culprit(x.at.stack ?? "");
      if (from) return from;
    }
    return null;
  };
  const emit = (e: GuardEvent): void => {
    if (reporting) return;
    reporting = true;
    try {
      o.report(e);
    } catch {
      /* never let reporting break the call */
    } finally {
      reporting = false;
    }
  };
  // A refusal that happens a tick after the call (a stream opening) has no caller on the stack: the call
  // reports it named, then and there (`named`), and the late refusal of the same path is not reported again.
  const named = new Map<string, number>();
  const refuse = (op: string, p: string): NodeJS.ErrnoException => {
    const c = culpritNow();
    const key = o.matcher.absolute(p);
    if (!c && Date.now() - (named.get(key) ?? 0) < 3000) return eacces(op, p, windows);
    emit({ kind: "blocked", extensionId: c?.id ?? "unknown", builtin: c?.builtin ?? false, op, path: p, decoy: o.matcher.isDecoy(p) });
    return eacces(op, p, windows);
  };
  const reportNamed = (op: string, p: string): void => {
    const c = culpritNow();
    if (!c) return;
    const key = o.matcher.absolute(p);
    if (named.size > 1000) named.clear();
    named.set(key, Date.now());
    emit({ kind: "blocked", extensionId: c.id, builtin: c.builtin, op, path: p, decoy: o.matcher.isDecoy(p) });
  };

  // ---- the file layer ------------------------------------------------------------------------
  const proc = process as unknown as { binding(name: string): Record<string, unknown> };
  let binding: Record<string, unknown> | null = null;
  try {
    binding = proc.binding("fs");
  } catch {
    binding = null;
  }
  if (binding) {
    const kUsePromises = binding.kUsePromises;
    // Fail the way the caller expects: a promise, a callback request, or a throw.
    const fail = (err: NodeJS.ErrnoException, args: unknown[]): unknown => {
      const last = args[args.length - 1];
      if (kUsePromises !== undefined && last === kUsePromises) return Promise.reject(err);
      if (last && typeof last === "object" && typeof (last as { oncomplete?: unknown }).oncomplete === "function") {
        process.nextTick(() => (last as { oncomplete: (e: unknown) => void }).oncomplete(err));
        return undefined;
      }
      throw err;
    };
    let wrapped = 0;
    for (const [name, idx] of Object.entries(PATH_FNS)) {
      const orig = binding[name];
      if (typeof orig !== "function") continue;
      const fn = orig as (...a: unknown[]) => unknown;
      binding[name] = function (this: unknown, ...args: unknown[]): unknown {
        for (const i of idx) {
          const p = pathOf(args[i]);
          if (p !== null && o.matcher.isProtected(p)) return fail(refuse(name, p), args);
        }
        // a third-party extension writing a program it may run later
        if (name === "chmod" || name === "open" || name === "writeFileUtf8") {
          const p = pathOf(args[0]);
          if (p !== null && writesRunnable(name, args, p, windows)) {
            const c = culpritNow();
            if (c && !c.builtin) emit({ kind: "write", extensionId: c.id, builtin: false, path: o.matcher.absolute(p) });
          }
        }
        return fn.apply(this, args);
      };
      wrapped++;
    }
    installed.fsBinding = wrapped > 0;
  }

  // ---- process launches ----------------------------------------------------------------------
  const checkLaunch = (file: string, args: string[], cwd: string | undefined): string | null => {
    const words = [file, ...args.slice(1)];
    for (const w of words) {
      if (typeof w !== "string") continue;
      for (const p of pathCandidates(w, windows, o.home)) {
        const abs = cwd && !path.isAbsolute(p) ? path.resolve(cwd, p) : p;
        if (o.matcher.isProtected(abs)) return abs;
      }
    }
    return null;
  };
  const isNode = (file: string, env: string[] | undefined): boolean => {
    const base = path.basename(file).toLowerCase();
    return base === "node" || base === "node.exe" || (file === process.execPath && !!env?.some((kv) => kv.startsWith("ELECTRON_RUN_AS_NODE=")));
  };
  const inject = (options: { file: string; envPairs?: string[] }, creator: Culprit | null): void => {
    if (!options.envPairs || !isNode(options.file, options.envPairs)) return;
    const req = `--require ${JSON.stringify(o.guardFile)}`;
    const i = options.envPairs.findIndex((kv) => kv.startsWith("NODE_OPTIONS="));
    if (i >= 0) options.envPairs[i] = `${options.envPairs[i]} ${req}`;
    else options.envPairs.push(`NODE_OPTIONS=${req}`);
    options.envPairs.push(`ANTITHEFT_GUARD_STATE=${o.childState(creator)}`);
  };
  type SpawnOptions = { file: string; args?: string[]; envPairs?: string[]; cwd?: string };
  const beforeLaunch = (options: SpawnOptions, op: string): Culprit | null => {
    const hit = checkLaunch(options.file, options.args ?? [], options.cwd);
    if (hit) throw refuse(op, hit);
    const c = culpritNow();
    inject(options, c);
    return c;
  };
  const command = (options: SpawnOptions): string => commandLine(options.file, options.args);

  try {
    const cp = require("child_process") as typeof import("child_process") & { ChildProcess: { prototype: { spawn: (o: SpawnOptions) => unknown } } };
    const proto = cp.ChildProcess.prototype;
    const origSpawn = proto.spawn;
    proto.spawn = function (this: { pid?: number }, options: SpawnOptions): unknown {
      const c = beforeLaunch(options, "spawn");
      const r = origSpawn.call(this, options);
      if (c && !c.builtin) emit({ kind: "spawn", extensionId: c.id, builtin: false, pid: this.pid, command: command(options) });
      return r;
    };
    installed.spawn = true;
  } catch {
    /* no child_process here */
  }
  try {
    const ss = proc.binding("spawn_sync") as { spawn: (o: SpawnOptions) => { pid?: number } };
    const origSS = ss.spawn;
    ss.spawn = function (this: unknown, options: SpawnOptions) {
      const c = beforeLaunch(options, "spawnSync");
      const r = origSS.call(this, options);
      if (c && !c.builtin) emit({ kind: "spawn", extensionId: c.id, builtin: false, pid: r?.pid, command: command(options) });
      return r;
    };
    installed.spawnSync = true;
  } catch {
    /* spawn_sync is not reachable */
  }

  // ---- workers -------------------------------------------------------------------------------
  try {
    const wt = require("worker_threads") as typeof import("worker_threads");
    const Orig = wt.Worker;
    const guardFile = o.guardFile;
    class GuardedWorker extends Orig {
      constructor(file: string | URL, opts: import("worker_threads").WorkerOptions = {}) {
        const creator = culpritNow();
        const boot = `require(${JSON.stringify(guardFile)}).boot(${JSON.stringify(o.childState(creator))});\n`;
        let src: string;
        if (opts.eval) src = boot + String(file);
        else {
          const f = file instanceof URL ? require("url").fileURLToPath(file) : String(file);
          src = /\.mjs$/i.test(f) ? `${boot}import(${JSON.stringify(require("url").pathToFileURL(f).href)});` : `${boot}require(${JSON.stringify(f)});`;
        }
        super(src, { ...opts, eval: true });
      }
    }
    (wt as { Worker: unknown }).Worker = GuardedWorker;
    installed.worker = true;
  } catch {
    /* no workers */
  }

  // ---- naming callers across async hops --------------------------------------------------------
  // setTimeout / setInterval / setImmediate / process.nextTick / queueMicrotask run their callback under the
  // origin of the call that scheduled it. Promise chains need nothing: V8 keeps the awaiting functions on the
  // stack (replacing Promise.prototype.then would lose exactly that inside the editor's own chains).
  // Only a callback that cannot name itself needs it (capturing a stack costs microseconds; this test costs
  // tens of nanoseconds): Node's own functions (fs.readFileSync handed over as is), built-ins, bound
  // functions and proxies. Any other callback is code in a file, and its own frame names it.
  const fnSource = Function.prototype.toString;
  const foreign = new WeakSet<object>();
  const NODE_MODULES = ["fs", "fs/promises", "child_process", "worker_threads", "vm", "module", "os", "net", "http", "https", "process"];
  try {
    for (const m of NODE_MODULES) {
      const mod = (m === "process" ? process : require(m)) as Record<string, unknown>;
      for (const k of Object.keys(mod)) if (typeof mod[k] === "function") foreign.add(mod[k] as object);
    }
  } catch {
    /* a module this runtime lacks */
  }
  const cannotNameItself = (fn: object): boolean => {
    if (foreign.has(fn)) return true;
    try {
      const src = fnSource.call(fn);
      return (src.length < 120 && src.endsWith("[native code] }")) || (fn as { name?: string }).name === "require";
    } catch {
      return true;
    }
  };
  const carry = <F extends (...a: never[]) => unknown>(fn: F): F => {
    if (typeof fn !== "function" || !cannotNameItself(fn)) return fn;
    const origin = capture();
    return function (this: unknown, ...args: never[]) {
      const prev = current;
      current = origin;
      try {
        return fn.apply(this, args);
      } finally {
        current = prev;
      }
    } as unknown as F;
  };
  const wrapScheduler = (holder: Record<string, unknown>, name: string): boolean => {
    const orig = holder[name] as ((...a: unknown[]) => unknown) | undefined;
    if (typeof orig !== "function" || (orig as { [MARK]?: boolean })[MARK]) return typeof orig === "function";
    const wrapped = function (this: unknown, cb: unknown, ...rest: unknown[]): unknown {
      return orig.call(this, carry(cb as (...a: never[]) => unknown), ...rest);
    };
    // keep what hangs off the original (util.promisify.custom on the timers)
    for (const k of Reflect.ownKeys(orig)) {
      if (k === "length" || k === "name" || k === "prototype") continue;
      try {
        Object.defineProperty(wrapped, k, Object.getOwnPropertyDescriptor(orig, k)!);
      } catch {
        /* read-only */
      }
    }
    Object.defineProperty(wrapped, MARK, { value: true });
    holder[name] = wrapped;
    foreign.add(wrapped);
    return true;
  };
  try {
    const timers = require("timers") as unknown as Record<string, unknown>;
    const glob = globalThis as unknown as Record<string, unknown>;
    let ok = true;
    for (const n of ["setTimeout", "setInterval", "setImmediate"]) {
      ok = wrapScheduler(glob, n) && ok;
      if (timers[n] !== glob[n]) wrapScheduler(timers, n);
    }
    ok = wrapScheduler(glob, "queueMicrotask") && ok;
    ok = wrapScheduler(process as unknown as Record<string, unknown>, "nextTick") && ok;
    installed.async = ok;
  } catch {
    /* no timers here */
  }

  // ---- naming callers the stack loses ---------------------------------------------------------
  // Streams open a tick later: name the caller when it asks for one.
  try {
    const fs = require("fs") as Record<string, unknown>;
    for (const name of ["createReadStream", "createWriteStream"]) {
      const orig = fs[name] as ((...a: unknown[]) => unknown) | undefined;
      if (typeof orig !== "function") continue;
      fs[name] = function (this: unknown, ...args: unknown[]): unknown {
        const p = pathOf(args[0]);
        if (p !== null && o.matcher.isProtected(p)) reportNamed(name, p);
        return orig.apply(this, args);
      };
    }
  } catch {
    /* no fs here */
  }
  // A script an extension loads from outside its folder (one it downloaded, say) is that extension's code.
  // Checked once per module compiled, and only for files that belong to no extension and not to the editor.
  try {
    const Module = require("module") as unknown as { prototype: Record<string, unknown> };
    const origCompile = Module.prototype._compile as ((content: string, filename: string) => unknown) | undefined;
    if (typeof origCompile === "function" && o.adopt && o.owned) {
      Module.prototype._compile = function (this: unknown, content: string, filename: string): unknown {
        if (typeof filename === "string" && !o.owned!(filename)) {
          const c = culpritNow();
          if (c) o.adopt!(filename, c);
        }
        return origCompile.call(this, content, filename);
      };
    }
  } catch {
    /* no CommonJS loader here */
  }
  // Code compiled at run time (vm) runs with no file of its own: give it a name inside the folder of the
  // extension that compiled it, so a refusal from it names that extension.
  try {
    const vm = require("vm") as Record<string, unknown>;
    const tag = (options: unknown, at: number, args: unknown[]): void => {
      const chosen = typeof options === "string" ? options : options && typeof options === "object" ? (options as { filename?: unknown }).filename : undefined;
      const c = culpritNow();
      if (!c) return;
      // a file name the caller chose: the code is the caller's, whatever folder the name points into
      if (typeof chosen === "string") {
        if (chosen) o.adopt?.(chosen, c);
        return;
      }
      if (!c.path) return;
      args[at] = { ...((options as object) ?? {}), filename: path.join(c.path, "[runtime code]") };
    };
    for (const name of ["runInThisContext", "runInNewContext", "runInContext", "compileFunction"]) {
      const orig = vm[name] as ((...a: unknown[]) => unknown) | undefined;
      if (typeof orig !== "function") continue;
      const at = name === "runInThisContext" ? 1 : 2;
      vm[name] = function (this: unknown, ...args: unknown[]): unknown {
        tag(args[at], at, args);
        return orig.apply(this, args);
      };
    }
    const OrigScript = vm.Script as new (code: string, options?: unknown) => unknown;
    if (typeof OrigScript === "function") {
      vm.Script = class extends (OrigScript as new (code: string, options?: unknown) => object) {
        constructor(code: string, options?: unknown) {
          const args: unknown[] = [code, options];
          tag(options, 1, args);
          super(code, args[1]);
        }
      };
    }
  } catch {
    /* no vm here */
  }

  // ---- the editor's requests to its main process --------------------------------------------
  const origStringify = JSON.stringify;
  const stringify = function (this: unknown, ...a: Parameters<typeof JSON.stringify>): string {
    const r = origStringify.apply(this, a) as string;
    if (typeof r === "string" && r.length < 262144 && (r.includes('"scheme":"file"') || r.includes("file://"))) {
      const hit = uriPathsIn(r, windows).find((p) => o.matcher.isProtected(p));
      if (hit) {
        const stack = new Error().stack ?? "";
        if (/serializeRequest/.test(stack)) {
          const c = o.culprit(stack);
          emit({ kind: "blocked", extensionId: c?.id ?? "unknown", builtin: c?.builtin ?? false, op: "open in editor", path: hit, decoy: o.matcher.isDecoy(hit) });
          throw eacces("open", hit, windows);
        }
      }
    }
    return r;
  };
  try {
    Object.defineProperty(JSON, "stringify", { value: stringify, writable: true, configurable: true });
    installed.rpc = JSON.stringify === stringify;
  } catch {
    installed.rpc = false;
  }

  g[MARK] = installed;
  return installed;
}

/** Does this call write a file that runs (executable bits, or a program's name on Windows)? Exported for tests. */
export function writesRunnable(name: string, args: unknown[], p: string, windows: boolean): boolean {
  const exec = (m: unknown): boolean => typeof m === "number" && (m & 0o111) !== 0;
  if (name === "chmod") return !windows && exec(args[1]);
  if (name === "writeFileUtf8") return windows ? RUNNABLE_ON_WINDOWS.test(p) : exec(args[3]);
  // open(path, flags, mode): writing (O_WRONLY 1 | O_RDWR 2) a file with executable bits, or a program on Windows
  const flags = typeof args[1] === "number" ? args[1] : 0;
  if ((flags & 3) === 0) return false;
  return windows ? RUNNABLE_ON_WINDOWS.test(p) : exec(args[2]);
}
