// The screens as they render: the real webview bundle (dist/webview.js, built by `npm test`) in jsdom, fed the
// state the extension host would send (built with the real model), every screen and standing. Checks what is
// on screen (texts, real icons, buttons, chains), that clicks send the right messages, and that an
// extension's name is shown as text, never as markup.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { extensionRows, feed, vaultSummary, type AlertEntry, type ExtInfo, type IdeEvent, type Vault } from "../src/model";

const dist = resolve(__dirname, "..", "dist");
const bundle = readFileSync(resolve(dist, "webview.js"), "utf8");
const css = readFileSync(resolve(dist, "webview.css"), "utf8");
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const exts: ExtInfo[] = [
  { id: "devtools-hub.solidity-snippets-pro", name: "solidity-snippets-pro", publisher: "devtools-hub", version: "1.4.2", builtin: false },
  { id: "ms-python.python", name: "Python", publisher: "ms-python", version: "2026.4.0", builtin: false },
  { id: "evil.name", name: '<img src=x onerror="window.pwned=1">', publisher: "evil", version: "1.0.0", builtin: false },
];
const byId = new Map(exts.map((e) => [e.id, e]));
const events: IdeEvent[] = [
  { seq: 1, at: 1000, ide_id: "i", kind: "blocked", extension_id: "devtools-hub.solidity-snippets-pro", op: "readFileUtf8", vault: { id: "metamask", name: "MetaMask", category: "wallet" } },
  { seq: 2, at: 1060, ide_id: "i", kind: "spawn", extension_id: "devtools-hub.solidity-snippets-pro", command: "/home/u/.cache/devtools-hub/node-update", pid: 42 },
  { seq: 3, at: 1070, ide_id: "i", kind: "spawn", extension_id: "ms-python.python", command: "/usr/bin/python3 -m pylsp" },
  { seq: 4, at: 1080, ide_id: "i", kind: "spawn", extension_id: "ms-python.python", command: "/usr/bin/python3 -m pylsp" },
  { seq: 5, at: 1090, ide_id: "i", kind: "blocked", extension_id: "evil.name", op: "open", vault: { id: "ssh", name: "SSH keys", category: "ssh_material" } },
];
const alerts: AlertEntry[] = [
  {
    id: 7, category: "alert", first_seen_unix: 1120, last_seen_unix: 1120, paused: false, count: 1, kind: "storage_access", extension_id: "devtools-hub.solidity-snippets-pro",
    data: { verdict: "denied", app_name: "Exodus", resource_id: "exodus", data_category: "wallet", access_response: "kill", actor_process: { pid: 43, image_path: "/home/u/.cache/devtools-hub/node-update", app: "node-update" }, actor_chain: [{ pid: 30, image_path: "/usr/share/code/code", app: "code" }] },
  },
];

const vaultList: Vault[] = [
  { id: "chrome", name: "Google Chrome", vendor: "Google", category: "browser_vault", kind: "vaults", parent: null, status: "protected", files: 7, locked: 7, week: { allowed: 1240, refused: 2 } },
  { id: "chrome:nkbi", name: "MetaMask", vendor: "", category: "software_wallet", kind: "wallets", parent: "chrome", status: "protected", files: 3, locked: 3, week: { allowed: 30, refused: 0 } },
  { id: "electrum", name: "Electrum", vendor: "Electrum Technologies", category: "software_wallet", kind: "wallets", parent: null, status: "pending", files: 1, locked: 0, week: { allowed: 0, refused: 0 } },
  { id: "openssh_client", name: "SSH keys", vendor: "", category: "ssh_material", kind: "secrets", parent: null, status: "watching", files: 13, locked: 0, week: { allowed: 40, refused: 0 } },
];
const vaultSum = vaultSummary(vaultList);
const vaults = { ...vaultSum, paused: false, groups: vaultSum.groups.map((g) => ({ ...g, vaults: g.vaults.map((v) => ({ ...v, icon: v.id === "electrum" ? null : PNG })) })) };

