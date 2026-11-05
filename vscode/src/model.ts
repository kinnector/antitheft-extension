// What the screens show, built from what antitheft returns (`GET /api/v1/ide/events`): the guard's own
// events in this editor and antitheft's alerts whose process chain runs through it. Pure, no editor API,
// so it is tested on its own. Words follow the antitheft app: "<who> tried to read your <what>", then
// what happened. No detection internals (how something was found, scores, rules).

import { programOf } from "./commandLine";

export interface VaultName {
  id: string;
  name: string;
  category: string;
}

export interface IdeEvent {
  seq: number;
  at: number;
  ide_id: string;
  kind: "blocked" | "spawn" | "write" | "guard_partial" | "guard_lost" | string;
  extension_id?: string | null;
  op?: string | null;
  vault?: VaultName | null;
  path?: string | null;
  command?: string | null;
  pid?: number | null;
}

export interface ProcessSnapshot {
  pid: number;
  image_path?: string;
  app?: string | null;
  title_id?: string | null;
  /** the corpus's role for it: terminal, shell, agent, remote, init */
  role?: string | null;
}

export interface AlertEntry {
  id: number;
  category: string;
  first_seen_unix: number;
  last_seen_unix: number;
  paused: boolean;
  count: number;
  kind: string;
  /** marked reviewed in antitheft (here, or in the app): no longer needs you */
  reviewed?: boolean;
  data: Record<string, unknown> & {
    verdict?: string;
    app_name?: string;
    resource_id?: string;
    data_category?: string;
    access_response?: string | null;
    actor_process?: ProcessSnapshot | null;
    actor_chain?: ProcessSnapshot[];
    process_image_path?: string | null;
  };
  extension_id?: string;
}

export interface ExtInfo {
  id: string;
  name: string;
  publisher: string;
  version: string;
  builtin: boolean;
  icon?: string | null;
}

export type Tone = "critical" | "warning" | "info" | "quiet";
/** The app's three severities (`ui/src/lib/alertHistory.ts`): Critical, Warning, Blocked (a block is the good outcome). */
export type Severity = "critical" | "warning" | "blocked";
export const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", warning: "Warning", blocked: "Blocked" };

export interface FeedItem {
  key: string;
  at: number;
  tone: Tone;
  /** BLOCKED, STOPPED, HELD, WOULD BE BLOCKED, STARTED, WROTE */
  label: string;
  title: string;
  detail: string;
  extensionId?: string;
  extensionName?: string;
  vault?: { id: string; name: string } | null;
  /** The program, for an alert about a separate process. */
  program?: { name: string; image?: string; titleId?: string | null } | null;
  /** Who started it, root first ("Visual Studio Code", "solidity-snippets-pro", "node-update"). */
  chain?: string[];
  alertId?: number;
  /** An alert's severity, as the app shows it. */
  severity?: Severity;
  /** What it was about, short (a file's name, a vault): the app's target line. */
  target?: string;
  /** Who did it, as the app's actor line: "Claude Code › rm", "solidity-snippets-pro › node-update". */
  actorLine?: string;
  /** Shown under "Needs you": something tried to read a vault. */
  needsYou: boolean;
  count?: number;
}

const CATEGORY_WORDS: Record<string, string> = {
  passwords: "saved passwords",
  cookies: "cookies",
  wallet: "wallet",
  wallet_keys: "wallet",
  seed: "wallet",
  keys: "keys",
  ssh_key: "SSH key",
  ssh_material: "SSH keys",
  totp: "2FA codes",
  otp: "2FA codes",
  messages: "messages",
  history: "history",
  keychain: "keychain",
  credentials: "credentials",
  dev_credential: "credentials",
};

