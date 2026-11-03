// Proves each hook of the guard still works, every time the guard is armed: an editor or runtime update
// can rename what it hooks. It uses a decoy folder under this extension's own storage, treated as a vault
// in this process only (and in the workers and children it starts), never a real vault, and its hits are
// never reported to antitheft. The result goes out with every heartbeat; antitheft shows a missing hook.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import type { Matcher } from "./guard/matcher";
import { asyncHooksInPlace, type Installed } from "./guard/core";

export type Hooks = Record<string, "ok" | "missing">;

const refused = (e: unknown): boolean => !!e && typeof e === "object" && (e as { code?: string }).code === "EACCES";

export async function runSelfCheck(context: vscode.ExtensionContext, matcher: Matcher, installed: Installed | null): Promise<Hooks> {
  const hooks: Hooks = {};
  const dir = path.join(context.globalStorageUri.fsPath, "selfcheck", "decoy-vault");
  const file = path.join(dir, "secret.txt");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, "decoy");
  } catch {
    return { decoy: "missing" };
  }
  matcher.setDecoys([dir]);
  try {
    // the file layer, sync and async
    try {
      fs.readFileSync(file, "utf8");
      hooks.fs_binding = "missing";
    } catch (e) {
      hooks.fs_binding = refused(e) ? "ok" : "missing";
    }
    hooks.fs_promises = await fs.promises.readFile(file, "utf8").then(
      () => "missing" as const,
      (e) => (refused(e) ? ("ok" as const) : ("missing" as const)),
    );
    // a worker
    hooks.worker = await new Promise<"ok" | "missing">((resolve) => {
      try {
        const { Worker } = require("worker_threads") as typeof import("worker_threads");
        const w = new Worker(
          "const {parentPort, workerData} = require('worker_threads'); try { require('fs').readFileSync(workerData); parentPort.postMessage('read'); } catch (e) { parentPort.postMessage(e && e.code === 'EACCES' ? 'refused' : 'other'); }",
          { eval: true, workerData: file },
        );
        const t = setTimeout(() => {
          void w.terminate();
          resolve("missing");
        }, 5000);
        w.once("message", (m) => {
          clearTimeout(t);
          void w.terminate();
          resolve(m === "refused" ? "ok" : "missing");
        });
        w.once("error", () => {
          clearTimeout(t);
          resolve("missing");
        });
      } catch {
        resolve("missing");
      }
    });
    // a Node child (the decoy's path goes by the environment: on its command line the launch itself is refused)
    hooks.node_children = await new Promise<"ok" | "missing">((resolve) => {
      const code = "try { require('fs').readFileSync(process.env.ANTITHEFT_SELFCHECK_FILE); console.log('read'); } catch (e) { console.log(e && e.code === 'EACCES' ? 'refused' : 'other'); }";
      cp.execFile(process.execPath, ["-e", code], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ANTITHEFT_SELFCHECK_FILE: file }, timeout: 10000, windowsHide: true }, (_err, stdout) => {
        resolve(String(stdout).trim() === "refused" ? "ok" : "missing");
      });
    });
    // a launch naming the decoy
    try {
      cp.execFileSync(process.platform === "win32" ? "cmd.exe" : "cat", process.platform === "win32" ? ["/c", "type", file] : [file], { timeout: 5000, windowsHide: true });
      hooks.launch = "missing";
    } catch (e) {
      hooks.launch = refused(e) ? "ok" : "missing";
    }
    // the editor's request to its main process
    hooks.rpc = await Promise.resolve(vscode.workspace.openTextDocument(vscode.Uri.file(file))).then(
      () => "missing" as const,
      (e) => (refused(e) || /EACCES|antitheft/.test(String(e)) ? ("ok" as const) : ("missing" as const)),
    );
  } finally {
    matcher.setDecoys([]);
  }
  if (installed && !installed.spawn) hooks.launch = "missing";
  // callbacks keep the extension that scheduled them
  hooks.async = installed?.async && asyncHooksInPlace() ? "ok" : "missing";
  return hooks;
}
