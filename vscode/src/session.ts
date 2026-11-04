// One editor window's connection to antitheft: checks the standing, and once protected says hello, arms
// the guard, runs the self-check, sends the heartbeat and the guard's reports, and follows antitheft's
// alert stream so the screens update when something happens. It connects when antitheft protects or is
// paused; paused, the screens and controls work and the guard refuses nothing.

import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BroadcastChannel } from "worker_threads";
import { request, stream, socketPath, type StreamHandle } from "./daemon/client";
import { helloStanding, IDE_API, readProtection, type Protection } from "./daemon/protection";
import { Matcher, NO_PREFIXES, type Prefixes } from "./guard/matcher";
import { CulpritFinder, type ExtensionRoot } from "./guard/culprit";
import { installGuard, type GuardEvent, type Installed } from "./guard/core";
import { CHANNEL, type GuardState } from "./guard/state";
import { runSelfCheck, type Hooks } from "./selfcheck";
import type { AlertEntry, IdeEvent, VaultsAnswer } from "./model";
import { programOf } from "./commandLine";
import { appIsRunning, launchApp } from "./daemon/launch";

const WINDOWS = process.platform === "win32";
const MAX_QUEUE = 256;
/** The vault list is re-read on an alert or a change of standing, at most this often. */
const VAULTS_EVERY_MS = 20_000;

interface Hello {
  ide_id: string;
  heartbeat_secs: number;
  prefixes: Prefixes;
}

interface EventsAnswer {
  events: IdeEvent[];
  last_seq: number;
  alerts: AlertEntry[];
}

export class Session implements vscode.Disposable {
  protection: Protection = { standing: "checking", systemLevel: false };
  ideId: string | null = null;
  installed: Installed | null = null;
  hooks: Hooks = {};
  events: IdeEvent[] = [];
  alerts: AlertEntry[] = [];
  /** The computer's vaults as antitheft lists them (names and states, never a path). */
  vaultList: VaultsAnswer | null = null;
  private vaultsReadAt = 0;
  private vaultsTimer: NodeJS.Timeout | null = null;

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly blockedEmitter = new vscode.EventEmitter<GuardEvent>();
  /** A read the guard refused (not the self-check's). */
  readonly onBlocked = this.blockedEmitter.event;

