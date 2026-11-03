// The sidebar view and the main panel (Alerts, Activity, Extensions). One webview bundle serves both; the
// extension host builds what they show (`model.ts`) and the images they need: each extension's own icon,
// antitheft's icons for vaults and programs (from the daemon, the app's own source), the editor's mark,
// and antitheft's marks. Webviews exist only while they are open.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { image, request } from "../daemon/client";
import { extensionRows, feed, vaultSummary, type ExtInfo, type FeedItem } from "../model";
import type { Session } from "../session";
import { disableExtension, uninstallExtension, showExtension } from "./extensionActions";

declare const __DEV__: boolean;

export type Screen = "alerts" | "vaults" | "activity" | "extensions";

interface Message {
  type: string;
  screen?: Screen;
  route?: string;
  id?: string;
  key?: string;
  alertId?: number;
}

/** The editor's own refusals that were marked reviewed: they have no record in antitheft to mark, so the extension
 *  remembers them (newest last, at most this many). */
const DISMISSED_KEY = "antitheft.reviewed";
const MAX_DISMISSED = 500;
/** Activity cleared up to this time (unix seconds): Activity and the sidebar's Recent leave out what came before it. */
const CLEARED_KEY = "antitheft.activityClearedAt";
/** Where "Get antitheft" leads while antitheft is not installed. */
const GET_ANTITHEFT = "https://antitheft.pro";

const IDE_ICONS: [RegExp, string][] = [
  [/cursor/i, "cursor.png"],
  [/intellij|pycharm|webstorm|goland|clion|rider|rustrover|phpstorm|jetbrains/i, "intellij.png"],
  [/code|codium/i, "vscode.png"],
];

export class Views implements vscode.Disposable, vscode.WebviewViewProvider {
  private sidebar: vscode.WebviewView | null = null;
  private panel: vscode.WebviewPanel | null = null;
  private screen: Screen = "alerts";
  private icons = new Map<string, string | null>();
  private pending = new Set<string>();
  private disposables: vscode.Disposable[] = [];
  private items: FeedItem[] = [];
  private exts = new Map<string, ExtInfo>();

  constructor(private readonly context: vscode.ExtensionContext, private readonly session: Session) {
    this.disposables.push(vscode.window.registerWebviewViewProvider("antitheft.sidebar", this, { webviewOptions: { retainContextWhenHidden: false } }));
    this.disposables.push(vscode.extensions.onDidChange(() => this.post()));
    // One antitheft panel. A tab left from an earlier session (or another extension host) comes back as that panel,
    // and any more than one are closed.
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer("antitheft.panel", {
        deserializeWebviewPanel: async (panel) => {
          if (this.panel) return panel.dispose();
          this.adopt(panel);
        },
      }),
    );
  }

  /** Everything the screens show, newest first (as of the last `post`). */
  get feedItems(): FeedItem[] {
    return this.items;
  }

  /** What needs the person's attention, for the status bar. */
  needsYou(): number {
    return this.items.filter((i) => i.needsYou).length;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.sidebar = view;
    this.setup(view.webview, "sidebar");
    view.onDidDispose(() => (this.sidebar = null));
    view.onDidChangeVisibility(() => {
      if (!view.visible) return;
      this.post();
      this.session.scheduleVaults();
    });
  }

  open(screen: Screen): void {
    this.screen = screen;
    if (screen === "vaults") this.session.scheduleVaults();
    if (this.panel) {
      this.panel.reveal();
      this.post();
      return;
    }
    this.adopt(vscode.window.createWebviewPanel("antitheft.panel", "antitheft", vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [this.mediaRoot(), this.distRoot()] }));
  }

  private adopt(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    // the tab's icon follows the theme: the mark is black, which disappears on a dark tab bar
    panel.iconPath = { light: vscode.Uri.joinPath(this.mediaRoot(), "mark-on-light.svg"), dark: vscode.Uri.joinPath(this.mediaRoot(), "mark-on-dark.svg") };
    this.setup(panel.webview, "panel");
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = null;
    });
  }

  private mediaRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, "media");
  }
  private distRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, "dist");
  }

  private setup(webview: vscode.Webview, surface: "sidebar" | "panel"): void {
    webview.options = { enableScripts: true, localResourceRoots: [this.mediaRoot(), this.distRoot()] };
    const nonce = randomBytes(16).toString("base64");
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.distRoot(), "webview.js"));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.distRoot(), "webview.css"));
    webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${css}"><title>antitheft</title></head>
