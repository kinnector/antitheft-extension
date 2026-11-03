// The sidebar and the panel's screens. Rendered with DOM calls only (never innerHTML): extension names and
// descriptions come from other extensions' manifests and are untrusted. Colours are the editor's theme;
// antitheft's own marks and the apps' real icons are the graphics.

export {};

interface VsCodeApi {
  postMessage(m: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const api = acquireVsCodeApi();

type Screen = "alerts" | "vaults" | "activity" | "extensions";

interface Item {
  key: string;
  at: number;
  tone: "critical" | "warning" | "info" | "quiet";
  label: string;
  title: string;
  detail: string;
  extensionId?: string;
  extensionName?: string;
  vault?: { id: string; name: string } | null;
  program?: { name: string } | null;
  chain?: string[];
  alertId?: number;
  needsYou: boolean;
  count?: number;
  severity?: "critical" | "warning" | "blocked";
  target?: string;
  actorLine?: string;
  extIcon?: string | null;
  vaultIcon?: string | null;
  programIcon?: string | null;
}

interface Ext {
  id: string;
  name: string;
  publisher: string;
  version: string;
  builtin: boolean;
  icon?: string | null;
}

interface ExtRow {
  ext: Ext;
  attention: Item[];
  started: Item[];
}

interface VaultView {
  id: string;
  name: string;
  where: string;
  status: string;
  files: number;
  locked: number;
  week: { allowed: number; refused: number };
  icon?: string | null;
}

interface VaultGroupView {
  kind: string;
  label: string;
  vaults: VaultView[];
  locked: number;
  observed: number;
}

interface VaultsView {
  groups: VaultGroupView[];
  total: number;
  locked: number;
  observed: number;
  pending: number;
  allowed: number;
  refused: number;
  paused: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  protected: "Protected",
  partial: "Partly protected",
  pending: "Needs approval",
  watching: "Observed",
  empty: "No data yet",
};

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

interface State {
  surface: "sidebar" | "panel";
  screen: Screen;
  protection: { standing: string; systemLevel: boolean; pausedBy?: string | null; version?: string | null };
  hooks: Record<string, string>;
  items: Item[];
  extensions: { attention: ExtRow[]; quiet: ExtRow[] };
  vaults: VaultsView | null;
  editor: string;
  media: Record<string, string>;
  now: number;
}

let state: State | null = null;
let screen: Screen | null = null;
let showAllQuiet = false;
const root = document.getElementById("root")!;
const surface = document.body.dataset.surface ?? "panel";

window.addEventListener("message", (e: MessageEvent) => {
  const m = e.data as { type?: string } & State;
  if (m?.type !== "state") return;
  if (m.surface !== surface) return;
  state = m;
  if (surface === "panel" && (screen === null || m.screen !== lastAsked)) screen = m.screen;
  lastAsked = m.screen;
  render();
});
let lastAsked: Screen | null = null;
api.postMessage({ type: "ready" });

// ---- small DOM helpers ------------------------------------------------------------------------

type Kid = Node | string | null | undefined | false;
function h(tag: string, props: Record<string, unknown> = {}, ...kids: Kid[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const GLYPHS: Record<string, string> = {
  shield: "M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  stop: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM6.5 6.5l11 11",
  puzzle: "M10 4h4v3a1.5 1.5 0 0 0 3 0V4h3v6h-3a1.5 1.5 0 0 0 0 3h3v7h-6v-3a1.5 1.5 0 0 0-3 0v3H4v-7h3a1.5 1.5 0 0 0 0-3H4V4h6z",
  terminal: "M4 5h16v14H4zM7 9l3 3-3 3M12 15h5",
  file: "M14 3H6v18h12V7zM14 3v4h4",
  pause: "M8 5v14M16 5v14",
  check: "M5 12l4 4 10-10",
  external: "M14 4h6v6M20 4l-9 9M18 14v5H5V6h5",
};

function glyph(name: string, cls = "glyph"): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", GLYPHS[name] ?? GLYPHS.shield);
  svg.append(p);
  return svg;
}

/** A real icon when there is one, else a glyph on a tile. */
function tile(src: string | null | undefined, fallback: string, tone = ""): HTMLElement {
  if (src) return h("span", { class: `tile ${tone}` }, h("img", { src, alt: "" }));
  return h("span", { class: `tile glyph-tile ${tone}` }, glyph(fallback));
}

function when(at: number, now: number): string {
  const s = Math.max(0, now - at);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(at * 1000);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === new Date(now * 1000).toDateString()) return `Today ${hm}`;
  return `${d.toLocaleDateString("en", { day: "numeric", month: "short" })} ${hm}`;
}

function button(label: string, onclick: (e?: Event) => void, kind: "primary" | "secondary" | "link" = "secondary", icon?: string): HTMLElement {
  return h("button", { class: `btn ${kind}`, onclick }, icon ? glyph(icon, "btn-glyph") : null, label);
}

/** BLOCKED -> Blocked, WOULD BE BLOCKED -> Would be blocked: labels read in sentence case. */
function word(label: string): string {
  const l = label.toLowerCase();
  return l.charAt(0).toUpperCase() + l.slice(1);
}

type Sev = "critical" | "warning" | "blocked";
const SEV_LABEL: Record<Sev, string> = { critical: "Critical", warning: "Warning", blocked: "Blocked" };

/** The app's severity for an item: Critical, Warning, or Blocked (a block is the good outcome). */
function sevOf(i: Item): Sev | null {
  if (i.severity) return i.severity;
  if (i.label === "BLOCKED" || i.label === "STOPPED") return "blocked";
  if (i.label === "WOULD BE BLOCKED" || i.label === "HELD") return "warning";
  return i.tone === "critical" ? "critical" : i.tone === "warning" ? "warning" : null;
}

/** The app's severity label: a dot and the word. Activity that is no alert shows its own word, muted. */
function severityLabel(i: Item): HTMLElement {
  const sev = sevOf(i);
  return sev
    ? h("span", { class: `sev sev--${sev}` }, h("span", { class: `sev-dot sev-dot--${sev}` }), SEV_LABEL[sev])
    : h("span", { class: "sev sev--quiet" }, h("span", { class: "sev-dot" }), word(i.label));
}

/** A program's or an extension's own icon; with none, the app's placeholder: a dashed box with its initial. */
function actorIcon(src: string | null | undefined, name: string): HTMLElement {
  if (src) return h("img", { class: "actor-icon", src, alt: "" });
  return h("span", { class: "actor-icon actor-icon--unknown", "aria-hidden": "true" }, (name.trim()[0] ?? "?").toUpperCase());
}

const send = (m: Record<string, unknown>) => api.postMessage(m);
const openApp = (route: string) => send({ type: "openApp", route });

// ---- the standing ---------------------------------------------------------------------------

/** antitheft answers this editor: protecting, or paused (screens and controls work, the guard refuses nothing). */
function connected(s: State): boolean {
  return s.protection.standing === "protected" || s.protection.standing === "paused";
}

interface Look {
  icon: string;
  title: string;
  sub: string;
  tone: "ok" | "warn" | "bad" | "muted";
  /** what to do about it, in the antitheft app */
  action?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The standing in a word and one short line. */
function look(s: State): Look {
  const p = s.protection;
  const m = s.media;
  if (p.standing === "checking") return { icon: m.offline, title: "Checking", sub: "Looking for antitheft on this computer", tone: "muted" };
  if (p.standing === "not-installed") return { icon: m.offline, title: "Almost there", sub: "One step left: install antitheft", tone: "muted" };
  if (p.standing === "not-running") return { icon: m.offline, title: "Not running", sub: "antitheft's service is stopped", tone: "warn" };
  if (p.standing === "paused") {
    return p.pausedBy === "license"
      ? { icon: m.paused, title: "Watching only", sub: "Nothing is blocked without a licence", tone: "warn", action: "Get a licence" }
      : { icon: m.paused, title: "Paused", sub: "Nothing is blocked until you resume", tone: "warn", action: "Resume in antitheft" };
  }
  const needs = s.items.filter((i) => i.needsYou).length;
  const v = s.vaults;
  const sub = v && v.locked ? `Only their own apps can open your ${plural(v.locked, "vault")}` : "Extensions can't reach your vaults";
  if (needs) return { icon: m.alert, title: needs === 1 ? "1 alert needs you" : `${needs} alerts need you`, sub, tone: "bad" };
  return { icon: m.protected, title: "Protected", sub, tone: "ok" };
}

function mark(s: State, icon: string): HTMLElement[] {
  // the alert mark has its own red dot: a light and a dark version instead of an inverted one
  return icon === s.media.alert
    ? [h("img", { class: "only-light", src: s.media.alertLight, alt: "" }), h("img", { class: "only-dark", src: s.media.alert, alt: "" })]
    : [h("img", { class: "invertable", src: icon, alt: "" })];
}

/** Two facts under the standing: whether this extension works, and what antitheft on this computer is doing. */
function coverage(s: State): HTMLElement {
  const p = s.protection.standing;
  const partial = Object.values(s.hooks ?? {}).some((v) => v !== "ok");
  const ext: [string, string, string] = !connected(s)
    ? ["Extension waiting", "muted", "It starts guarding this editor once antitheft runs."]
    : partial
      ? ["Extension partly working", "warn", "Part of the editor guard stopped working after an editor update."]
      : ["Extension working", "ok", "An extension's own reads of your vaults are refused."];
  const at: [string, string, string] =
    p === "protected"
      ? ["antitheft installed", "ok", s.protection.systemLevel ? "Programs an extension starts are stopped too." : "This computer can't block at the system level."]
      : p === "paused"
        ? ["antitheft paused", "warn", s.protection.pausedBy === "license" ? "Watching only: no licence on this computer." : "Nothing is blocked until you resume."]
        : p === "not-running"
          ? ["antitheft not running", "warn", "antitheft is installed, but its service is stopped."]
          : p === "checking"
            ? ["antitheft starting", "muted", "Looking for antitheft on this computer."]
            : ["antitheft not found", "muted", "antitheft isn't installed on this computer."];
  const chip = ([label, tone, tip]: [string, string, string]) => h("span", { class: `cover ${tone}`, title: tip }, h("span", { class: `dot ${tone}` }), label);
  return h("div", { class: "coverage" }, chip(ext), chip(at));
}

/** The standing, as a status row: antitheft's mark (the page's only one), a word, one line, where it blocks. When
 *  alerts need you, the whole row is the way to them. */
function hero(s: State): HTMLElement {
  const l = look(s);
  const needs = connected(s) && s.items.some((i) => i.needsYou);
  const toAlerts = () => (surface === "panel" ? ((screen = "alerts"), render()) : send({ type: "screen", screen: "alerts" }));
  // a row that can be clicked as a whole, holding a button of its own: a section with a button's role, never a
  // <button> inside a <button>
  return h(
    "section",
    {
      class: `hero hero--${l.tone}${needs ? " hero--link" : ""}`,
      onclick: needs ? toAlerts : null,
      onkeydown: needs ? (e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toAlerts()) : null,
      role: needs ? "button" : null,
      tabindex: needs ? "0" : null,
      title: needs ? "Show the alerts" : null,
    },
    h(
      "div",
      { class: "hero-row" },
      h("span", { class: "hero-mark" }, ...mark(s, l.icon)),
      h("div", { class: "hero-text" }, h("div", { class: "hero-title standing-title" }, l.title), h("div", { class: "hero-sub muted" }, l.sub)),
      needs ? h("span", { class: "hero-go" }, "Show", h("span", { class: "chev" }, "›")) : null,
    ),
    // before antitheft is installed the setup steps say where things stand; the chips would only repeat it
    s.protection.standing === "not-installed" ? null : coverage(s),
    l.action ? button(l.action, (e?: Event) => (e?.stopPropagation(), openApp("/")), "link", "external") : null,
  );
}

// ---- sidebar --------------------------------------------------------------------------------

function userExtensions(s: State): ExtRow[] {
  return [...s.extensions.attention, ...s.extensions.quiet].filter((r) => !r.ext.builtin);
}

function stats(s: State): HTMLElement | null {
  const v = s.vaults;
  const exts = userExtensions(s);
  const blockedHere = s.items.filter((i) => i.label === "BLOCKED" || i.label === "STOPPED").length;
  const paused = s.protection.standing !== "protected";
  const tile = (value: string, label: string, tone = "", onclick?: () => void) =>
    h(onclick ? "button" : "div", { class: `stat ${tone}`, onclick }, h("span", { class: "stat-value" }, value), h("span", { class: "stat-label" }, label));
  return h(
    "div",
    { class: "stats" },
    v ? tile(String(v.locked), v.locked === 1 ? "vault locked" : "vaults locked", "", () => send({ type: "screen", screen: "vaults" })) : null,
    tile(String(exts.length), exts.length === 1 ? "extension watched" : "extensions watched", "", () => send({ type: "screen", screen: "extensions" })),
    v
      ? tile(compact(v.refused), paused ? "would be denied, 7d" : "denied, 7 days", v.refused ? "bad" : "", () => openApp("/activity"))
      : tile(String(blockedHere), "blocked here", blockedHere ? "bad" : "", () => send({ type: "screen", screen: "alerts" })),
  );
}

/** Up to four real icons, overlapping. */
function stack(srcs: (string | null | undefined)[], max = 4): HTMLElement {
  const real = srcs.filter((x): x is string => !!x).slice(0, max);
  return h("span", { class: "stack" }, ...real.map((src) => h("span", { class: "stack-item" }, h("img", { src, alt: "" }))));
}

function card(title: string, more: string | null, onMore: (() => void) | null, ...kids: Kid[]): HTMLElement {
  return h(
    "section",
    { class: "panel-card" },
    h("div", { class: "card-bar" }, h("span", { class: "eyebrow" }, title), more && onMore ? h("button", { class: "more-link", onclick: onMore }, more, h("span", { class: "chev" }, "›")) : null),
    ...kids,
  );
}

function vaultsCard(s: State): HTMLElement | null {
  const v = s.vaults;
  if (!v || !v.total) return null;
  const open = () => send({ type: "screen", screen: "vaults" });
  return card(
    "Your vaults",
    "See all",
    open,
    ...v.groups.map((g) =>
      h(
        "button",
        { class: "group-row", onclick: open, title: g.label },
        stack(g.vaults.map((x) => x.icon)),
        h("span", { class: "group-text" }, h("span", { class: "group-name" }, g.label), h("span", { class: "muted" }, [g.locked ? `${g.locked} protected` : "", g.observed ? `${g.observed} observed` : ""].filter(Boolean).join(" · "))),
        h("span", { class: "group-count" }, String(g.vaults.length)),
      ),
    ),
  );
}

function extensionsCard(s: State): HTMLElement {
  const exts = userExtensions(s);
  const attention = s.extensions.attention.length;
  const started = exts.filter((r) => r.started.length).length;
  const line = attention
    ? `${plural(attention, "extension")} ${attention === 1 ? "needs" : "need"} your attention`
    : started
      ? `${plural(started, "extension")} started programs. None touched your vaults.`
      : "None of them has reached for your vaults";
  return card(
    "Extensions in this editor",
    "See all",
    () => send({ type: "screen", screen: "extensions" }),
    h(
      "button",
      { class: `group-row${attention ? " bad" : ""}`, onclick: () => send({ type: "screen", screen: "extensions" }) },
      stack(exts.map((r) => r.ext.icon)),
      h("span", { class: "group-text" }, h("span", { class: "group-name" }, `${plural(exts.length, "extension")} watched`), h("span", { class: attention ? "bad" : "muted" }, line)),
    ),
  );
}

function sidebar(s: State): HTMLElement {
  if (!connected(s)) return h("div", { class: "side" }, hero(s), notProtected(s, true));
  const needs = s.items.filter((i) => i.needsYou);
  const recent = s.items.filter((i) => !i.needsYou).slice(0, 4);
  const mini = (i: Item) =>
    h(
      "div",
      { class: "mini-wrap" },
      miniRow(i),
      i.needsYou ? h("button", { class: "mini-check", title: "Mark reviewed", "aria-label": `Mark reviewed: ${i.title}`, onclick: () => send({ type: "review", key: i.key, alertId: i.alertId }) }, glyph("check")) : null,
    );
  const miniRow = (i: Item) =>
    h(
      "button",
      { class: "mini", onclick: () => send({ type: "screen", screen: i.needsYou ? "alerts" : "activity" }) },
      actorIcon(i.programIcon ?? i.extIcon, i.program?.name ?? i.extensionName ?? i.title),
      h("span", { class: "mini-text" }, h("span", { class: "mini-title" }, i.title), h("span", { class: "mini-meta" }, severityLabel(i), h("span", { class: "muted when" }, when(i.at, s.now)))),
    );
  return h(
    "div",
    { class: "side" },
    hero(s),
    stats(s),
    needs.length ? card("Needs you", needs.length > 1 ? "Mark all reviewed" : null, () => send({ type: "reviewAll" }), ...needs.slice(0, 5).map(mini)) : null,
    vaultsCard(s),
    extensionsCard(s),
    card(
      "Recent in this editor",
      recent.length ? "Clear" : null,
      () => send({ type: "clearActivity" }),
      ...(recent.length ? recent.map(mini) : [h("div", { class: "quiet-note muted" }, "Nothing has reached for your vaults from this editor")]),
    ),
    h("div", { class: "side-actions" }, button("Open antitheft", () => openApp("/"), "link", "external")),
  );
}

function notProtected(s: State, compact: boolean): HTMLElement {
  const p = s.protection.standing;
  if (p === "not-running") return h("div", { class: "explain" }, h("p", {}, "Start antitheft, and this editor is guarded again"), button("Check again", () => send({ type: "recheck" }), "secondary"));
  if (p === "checking") return h("div");
  // Not installed: a setup that is mostly done. The extension is in; antitheft is the one step left; the editor
  // switches on by itself once it runs (the socket watcher and the retry notice it, no button needed).
  const step = (state: "done" | "now" | "next", t: string, d: string, ...extra: (HTMLElement | null)[]) =>
    h(
      "li",
      { class: `step step--${state}` },
      h("span", { class: "step-mark" }, h("span", { class: `dot ${state === "done" ? "ok" : state === "now" ? "now" : "muted"}` })),
      h("div", { class: "step-text" }, h("div", { class: "step-title" }, t), h("div", { class: "muted" }, d), ...extra),
    );
  // Why it is here, then the moment it is for: a real antitheft alert, as a picture (media/alert-example.webp, the app's
  // own AlertNotification rendered by test/shots/popup for the README's demo attack), never a rebuilt one. Only what
  // antitheft LOCKS is named (the README's "What it protects"): SSH keys, .env and cloud CLI credentials are only watched.
  const why = h(
    "div",
    { class: "why" },
    h("div", { class: "why-title" }, `Why antitheft, in ${s.editor}`),
    h(
      "div",
      { class: "muted" },
      "Extensions and AI agents run with the same access you have, so any of them can read your wallets and saved passwords. antitheft locks those to their own apps and tells you which extension tried.",
    ),
  );
  const sample = s.media.alertExample
    ? h(
        "figure",
        { class: "sample" },
        h("img", { src: s.media.alertExample, alt: "An antitheft alert: a program an editor extension started tried to read Google Chrome's passwords and was stopped" }),
        h("figcaption", { class: "muted" }, "An alert from the antitheft app"),
      )
    : null;
  const also = h(
    "div",
    { class: "muted also" },
    "The same goes for browser passwords and cookies, password managers and 2FA apps, and chat and cloud logins, and for what AI agents, the terminal and package installs run.",
  );
  return h(
    "div",
    { class: compact ? "explain setup" : "explain setup wide" },
    h(
      "ol",
      { class: "steps" },
      step("done", `Added to ${s.editor}`, "The extension is in and ready"),
      step(
        "now",
        "Install antitheft",
        "The app that keeps your wallets and saved passwords yours, on this computer",
        h("div", { class: "step-actions" }, button("Get antitheft", () => send({ type: "getAntitheft" }), "primary", "external")),
      ),
      step("next", "Protected", "This editor switches on by itself once antitheft runs"),
    ),
    why,
    sample,
    also,
  );
}

// ---- panel ----------------------------------------------------------------------------------

function panel(s: State): HTMLElement {
  if (!connected(s)) return h("div", { class: "page" }, h("div", { class: "page-body narrow" }, hero(s), notProtected(s, false)));
  const needs = s.items.filter((i) => i.needsYou).length;
  const tabs: [Screen, string, number][] = [
    ["alerts", "Alerts", needs],
    ["vaults", "Vaults", 0],
    ["activity", "Activity", 0],
    ["extensions", "Extensions", 0],
  ];
  const current = screen ?? "alerts";
  const l = look(s);
  const route = current === "alerts" ? "/alerts" : current === "activity" ? "/activity" : current === "vaults" ? "/vaults" : "/";
  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "page-head" },
      h(
        "nav",
        { class: "tabs", role: "tablist" },
        ...tabs.map(([k, label, count]) =>
          h(
            "button",
            { class: k === current ? "tab on" : "tab", role: "tab", "aria-selected": String(k === current), onclick: () => ((screen = k), render()) },
            h("span", { class: "tab-label" }, label),
            count ? h("span", { class: "badge" }, String(count)) : null,
          ),
        ),
      ),
      h("span", { class: "grow" }),
      // paused, the bar under the head says it once
      l.action ? null : h("span", { class: `status ${l.tone}`, title: l.sub }, h("span", { class: `dot ${l.tone}` }), "Protected"),
      button("Open antitheft", () => openApp(route), "link", "external"),
    ),
    l.action ? h("div", { class: "pause-bar" }, glyph("pause", "bar-glyph"), h("span", {}, `${l.title}. ${l.sub}.`), button(l.action, () => openApp("/"), "link", "external")) : null,
    h("div", { class: "page-body" }, screenHead(s, current), current === "alerts" ? alertsScreen(s) : current === "activity" ? activityScreen(s) : current === "vaults" ? vaultsScreen(s) : extensionsScreen(s)),
  );
}

