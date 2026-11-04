// Is antitheft here, and is it protecting? Everything this extension does waits for "protected".
//
//   not-installed   no antitheft service on this computer
//   no-access       installed and running, but this login session may not use its socket yet: the installer
//                   added the person to the socket's group, which only takes effect at their next login
//   not-running     installed, but its service does not answer
//   update-antitheft  running, but older than this extension: it has no editor API (404 on hello) or an older one
//   update-extension  running, and newer than this extension can speak (426 on hello): antitheft installs its
//                   own copy (the store copy and antitheft's own may differ in version)
//   paused          the owner (or the licence) paused protection: nothing is enforced, the guard stays off
//   protected       everything on
//
// "Installed" comes from the service registration, "running" from the socket answering, so a stopped
// service never reads as "not installed"; a socket that is there but refuses this process is "no-access".

import * as fs from "fs";
import * as cp from "child_process";
import { request, socketPath } from "./client";
import { dev } from "../dev";

export type Standing = "checking" | "not-installed" | "no-access" | "not-running" | "update-antitheft" | "update-extension" | "paused" | "protected";

/** The editor API this extension speaks, sent on hello. antitheft answers 426 when it no longer serves it. */
export const IDE_API = 1;
/** The oldest antitheft editor API this extension can use. An answer with no `api` is 1. */
export const MIN_DAEMON_API = 1;

/** Pure: what a hello's answer means. `null` = connected; otherwise the standing to show (the guard stays off).
 *  A 404 with none of antitheft's own error codes is a route that does not exist: an antitheft from before the
 *  editor API. Anything else that fails reads as not running, as before. */
export function helloStanding(status: number | null, body: { api?: unknown; code?: unknown } | null): Standing | null {
  if (status === null) return "not-running";
  if (status === 426 || body?.code === "extension_outdated") return "update-extension";
  if (status === 404 && typeof body?.code !== "string") return "update-antitheft";
  if (status < 200 || status >= 300) return "not-running";
  const api = typeof body?.api === "number" ? body.api : 1;
  return api < MIN_DAEMON_API ? "update-antitheft" : null;
}

export interface Protection {
  standing: Standing;
  /** antitheft blocks at the operating-system level here (Linux BPF LSM, macOS auditing, Windows). */
  systemLevel: boolean;
  /** `user` or `license` while paused. */
  pausedBy?: string | null;
  version?: string | null;
}

export interface StatusBody {
  enforcement_paused?: boolean;
  enforcement_paused_source?: string | null;
  paused_source?: string | null;
  protection_source_active?: boolean;
  version?: string;
  agent_version?: string;
}

/** Pure: the standing from what the socket answered, whether the service is registered, and whether its socket is
 *  there but refuses this process. */
export function standingOf(status: StatusBody | null, registered: boolean, pausedIsProtected = false, refused = false): Protection {
  if (!status) return { standing: refused ? "no-access" : registered ? "not-running" : "not-installed", systemLevel: false };
  const paused = !!status.enforcement_paused && !pausedIsProtected;
  return {
    standing: paused ? "paused" : "protected",
    systemLevel: status.protection_source_active !== false,
    pausedBy: paused ? status.enforcement_paused_source ?? status.paused_source ?? "user" : null,
    version: status.version ?? status.agent_version ?? null,
  };
}

const LINUX_UNITS = ["/etc/systemd/system/antitheftd.service", "/lib/systemd/system/antitheftd.service", "/usr/lib/systemd/system/antitheftd.service"];
const MAC_PLIST = "/Library/LaunchDaemons/com.antitheft.antitheftd.plist";

/** Is antitheft's service registered with the system? */
export function serviceRegistered(): Promise<boolean> {
  if (dev.assumeService()) return Promise.resolve(true);
  if (process.platform === "linux") return Promise.resolve(LINUX_UNITS.some((f) => fs.existsSync(f)));
  if (process.platform === "darwin") return Promise.resolve(fs.existsSync(MAC_PLIST));
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      cp.execFile("reg.exe", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Services\\antitheftd"], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
    });
  }
  return Promise.resolve(false);
}

/** The socket file is there but this process may not use it (Unix: `access(2)` checks this process's own groups,
 *  so it tells "not in the group yet" from "nothing listening"). Never true on Windows (a named pipe). */
export function socketRefused(path = socketPath()): boolean {
  if (process.platform === "win32") return false;
  try {
    fs.accessSync(path, fs.constants.R_OK | fs.constants.W_OK);
    return false;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM";
  }
}

export async function readProtection(): Promise<Protection> {
  const a = await request<StatusBody>("GET", "/api/v1/status", undefined, 3000);
  const status = a && a.status === 200 && a.body && typeof a.body === "object" ? a.body : null;
  const registered = status ? true : await serviceRegistered();
  return standingOf(status, registered, dev.pausedIsProtected(), !status && registered && socketRefused());
}
