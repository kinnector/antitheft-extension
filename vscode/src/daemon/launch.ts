// Starting the antitheft app on one of its pages, when it cannot be asked through antitheft's service (not connected
// yet, protection paused, or no app running to hear it): the installed app with `--open <page>`. A copy already
// running gets the page from the new one and that one quits (the app's single-instance handover).
//
// Only antitheft's own pages, and only antitheft's own app at the places its installers put it.

import * as fs from "fs";
import { spawn } from "child_process";

/** The app's pages the extension may open (the same list antitheft's service accepts). */
const OPENABLE = ["/alerts", "/activity", "/decisions", "/vaults", "/settings", "/"];

/** An app page: `/`, or one of the pages, alone or followed by `/...` or `?...` (`/alerts?id=7`). */
export function isAppRoute(route: string): boolean {
  if (!route.startsWith("/") || route.startsWith("//") || route.length > 128 || !/^[A-Za-z0-9/_?=&-]+$/.test(route)) return false;
  return OPENABLE.some((p) => route === p || (p.length > 1 && route.startsWith(p) && "/?".includes(route[p.length] ?? "")));
}

export type Launch = { command: string; args: string[] };

/** How to start the installed app on `route` on this platform, or null when it is not installed where antitheft
 *  puts it. `exists` and `env` are passed in for tests. */
export function appLaunch(route: string, platform: NodeJS.Platform, exists: (p: string) => boolean, env: NodeJS.ProcessEnv): Launch | null {
  if (!isAppRoute(route)) return null;
  const open = ["--open", route];
  if (platform === "darwin") {
    const app = "/Applications/Antitheft.app";
    return exists(app) ? { command: "/usr/bin/open", args: ["-a", app, "--args", ...open] } : null;
  }
  if (platform === "win32") {
    const programFiles = env.ProgramW6432 || env.ProgramFiles || "C:\\Program Files";
    const exe = `${programFiles}\\Antitheft\\antitheft.exe`;
    return exists(exe) ? { command: exe, args: open } : null;
  }
  // Linux: the link install.sh makes, then the installed version itself.
  const exe = ["/usr/local/bin/antitheft", "/usr/lib/antitheft/current/antitheft"].find(exists);
  return exe ? { command: exe, args: open } : null;
}

/** Whether the antitheft app runs for this user. Linux: one `/proc` listing, a readlink per process (other users' fail
 *  and are skipped). Elsewhere it is not looked up: antitheft's service is trusted to reach a running app. */
export function appIsRunning(procRoot = "/proc", platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "linux") return true;
  let pids: string[];
  try {
    pids = fs.readdirSync(procRoot).filter((n) => /^\d+$/.test(n));
  } catch {
    return true;
  }
  for (const pid of pids) {
    try {
      const exe = fs.readlinkSync(`${procRoot}/${pid}/exe`).replace(/ \(deleted\)$/, "");
      if (exe === "/usr/lib/antitheft/current/antitheft" || /\/usr\/lib\/antitheft\/versions\/[^/]+\/antitheft$/.test(exe) || exe.endsWith("/src-tauri/target/debug/antitheft")) return true;
    } catch {
      // not ours to read, or gone
    }
  }
  return false;
}

/** Starts the app on `route`, detached from the editor. False when it is not installed or could not be started. */
export function launchApp(route: string): boolean {
  const l = appLaunch(route, process.platform, (p) => fs.existsSync(p), process.env);
  if (!l) return false;
  try {
    const child = spawn(l.command, l.args, { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
