import { test } from "node:test";
import assert from "node:assert/strict";
import { alertItem, eventItem, extensionRows, feed, vaultPhrase, when, type AlertEntry, type ExtInfo, type IdeEvent } from "../src/model";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { socketRefused, standingOf } from "../src/daemon/protection";
import { writesRunnable } from "../src/guard/core";

const exts = new Map<string, ExtInfo>([
  ["devtools-hub.solidity-snippets-pro", { id: "devtools-hub.solidity-snippets-pro", name: "solidity-snippets-pro", publisher: "devtools-hub", version: "1.4.2", builtin: false }],
  ["ms-python.python", { id: "ms-python.python", name: "Python", publisher: "ms-python", version: "2026.4.0", builtin: false }],
  ["vscode.git", { id: "vscode.git", name: "Git", publisher: "vscode", version: "1.0.0", builtin: true }],
]);

const blocked: IdeEvent = { seq: 1, at: 1000, ide_id: "ide-1-1", kind: "blocked", extension_id: "devtools-hub.solidity-snippets-pro", op: "readFileUtf8", vault: { id: "metamask", name: "MetaMask", category: "browser_extension_wallet" } };
const spawn: IdeEvent = { seq: 2, at: 1060, ide_id: "ide-1-1", kind: "spawn", extension_id: "devtools-hub.solidity-snippets-pro", command: "/home/u/.cache/devtools-hub/node-update --quiet", pid: 42 };
const beacon: AlertEntry = {
  id: 7,
  category: "alert",
  first_seen_unix: 1120,
  last_seen_unix: 1120,
  paused: false,
  count: 1,
  kind: "storage_access",
  extension_id: "devtools-hub.solidity-snippets-pro",
  data: {
    verdict: "denied",
    app_name: "Exodus",
    resource_id: "exodus",
    data_category: "wallet",
    access_response: "kill",
    actor_process: { pid: 42, image_path: "/home/u/.cache/devtools-hub/node-update", app: "node-update" },
    actor_chain: [{ pid: 30, image_path: "/usr/share/code/code", app: "code" }, { pid: 1, image_path: "/sbin/init", app: "systemd" }],
  },
};

test("a refused read reads like the app: who tried to read your what, then what happened", () => {
  const i = eventItem(blocked, exts)!;
  assert.equal(i.title, "solidity-snippets-pro tried to read your MetaMask wallet");
  assert.equal(i.label, "BLOCKED");
  assert.equal(i.needsYou, true);
});

test("a downloaded program's alert names the extension and draws the chain editor first", () => {
  const i = alertItem(beacon, exts, "Visual Studio Code")!;
  assert.equal(i.title, "A program solidity-snippets-pro started tried to read your Exodus wallet");
  assert.equal(i.label, "STOPPED");
  assert.deepEqual(i.chain, ["Visual Studio Code", "solidity-snippets-pro", "node-update"]);
  const paused = alertItem({ ...beacon, paused: true }, exts, "Visual Studio Code")!;
  assert.equal(paused.label, "WOULD BE BLOCKED");
  const held = alertItem({ ...beacon, data: { ...beacon.data, access_response: "ask" } }, exts, "Visual Studio Code")!;
  assert.equal(held.label, "HELD");
});

test("launches are activity, not alerts; newest first", () => {
  const items = feed([blocked, spawn], [beacon], exts, "Visual Studio Code");
  assert.deepEqual(items.map((i) => i.label), ["STOPPED", "STARTED", "BLOCKED"]);
  assert.equal(items.find((i) => i.label === "STARTED")!.title, "solidity-snippets-pro started node-update");
  assert.equal(items.filter((i) => i.needsYou).length, 2);
});

test("the extensions screen: attention first, quiet third-party ones after, built-ins left out", () => {
  const items = feed([blocked, spawn, { ...spawn, seq: 3, extension_id: "ms-python.python", command: "python3 -m pylsp" }], [beacon], exts, "Visual Studio Code");
  const rows = extensionRows([...exts.values()], items);
  assert.deepEqual(rows.attention.map((r) => r.ext.id), ["devtools-hub.solidity-snippets-pro"]);
  assert.equal(rows.attention[0].attention.length, 2);
  assert.deepEqual(rows.quiet.map((r) => r.ext.id), ["ms-python.python"]);
  assert.equal(rows.quiet[0].started.length, 1);
});

