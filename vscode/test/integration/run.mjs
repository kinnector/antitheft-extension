// The extension in a real editor, against the fake daemon: a decoy vault, the stealer fixture trying every
// route, the probe listing the editor's commands. Checks the guard refused every in-process route and named
// the stealer, the self-check found every hook, and the launches and the program write were reported.
//
//   npm run build:dev && node test/integration/run.mjs <editor binary> [--xvfb] [--keep]
//
// Linux with --xvfb runs it on a virtual display. Uses a throwaway profile under the system temp folder.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..", "..");
const [binary] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const xvfb = process.argv.includes("--xvfb");
const keep = process.argv.includes("--keep");
if (!binary) {
  console.error("usage: run.mjs <editor binary> [--xvfb] [--keep]");
  process.exit(2);
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "antitheft-ide-it-")));
const vaultDir = path.join(tmp, "vault");
const vaultFile = path.join(vaultDir, "wallet.dat");
const logFile = path.join(tmp, "log.txt");
const record = path.join(tmp, "record.jsonl");
const socket = process.platform === "win32" ? `\\\\.\\pipe\\antitheft-it-${process.pid}` : path.join(tmp, "s.sock");
fs.mkdirSync(vaultDir);
fs.mkdirSync(path.join(tmp, "ws"));
fs.writeFileSync(vaultFile, "decoy-seed-phrase");
// routes that each read their own file, so every refusal can be checked for the extension it names: the
// stack at the read holds no frame of the stealer (workers, vm code, fs's own function behind a timer,
// a microtask or then)
const ownFile = {
  worker: "worker-eval",
  "vm function on a timer": "vm-timer",
  "then(fs.readFileSync)": "then-bare",
  "bound read after a timer": "timer-bound",
  "nextTick, no extension frame": "nexttick",
  "setImmediate, no extension frame": "immediate",
  "timer then nextTick, no extension frame": "two-hops",
  "vm function in a worker": "worker-vm",
  "downloaded script, on its own timer": "payload",
};
for (const f of Object.values(ownFile)) fs.writeFileSync(path.join(vaultDir, `${f}.dat`), "decoy-seed-phrase");
fs.writeFileSync(logFile, "");
fs.writeFileSync(record, "");

const daemon = spawn(process.execPath, [path.join(here, "fake-daemon.mjs"), socket, vaultDir, record], { stdio: "inherit" });
await new Promise((r) => setTimeout(r, 800));

const args = [
  ...(process.platform === "linux" ? ["--no-sandbox"] : []),
  "--user-data-dir", path.join(tmp, "ud"),
  "--extensions-dir", path.join(tmp, "ext"),
  "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--disable-telemetry",
  `--extensionDevelopmentPath=${ext}`,
  `--extensionDevelopmentPath=${path.join(ext, "test", "fixtures", "stealer")}`,
  `--extensionDevelopmentPath=${path.join(ext, "test", "fixtures", "probe")}`,
  path.join(tmp, "ws"),
];
const env = { ...process.env, ANTITHEFT_SOCKET: socket, ANTITHEFT_DEV_ASSUME_SERVICE: "1", ANTITHEFT_TEST_VAULT: vaultFile, ANTITHEFT_TEST_LOG: logFile };
const editor = xvfb ? spawn("xvfb-run", ["-a", binary, ...args], { env, detached: true, stdio: "ignore" }) : spawn(binary, args, { env, detached: true, stdio: "ignore" });

const deadline = Date.now() + 150000;
while (Date.now() < deadline && !fs.readFileSync(logFile, "utf8").includes("DONE")) await new Promise((r) => setTimeout(r, 1000));
await new Promise((r) => setTimeout(r, 16000)); // the last reports, and the probe opening the views
if (process.platform === "win32") {
  // the editor's own child processes hold the profile's files: end the whole tree
  spawn("taskkill", ["/pid", String(editor.pid), "/T", "/F"], { stdio: "ignore" });
} else {
  try {
    process.kill(-editor.pid, "SIGTERM");
  } catch {
    editor.kill();
  }
}
daemon.kill();
await new Promise((r) => setTimeout(r, 3000));

const log = fs.readFileSync(logFile, "utf8");
const records = fs.readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const lines = log.split("\n").filter((l) => l.startsWith("[stealer] READ") || l.startsWith("[stealer] FAIL"));
const hooks = records.filter((r) => r.kind === "health").pop()?.body?.hooks ?? {};
const items = records.filter((r) => r.kind === "report").flatMap((r) => r.body.items);
const hello = records.find((r) => r.kind === "hello")?.body;

console.log(`editor: ${hello?.app} ${hello?.app_version}`);
console.log(log.split("\n").find((l) => l.startsWith("[probe]")) ?? "[probe] (no output)");
console.log("stealer:");
for (const l of lines) console.log("  " + l.slice(10));
console.log("self-check hooks:", JSON.stringify(hooks));
console.log("reports:", items.map((i) => `${i.kind}:${i.extension_id}${i.op ? ":" + i.op : ""}`).join(", "));