  private matcher = new Matcher(NO_PREFIXES, WINDOWS);
  private finder: CulpritFinder;
  private queue: (GuardEvent & { quiet?: boolean })[] = [];
  private readonly lastLaunch = new Map<string, number>();
  /** Extensions whose icon this connection has sent (cleared on every hello: a restarted daemon has none). */
  private readonly iconSent = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private retryDelay = 2000;
  private alertStream: StreamHandle | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private channel: BroadcastChannel | null = null;
  private disposables: vscode.Disposable[] = [];
  private lastSeq = 0;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly guardFile: string) {
    this.finder = new CulpritFinder(this.roots(), context.extension.id, WINDOWS);
    this.disposables.push(vscode.extensions.onDidChange(() => this.finder.setRoots(this.roots())), this.changed, this.blockedEmitter);
  }

  get ownId(): string {
    return this.context.extension.id;
  }

  /** Every extension's folder, for naming the one behind a call. */
  roots(): ExtensionRoot[] {
    const appRoot = vscode.env.appRoot;
    return vscode.extensions.all.map((e) => ({
      path: e.extensionPath,
      id: e.id,
      builtin: e.packageJSON?.isBuiltin === true || e.extensionPath.startsWith(appRoot),
    }));
  }

  async start(): Promise<void> {
    this.watchSocket();
    await this.recheck();
  }

  /** Read the standing again and move to it. */
  async recheck(): Promise<void> {
    if (this.disposed) return;
    const before = this.protection;
    this.protection = await readProtection();
    const reachable = this.protection.standing === "protected" || this.protection.standing === "paused";
    if (reachable) {
      // Paused is connected too: the screens, the alerts and the extension controls work, and a resume or a licence
      // arriving comes in on the alerts stream (`event: protection`), no polling. Only the guard refuses nothing.
      if (!this.ideId) await this.connect();
      else this.applyStanding();
      if (before.standing === "paused" && this.protection.standing === "protected") await this.reloadVaults();
    } else {
      this.disconnect();
      this.scheduleRetry();
    }
    // the reason counts too: paused by the licence and paused by the owner read differently
    if (before.standing !== this.protection.standing || before.pausedBy !== this.protection.pausedBy) this.changed.fire();
  }

  /** The vaults antitheft last named, kept while paused so a resume needs no new hello. */
  private vaults: Prefixes = NO_PREFIXES;

  /** The guard refuses vaults only while antitheft protects; paused, it knows none. */
  private applyStanding(): void {
    this.matcher.update(this.protection.standing === "protected" ? this.vaults : NO_PREFIXES);
  }

  /** Ask antitheft for the vaults again (a resume, or a heartbeat naming a newer set). */
  private async reloadVaults(): Promise<void> {
    if (!this.ideId) return;
    const p = await request<Prefixes>("GET", `/api/v1/ide/vault-prefixes?ide_id=${encodeURIComponent(this.ideId)}`);
    if (p?.status === 200 && p.body?.salt) this.vaults = p.body;
    this.applyStanding();
  }

  private async connect(): Promise<void> {
    const a = await request<Hello & { api?: number; code?: string }>("POST", "/api/v1/ide/hello", {
      app: vscode.env.appName,
      app_version: vscode.version,
      extension_version: String(this.context.extension.packageJSON?.version ?? ""),
      api: IDE_API,
    });
    // an antitheft older or newer than this extension can speak is a step left, never "not running"
    const left = helloStanding(a?.status ?? null, a?.body && typeof a.body === "object" ? a.body : null);
    if (left || !a) {
      this.protection = { ...this.protection, standing: left ?? "not-running" };
      this.scheduleRetry();
      return;
    }
    const hello = a.body;
    this.ideId = hello.ide_id;
    this.iconSent.clear();
    this.retryDelay = 2000;
    this.vaults = hello.prefixes;
    this.applyStanding();
    this.armGuard();
    this.hooks = await runSelfCheck(this.context, this.matcher, this.installed);
    await this.sendHeartbeat();
    this.heartbeat = setInterval(() => void this.sendHeartbeat(), Math.max(15, hello.heartbeat_secs) * 1000);
    this.followAlerts();
    await this.refresh();
  }

  private disconnect(): void {
    // The hooks stay (they cannot be taken out of a running process); with no vaults known they refuse nothing.
    this.matcher.update(NO_PREFIXES);
    this.ideId = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.alertStream?.close();
    this.alertStream = null;
  }

  /** What a worker or a Node child needs to run its own guard. */
  childState(creator: { id: string; builtin: boolean } | null): string {
    const s: GuardState = {
      prefixes: this.matcher.prefixes,
      windows: WINDOWS,
      decoys: this.matcher.decoyPaths,
      roots: this.finder.allRoots,
      ownId: this.ownId,
      home: os.homedir(),
      ideId: this.ideId ?? undefined,
      socket: socketPath(),
      creator,
    };
    return JSON.stringify(s);
  }

  private armGuard(): void {
    if (this.installed) return;
    this.installed = installGuard({
      matcher: this.matcher,
      culprit: (stack) => this.finder.fromStack(stack),
      report: (e) => this.onGuardEvent(e),
      guardFile: this.guardFile,
      childState: (creator) => this.childState(creator),
      home: os.homedir(),
      adopt: (file, by) => this.finder.adopt(file, by),
      owned: (file) => this.finder.extensionOf(file) !== null || isUnder(file, vscode.env.appRoot),
    });
    // workers report here (their guard cannot reach the editor's API)
    try {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (m: unknown) => {
        const e = (m as { data?: GuardEvent }).data;
        if (e && typeof e === "object" && typeof e.kind === "string") this.onGuardEvent(e);
      };
      (this.channel as unknown as { unref?: () => void }).unref?.();
    } catch {
      this.channel = null;
    }
  }

  private onGuardEvent(e: GuardEvent): void {
    if (e.decoy) return;
    // Every launch is reported, so antitheft names each process's alerts. The same program launched again by the same
    // extension within a minute (GitLens runs git all day) goes as a quiet repeat: named, never listed again.
    let quiet = false;
    if (e.kind === "spawn") {
      const program = programOf(e.command);
      const key = `${e.extensionId}\u0000${program}`;
      const now = Date.now();
      quiet = now - (this.lastLaunch.get(key) ?? 0) < 60_000;
      if (!quiet) {
        if (this.lastLaunch.size > 2000) this.lastLaunch.clear();
        this.lastLaunch.set(key, now);
      }
    }
    if (this.queue.length < MAX_QUEUE) this.queue.push({ ...e, quiet });
    if (e.kind === "blocked") this.blockedEmitter.fire(e);
    // at once, not on a timer: the program it started is caught while it runs (`cat` lives a millisecond), and its
    // alert should name the extension the moment it pops up
    if (!this.flushTimer) this.flushTimer = setTimeout(() => void this.flush(), 0);
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    if (!this.ideId || !this.queue.length) return;
    // each item names the extension as its manifest does and, once per connection, carries its icon: antitheft's
    // alerts (the app's popup and Alerts page) name the extension with them
    const items = this.queue.splice(0, 64).map((e) => {
      const own = extensionCard(e.extensionId, !this.iconSent.has(e.extensionId));
      if (own.icon) this.iconSent.add(e.extensionId);
      return { kind: e.kind, extension_id: e.extensionId, op: e.op, path: e.path, pid: e.pid, command: e.command, extension_name: own.name, extension_icon: own.icon, quiet: e.quiet || undefined };
    });
    await request("POST", "/api/v1/ide/report", { ide_id: this.ideId, items });
    // more than one report's worth came at once: the rest right after
    if (this.queue.length) this.flushTimer = setTimeout(() => void this.flush(), 0);
    else this.scheduleRefresh();
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.ideId) return;
    const a = await request<{ rev?: string; protection?: { paused?: boolean } }>("POST", "/api/v1/ide/health", {
      ide_id: this.ideId,
      hooks: this.hooks,
      extension_version: String(this.context.extension.packageJSON?.version ?? ""),
    });
    if (!a || a.status === 404 || a.status === 403) {
      // antitheft restarted (it forgot this editor) or went away: start over
      this.disconnect();
      await this.recheck();
      return;
    }
    if (a.body?.rev && a.body.rev !== this.vaults.rev) await this.reloadVaults();
    if (a.body?.protection?.paused !== undefined && (a.body.protection.paused ? "paused" : "protected") !== this.protection.standing) await this.recheck();
  }

  private followAlerts(): void {
    this.alertStream?.close();
    this.alertStream = stream(
      "/api/v1/alerts/stream",
      (name) => {
        if (name === "alert" || name === "resync") this.scheduleRefresh();
        // paused, resumed, or the licence came or went
        if (name === "protection" || name === "resync") {
          void this.recheck();
          this.scheduleVaults();
        }
      },
      () => {
        this.alertStream = null;
        if (this.disposed || !this.ideId) return;
        setTimeout(() => void this.recheck().then(() => this.ideId && this.followAlerts()), 3000);
      },
    );
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 500);
  }

  /** Re-read this editor's events and alerts. */
  async refresh(): Promise<void> {
    if (!this.ideId) return;
    const a = await request<EventsAnswer>("GET", `/api/v1/ide/events?ide_id=${encodeURIComponent(this.ideId)}&since=0`);
    if (!a || a.status !== 200 || !a.body) return;
    this.events = a.body.events ?? [];
    this.alerts = a.body.alerts ?? [];
    this.lastSeq = a.body.last_seq ?? this.lastSeq;
    this.changed.fire();
    this.scheduleVaults();
  }

  /** Re-read the vault list soon: at once the first time, then at most every VAULTS_EVERY_MS. */
  scheduleVaults(): void {
    if (this.vaultsTimer || !this.ideId) return;
    const wait = Math.max(0, this.vaultsReadAt + VAULTS_EVERY_MS - Date.now());
    this.vaultsTimer = setTimeout(() => {
      this.vaultsTimer = null;
      void this.readVaults();
    }, wait);
  }

  private async readVaults(): Promise<void> {
    if (!this.ideId) return;
    this.vaultsReadAt = Date.now();
    const a = await request<VaultsAnswer>("GET", `/api/v1/ide/vaults?ide_id=${encodeURIComponent(this.ideId)}`, undefined, 15000);
    // an older antitheft has no such route: the screens leave the vaults out
    if (!a || a.status !== 200 || !Array.isArray(a.body?.vaults)) return;
    this.vaultList = a.body;
    this.changed.fire();
  }

  /** Bring the antitheft app forward on one of its pages: through antitheft's service when connected (the running app
   *  hears it), else by starting the installed app on that page (not connected yet, protection paused, or the
   *  service answered something else). False only when neither worked. */
  async openApp(route: string): Promise<boolean> {
    if (this.ideId) {
      const a = await request("POST", "/api/v1/ide/open-app", { ide_id: this.ideId, route });
      if (a && a.status === 200 && this.appListening()) return true;
    }
    return launchApp(route);
  }

  /** Whether a running antitheft app is there to hear `open-app`: a copy of it is among this user's processes. A
   *  service answering 200 with no app running would otherwise open nothing. */
  private appListening(): boolean {
    return appIsRunning();
  }

  private scheduleRetry(): void {
    if (this.retry || this.disposed) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.recheck();
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 60000);
  }

  /** The socket's folder changing (antitheft started or stopped) is a reason to look again, at once. */
  private watchSocket(): void {
    if (WINDOWS) return;
    const dir = path.dirname(socketPath());
    try {
      this.watcher = fs.watch(dir, () => {
        this.retryDelay = 2000;
        if (this.retry) clearTimeout(this.retry);
        this.retry = null;
        setTimeout(() => void this.recheck(), 300);
      });
    } catch {
      this.watcher = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    for (const t of [this.flushTimer, this.retry, this.refreshTimer, this.vaultsTimer]) if (t) clearTimeout(t);
    this.watcher?.close();
    this.channel?.close();
    for (const d of this.disposables) d.dispose();
  }
}

