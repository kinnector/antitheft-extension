// The plugin in a real JetBrains IDE against the fake daemon (vscode/test/integration/fake-daemon.mjs), on
// macOS, Linux and Windows: a throwaway profile with antitheft's plugin and the test stealer plugin, a project
// open, a decoy vault. The stealer tries every route to the vault, then opens antitheft's tool window and logs
// what is on screen (from the Swing component tree). Build first: `IDE_HOME=... ./build.sh --dev`.
//
//   node test/run.mjs <IDE home: macOS .../Contents, else the install folder> [--xvfb]
//
// Checks: every read refused but the shell command hiding its path (the OS layer's job), the self-check's
// hooks ok, the reports name the stealer, and the tool window, its tabs and the status bar show the alerts.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const build = path.resolve(here, "..", "build");
const [ideHome] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const xvfb = process.argv.includes("--xvfb");
if (!ideHome) {
  console.error("usage: run.mjs <IDE home> [--xvfb]");
  process.exit(2);
}
const win = process.platform === "win32";
const mac = process.platform === "darwin";

const P = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "antitheft-jb-it-")));
for (const d of ["config", "system", "plugins/test-stealer/lib", "log", "vault", "project"]) fs.mkdirSync(path.join(P, d), { recursive: true });
fs.writeFileSync(path.join(P, "vault", "wallet.dat"), "decoy-seed-phrase");
fs.writeFileSync(path.join(P, "project", "main.py"), "print('hi')\n");
const LOG = path.join(P, "rasp.log");
const RECORD = path.join(P, "record.jsonl");
fs.writeFileSync(LOG, "");
fs.writeFileSync(RECORD, "");
// antitheft's plugin and the test stealer
fs.cpSync(path.join(build, "dist", "antitheft"), path.join(P, "plugins", "antitheft"), { recursive: true });
fs.copyFileSync(path.join(build, "test-stealer.jar"), path.join(P, "plugins", "test-stealer", "lib", "test-stealer.jar"));

const socket = win ? `\\\\.\\pipe\\antitheft-jb-it-${process.pid}` : path.join(P, "s.sock");
const daemon = spawn(process.execPath, [path.resolve(here, "..", "..", "vscode", "test", "integration", "fake-daemon.mjs"), socket, path.join(P, "vault"), RECORD], { stdio: "inherit" });
await new Promise((r) => setTimeout(r, 1000));

const bin = path.join(ideHome, "bin");
const vmo = fs.readdirSync(bin).find((f) => f.endsWith(".vmoptions") && !f.includes("jetbrains_client") && (win ? f.endsWith(".exe.vmoptions") : true));
const product = vmo.split(/[.6]/)[0].toUpperCase(); // pycharm64.vmoptions -> PYCHARM
const opts = fs.readFileSync(path.join(bin, vmo), "utf8") + [
  `-Dpoc.wallet=${path.join(P, "vault", "wallet.dat")}`,
  `-Dpoc.log=${LOG}`,
  "-Djb.consents.confirmation.enabled=false",
  "-Djb.privacy.policy.text=<!--999.999-->",
  "-Didea.initially.ask.config=never",
  "-Didea.trust.all.projects=true",
  "-Dide.show.tips.on.startup.default.value=false",
  // Android Studio: no Setup Wizard (it opens, modal, wherever no Android SDK is set up, and the project waits
  // behind it); the other IDEs ignore the property
  "-Ddisable.android.first.run=true",
  "",
].join("\n");
fs.writeFileSync(path.join(P, "vmoptions"), opts);
fs.writeFileSync(path.join(P, "idea.properties"), ["config", "system", "plugins", "log"].map((k) => `idea.${k}.path=${path.join(P, k).replace(/\\/g, "/")}`).join("\n") + "\n");

// the product's own launcher: pycharm (Linux), pycharm64.exe (Windows), Contents/MacOS/pycharm (macOS)
const name = vmo.split(/[.]/)[0].replace(/64$/, "");
const launcher = mac
  ? path.join(ideHome, "MacOS", fs.readdirSync(path.join(ideHome, "MacOS"))[0])
  : win
    ? path.join(bin, `${name}64.exe`)
    : fs.existsSync(path.join(bin, name)) ? path.join(bin, name) : path.join(bin, `${name}.sh`);
const env = { ...process.env, ANTITHEFT_SOCKET: socket, ANTITHEFT_DEV_ASSUME_SERVICE: "1", [`${product}_VM_OPTIONS`]: path.join(P, "vmoptions"), [`${product}_PROPERTIES`]: path.join(P, "idea.properties") };
const args = [path.join(P, "project")];
const ide = xvfb ? spawn("xvfb-run", ["-a", "-s", "-screen 0 1600x1000x24", launcher, ...args], { env, detached: true, stdio: "ignore" }) : spawn(launcher, args, { env, detached: !win, stdio: "ignore" });