/** "your MetaMask wallet", "your Google Chrome saved passwords", "your Signal". */
export function vaultPhrase(name: string, category?: string | null): string {
  const c = (category ?? "").toLowerCase();
  const word = CATEGORY_WORDS[c] ?? (c.includes("wallet") ? "wallet" : c.includes("password") ? "saved passwords" : c.includes("ssh") ? "SSH keys" : "");
  if (!word || name.toLowerCase().endsWith(word.toLowerCase())) return `your ${name}`;
  return `your ${name} ${word}`;
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function programName(p?: ProcessSnapshot | null, image?: string | null): string {
  if (p?.app) return p.app;
  const img = p?.image_path ?? image;
  return img ? basename(img) : "a program";
}

/** The name an extension is shown by: its display name, else its id. */
export function extensionLabel(id: string | null | undefined, exts: Map<string, ExtInfo>): string {
  if (!id || id === "unknown") return "An unknown extension";
  return exts.get(id.toLowerCase())?.name ?? id;
}

const PASSTHROUGH = new Set(["sudo", "doas", "timeout", "env", "nohup", "setsid", "xargs", "nice", "ionice", "stdbuf", "systemd", "init"]);

/** The app's actor line (`ui/src/lib/alertTitles.ts` `originLine`): the first launcher above the actor that is not a
 *  shell, init or a pass-through (sudo, timeout), then the actor. "Claude Code › rm", or just "rm". */
export function actorLine(chain: ProcessSnapshot[] | undefined, actor: string): string {
  const p = launcherOf(chain, actor);
  return p ? `${p.role === "terminal" ? "Terminal" : programName(p)} › ${actor}` : actor;
}

/** The launcher `actorLine` names: the first process above the actor that is not a shell, init or a pass-through. */
function launcherOf(chain: ProcessSnapshot[] | undefined, actor: string): ProcessSnapshot | null {
  for (const p of chain ?? []) {
    const name = programName(p);
    if (p.role === "shell" || p.role === "init" || name === actor || PASSTHROUGH.has(name.toLowerCase())) continue;
    if (/^(ba|da|z|fi|k|tc|c)?sh$/i.test(name)) continue;
    return p;
  }
  return null;
}

/** Which program an alert's icon is asked for (the app's `toAlertRow`): the actor's own when the corpus knows it (or a
 *  Windows program, which always has an icon), else its launcher's. `rm` has no icon; the person knows it by "Claude Code". */
export function iconSubject(actor: ProcessSnapshot | null, image: string | undefined, chain: ProcessSnapshot[] | undefined, name: string): { image?: string; titleId?: string | null } {
  const own = { image, titleId: actor?.title_id };
  if (own.titleId || /^[a-z]:[\\/]/i.test(image ?? "")) return own;
  const launcher = launcherOf(chain, name);
  return launcher?.image_path ? { image: launcher.image_path, titleId: launcher.title_id } : own;
}

const SIGNAL_VERBS: Record<number, string> = { 2: "interrupt", 9: "kill", 15: "terminate", 18: "resume", 19: "pause" };
const humanize = (t: string) => t.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** An alert's sentence for the kinds that are not a vault read, the app's words (`alertTitles.ts` `headline`). */
function otherTitle(a: AlertEntry, actor: string): { title: string; target: string; severity: Severity } {
  const d = a.data as Record<string, unknown>;
  const text = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : "");
  const file = (k: string) => (text(k) ? basename(text(k)) : "");
  const result = (blocked: boolean) => (blocked ? (a.paused ? "would be blocked" : "blocked") : "allowed");
  const tried = (phrase: string, blocked: boolean, target = "") => ({ title: `${actor} tried to ${phrase} - ${result(blocked)}`, target, severity: (blocked && !a.paused ? "blocked" : "warning") as Severity });
  switch (a.kind) {
    case "persistence_location_changed": {
      const change = text("change");
      const f = file("path");
      const named = !!(d.writer as { image_path?: unknown } | undefined)?.image_path;
      const title = named
        ? `${actor} ${change === "appeared" ? "added" : change === "disappeared" ? "removed" : "changed"} auto-start entry ${f}`
        : change === "appeared" ? `New auto-start entry ${f}` : change === "disappeared" ? `Auto-start entry ${f} removed` : `Auto-start entry ${f} changed`;
      return { title, target: text("path"), severity: "warning" };
    }
    case "persistence_denied":
      return tried(`add ${humanize(text("location_id")).toLowerCase()}`, d.denied === true, text("path"));
    case "signal_delivery": {
      const sig = typeof d.signal === "number" ? d.signal : 0;
      const target = file("target_image_path") || "a protected app";
      const whom = d.sender_pid !== undefined && d.sender_pid === d.target_pid ? "itself" : text("sender_image_path") && text("sender_image_path") === text("target_image_path") ? `another ${target} process` : target;
      return tried(SIGNAL_VERBS[sig] ? `${SIGNAL_VERBS[sig]} ${whom}` : `send signal ${sig} to ${whom}`, d.blocked === true, text("target_image_path"));
    }
    case "ptrace_blocked": {
      const app = text("target_image_path") ? basename(text("target_image_path")) : "a protected app";
      return tried(`read ${app}'s memory`, true, text("target_image_path"));
    }
    case "mass_delete": {
      const t = text("target");
      const what = t === "/" ? "everything on this computer" : t === "/*" ? "most of this computer's files" : t.endsWith("/*") ? `most of ${t.slice(0, -2)}` : t === "/home" ? "every home folder" : t.replace(/\/+$/, "");
      const ended = d.ended === true;
      return { title: `${actor} tried to delete ${what} - ${ended ? "stopped" : a.paused ? "would be stopped" : "seen"}`, target: t, severity: ended ? "blocked" : "critical" };
    }
    case "process_injected": {
      const target = text("target_image_path") ? basename(text("target_image_path")).replace(/\.exe$/i, "") : "another program";
      const ended = d.target_ended === true || d.caller_ended === true;
      return { title: `${actor} tried to run its code inside ${target} - ${ended ? "stopped" : a.paused ? "would be stopped" : "seen"}`, target: text("target_image_path"), severity: ended ? "blocked" : "critical" };
    }
    case "self_exec_denied":
      return tried("run code from memory", true);
    case "rename_denied":
      return tried(`replace ${file("resource_path")}`, true, text("resource_path"));
    case "secret_broker_connect":
      return tried(`reach ${text("broker_name") || "the password service"}`, false, text("socket_path"));
    case "untrusted_repository_domain":
      return tried(`add a package source from ${text("domain")}`, false, text("path"));
    case "resource_change": {
      const held = text("outcome").startsWith("held");
      if (text("outcome") === "approved_tainted_owner") return { title: `${actor} changed ${file("resource_path")} - tampered app`, target: text("resource_path"), severity: "critical" };
      return held ? { title: `${actor} tried to change ${file("resource_path")} - held`, target: text("resource_path"), severity: "blocked" } : tried(`change ${file("resource_path")}`, false, text("resource_path"));
    }
    case "owner_change": {
      const held = text("outcome").startsWith("held");
      return { title: held ? `${actor} tried to change ${file("owner_path")} - held` : `${actor} changed ${file("owner_path")} - allowed`, target: text("owner_path"), severity: held ? "blocked" : "warning" };
    }
    case "revocation": {
      const reason = text("reason");
      const killed = reason.endsWith("_killed");
      const why = humanize(killed ? reason.slice(0, -"_killed".length) : reason).toLowerCase();
      const title = killed ? `${actor} was ended because ${why}` : d.enforced === false ? `${actor} was flagged because ${why}` : `${actor} ${a.paused ? "would have lost" : "lost"} its vault access because ${why}`;
      return { title, target: text("image_path"), severity: d.enforced === false ? "critical" : "blocked" };
    }
    case "package_source_changed":
      return { title: `Package source ${file("path")} changed`, target: text("path"), severity: "warning" };
    case "app_image_validation": {
      const app = text("app_name");
      const change = d.is_change === true;
      return { title: app ? (change ? `${app} changed since you trusted it` : `${app} wants to run`) : change ? "AppImage changed unexpectedly" : "New AppImage recorded", target: text("path"), severity: change ? "critical" : "warning" };
    }
    case "unverified_library":
      return { title: "Unverified library loaded into a protected app", target: text("module_path"), severity: d.revoked === true ? "blocked" : "critical" };
    case "trusted_system_tracer":
      return { title: `${actor} attached to a protected app - allowed (system tool)`, target: "", severity: "warning" };
    default:
      return { title: humanize(a.kind), target: "", severity: "warning" };
  }
}