/** Each tab's title and subtitle, as the app's pages have them ("Alerts & history", "21 alerts, 3 not yet reviewed"). */
function screenHead(s: State, current: Screen): HTMLElement {
  const needs = s.items.filter((i) => i.needsYou).length;
  const v = s.vaults;
  const exts = userExtensions(s);
  const attention = s.extensions.attention.length;
  const [title, sub] =
    current === "alerts"
      ? ["Alerts", needs ? `${plural(needs, "alert")} from this editor, ${needs === 1 ? "it needs" : "they need"} you` : "Nothing from this editor needs you"]
      : current === "vaults"
        ? ["Vaults", v ? `${v.locked} of ${v.total} locked to their own app` : "Reading the vaults on this computer"]
        : current === "activity"
          ? ["Activity", `${plural(s.items.length, "thing")} extensions did in this editor`]
          : ["Extensions", `${exts.length} installed, ${attention ? `${attention} ${attention === 1 ? "needs" : "need"} your attention` : "none needs your attention"}`];
  return h(
    "div",
    { class: "screen-head" },
    h("div", {}, h("h1", { class: "screen-title" }, title), h("div", { class: "screen-sub" }, sub)),
    current === "alerts" && needs > 1 ? button("Mark all reviewed", () => send({ type: "reviewAll" }), "secondary", "check") : null,
    current === "activity" && s.items.some((i) => !i.needsYou) ? button("Clear", () => send({ type: "clearActivity" }), "secondary", "check") : null,
  );
}