<body data-surface="${surface}"><div id="root"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
    webview.onDidReceiveMessage((m: Message) => void this.handle(m), undefined, this.disposables);
  }

  private async handle(m: Message): Promise<void> {
    switch (m.type) {
      case "ready":
        this.post();
        break;
      case "screen":
        if (m.screen) this.open(m.screen);
        break;
      case "openApp": {
        const ok = await this.session.openApp(m.route ?? "/");
        if (!ok) void vscode.window.showInformationMessage("antitheft's app was not found on this computer. Start it from your applications, or install antitheft.");
        break;
      }
      case "recheck":
        await this.session.recheck();
        break;
      case "getAntitheft":
        // a fixed address, never one the webview names
        await vscode.env.openExternal(vscode.Uri.parse(GET_ANTITHEFT));
        break;
      case "disable":
        if (m.id) await disableExtension(m.id, this.exts.get(m.id.toLowerCase())?.name ?? m.id);
        break;
      case "uninstall":
        if (m.id) await uninstallExtension(m.id, this.exts.get(m.id.toLowerCase())?.name ?? m.id);
        break;
      case "review":
        await this.review(m.alertId ? [m.alertId] : [], m.key && !m.alertId ? [m.key] : []);
        break;
      case "reviewAll": {
        const open = this.items.filter((i) => i.needsYou);
        await this.review(open.flatMap((i) => (i.alertId ? [i.alertId] : [])), open.filter((i) => !i.alertId).map((i) => i.key));
        break;
      }
      case "clearActivity":
        await this.context.globalState.update(CLEARED_KEY, Math.max(Math.floor(Date.now() / 1000), ...this.items.map((i) => i.at)));
        this.post();
        break;
      case "showExtension":
        if (m.id) await showExtension(m.id);
        break;
      case "rendered":
        // development builds only: what a webview drew, for the editor integration test
        if (__DEV__ && process.env.ANTITHEFT_TEST_LOG) fs.appendFileSync(process.env.ANTITHEFT_TEST_LOG, `[rendered] ${JSON.stringify(m)}\n`);
        break;
    }
  }

  /** Mark alerts reviewed in antitheft (the app sees it too) and the editor's own refusals here, then redraw. */
  private async review(alertIds: number[], keys: string[]): Promise<void> {
    if (keys.length) {
      const kept = (this.context.globalState.get<string[]>(DISMISSED_KEY) ?? []).filter((k) => !keys.includes(k));
      await this.context.globalState.update(DISMISSED_KEY, [...kept, ...keys].slice(-MAX_DISMISSED));
    }
    if (alertIds.length === 1) await request("POST", `/api/v1/alerts/${alertIds[0]}/reviewed`);
    else if (alertIds.length) await request("POST", "/api/v1/alerts/reviewed", { ids: alertIds });
    if (alertIds.length) await this.session.refresh();
    this.post();
  }

  /** Rebuild what the screens show and send it to every open webview. */
  post(): void {
    this.exts = new Map(
      vscode.extensions.all.map((e) => {
        const pj = e.packageJSON ?? {};
        const info: ExtInfo = {
          id: e.id,
          name: String(pj.displayName || pj.name || e.id),
          publisher: String(pj.publisher ?? ""),
          version: String(pj.version ?? ""),
          builtin: pj.isBuiltin === true || e.extensionPath.startsWith(vscode.env.appRoot),
          icon: null,
        };
        return [e.id.toLowerCase(), info];
      }),
    );
    const dismissed = new Set(this.context.globalState.get<string[]>(DISMISSED_KEY) ?? []);
    this.items = feed(this.session.events, this.session.alerts, this.exts, vscode.env.appName).map((i) => (i.needsYou && !i.alertId && dismissed.has(i.key) ? { ...i, needsYou: false } : i));
    const rows = extensionRows([...this.exts.values()].filter((e) => e.id !== this.session.ownId), this.items);
    const wanted: string[] = [];
    const icon = (key: string): string | null => {
      if (this.icons.has(key)) return this.icons.get(key) ?? null;
      wanted.push(key);
      return null;
    };
    // what was cleared stays out of Activity and Recent; what still needs you stays until it is reviewed
    const clearedAt = this.context.globalState.get<number>(CLEARED_KEY) ?? 0;
    const items = this.items.filter((i) => i.needsYou || i.at > clearedAt).map((i) => ({
      ...i,
      extIcon: i.extensionId ? icon(`ext:${i.extensionId.toLowerCase()}`) : null,
      vaultIcon: i.vault ? icon(`vault:${i.vault.id}|`) : null,
      programIcon: i.program?.image ? icon(`actor:${i.program.image}|${i.program.titleId ?? ""}`) : null,
    }));
    const row = (r: (typeof rows.attention)[number]) => ({ ...r, ext: { ...r.ext, icon: icon(`ext:${r.ext.id.toLowerCase()}`) } });
    const list = this.session.vaultList;
    const summary = list ? vaultSummary(list.vaults) : null;
    const vaults = summary
      ? { ...summary, paused: list!.paused, groups: summary.groups.map((g) => ({ ...g, vaults: g.vaults.map((v) => ({ ...v, icon: icon(`vault:${v.id}|${v.category}`) })) })) }
      : null;
    const payload = {
      type: "state",
      screen: this.screen,
      protection: this.session.protection,
      hooks: this.session.hooks,
      items,
      extensions: { attention: rows.attention.map(row), quiet: rows.quiet.map(row) },
      vaults,
      editor: vscode.env.appName,
      now: Math.floor(Date.now() / 1000),
    };
    if (this.sidebar) void this.sidebar.webview.postMessage({ ...payload, surface: "sidebar", media: this.mediaFor(this.sidebar.webview) });
    if (this.panel) void this.panel.webview.postMessage({ ...payload, surface: "panel", media: this.mediaFor(this.panel.webview) });
    if (wanted.length) void this.loadIcons(wanted);
  }

  private mediaFor(webview: vscode.Webview): Record<string, string> {
    const u = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot(), f)).toString();
    const ideIcon = IDE_ICONS.find(([re]) => re.test(vscode.env.appName))?.[1] ?? "vscode.png";
    return {
      logo: u("logo.svg"),
      mark: u("mark.svg"),
      protected: u("state-protected.svg"),
      paused: u("state-paused-dark.svg"),
      pausedLight: u("state-paused-light.svg"),
      alert: u("state-alert-dark.svg"),
      alertLight: u("state-alert-light.svg"),
      offline: u("state-offline.svg"),
      ide: u(`apps/${ideIcon}`),
      claude: u("apps/claude.png"),
      codex: u("apps/codex.png"),
      // a real antitheft alert, pictured on the screen shown before antitheft is installed
      alertExample: u("alert-example.webp"),
    };
  }

  /** Icons nobody has asked for yet: an extension's own, antitheft's for a vault or a program. */
  private async loadIcons(keys: string[]): Promise<void> {
    const todo = keys.filter((k) => !this.pending.has(k));
    if (!todo.length) return;
    todo.forEach((k) => this.pending.add(k));
    await Promise.all(
      todo.map(async (k) => {
        let v: string | null = null;
        if (k.startsWith("ext:")) v = extensionIcon(k.slice(4));
        else if (k.startsWith("vault:")) v = await vaultIcon(k.slice(6));
        else if (k.startsWith("actor:")) {
          const [img, title] = k.slice(6).split("|");
          v = await image(`/api/v1/icon/actor?image=${encodeURIComponent(img)}${title ? `&title=${encodeURIComponent(title)}` : ""}`);
        }
        this.icons.set(k, v);
        this.pending.delete(k);
      }),
    );
    this.post();
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** A vault's icon as the app finds it (`ActorIcon`): the vault's own (a browser's, an extension's), else its app's
 *  brand mark, else its category's. `key` is `id|category`. */
async function vaultIcon(key: string): Promise<string | null> {
  const bar = key.lastIndexOf("|");
  const id = bar < 0 ? key : key.slice(0, bar);
  const category = bar < 0 ? "" : key.slice(bar + 1);
  return (
    (await image(`/api/v1/icon/${encodeURIComponent(id)}`)) ??
    (id.includes(":") ? null : await image(`/api/v1/icon/actor?title=${encodeURIComponent(id)}`)) ??
    (category ? await image(`/api/v1/icon/category/${encodeURIComponent(category)}`) : null)
  );
}

/** An installed extension's own icon (its package.json `icon`), as a data: URL. */
function extensionIcon(id: string): string | null {
  const e = vscode.extensions.all.find((x) => x.id.toLowerCase() === id);
  const rel = e?.packageJSON?.icon;
  if (!e || typeof rel !== "string") return null;
  const file = path.join(e.extensionPath, rel);
  const type = /\.svg$/i.test(file) ? "image/svg+xml" : /\.jpe?g$/i.test(file) ? "image/jpeg" : "image/png";
  try {
    const st = fs.statSync(file);
    if (st.size > 256 * 1024) return null;
    return `data:${type};base64,${fs.readFileSync(file).toString("base64")}`;
  } catch {
    return null;
  }
}