/** One alert of antitheft's, read for the editor. */
export function alertItem(a: AlertEntry, exts: Map<string, ExtInfo>, editor: string): FeedItem | null {
  const d = a.data ?? {};
  // the actor, as each kind records it
  const writer = (d.writer ?? d.actor_process ?? null) as ProcessSnapshot | null;
  const actorImage = (d.actor_process?.image_path ?? writer?.image_path ?? d.process_image_path ?? (d as Record<string, unknown>).image_path ?? (d as Record<string, unknown>).sender_image_path ?? (d as Record<string, unknown>).tracer_image_path ?? (d as Record<string, unknown>).actor_image_path) as string | undefined;
  const actor = d.actor_process ?? null;
  const program = programName(actor, actorImage);
  const ext = a.extension_id ? extensionLabel(a.extension_id, exts) : null;
  const chain = [...(d.actor_chain ?? [])].reverse().map((p) => programName(p));
  if (ext) {
    // the editor, then the extension, then the program: the chain as the person thinks of it
    const ideAt = chain.findIndex((n) => /code|cursor|windsurf|codium|idea|pycharm|webstorm|goland|clion|rider|rustrover|phpstorm|electron/i.test(n));
    const tail = ideAt >= 0 ? chain.slice(ideAt + 1) : chain;
    chain.splice(0, chain.length, editor, ext, ...tail);
  }
  chain.push(program);
  const line = ext ? `${ext} › ${program}` : actorLine(d.actor_chain, program);
  const base = {
    key: `alert-${a.id}`,
    at: a.last_seen_unix,
    extensionId: a.extension_id,
    extensionName: ext ?? undefined,
    // name: the actor; image/titleId: what its icon is asked for (its launcher's when it has none, `iconSubject`)
    program: { name: program, ...(ext ? { image: actorImage, titleId: actor?.title_id } : iconSubject(actor, actorImage, d.actor_chain, program)) },
    chain,
    alertId: a.id,
    count: a.count,
    actorLine: line,
  };
  if (a.kind !== "storage_access") {
    const o = otherTitle(a, program);
    const tone: Tone = o.severity === "critical" ? "critical" : o.severity === "blocked" ? "critical" : "warning";
    const label = o.severity === "blocked" ? "BLOCKED" : a.paused ? "WOULD BE BLOCKED" : o.severity === "critical" ? "CRITICAL" : "WARNING";
    return { ...base, tone, label, severity: o.severity, title: o.title, target: o.target ? basename(o.target) : "", detail: "", needsYou: !a.reviewed };
  }
  let label = "BLOCKED";
  let tone: Tone = "critical";
  let severity: Severity = "blocked";
  let result = "antitheft stopped it.";
  const response = (d.access_response ?? "").toLowerCase();
  const verdict = (d.verdict ?? "").toLowerCase();
  if (a.paused) {
    label = "WOULD BE BLOCKED";
    tone = "warning";
    severity = "warning";
    result = "Protection was paused, so nothing was blocked.";
  } else if (response === "ask") {
    label = "HELD";
    tone = "warning";
    severity = "warning";
    result = "antitheft is holding it until you answer in the app.";
  } else if (response === "kill" || verdict.startsWith("denied")) {
    label = "STOPPED";
    result = response === "kill" ? "antitheft stopped the program when it reached for it." : "antitheft refused it before anything was read.";
  } else if (verdict === "allowed") {
    label = "ALLOWED";
    tone = "info";
    severity = "warning";
    result = "It was allowed.";
  }
  const what = vaultPhrase(String(d.app_name ?? "a protected app"), d.data_category as string | undefined);
  const title = ext ? `A program ${ext} started tried to read ${what}` : `${program} tried to read ${what}`;
  return {
    ...base,
    tone,
    label,
    severity,
    title,
    target: String(d.app_name ?? (d.resource_path ? basename(String(d.resource_path)) : "")),
    detail: ext ? `${program}: ${result}` : result,
    vault: d.resource_id ? { id: String(d.resource_id), name: String(d.app_name ?? d.resource_id) } : null,
    needsYou: tone !== "info" && !a.reviewed,
  };
}