function vaultsScreen(s: State): HTMLElement {
  const v = s.vaults;
  if (!v) return h("div", { class: "screen" }, empty(s, "Vaults are loading", "antitheft is listing the vaults on this computer"));
  if (!v.total) return h("div", { class: "screen" }, empty(s, "No vaults found yet", "When a wallet, password manager or key appears on this computer, antitheft locks it to its own app"));
  const paused = s.protection.standing !== "protected";
  const figure = (value: string, label: string, tone = "") => h("div", { class: `figure ${tone}` }, h("span", { class: "figure-value" }, value), h("span", { class: "figure-label muted" }, label));
  const status = (x: VaultView) => {
    const tone = x.status === "protected" ? "ok" : x.status === "partial" || x.status === "pending" ? "warn" : "muted";
    const word = paused && (x.status === "protected" || x.status === "partial") ? (s.protection.pausedBy === "license" ? "Watching only" : "Paused") : (STATUS_LABEL[x.status] ?? x.status);
    return h("span", { class: `pill ${paused && tone === "ok" ? "warn" : tone}` }, h("span", { class: `dot ${paused && tone === "ok" ? "warn" : tone}` }), word);
  };
  return h(
    "div",
    { class: "screen" },
    h(
      "div",
      { class: "vault-hero" },
      h(
        "div",
        { class: "vault-hero-text" },
        h("div", { class: "muted" }, `No other program can open them, extensions included.${v.observed === 1 ? " The other one is observed: antitheft records every program that opens it." : v.observed ? ` The other ${v.observed} are observed: antitheft records every program that opens them.` : ""}`),
      ),
      h(
        "div",
        { class: "figures" },
        figure(compact(v.allowed), "allowed reads, 7 days"),
        figure(compact(v.refused), paused ? "would be denied, 7 days" : "denied reads, 7 days", v.refused ? "bad" : ""),
        v.pending ? figure(String(v.pending), v.pending === 1 ? "needs your approval" : "need your approval", "warn") : null,
      ),
    ),
    ...v.groups.map((g) =>
      h(
        "section",
        { class: "vault-group" },
        h("div", { class: "eyebrow" }, `${g.label} · ${g.vaults.length}`),
        h(
          "div",
          { class: "rows" },
          ...g.vaults.map((x) =>
            h(
              "button",
              { class: "row vault-row", onclick: () => openApp("/vaults"), title: "Open in antitheft" },
              tile(x.icon, g.kind === "wallets" ? "lock" : g.kind === "secrets" ? "file" : "shield", "small"),
              h("span", { class: "row-title" }, h("span", { class: "vault-name" }, x.name), x.where ? h("span", { class: "row-detail" }, x.where) : null),
              h("span", { class: "muted vault-week" }, x.week.refused ? `${compact(x.week.allowed)} reads · ${compact(x.week.refused)} denied` : x.week.allowed ? `${compact(x.week.allowed)} reads` : ""),
              status(x),
            ),
          ),
        ),
      ),
    ),
  );
}