const failures = [];
const mustRefuse = ["fs.readFileSync", "early-captured readFileSync", "fs.promises.readFile", "fs.readFile callback", "fs.createReadStream", "original-fs", "ESM import(node:fs)", "process.binding(fs)", "worker", "vscode.workspace.fs.readFile", "vscode.workspace.openTextDocument", "exec cat", "node child", ...Object.keys(ownFile)];
for (const name of mustRefuse) {
  const l = lines.find((x) => x.includes(` ${name} ->`));
  if (!l) failures.push(`${name}: no result`);
  else if (!l.includes("FAIL") || !l.includes("EACCES")) failures.push(`${name}: ${l}`);
}
for (const [k, v] of Object.entries(hooks)) if (v !== "ok") failures.push(`self-check ${k}: ${v}`);
for (const l of log.split("\n").filter((x) => x.startsWith("[probe] FAILED"))) failures.push(l);
if (!log.includes("[probe] ran antitheft.openExtensions")) failures.push("the views were not opened");
// errors from this extension in the editor's extension host log
const logs = path.join(tmp, "ud", "logs");
const exthost = [];
const walk = (d) => {
  for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/exthost\.log$|renderer\.log$/.test(e.name)) exthost.push(p);
  }
};
walk(logs);
const ours = exthost.flatMap((f) => fs.readFileSync(f, "utf8").split("\n")).filter((l) => /\[error\]/i.test(l) && /antitheft/i.test(l));
for (const l of ours.slice(0, 5)) failures.push(`editor log: ${l.slice(0, 300)}`);
console.log(`editor log errors from antitheft: ${ours.length}`);
if (!Object.keys(hooks).length) failures.push("no heartbeat with the self-check");
const stealer = "devtools-hub.solidity-snippets-pro";
if (!items.some((i) => i.kind === "blocked" && i.extension_id === stealer)) failures.push("no blocked report naming the stealer");
if (!items.some((i) => i.kind === "write" && i.extension_id === stealer)) failures.push("the beacon's write was not reported");
if (!items.some((i) => i.kind === "spawn" && i.extension_id === stealer && /node-update/.test(i.command ?? ""))) failures.push("the beacon's launch was not reported");
if (items.some((i) => i.extension_id === "kinnector.antitheft")) failures.push("the extension named itself");
const unknown = items.filter((i) => i.kind === "blocked" && i.extension_id === "unknown");
if (unknown.length) failures.push(`refusals that name no extension: ${unknown.map((i) => i.op).join(", ")}`);
for (const [route, f] of Object.entries(ownFile)) {
  const named = items.filter((i) => i.kind === "blocked" && (i.path ?? "").endsWith(`${f}.dat`));
  if (!named.length) failures.push(`${route}: no refusal reported`);
  else if (!named.every((i) => i.extension_id === stealer)) failures.push(`${route}: named ${named.map((i) => i.extension_id).join(", ")}`);
}
console.log(`routes with no stealer frame, named: ${Object.keys(ownFile).filter((r) => items.some((i) => i.kind === "blocked" && (i.path ?? "").endsWith(`${ownFile[r]}.dat`) && i.extension_id === stealer)).length}/${Object.keys(ownFile).length}`);

// what the webviews drew in this editor (development builds report it)
const rendered = log.split("\n").filter((l) => l.startsWith("[rendered] ")).map((l) => JSON.parse(l.slice(11)));
const last = (pred) => rendered.filter(pred).pop();
const side = last((r) => r.surface === "sidebar");
const alertsView = last((r) => r.surface === "panel" && r.screen === "alerts");
const activityView = last((r) => r.surface === "panel" && r.screen === "activity");
const extsView = last((r) => r.surface === "panel" && r.screen === "extensions");
const vaultsView = last((r) => r.surface === "panel" && r.screen === "vaults");
console.log("rendered in the editor:");
for (const [name, r] of [["sidebar", side], ["Alerts", alertsView], ["Activity", activityView], ["Vaults", vaultsView], ["Extensions", extsView]]) {
  console.log(`  ${name}: ${r ? `${Math.round(r.width)}x${Math.round(r.height)}, ${r.loaded}/${r.images} images loaded, standing "${r.standing}", ${r.cards.length} cards, ${r.rows.length} rows, buttons: ${[...new Set(r.buttons)].slice(0, 8).join(" | ")}` : "NOT RENDERED"}`);
}
if (!side || !/alerts? needs? you/.test(side.standing) || side.width < 50) failures.push("the sidebar did not render the alerts");
if (!alertsView || !alertsView.cards.some((c) => c.startsWith("solidity-snippets-pro tried to read your Exodus wallet"))) failures.push("the Alerts screen did not show the stealer's refusal");
if (!alertsView || !alertsView.buttons.includes("Disable extension") || !alertsView.buttons.includes("Mark reviewed")) failures.push("the Alerts screen has no actions");
if (!alertsView || alertsView.loaded < 1) failures.push("the Alerts screen loaded no real images");
if (!activityView || !activityView.rows.some((r) => /started node-update/.test(r))) failures.push("the Activity screen did not show the beacon's launch");
if (!side || !side.rows.includes("Wallets")) failures.push("the sidebar did not show the vaults");
if (!vaultsView || !vaultsView.vaults?.includes("Exodus") || !vaultsView.vaults?.includes("SSH keys")) failures.push("the Vaults screen did not list the vaults");
if (!vaultsView || vaultsView.loaded < 2) failures.push("the Vaults screen loaded no vault icons (antitheft sends them as JSON)");
if (!extsView || !extsView.rows.includes("solidity-snippets-pro") || !extsView.buttons.includes("Uninstall")) failures.push("the Extensions screen did not show the stealer with its actions");

console.log(failures.length ? `FAILED:\n  ${failures.join("\n  ")}` : "PASSED");
if (!keep) {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  } catch (e) {
    console.log(`could not remove ${tmp}: ${e.code}`);
  }
} else console.log(`kept: ${tmp}`);
process.exit(failures.length ? 1 : 0);