/** One of the guard's events. Launches and writes are activity, not alerts. */
export function eventItem(e: IdeEvent, exts: Map<string, ExtInfo>): FeedItem | null {
  const ext = extensionLabel(e.extension_id, exts);
  const key = `event-${e.seq}`;
  switch (e.kind) {
    case "blocked": {
      const what = e.vault ? vaultPhrase(e.vault.name, e.vault.category) : "a protected file";
      return {
        key,
        at: e.at,
        tone: "critical",
        label: "BLOCKED",
        title: `${ext} tried to read ${what}`,
        detail: "Its own code asked for the file. antitheft refused it before anything was read.",
        extensionId: e.extension_id ?? undefined,
        extensionName: ext,
        vault: e.vault ? { id: e.vault.id, name: e.vault.name } : null,
        severity: "blocked",
        target: e.vault?.name ?? (e.path ? basename(e.path) : ""),
        actorLine: ext,
        needsYou: true,
      };
    }
    case "spawn": {
      const cmd = programOf(e.command) || "a program";
      return { key, at: e.at, tone: "quiet", label: "STARTED", title: `${ext} started ${cmd}`, detail: e.command ?? "", actorLine: ext, extensionId: e.extension_id ?? undefined, extensionName: ext, program: { name: cmd }, needsYou: false };
    }
    case "write": {
      const file = e.path ? basename(e.path) : "a program";
      return { key, at: e.at, tone: "quiet", label: "WROTE", title: `${ext} wrote a program: ${file}`, detail: e.path ?? "", actorLine: ext, extensionId: e.extension_id ?? undefined, extensionName: ext, needsYou: false };
    }
    // the guard's own health is not something an extension did: the standing's "Editor guard: partly" says it
    case "guard_partial":
    case "guard_lost":
      return null;
    default:
      return null;
  }
}