/** One alert or activity line, drawn as the app's Alerts table draws it: severity, the sentence with its target, who
 *  did it (their icon and "Claude Code › rm"), when. An alert opens in antitheft; an extension's own gets its controls. */
function alertRow(i: Item, s: State, withActions: boolean): HTMLElement {
  const own = withActions && i.extensionId && i.extensionId !== "unknown";
  const who = i.actorLine ?? i.extensionName ?? i.program?.name ?? "";
  const open = i.alertId ? () => openApp(`/alerts?id=${i.alertId}`) : null;
  return h(
    "article",
    { class: `alert-row${open ? " clickable" : ""}${i.needsYou ? " new" : ""}`, onclick: open, title: open ? "Open in antitheft" : null },
    h("div", { class: "alert-sev" }, severityLabel(i)),
    h(
      "div",
      { class: "alert-main" },
      h("div", { class: "alert-title-line" }, h("span", { class: "alert-title card-title row-title" }, i.title), i.count && i.count > 1 ? h("span", { class: "mono alert-count" }, `x${i.count}`) : null),
      i.target
        ? h("div", { class: "mono alert-target" }, i.vaultIcon ? h("img", { class: "target-icon", src: i.vaultIcon, alt: "" }) : null, i.target)
        : i.detail && !i.needsYou
          ? h("div", { class: "mono alert-target" }, i.detail)
          : null,
    ),
    who ? h("div", { class: "alert-actor" }, actorIcon(i.programIcon ?? i.extIcon, who.split(" › ").pop() ?? who), h("span", { class: "alert-actor-name" }, who)) : h("div"),
    h("div", { class: "mono alert-when" }, when(i.at, s.now)),
    own || (withActions && i.needsYou)
      ? h(
          "div",
          { class: "alert-actions", onclick: (e: Event) => e.stopPropagation() },
          own ? button("Disable extension", () => send({ type: "disable", id: i.extensionId }), "primary") : null,
          own ? button("Uninstall", () => send({ type: "uninstall", id: i.extensionId }), "secondary") : null,
          i.needsYou ? button("Mark reviewed", () => send({ type: "review", key: i.key, alertId: i.alertId }), own ? "link" : "secondary", "check") : null,
        )
      : null,
  );
}