function state(surface: "sidebar" | "panel", standing: string, overrides: Record<string, unknown> = {}) {
  const items = feed(events, alerts, byId, "Visual Studio Code").map((i) => ({
    ...i,
    extIcon: i.extensionId === "devtools-hub.solidity-snippets-pro" ? PNG : null,
    vaultIcon: i.vault ? PNG : null,
    programIcon: i.program ? PNG : null,
  }));
  const rows = extensionRows(exts, items);
  const icon = (r: (typeof rows.attention)[number]) => ({ ...r, ext: { ...r.ext, icon: r.ext.id === "ms-python.python" ? PNG : null } });
  return {
    type: "state", surface, screen: "alerts",
    protection: { standing, systemLevel: true, pausedBy: standing === "paused" ? "user" : null, version: "0.1.1" },
    hooks: { fs_binding: "ok", rpc: "ok" },
    items,
    extensions: { attention: rows.attention.map(icon), quiet: rows.quiet.map(icon) },
    vaults,
    editor: "Visual Studio Code",
    media: { logo: "m/logo.svg", mark: "m/mark.svg", protected: "m/p.svg", paused: "m/pa.svg", alert: "m/ad.svg", alertLight: "m/al.svg", offline: "m/o.svg", ide: "m/vscode.png", claude: "m/c.png", codex: "m/x.png", brand_metamask: "m/b/metamask.svg", brand_chrome: "m/b/chrome.svg", brand_npm: "m/b/npm.svg" },
    now: 1200,
    ...overrides,
  };
}