/** Everything, newest first. The same extension starting the same program again is one row with a count. */
export function feed(events: IdeEvent[], alerts: AlertEntry[], exts: Map<string, ExtInfo>, editor: string): FeedItem[] {
  const items: FeedItem[] = [];
  const launches = new Map<string, FeedItem>();
  for (const e of events) {
    const i = eventItem(e, exts);
    if (!i) continue;
    // the same extension starting the same program, or refused the same vault again: one row with a count
    if (i.label === "STARTED" || i.label === "BLOCKED") {
      const k = `${i.extensionId}\u0000${i.title}`;
      const prev = launches.get(k);
      if (prev) {
        prev.count = (prev.count ?? 1) + 1;
        if (i.at > prev.at) prev.at = i.at;
        continue;
      }
      launches.set(k, i);
    }
    items.push(i);
  }
  for (const a of alerts) {
    const i = alertItem(a, exts, editor);
    if (i) items.push(i);
  }
  return items.sort((x, y) => y.at - x.at || x.key.localeCompare(y.key));
}

export interface ExtRow {
  ext: ExtInfo;
  /** What it did that matters: its blocks and the alerts about programs it started. */
  attention: FeedItem[];
  /** Programs it started and wrote. */
  started: FeedItem[];
}

/** The Extensions screen: those that need attention first, then the rest (third-party before built-in). */
export function extensionRows(exts: ExtInfo[], items: FeedItem[]): { attention: ExtRow[]; quiet: ExtRow[] } {
  const by = new Map<string, ExtRow>();
  for (const ext of exts) by.set(ext.id.toLowerCase(), { ext, attention: [], started: [] });
  for (const i of items) {
    if (!i.extensionId) continue;
    const row = by.get(i.extensionId.toLowerCase());
    if (!row) continue;
    (i.needsYou ? row.attention : row.started).push(i);
  }
  const rows = [...by.values()];
  const attention = rows.filter((r) => r.attention.length).sort((a, b) => b.attention[0].at - a.attention[0].at);
  const quiet = rows
    .filter((r) => !r.attention.length && !r.ext.builtin)
    .sort((a, b) => b.started.length - a.started.length || a.ext.name.localeCompare(b.ext.name));
  return { attention, quiet };
}

/** "just now", "5 min ago", "Today 14:32", "Mon 09:12", "3 Nov". `now` in seconds. */
export function when(at: number, now: number): string {
  const s = Math.max(0, now - at);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(at * 1000);
  const n = new Date(now * 1000);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === n.toDateString()) return `Today ${hm}`;
  if (s < 6 * 86400) return `${d.toLocaleDateString("en", { weekday: "short" })} ${hm}`;
  return d.toLocaleDateString("en", { day: "numeric", month: "short" });
}