function empty(s: State, title: string, sub: string): HTMLElement {
  return h("div", { class: "empty" }, h("span", { class: "empty-mark" }, h("img", { class: "invertable", src: s.media.protected, alt: "" })), h("div", { class: "empty-title" }, title), h("div", { class: "muted" }, sub));
}

function alertsScreen(s: State): HTMLElement {
  const needs = s.items.filter((i) => i.needsYou);
  return h(
    "div",
    { class: "screen" },
    needs.length ? h("div", { class: "alert-list" }, ...needs.map((i) => alertRow(i, s, true))) : empty(s, "Nothing needs you", "antitheft is watching every extension in this editor"),
  );
}

function activityScreen(s: State): HTMLElement {
  return h(
    "div",
    { class: "screen" },
    s.items.length
      ? h("div", { class: "alert-list" }, ...s.items.map((i) => alertRow(i, s, false)))
      : empty(s, "Nothing new", "What extensions do in this editor shows here"),
  );
}

function extensionsScreen(s: State): HTMLElement {
  const { attention, quiet } = s.extensions;
  const head = (r: ExtRow, small = false) =>
    h(
      "div",
      { class: "ext-head" },
      r.ext.icon ? tile(r.ext.icon, "puzzle", small ? "small" : "") : h("span", { class: `ext-noicon${small ? " small" : ""}` }, actorIcon(null, r.ext.name)),
      h("div", { class: "ext-text" }, h("div", { class: "ext-name" }, r.ext.name), h("div", { class: "muted" }, [r.ext.publisher, r.ext.version].filter(Boolean).join(" · "))),
    );
  const summary = (r: ExtRow) => (r.started.length ? `Started ${r.started.length} ${r.started.length === 1 ? "program" : "programs"}. None of them touched your vaults.` : "Nothing seen");
  const shown = showAllQuiet ? quiet : quiet.slice(0, 12);
  return h(
    "div",
    { class: "screen" },
    attention.length ? h("div", { class: "eyebrow" }, "Needs your attention") : null,
    ...attention.map((r) =>
      h(
        "article",
        { class: "card critical ext-card" },
        h("div", { class: "ext-top" }, head(r), h("div", { class: "actions inline" }, button("Disable", () => send({ type: "disable", id: r.ext.id }), "primary"), button("Uninstall", () => send({ type: "uninstall", id: r.ext.id })))),
        h(
          "div",
          { class: "ext-events" },
          ...[...r.attention, ...r.started]
            .sort((a, b) => a.at - b.at)
            .map((i) => h("div", { class: "ext-event" }, h("span", { class: "ext-event-sev" }, severityLabel(i)), h("span", { class: "row-title" }, i.title), h("span", { class: "muted when" }, when(i.at, s.now)))),
        ),
      ),
    ),
    quiet.length ? h("div", { class: "eyebrow" }, "Nothing to worry about") : null,
    quiet.length
      ? h(
          "div",
          { class: "rows" },
          ...shown.map((r) => h("button", { class: "row ext-row", onclick: () => send({ type: "showExtension", id: r.ext.id }) }, head(r, true), h("span", { class: "muted ext-summary" }, summary(r)))),
          quiet.length > shown.length ? h("button", { class: "more", onclick: () => ((showAllQuiet = true), render()) }, `Show ${quiet.length - shown.length} more`) : null,
        )
      : null,
  );
}

function render(): void {
  if (!state) return;
  root.replaceChildren(surface === "sidebar" ? sidebar(state) : panel(state));
  // development builds only: tell the extension what is on screen, for the editor integration test (a moment
  // later, once images have loaded)
  if (__DEV__) setTimeout(report, 1200);
}

declare const __DEV__: boolean;

function report(): void {
  const texts = (sel: string) => [...root.querySelectorAll(sel)].map((e) => (e.textContent ?? "").trim()).filter(Boolean);
    api.postMessage({
      type: "rendered",
      surface,
      screen: surface === "panel" ? screen : null,
      standing: texts(".standing-title")[0] ?? "",
      vaults: texts(".vault-name"),
      tabs: texts(".tab"),
      headings: texts("h1, h2"),
      cards: texts(".card-title"),
      rows: texts(".row-title, .mini-title, .ext-name, .group-name"),
      buttons: texts("button"),
      images: [...root.querySelectorAll("img")].filter((i) => (i as HTMLImageElement).getAttribute("src")).length,
      loaded: [...root.querySelectorAll("img")].filter((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0).length,
      width: root.getBoundingClientRect().width,
      height: root.getBoundingClientRect().height,
    });
}