test("the same program started again is one row with a count", () => {
  const git = (seq: number, at: number): IdeEvent => ({ seq, at, ide_id: "x", kind: "spawn", extension_id: "ms-python.python", command: "/usr/bin/git status" });
  const items = feed([git(1, 10), git(2, 20), git(3, 30)], [], exts, "Visual Studio Code");
  assert.equal(items.length, 1);
  assert.equal(items[0].count, 3);
  assert.equal(items[0].at, 30);
});

test("one extension refused the same vault many times is one alert with a count", () => {
  const again = (seq: number, at: number): IdeEvent => ({ ...blocked, seq, at });
  const items = feed([again(1, 10), again(2, 20), again(3, 30)], [], exts, "Visual Studio Code");
  assert.equal(items.length, 1);
  assert.equal(items[0].count, 3);
  assert.equal(items.filter((i) => i.needsYou).length, 1);
});

test("vault phrases", () => {
  assert.equal(vaultPhrase("Google Chrome", "passwords"), "your Google Chrome saved passwords");
  assert.equal(vaultPhrase("Signal", "messaging"), "your Signal");
  assert.equal(vaultPhrase("MetaMask Wallet", "wallet"), "your MetaMask Wallet");
});

test("an unknown extension and guard events", () => {
  assert.equal(eventItem({ ...blocked, extension_id: "unknown" }, exts)!.title, "An unknown extension tried to read your MetaMask wallet");
  assert.equal(eventItem({ seq: 9, at: 1, ide_id: "x", kind: "guard_lost" }, exts), null, "the guard's health is on the standing, not in the activity");
  assert.equal(eventItem({ seq: 10, at: 1, ide_id: "x", kind: "guard_partial" }, exts), null);
  assert.equal(eventItem({ seq: 9, at: 1, ide_id: "x", kind: "nonsense" }, exts), null);
});

test("times", () => {
  assert.equal(when(1000, 1030), "just now");
  assert.equal(when(1000, 1000 + 600), "10 min ago");
});

test("the standing from the socket's answer and the service registration", () => {
  assert.equal(standingOf(null, false).standing, "not-installed");
  assert.equal(standingOf(null, true).standing, "not-running");
  assert.equal(standingOf({ enforcement_paused: true, enforcement_paused_source: "license" }, true).standing, "paused");
  assert.equal(standingOf({ enforcement_paused: true }, true).pausedBy, "user");
  assert.equal(standingOf({ enforcement_paused: true }, true, true).standing, "protected", "the dev stack's pause, in a dev build");
  assert.equal(standingOf({ enforcement_paused: false, protection_source_active: false }, true).systemLevel, false);
  assert.equal(standingOf(null, true, false, true).standing, "no-access", "running, but this login may not use the socket yet");
});