// ---- vaults (`GET /api/v1/ide/vaults`: what the app's Vaults page lists, with no path in it) ----------------

export type VaultKind = "wallets" | "passwords" | "vaults" | "secrets" | "other";
export type VaultStatus = "protected" | "partial" | "pending" | "watching" | "empty";

export interface Vault {
  id: string;
  name: string;
  vendor: string;
  category: string;
  kind: VaultKind | string;
  /** The browser a live-found extension (a wallet, an authenticator) lives in. */
  parent: string | null;
  status: VaultStatus | string;
  files: number;
  locked: number;
  /** Opens of its files over the last seven days: by programs allowed, and refused (or that would be, paused). */
  week: { allowed: number; refused: number };
}

export interface VaultsAnswer {
  vaults: Vault[];
  week: { since_ms: number };
  paused: boolean;
}

/** The app's words for a vault's state (`ui/src/lib/vaultsData.ts` `STATUS_LABEL`). */
export const STATUS_LABEL: Record<string, string> = {
  protected: "Protected",
  partial: "Partly protected",
  pending: "Needs approval",
  watching: "Observed",
  empty: "No data yet",
};

export const KIND_ORDER: VaultKind[] = ["wallets", "passwords", "vaults", "secrets", "other"];
export const KIND_LABEL: Record<VaultKind, string> = {
  wallets: "Wallets",
  passwords: "Passwords & keychains",
  vaults: "Browsers & apps",
  secrets: "Keys & developer secrets",
  other: "Other",
};

export interface VaultRow extends Vault {
  /** "MetaMask" in Brave and in Chrome: the browser's name under it. */
  where: string;
}

export interface VaultGroup {
  kind: VaultKind;
  label: string;
  vaults: VaultRow[];
  locked: number;
  observed: number;
}

export interface VaultSummary {
  groups: VaultGroup[];
  total: number;
  /** protected or partly protected: only their own apps get in */
  locked: number;
  observed: number;
  /** owners waiting for the person's approval */
  pending: number;
  allowed: number;
  refused: number;
}

const isLocked = (v: Vault) => v.status === "protected" || v.status === "partial";

/** Vaults by kind (wallets first), locked before observed, then by name; and the totals the screens count. */
export function vaultSummary(vaults: Vault[]): VaultSummary {
  const names = new Map(vaults.map((v) => [v.id, v.name]));
  const rows: VaultRow[] = vaults.map((v) => ({
    ...v,
    where: v.parent ? (names.get(v.parent) ?? v.parent) : v.vendor && v.vendor !== v.name ? v.vendor : "",
  }));
  const rank = (v: Vault) => (v.status === "protected" ? 0 : v.status === "partial" ? 1 : v.status === "pending" ? 2 : v.status === "watching" ? 3 : 4);
  const groups: VaultGroup[] = [];
  for (const kind of KIND_ORDER) {
    const mine = rows.filter((v) => (KIND_ORDER.includes(v.kind as VaultKind) ? v.kind : "other") === kind);
    if (!mine.length) continue;
    mine.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    groups.push({ kind, label: KIND_LABEL[kind], vaults: mine, locked: mine.filter(isLocked).length, observed: mine.filter((v) => !isLocked(v)).length });
  }
  // a browser's week already counts its extensions' opens (antitheft's `opens_of`), so a row inside another listed
  // row is not added again: MetaMask's refusals would count once for MetaMask and once for its browser
  const counted = vaults.filter((v) => !(v.parent && names.has(v.parent)));
  return {
    groups,
    total: vaults.length,
    locked: vaults.filter(isLocked).length,
    observed: vaults.filter((v) => !isLocked(v)).length,
    pending: vaults.filter((v) => v.status === "pending").length,
    allowed: counted.reduce((n, v) => n + (v.week?.allowed ?? 0), 0),
    refused: counted.reduce((n, v) => n + (v.week?.refused ?? 0), 0),
  };
}

/** 1234 -> "1.2k", 12 -> "12". */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
