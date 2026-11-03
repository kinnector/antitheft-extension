// A launch as one readable command line, and the program it names. The guard writes the line; the screens and
// the launch dedupe read the program back from it. A shell running a script (`sh -c`, `cmd /c`,
// `powershell -Command`) is shown as the script, since the program that matters is the one the shell runs.

const SHELL = /^(sh|bash|zsh|dash|ksh|fish|cmd|powershell|pwsh)$/;
const SCRIPT_FLAG = /^([-/]c|-command|-file)$/i;
const MAX = 400;

function base(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function quote(s: string): string {
  return /[\s"]/.test(s) && !/^".*"$/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/** `file` is what was started, `args` its argv as Node passes it (argv[0] first). */
export function commandLine(file: string, args: string[] | undefined): string {
  const rest = args && args.length ? args.slice(1) : [];
  const shell = base(file).toLowerCase().replace(/\.exe$/, "");
  if (SHELL.test(shell)) {
    const i = rest.findIndex((a) => SCRIPT_FLAG.test(a));
    const tail = i >= 0 ? rest.slice(i + 1) : [];
    let script = "";
    if (shell === "cmd") {
      // `/s`: the line is passed verbatim and cmd drops its outer quotes (Node's exec); otherwise each
      // argument is quoted on the way, as Node does
      const verbatim = rest.some((a) => /^\/s$/i.test(a));
      script = verbatim ? tail.join(" ").replace(/^"(.*)"$/, "$1") : tail.map(quote).join(" ");
    } else if (shell === "powershell" || shell === "pwsh") {
      script = /^-file$/i.test(rest[i] ?? "") || tail.length > 1 ? tail.map(quote).join(" ") : tail[0] ?? "";
    } else {
      script = tail[0] ?? ""; // sh -c takes one script; later arguments are $0, $1
    }
    if (script.trim()) return script.slice(0, MAX);
  }
  return [file, ...rest].map(quote).join(" ").slice(0, MAX);
}

/** The program a command line starts: its first word, read with quotes ("C:\Program Files\x.exe" stays whole). */
export function programOf(command: string | null | undefined): string {
  const m = (command ?? "").trim().match(/^"((?:[^"\\]|\\.)*)"|^'([^']*)'|^(\S+)/);
  const first = m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
  return base(first.replace(/\\"/g, '"'));
}