test("a socket this process may not use reads as refused; a missing one does not", () => {
  if (process.platform === "win32") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at-sock-"));
  const f = path.join(dir, "antitheft.sock");
  fs.writeFileSync(f, "");
  fs.chmodSync(f, 0o000);
  // root may use anything: the refusal only exists for a normal user
  if (process.getuid?.() !== 0) assert.equal(socketRefused(f), true);
  fs.chmodSync(f, 0o600);
  assert.equal(socketRefused(f), false);
  assert.equal(socketRefused(path.join(dir, "missing.sock")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("which writes are a program being written", () => {
  assert.equal(writesRunnable("chmod", ["/x", 0o755], "/x", false), true);
  assert.equal(writesRunnable("chmod", ["/x", 0o644], "/x", false), false);
  assert.equal(writesRunnable("open", ["/x", 0o1101, 0o755], "/x", false), true);
  assert.equal(writesRunnable("open", ["/x", 0, 0o755], "/x", false), false, "a read");
  assert.equal(writesRunnable("open", ["C:\\x\\beacon.exe", 0o1101, 0o666], "C:\\x\\beacon.exe", true), true);
  assert.equal(writesRunnable("writeFileUtf8", ["C:\\x\\notes.js", "", 0, 0o666], "C:\\x\\notes.js", true), false);
});

test("vaults group by kind, wallets first, locked before observed, a browser's extension named by its browser", async () => {
  const { vaultSummary, compact } = await import("../src/model");
  const v = (id: string, name: string, kind: string, status: string, parent: string | null = null, allowed = 0, refused = 0) => ({ id, name, vendor: "", category: "", kind, parent, status, files: 1, locked: status === "protected" ? 1 : 0, week: { allowed, refused } });
  const s = vaultSummary([
    v("openssh_client", "SSH keys", "secrets", "watching", null, 40),
    v("chrome", "Google Chrome", "vaults", "protected", null, 900, 2),
    v("chrome:nkbi", "MetaMask", "wallets", "protected", "chrome", 30),
    v("wasabi_wallet", "Wasabi Wallet", "wallets", "watching"),
    v("electrum", "Electrum", "wallets", "partial", null, 0, 1),
  ]);
  assert.deepEqual(s.groups.map((g) => g.kind), ["wallets", "vaults", "secrets"]);
  assert.deepEqual(s.groups[0].vaults.map((x) => x.name), ["MetaMask", "Electrum", "Wasabi Wallet"]);
  assert.equal(s.groups[0].vaults[0].where, "Google Chrome");
  assert.deepEqual([s.total, s.locked, s.observed, s.allowed, s.refused], [5, 3, 2, 970, 3]);
  assert.deepEqual([compact(999), compact(1234), compact(12_400), compact(2_500_000)], ["999", "1.2k", "12k", "2.5M"]);
});

test("an icon from antitheft is its JSON form or raw image bytes, and only an image", async () => {
  const { imageData } = await import("../src/daemon/client");
  const png = "iVBORw0KGgo=";
  assert.equal(imageData("application/json", Buffer.from(JSON.stringify({ content_type: "image/png", data_base64: png }))), `data:image/png;base64,${png}`);
  assert.equal(imageData("application/json; charset=utf-8", Buffer.from(JSON.stringify({ content_type: "image/svg+xml", data_base64: png }))), `data:image/svg+xml;base64,${png}`);
  assert.equal(imageData("image/png", Buffer.from("x")), "data:image/png;base64,eA==");
  assert.equal(imageData("application/json", Buffer.from(JSON.stringify({ content_type: "text/html", data_base64: png }))), null, "not an image");
  assert.equal(imageData("application/json", Buffer.from(JSON.stringify({ content_type: "image/png", data_base64: "a\"><script>" }))), null, "not base64");
  assert.equal(imageData("application/json", Buffer.from(JSON.stringify({ error: "no live icon resolved" }))), null);
  assert.equal(imageData("text/html", Buffer.from("<b>")), null);
});

test("a reviewed alert no longer needs you; other kinds read as the app's sentences", async () => {
  const { alertItem, actorLine } = await import("../src/model");
  const base = { category: "alert", first_seen_unix: 1, last_seen_unix: 2, paused: true, count: 9 };
  const rm = { ...base, id: 3848, kind: "persistence_location_changed", data: { path: "/etc/systemd/system/antitheftd.service.prev", change: "disappeared", writer: { pid: 1, image_path: "/usr/bin/rm" },
    actor_chain: [{ pid: 9, app: "dash", role: "shell" }, { pid: 8, app: "timeout" }, { pid: 7, app: "sudo" }, { pid: 6, app: "bash", role: "shell" }, { pid: 5, app: "Claude Code", role: "agent" }, { pid: 4, app: "VSCodium" }] } };
  const i = alertItem(rm as never, exts, "VSCodium")!;
  assert.equal(i.title, "rm removed auto-start entry antitheftd.service.prev");
  assert.equal(i.target, "antitheftd.service.prev");
  assert.equal(i.actorLine, "Claude Code › rm", "shells, sudo and timeout left out, as the app's origin line");
  assert.equal(i.severity, "warning");
  assert.equal(i.needsYou, true);
  assert.equal(alertItem({ ...rm, reviewed: true } as never, exts, "VSCodium")!.needsYou, false);
  assert.equal(alertItem({ ...beacon, reviewed: true }, exts, "Visual Studio Code")!.needsYou, false);
  assert.equal(actorLine([], "rm"), "rm");
});