const deadline = Date.now() + 240000;
while (Date.now() < deadline && !fs.readFileSync(LOG, "utf8").includes("DONE")) await new Promise((r) => setTimeout(r, 1000));
await new Promise((r) => setTimeout(r, 3000));
if (win) {
  try {
    execFileSync("taskkill", ["/pid", String(ide.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
} else {
  try {
    process.kill(-ide.pid, "SIGTERM");
  } catch {
    ide.kill();
  }
}
daemon.kill();
await new Promise((r) => setTimeout(r, 4000));

const log = fs.readFileSync(LOG, "utf8");
const records = fs.readFileSync(RECORD, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const hooks = records.filter((r) => r.kind === "health").pop()?.body?.hooks ?? {};
const items = records.filter((r) => r.kind === "report").flatMap((r) => r.body.items);
const lines = log.split("\n");
console.log(`IDE: ${records.find((r) => r.kind === "hello")?.body?.app ?? "?"}`);
for (const l of lines.filter((x) => /READ|FAIL/.test(x))) console.log("  " + l.slice(10, 140));
console.log("self-check hooks:", JSON.stringify(hooks));
console.log("reports:", [...new Set(items.map((i) => `${i.kind}:${i.extension_id}`))].join(", "));
const probe = lines.filter((l) => l.includes("PROBE")).map((l) => l.replace("[stealer] PROBE ", ""));
console.log("tool window, as on screen:");
for (const p of [...new Set(probe)].slice(0, 60)) console.log("  " + p.slice(0, 160));

const failures = [];
const reads = lines.filter((l) => l.includes("READ "));
if (reads.length > 1 || (reads.length === 1 && !/obfuscated/.test(reads[0]))) failures.push(`reads that got through: ${reads.join(" | ")}`);
if (!lines.some((l) => l.includes("FAIL  Files.readString"))) failures.push("the stealer did not run");
for (const [k, v] of Object.entries(hooks)) if (v !== "ok") failures.push(`self-check ${k}: ${v}`);
if (!Object.keys(hooks).length) failures.push("no heartbeat with the self-check");
if (!items.some((i) => i.kind === "blocked" && i.extension_id === "poc.stealer")) failures.push("no blocked report naming the stealer");
if (!items.some((i) => i.kind === "spawn" && i.extension_id === "poc.stealer")) failures.push("the shell launch was not attributed");
const has = (re) => probe.some((p) => re.test(p));
if (!has(/^tool window icon true/)) failures.push("the tool window has no icon");
if (!has(/^status bar "\d+ alerts?"/)) failures.push("the status bar does not count the alerts");
// antitheft's mark once, as the standing (the tool window's own title and icon say antitheft): no brand label
if (has(/^label "antitheft" \+icon/)) failures.push("the antitheft brand is repeated inside the tool window");
if (has(/^emblem /)) failures.push("the standing is a status row now, not an animated emblem");
if (has(/^label "Guard/i)) failures.push("the guard's own health is listed as activity");
if (!has(/^label "●&nbsp;Plugin working"/) || !has(/^label "●&nbsp;Antitheft installed"/)) failures.push("the status does not say the plugin works and antitheft is installed");
if (!has(/^button "Mark reviewed"/)) failures.push("an alert cannot be marked reviewed");
if (!has(/^button "Clear"/)) failures.push("the activity cannot be cleared");
if (!has(/^label "●&nbsp;Blocked"/)) failures.push("the severity is not the app's dot and word");
if (!has(/^label "plugins? watched"/) || !has(/^label "vaults? locked"/)) failures.push("the figures are missing");
if (!has(/^label "\d+ alerts? needs? you"/)) failures.push("the standing does not show the alerts");
// one stealer trying many routes to one vault is one card, with a count
// (the same card shows under Alerts and under Activity: count distinct labels)
const wallet = [...new Set(probe.filter((p) => /^label "POC Stealer tried to read your Exodus wallet/.test(p)))];
if (wallet.length !== 1 || !/×\d+/.test(wallet[0] ?? "")) failures.push(`repeated refusals of one vault are not one card with a count: ${wallet.join(" | ")}`);
if (!has(/^tab "Alerts · \d+"/) || !has(/^tab "Vaults"/) || !has(/^tab "Activity"/) || !has(/^tab "Plugins"/)) failures.push("the tabs are missing");
if (!has(/test stealer|poc\.stealer|POC Stealer/i)) failures.push("the stealer plugin is not named in the tool window");
if (!has(/^button "Disable plugin"/) || !has(/^button "Open in antitheft"/)) failures.push("the alert actions are missing");
// a shell running a script is named by the program it runs
if (!has(/^label "POC Stealer started cat"/)) failures.push("the shell launch is not named by the program it runs (expected \"started cat\")");
console.log(failures.length ? `FAILED:\n  ${failures.join("\n  ")}` : "PASSED");
if (process.argv.includes("--keep")) console.log(`kept: ${P}`);
else {
  try {
    fs.rmSync(P, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  } catch {}
}
process.exit(failures.length ? 1 : 0);
