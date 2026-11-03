// Decides whether a path is one of this computer's vaults (a wallet, a password store, a key) without
// knowing any vault path: antitheft hands the extension salted hashes of the vault locations, never the
// locations themselves, because every other extension shares this process and could read them.
//
// A path is a vault's when its own hash is a vault file's or a vault folder's, or when one of the folders
// above it is a vault folder. Folder answers are cached, so a busy extension host pays one hash per new
// file and a map lookup per folder it has seen before.

import { createHash } from "crypto";
import * as path from "path";

export interface Prefixes {
  salt: string;
  dirs: string[];
  files: string[];
  rev: string;
}

const MAX_CACHE = 20000;

export const NO_PREFIXES: Prefixes = { salt: "", dirs: [], files: [], rev: "" };

export class Matcher {
  private salt: Buffer;
  private dirs: Set<string>;
  private files: Set<string>;
  private readonly dirCache = new Map<string, boolean>();
  /** Answers by the path exactly as a caller passed it: the same files are read again and again. */
  private readonly pathCache = new Map<string, boolean>();
  private decoys: string[];
  prefixes: Prefixes;

  constructor(prefixes: Prefixes, readonly windows: boolean, decoys: string[] = []) {
    this.prefixes = prefixes;
    this.salt = Buffer.from(prefixes.salt, "hex");
    this.dirs = new Set(prefixes.dirs);
    this.files = new Set(prefixes.files);
    this.decoys = decoys.map((d) => this.key(this.absolute(d)));
  }

  /** A new vault set (antitheft's `rev` changed), or none at all (protection paused: nothing is refused). */
  update(prefixes: Prefixes): void {
    this.prefixes = prefixes;
    this.salt = Buffer.from(prefixes.salt, "hex");
    this.dirs = new Set(prefixes.dirs);
    this.files = new Set(prefixes.files);
    this.dirCache.clear();
    this.pathCache.clear();
  }

  setDecoys(decoys: string[]): void {
    this.decoys = decoys.map((d) => this.key(this.absolute(d)));
    this.pathCache.clear();
  }

  /** The self-check's own decoy folders, treated as vaults in this process only. */
  get decoyPaths(): string[] {
    return this.decoys.slice();
  }

  /** True when nothing is protected yet (no vaults known, no decoy). */
  get empty(): boolean {
    return this.dirs.size === 0 && this.files.size === 0 && this.decoys.length === 0;
  }

  /** The path the way antitheft hashed it: absolute, Windows case-folded with backslashes. */
  key(p: string): string {
    return this.windows ? p.replace(/\//g, "\\").toLowerCase() : p;
  }

  hash(key: string): string {
    return createHash("sha256").update(this.salt).update(key, "utf8").digest("hex").slice(0, 32);
  }

  absolute(p: string): string {
    if (this.windows) {
      const stripped = p.startsWith("\\\\?\\") ? p.slice(4) : p;
      return path.win32.resolve(stripped);
    }
    // already clean and absolute (the usual case): no resolve
    if (p.charCodeAt(0) === 47 && !p.includes("/.") && !p.includes("//") && (p.length === 1 || p.charCodeAt(p.length - 1) !== 47)) return p;
    return path.posix.resolve(p);
  }

  /** Is `p` (absolute or relative to the current folder) a vault file or inside a vault folder? */
  isProtected(p: string): boolean {
    if (this.empty || !p) return false;
    // a relative path's answer depends on the current folder: only absolute ones are remembered
    const cacheable = this.windows ? /^[a-zA-Z]:[\\/]|^\\\\/.test(p) : p.charCodeAt(0) === 47;
    if (cacheable) {
      const hit = this.pathCache.get(p);
      if (hit !== undefined) return hit;
    }
    const r = this.compute(p);
    if (cacheable) {
      if (this.pathCache.size >= MAX_CACHE) this.pathCache.clear();
      this.pathCache.set(p, r);
    }
    return r;
  }

  private compute(p: string): boolean {
    const abs = this.absolute(p);
    const key = this.key(abs);
    if (this.decoys.length && this.decoys.some((d) => key === d || key.startsWith(d + (this.windows ? "\\" : "/")))) return true;
    const h = this.hash(key);
    if (this.files.has(h) || this.dirs.has(h)) return true;
    const parent = this.windows ? path.win32.dirname(abs) : path.posix.dirname(abs);
    return parent !== abs && this.underDir(parent);
  }

  /** Is the decoy the path's reason for being protected (the self-check, never reported)? */
  isDecoy(p: string): boolean {
    if (!this.decoys.length) return false;
    const key = this.key(this.absolute(p));
    return this.decoys.some((d) => key === d || key.startsWith(d + (this.windows ? "\\" : "/")));
  }

  private underDir(dir: string): boolean {
    const cached = this.dirCache.get(dir);
    if (cached !== undefined) return cached;
    let result = this.dirs.has(this.hash(this.key(dir)));
    if (!result) {
      const parent = this.windows ? path.win32.dirname(dir) : path.posix.dirname(dir);
      result = parent !== dir && this.underDir(parent);
    }
    if (this.dirCache.size >= MAX_CACHE) this.dirCache.clear();
    this.dirCache.set(dir, result);
    return result;
  }
}

/** The path a file call was given: a string, a Buffer, or a file: URL. Anything else (a file descriptor) is none. */
export function pathOf(arg: unknown): string | null {
  if (typeof arg === "string") return arg;
  if (Buffer.isBuffer(arg)) return arg.toString("utf8");
  if (arg instanceof Uint8Array) return Buffer.from(arg).toString("utf8");
  if (arg && typeof arg === "object" && (arg as { protocol?: string }).protocol === "file:" && typeof (arg as { pathname?: string }).pathname === "string") {
    try {
      return require("url").fileURLToPath(arg as URL);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Path-like words in a command line or a JSON message: absolute paths, home-relative ones, Windows drive
 * paths, and file: URLs. Used where a vault path may hide inside a longer string (a shell command, an
 * extension host request to the main process).
 */
export function pathsIn(text: string, windows: boolean, home: string): string[] {
  const out: string[] = [];
  const words = text.split(/[\s"'`;|&<>()=,]+/);
  for (let w of words) {
    if (!w) continue;
    if (w.startsWith("file://")) {
      try {
        w = decodeURIComponent(w.slice(7));
        if (windows && /^\/[a-zA-Z]:/.test(w)) w = w.slice(1);
      } catch {
        continue;
      }
    }
    if (w.startsWith("~/") || w === "~") out.push(home + w.slice(1));
    else if (w.startsWith("/")) out.push(windows && /^\/[a-zA-Z]:/.test(w) ? w.slice(1) : w);
    else if (windows && /^[a-zA-Z]:[\\/]/.test(w)) out.push(w);
    else if (/[\\/]/.test(w)) out.push(w);
  }
  return out;
}

/** The `path` / `fsPath` / `external` fields of every URI in a serialized request (VS Code's RPC). */
export function uriPathsIn(json: string, windows: boolean): string[] {
  const out: string[] = [];
  const re = /"(?:path|fsPath|external)":"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(json)) !== null) {
    let v: string;
    try {
      v = JSON.parse(`"${m[1]}"`);
    } catch {
      continue;
    }
    if (v.startsWith("file://")) {
      try {
        v = decodeURIComponent(v.slice(7));
      } catch {
        continue;
      }
    }
    if (windows && /^\/[a-zA-Z]:/.test(v)) v = v.slice(1);
    if (v.startsWith("/") || (windows && /^[a-zA-Z]:[\\/]/.test(v))) out.push(v);
  }
  return out;
}
