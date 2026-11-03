// Which extension made a call, from the JavaScript stack: every extension's code runs from its own
// folder, so the first stack frame inside an extension's folder names it. The editor's own code and its
// built-in extensions are told apart from third-party ones, and this extension never names itself.

export interface ExtensionRoot {
  /** The extension's folder, as the stack shows it. */
  path: string;
  /** `publisher.name`. */
  id: string;
  /** Shipped with the editor. */
  builtin: boolean;
}

export interface Culprit {
  id: string;
  builtin: boolean;
  /** The extension's folder (tags code it compiles at run time, `vm`). */
  path?: string;
}

/**
 * Files of a V8 stack, innermost first. Every path on a line counts: `eval` frames carry their caller's file
 * inside "eval at f (/ext/x.js:1:2), <anonymous>:1:1", the caller listed last.
 */
export function stackFiles(stack: string): string[] {
  const out: string[] = [];
  const re = /((?:file:\/\/)?(?:[a-zA-Z]:)?[\\/][^():,\n]*|evalmachine\.<anonymous>|node:[^():,\n]+):\d+:\d+/g;
  for (const line of stack.split("\n")) {
    const found: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      let f = m[1].trim();
      if (f.startsWith("file://")) {
        try {
          f = decodeURIComponent(f.slice(7));
          if (/^\/[a-zA-Z]:/.test(f)) f = f.slice(1);
        } catch {
          /* keep it */
        }
      }
      found.push(f);
    }
    // the frame's own file first, then the files of the eval chain that created it
    out.push(...found.reverse());
  }
  return out;
}

export class CulpritFinder {
  private roots: ExtensionRoot[] = [];
  private windows: boolean;
  /** Files outside their loader's folder, owned by the extension that loaded or compiled them. */
  private adopted = new Map<string, ExtensionRoot>();

  constructor(roots: ExtensionRoot[], private readonly ownId: string, windows: boolean) {
    this.windows = windows;
    this.setRoots(roots);
  }

  setRoots(roots: ExtensionRoot[]): void {
    // longest first, so a nested folder wins over the folder that holds it
    this.roots = roots.map((r) => ({ ...r, path: this.norm(r.path) })).sort((a, b) => b.path.length - a.path.length);
  }

  get allRoots(): ExtensionRoot[] {
    return this.roots.slice();
  }

  private norm(p: string): string {
    const s = this.windows ? p.replace(/\//g, "\\").toLowerCase() : p;
    const sep = this.windows ? "\\" : "/";
    return s.endsWith(sep) ? s : s + sep;
  }

  /** The extension a file belongs to, or null (the editor itself, Node's own code, unknown). */
  extensionOf(file: string): ExtensionRoot | null {
    const f = this.windows ? file.replace(/\//g, "\\").toLowerCase() : file;
    const a = this.adopted.get(f);
    if (a) return a;
    for (const r of this.roots) if (f.startsWith(r.path)) return r;
    return null;
  }

  /**
   * Code an extension runs from a file outside its own folder (a script it downloaded and required, code it
   * compiled under a file name of its choosing, even one inside another extension's folder) is its own.
   */
  adopt(file: string, by: Culprit): void {
    const f = this.windows ? file.replace(/\//g, "\\").toLowerCase() : file;
    if (this.adopted.has(f) || this.adopted.size >= 5000) return;
    for (const r of this.roots) if (f.startsWith(r.path) && r.id === by.id) return;
    this.adopted.set(f, { id: by.id, builtin: by.builtin, path: by.path ?? "" });
  }

  /** The extension behind the call whose stack this is: the first frame in an extension's folder other than this one's. */
  fromStack(stack: string): Culprit | null {
    for (const f of stackFiles(stack)) {
      const r = this.extensionOf(f);
      if (r && r.id !== this.ownId) return { id: r.id, builtin: r.builtin, path: r.path };
    }
    return null;
  }
}