/** A file inside a folder (case-insensitive on Windows). */
function isUnder(file: string, dir: string): boolean {
  if (!dir) return false;
  const win = process.platform === "win32";
  const f = path.resolve(file);
  const d = path.resolve(dir) + path.sep;
  return win ? f.toLowerCase().startsWith(d.toLowerCase()) : f.startsWith(d);
}

/** An extension as antitheft's alerts name it: its manifest's display name and, when asked, its icon (the file its
 *  manifest names, PNG/SVG/JPEG, at most 96 KB) as `{content_type, data_base64}`. */
function extensionCard(id: string, withIcon: boolean): { name?: string; icon?: { content_type: string; data_base64: string } } {
  const ext = vscode.extensions.getExtension(id);
  const pj = (ext?.packageJSON ?? {}) as { displayName?: unknown; name?: unknown; icon?: unknown };
  const raw = typeof pj.displayName === "string" && !pj.displayName.startsWith("%") ? pj.displayName : typeof pj.name === "string" ? pj.name : undefined;
  if (!withIcon || !ext || typeof pj.icon !== "string") return { name: raw };
  const file = path.join(ext.extensionPath, pj.icon);
  const type = /\.png$/i.test(file) ? "image/png" : /\.svg$/i.test(file) ? "image/svg+xml" : /\.jpe?g$/i.test(file) ? "image/jpeg" : null;
  try {
    if (!type || !isUnder(file, ext.extensionPath)) return { name: raw };
    const bytes = fs.readFileSync(file);
    if (bytes.length > 96 * 1024) return { name: raw };
    return { name: raw, icon: { content_type: type, data_base64: bytes.toString("base64") } };
  } catch {
    return { name: raw };
  }
}
