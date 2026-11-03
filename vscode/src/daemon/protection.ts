// Is antitheft here, and is it protecting? Everything this extension does waits for "protected".
//
//   not-installed   no antitheft service on this computer
//   not-running     installed, but its service does not answer
//   paused          the owner (or the licence) paused protection: nothing is enforced, the guard stays off
//   protected       everything on
//
// "Installed" comes from the service registration, "running" from the socket answering, so a stopped
// service never reads as "not installed".

import * as fs from "fs";
import * as cp from "child_process";
import { request } from "./client";
import { dev } from "../dev";

export type Standing = "checking" | "not-installed" | "not-running" | "paused" | "protected";

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

/** Pure: the standing from what the socket answered and whether the service is registered. */
export function standingOf(status: StatusBody | null, registered: boolean, pausedIsProtected = false): Protection {
  if (!status) return { standing: registered ? "not-running" : "not-installed", systemLevel: false };
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

export async function readProtection(): Promise<Protection> {
  const a = await request<StatusBody>("GET", "/api/v1/status", undefined, 3000);
  const status = a && a.status === 200 && a.body && typeof a.body === "object" ? a.body : null;
  const registered = status ? true : await serviceRegistered();
  return standingOf(status, registered, dev.pausedIsProtected());
}
