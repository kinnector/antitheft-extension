// A test fixture posing as a malicious extension: tries every route to a decoy vault file and logs what
// worked. The file and the log come from the test (ANTITHEFT_TEST_VAULT, ANTITHEFT_TEST_LOG). It never
// touches anything else.
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const vm = require("vm");

const earlyRead = fs.readFileSync; // taken before antitheft's guard may load
const W = process.env.ANTITHEFT_TEST_VAULT;
const LOG = process.env.ANTITHEFT_TEST_LOG;
const log = (m) => fs.appendFileSync(LOG, `[stealer] ${m}\n`);
// a route's own file in the vault folder, so each refusal can be told apart in the reports
const F = (name) => path.join(path.dirname(W), `${name}.dat`);

async function t(name, f) {
  try {
    const r = await f();
    log(`READ  ${name} -> ${String(r).trim().slice(0, 30)}`);
  } catch (e) {
    log(`FAIL  ${name} -> ${(e && e.code) || ""} ${String((e && e.message) || e).split("\n")[0].slice(0, 80)}`);
  }
}

exports.activate = function () {
  const vscode = require("vscode");
  if (!W || !LOG) return;
  setTimeout(async () => {
    await t("fs.readFileSync", () => fs.readFileSync(W, "utf8"));
    await t("early-captured readFileSync", () => earlyRead(W, "utf8"));
    await t("fs.promises.readFile", () => fs.promises.readFile(W, "utf8"));
    await t("fs.readFile callback", () => new Promise((ok, no) => fs.readFile(W, "utf8", (e, d) => (e ? no(e) : ok(d)))));
    await t("fs.createReadStream", () => new Promise((ok, no) => { let d = ""; fs.createReadStream(W).on("data", (c) => (d += c)).on("end", () => ok(d)).on("error", no); }));
    await t("original-fs", () => require("original-fs").readFileSync(W, "utf8"));
    await t("ESM import(node:fs)", async () => (await import("node:fs")).readFileSync(W, "utf8"));
    await t("process.binding(fs)", () => process.binding("fs").readFileUtf8(W, 0));
    await t("worker", () => new Promise((ok, no) => { const { Worker } = require("worker_threads"); const w = new Worker("const {parentPort, workerData} = require('worker_threads'); parentPort.postMessage(require('fs').readFileSync(workerData, 'utf8'))", { eval: true, workerData: F("worker-eval") }); w.on("message", ok); w.on("error", no); }));
    await t("vscode.workspace.fs.readFile", async () => Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(W))).toString());
    await t("vscode.workspace.openTextDocument", () => Promise.race([vscode.workspace.openTextDocument(vscode.Uri.file(W)).then((d) => d.getText()), new Promise((_, no) => setTimeout(() => no(new Error("no answer in 5s")), 5000))]));
    await t("exec cat", () => cp.execSync(`cat "${W}"`).toString());
    await t("node child", () => {
      const out = cp.execFileSync(process.execPath, ["-e", "try { process.stdout.write(require('fs').readFileSync(process.env.W,'utf8')) } catch (e) { process.stdout.write('CHILD-REFUSED:' + e.code) }"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", W } }).toString();
      if (out.startsWith("CHILD-REFUSED:")) throw Object.assign(new Error(out), { code: out.slice(14) });
      return out;
    });
    const hidden = vm.runInThisContext('(function (r, w, log) { try { log("READ  vm function on a timer -> " + r("fs").readFileSync(w, "utf8").trim()); } catch (e) { log("FAIL  vm function on a timer -> " + e.code); } })');
    setTimeout(hidden, 0, require, F("vm-timer"), log);
    // reads with no extension frame on the stack when they happen: the function that reads is fs's own (or
    // code compiled under a file name outside every extension), reached through timers, microtasks and then
    const tramp = vm.runInThisContext("(function (f, a, ok, no) { try { ok(f.apply(null, a)); } catch (e) { no(e); } })", { filename: path.join(os.tmpdir(), "elsewhere", "trampoline.js") });
    await t("then(fs.readFileSync)", () => Promise.resolve(F("then-bare")).then(fs.readFileSync));
    await t("bound read after a timer", () => new Promise((ok) => setTimeout(ok, 0)).then(fs.readFileSync.bind(null, F("timer-bound"), "utf8")));
    await t("nextTick, no extension frame", () => new Promise((ok, no) => process.nextTick(tramp, fs.readFileSync, [F("nexttick"), "utf8"], ok, no)));
    await t("setImmediate, no extension frame", () => new Promise((ok, no) => setImmediate(tramp, fs.readFileSync, [F("immediate"), "utf8"], ok, no)));
    await t("timer then nextTick, no extension frame", () => new Promise((ok, no) => setTimeout(tramp, 0, process.nextTick, [tramp, fs.readFileSync, [F("two-hops"), "utf8"], ok, no], () => {}, no)));
    await t("downloaded script, on its own timer", () => new Promise((ok, no) => {
      const payload = path.join(os.tmpdir(), "devtools-hub-cache", "payload.js");
      fs.mkdirSync(path.dirname(payload), { recursive: true });
      fs.writeFileSync(payload, "module.exports = (f, ok, no) => setTimeout(() => { try { ok(require('fs').readFileSync(f, 'utf8')) } catch (e) { no(e) } }, 0);\n");
      delete require.cache[payload];
      require(payload)(F("payload"), ok, no);
    }));
    await t("vm function in a worker", () => new Promise((ok, no) => { const { Worker } = require("worker_threads"); const w = new Worker("const {parentPort, workerData} = require('worker_threads'); const f = require('vm').runInThisContext('(function (w) { return require(\\'fs\\').readFileSync(w, \\'utf8\\') })', { filename: '/elsewhere/x.js' }); setTimeout(() => { try { parentPort.postMessage({ ok: f(workerData) }) } catch (e) { parentPort.postMessage({ code: e.code }) } }, 0)", { eval: true, workerData: F("worker-vm") }); w.on("message", (m) => (m.code ? no(Object.assign(new Error(m.code), { code: m.code })) : ok(m.ok))); w.on("error", no); }));
    // download-then-run: write a program into a cache folder, make it executable, run it. The program
    // reads the vault by itself with its path hidden: only the operating system can stop that read; the
    // guard reports the write and the launch.
    const dir = path.join(os.tmpdir(), "devtools-hub-cache");
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === "win32") {
      const beacon = path.join(dir, "node-update.cmd");
      const ps = Buffer.from(`Get-Content -Raw ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(W).toString("base64")}')))`, "utf16le").toString("base64");
      fs.writeFileSync(beacon, `@powershell -NoProfile -EncodedCommand ${ps}\r\n`);
      await t("beacon (separate program, path hidden)", () => cp.execFileSync("cmd.exe", ["/c", beacon]).toString());
    } else {
      const beacon = path.join(dir, "node-update");
      fs.writeFileSync(beacon, `#!/bin/sh\ncat "$(echo ${Buffer.from(W).toString("base64")} | base64 -d)"\n`);
      fs.chmodSync(beacon, 0o755);
      await t("beacon (separate program, path hidden)", () => cp.execFileSync(beacon).toString());
    }
    setTimeout(() => log("DONE"), 1500);
  }, Number(process.env.ANTITHEFT_TEST_DELAY_MS || 8000));
};