function render(surface: "sidebar" | "panel", s: ReturnType<typeof state>, theme = "vscode-dark") {
  const dom = new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body class="${theme}" data-surface="${surface}"><div id="root"></div></body></html>`, { runScripts: "outside-only" });
  const posted: Record<string, unknown>[] = [];
  const w = dom.window as unknown as Record<string, unknown> & typeof dom.window;
  // copied out of jsdom's realm, so deepEqual compares values
  w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))) });
  w.eval(bundle);
  w.dispatchEvent(new w.MessageEvent("message", { data: s }));
  const root = w.document.getElementById("root")!;
  const text = (sel: string) => [...root.querySelectorAll(sel)].map((e) => e.textContent?.trim() ?? "");
  const click = (label: string) => {
    const b = [...root.querySelectorAll("button")].find((x) => x.textContent?.trim() === label || x.textContent?.trim().startsWith(label));
    assert.ok(b, `a button "${label}"`);
    (b as HTMLButtonElement).click();
  };
  return { w, root, posted, text, click };
}

test("the panel's Alerts: the app's table rows, real icons, actions, and marking them reviewed", () => {
  const r = render("panel", state("panel", "protected"));
  assert.deepEqual(r.posted[0], { type: "ready" });
  assert.deepEqual(r.text(".tab-label"), ["Alerts", "Vaults", "Activity", "Extensions"]);
  assert.deepEqual(r.text(".tab .badge"), ["3"], "what needs you, counted on its tab");
  assert.deepEqual(r.text(".tab.on .tab-label"), ["Alerts"]);
  assert.equal(r.text(".page-head .status")[0], "Protected");
  assert.equal(r.root.querySelectorAll(".pause-bar").length, 0);
  // the tab's title and subtitle, as the app's pages
  assert.deepEqual([r.text(".screen-title")[0], r.text(".screen-sub")[0]], ["Alerts", "3 alerts from this editor, they need you"]);
  const titles = r.text(".alert-title");
  assert.deepEqual(titles, [
    "A program solidity-snippets-pro started tried to read your Exodus wallet",
    `${exts[2].name} tried to read your SSH keys`,
    "solidity-snippets-pro tried to read your MetaMask wallet",
  ]);
  // the app's severity: a dot and a word; a block is "Blocked"
  assert.deepEqual(r.text(".alert-row .sev"), ["Blocked", "Blocked", "Blocked"]);
  assert.equal(r.root.querySelectorAll(".alert-row .sev-dot--blocked").length, 3);
  // who did it, as the app's actor line, with the real icon (or the dashed initial)
  assert.deepEqual(r.text(".alert-actor-name"), ["solidity-snippets-pro › node-update", exts[2].name, "solidity-snippets-pro"]);
  assert.equal(r.root.querySelectorAll(".alert-actor img.actor-icon").length, 2, "the program's and the extension's own icons");
  assert.equal(r.root.querySelectorAll(".alert-actor .actor-icon--unknown").length, 1, "no icon: the dashed initial, never a glyph tile");
  assert.equal(r.root.querySelectorAll(".tile, .chain, .chip").length, 0, "no glyph tiles or chip chains");
  r.click("Disable extension");
  assert.deepEqual(r.posted.at(-1), { type: "disable", id: "devtools-hub.solidity-snippets-pro" });
  // the row itself opens the alert in antitheft
  (r.root.querySelector(".alert-row.clickable") as HTMLElement).click();
  assert.deepEqual(r.posted.at(-1), { type: "openApp", route: "/alerts?id=7" });
  // and each can be marked reviewed, or all at once
  r.click("Mark reviewed");
  assert.deepEqual(r.posted.at(-1), { type: "review", key: "alert-7", alertId: 7 });
  r.click("Mark all reviewed");
  assert.deepEqual(r.posted.at(-1), { type: "reviewAll" });
});

test("an extension's name is text, never markup", () => {
  const r = render("panel", state("panel", "protected"));
  assert.equal((r.w as unknown as { pwned?: number }).pwned, undefined);
  assert.equal(r.root.querySelectorAll("img[src=x]").length, 0);
  assert.ok(r.root.textContent!.includes('<img src=x onerror="window.pwned=1">'));
});

test("the panel's Activity and Extensions tabs", () => {
  const r = render("panel", state("panel", "protected"));
  r.click("Activity");
  const rows = r.text(".row-title");
  assert.ok(rows.some((t) => t.startsWith("Python started python3")), rows.join(" | "));
  assert.ok(r.text(".alert-count").includes("x2"), "how often, as the app's xN");
  assert.ok(rows.some((t) => t.startsWith("solidity-snippets-pro started node-update")));
  r.click("Clear");
  assert.deepEqual(r.posted.at(-1), { type: "clearActivity" });
  r.click("Extensions");
  // most recent first: the stealer's newest is the stopped program at 1120
  assert.deepEqual(r.text(".ext-card .ext-name"), ["solidity-snippets-pro", exts[2].name]);
  assert.ok(r.text(".ext-summary").includes("Started 1 program. None of them touched your vaults."));
  assert.equal(r.root.querySelectorAll(".ext-row .tile img").length, 1, "Python's own icon");
  r.click("Uninstall");
  assert.equal(r.posted.at(-1)!.type, "uninstall");
});

test("the sidebar when protected: one mark, the standing, the figures, the vaults, the extensions, what happened", () => {
  const r = render("sidebar", state("sidebar", "protected"));
  assert.equal(r.text(".standing-title")[0], "3 alerts need you");
  assert.equal(r.text(".hero-sub")[0], "Only their own apps can open your 2 vaults");
  // antitheft's mark once: the standing itself (the view's own title already says antitheft)
  assert.equal(r.root.querySelectorAll(".brand, .logo, .wordmark").length, 0);
  assert.equal(r.root.querySelectorAll(".hero-mark").length, 1);
  assert.equal(r.root.querySelectorAll(".hero-mark img.only-light, .hero-mark img.only-dark").length, 2, "the alert mark: a light and a dark one");
  assert.equal(r.root.querySelectorAll(".ring, .emblem").length, 0, "a status row: no disc, no looping ring");
  assert.deepEqual(r.text(".cover"), ["Extension working", "antitheft installed"]);
  assert.deepEqual(r.text(".stat-value"), ["2", "3", "2"], "vaults locked, extensions watched, denied reads this week");
  assert.deepEqual(r.text(".eyebrow"), ["Needs you", "Your vaults", "Extensions in this editor", "Recent in this editor"], "sentence case, no tracked capitals");
  assert.deepEqual(r.text(".panel-card .group-name"), ["Wallets", "Browsers & apps", "Keys & developer secrets", "3 extensions watched"]);
  assert.equal(r.root.querySelectorAll(".stack img").length, 4, "the vaults' and extensions' real icons");
  assert.equal(r.root.querySelectorAll(".mini").length, 5, "3 that need you, 2 recent");
  // the status row is the way to the alerts it counts
  (r.root.querySelector(".hero--link") as HTMLElement).click();
  assert.deepEqual(r.posted.at(-1), { type: "screen", screen: "alerts" });
  assert.equal(r.root.querySelectorAll(".hero.bad, .hero .bad").length, 0, "the status is not painted red");
  (r.root.querySelector(".mini-check") as HTMLElement).click();
  assert.equal(r.posted.at(-1)!.type, "review");
  r.click("Mark all reviewed");
  assert.deepEqual(r.posted.at(-1), { type: "reviewAll" });
  r.click("Clear");
  assert.deepEqual(r.posted.at(-1), { type: "clearActivity" }, "the sidebar's Recent clears too");
  r.click("Wallets");
  assert.deepEqual(r.posted.at(-1), { type: "screen", screen: "vaults" });
  r.click("3 extensions watched");
  assert.deepEqual(r.posted.at(-1), { type: "screen", screen: "extensions" });
});

test("the panel's Vaults: how many are locked, every vault by kind with its own icon, state and week", () => {
  const r = render("panel", state("panel", "protected"));
  r.click("Vaults");
  assert.deepEqual([r.text(".screen-title")[0], r.text(".screen-sub")[0]], ["Vaults", "2 of 4 locked to their own app"]);
  assert.deepEqual(r.text(".figure-value"), ["1.3k", "2", "1"], "allowed, denied, waiting for approval");
  assert.deepEqual(r.text(".vault-group > .eyebrow"), ["Wallets · 2", "Browsers & apps · 1", "Keys & developer secrets · 1"]);
  assert.deepEqual(r.text(".vault-name"), ["MetaMask", "Electrum", "Google Chrome", "SSH keys"]);
  assert.deepEqual(r.text(".vault-row .row-detail"), ["Google Chrome", "Electrum Technologies", "Google"], "a browser's wallet says which browser");
  assert.deepEqual(r.text(".vault-row .pill"), ["Protected", "Needs approval", "Protected", "Observed"]);
  assert.equal(r.root.querySelectorAll(".vault-row .tile img").length, 3, "real icons; a glyph where there is none");
  r.click("MetaMask");
  assert.deepEqual(r.posted.at(-1), { type: "openApp", route: "/vaults" });
  const paused = render("panel", state("panel", "paused"));
  paused.click("Vaults");
  assert.deepEqual(paused.text(".vault-row .pill"), ["Paused", "Needs approval", "Paused", "Observed"], "paused, nothing reads as protected");
  const none = render("panel", state("panel", "protected", { vaults: null }));
  none.click("Vaults");
  assert.equal(none.text(".empty-title")[0], "Vaults are loading");
});

test("nothing needs you: the quiet standing and an empty Alerts screen", () => {
  const quiet = { ...state("panel", "protected"), items: [] };
  const r = render("panel", quiet);
  assert.equal(r.text(".empty-title")[0], "Nothing needs you");
  const s = render("sidebar", { ...state("sidebar", "protected"), items: [] });
  assert.equal(s.text(".standing-title")[0], "Protected");
  assert.equal(s.text(".hero-sub")[0], "Only their own apps can open your 2 vaults");
  const old = render("sidebar", state("sidebar", "protected", { items: [], vaults: null }));
  assert.equal(old.text(".hero-sub")[0], "Extensions can't reach your vaults", "an antitheft with no vault list");
});

test("not installed: almost there, one step left, what switches on; nothing else", () => {
  for (const surface of ["sidebar", "panel"] as const) {
    const r = render(surface, state(surface, "not-installed"), "vscode-light");
    assert.equal(r.text(".standing-title")[0], "Almost there");
    assert.equal(r.text(".hero-sub")[0], "One step left: install antitheft");
    assert.deepEqual(r.text(".cover"), [], "the steps say it; no not-found chips");
    assert.deepEqual(r.text(".step-title"), ["Added to Visual Studio Code", "Install antitheft", "Protected"]);
    assert.equal(r.root.querySelectorAll(".step--done").length, 1);
    assert.deepEqual([...r.root.querySelectorAll(".step-mark .dot")].map((d) => d.className), ["dot ok", "dot now", "dot muted"], "the status dot as each step's mark");
    assert.equal(r.root.querySelectorAll(".step-mark svg").length, 0, "no check glyph");
    assert.equal(r.root.querySelector(".step--now .step-title")?.textContent, "Install antitheft");
    r.click("Get antitheft");
    assert.deepEqual(r.posted.at(-1), { type: "getAntitheft" });
    // why it is here, then one example alert, tagged as one, in the alerts' own parts
    assert.equal(r.text(".why-title")[0], "Why antitheft, in Visual Studio Code");
    assert.equal(r.text(".sample-tag")[0], "Example");
    assert.equal(r.text(".sample .sev")[0], "Blocked");
    assert.equal(r.text(".sample-title")[0], "Color Theme Studio tried to read your MetaMask wallet");
    assert.equal(r.root.querySelector(".sample .target-icon")?.getAttribute("src"), "m/b/metamask.svg");
    assert.equal(r.text(".sample .actor-icon--unknown")[0], "C", "a made-up extension has no icon: the app's dashed initial");
    assert.equal(r.root.querySelectorAll(".sample button").length, 0, "nothing in the example can be clicked");
    assert.match(r.text(".also")[0], /browser passwords/);
    assert.doesNotMatch(r.root.textContent ?? "", /SSH|\.env/, "only what antitheft locks is named");
    assert.equal(r.root.querySelectorAll("h2, .soon").length, 0, "no warning headline, no coming soon");
    assert.equal(r.root.querySelectorAll(".tab, .card").length, 0, "no alerts or tabs before antitheft protects");
  }
});

test("paused and not running", () => {
  const p = render("sidebar", state("sidebar", "paused"));
  assert.equal(p.text(".standing-title")[0], "Paused");
  assert.equal(p.text(".hero-sub")[0], "Nothing is blocked until you resume");
  assert.deepEqual(p.text(".cover"), ["Extension working", "antitheft paused"]);
  // paused is connected: the alerts and the controls are there
  assert.equal(p.root.querySelectorAll(".mini").length, 5);
  p.click("Resume in antitheft");
  assert.deepEqual(p.posted.at(-1), { type: "openApp", route: "/" });
  const pp = render("panel", state("panel", "paused"));
  assert.deepEqual(pp.text(".tab-label"), ["Alerts", "Vaults", "Activity", "Extensions"]);
  assert.match(pp.text(".pause-bar")[0], /^Paused\. Nothing is blocked until you resume\./);
  assert.equal(pp.root.querySelectorAll(".page-head .status").length, 0, "the bar says it, once");
  pp.click("Disable extension");
  assert.equal(pp.posted.at(-1)!.type, "disable");
  const lic = render("sidebar", state("sidebar", "paused", { protection: { standing: "paused", systemLevel: true, pausedBy: "license" } }));
  assert.equal(lic.text(".standing-title")[0], "Watching only");
  lic.click("Get a licence");
  assert.deepEqual(lic.posted.at(-1), { type: "openApp", route: "/" });
  const n = render("panel", state("panel", "not-running"));
  assert.equal(n.text(".standing-title")[0], "Not running");
  n.click("Check again");
  assert.deepEqual(n.posted.at(-1), { type: "recheck" });
});

test("a broken hook shows on the standing", () => {
  const r = render("sidebar", state("sidebar", "protected", { hooks: { fs_binding: "ok", rpc: "missing" } }));
  assert.equal(r.text(".cover")[0], "Extension partly working");
  assert.match(r.root.querySelector(".cover")!.getAttribute("title")!, /stopped working after an editor update/);
});

test("the stylesheet keeps the rhythm: no washes or glows, no tracked capitals but the editor's own tabs, spaces in steps of 4", () => {
  assert.doesNotMatch(css, /radial-gradient|linear-gradient|drop-shadow|text-shadow|infinite/, "no washes, glows or looping motion");
  assert.equal((css.match(/letter-spacing/g) ?? []).length, 2, "the panel tabs (the editor's own uppercase) and the badge resetting it");
  assert.doesNotMatch(css, /font-weight:\s*(650|700|800|900)/);
  // every padding, margin and gap in px is a step of 4 (a 1px hairline and a 2px nudge excepted)
  for (const m of css.matchAll(/(?:padding|margin|gap)[a-z-]*:\s*([^;]+);/g)) {
    for (const n of m[1].matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
      const v = Math.abs(Number(n[1]));
      assert.ok(v <= 2 || v % 4 === 0, `${m[0]} is off the 4px grid`);
    }
  }
});

test("the stylesheet uses the editor's theme, not colours of its own", () => {
  const colours = css.match(/#[0-9a-fA-F]{3,6}\b/g) ?? [];
  // only fallbacks inside var(--vscode-..., #...) are allowed
  for (const c of colours) assert.ok(new RegExp(`var\\(--vscode-[a-zA-Z-]+, ${c}\\)`).test(css), `colour ${c} outside a theme fallback`);
});
