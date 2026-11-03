// The guard end to end, in a separate Node process (it rewrites that process's file layer): a temporary
// "vault" folder, the guard booted from the environment as it is in a Node child the editor starts, and
// every route a stealer would take.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const guardFile = resolve(__dirname, "..", "dist", "guard.js");

function state(vaultDir: string): string {
  const salt = "aabbccddeeff00112233445566778899";
  const h = (k: string) => createHash("sha256").update(Buffer.from(salt, "hex")).update(k).digest("hex").slice(0, 32);
  return JSON.stringify({ prefixes: { salt, dirs: [h(vaultDir)], files: [], rev: "t" }, windows: process.platform === "win32", decoys: [], roots: [], ownId: "kinnector.antitheft", home: tmpdir() });
}

const STEALER = String.raw`
const fs = require('fs'); const cp = require('child_process'); const path = require('path');
const W = process.env.W; const out = {};
const tryIt = async (name, f) => { try { await f(); out[name] = 'read'; } catch (e) { out[name] = e && e.code === 'EACCES' ? 'refused' : 'other:' + (e && e.message); } };
(async () => {
  await tryIt('readFileSync', () => fs.readFileSync(W));
  await tryIt('promises', () => fs.promises.readFile(W));
  await tryIt('callback', () => new Promise((ok, no) => fs.readFile(W, (e, d) => e ? no(e) : ok(d))));
  await tryIt('stream', () => new Promise((ok, no) => fs.createReadStream(W).on('data', () => {}).on('end', ok).on('error', no)));
  await tryIt('esm', async () => (await import('node:fs')).readFileSync(W));
  await tryIt('binding', () => process.binding('fs').readFileUtf8(W, 0));
  await tryIt('copy', () => fs.copyFileSync(W, path.join(process.env.OUT, 'copy')));
  await tryIt('readdir', () => fs.readdirSync(path.dirname(W)));
  await tryIt('rename', () => fs.renameSync(W, path.join(process.env.OUT, 'moved')));
  await tryIt('worker', () => new Promise((ok, no) => { const { Worker } = require('worker_threads'); const w = new Worker("require('fs').readFileSync(require('worker_threads').workerData)", { eval: true, workerData: W }); w.on('exit', (c) => c === 0 ? ok() : no(Object.assign(new Error('worker'), { code: 'EACCES' }))); w.on('error', no); }));
  await tryIt('spawnCat', () => cp.execFileSync('cat', [W]));
  await tryIt('execShell', () => cp.execSync('cat "' + W + '"'));
  await tryIt('nodeChild', () => { const r = cp.spawnSync(process.execPath, ['-e', "require('fs').readFileSync(process.env.W)"], { env: process.env }); if (r.status !== 0) throw Object.assign(new Error('child'), { code: 'EACCES' }); });
  await tryIt('unrelated', () => fs.readFileSync(path.join(process.env.OUT, 'ok.txt')));
  console.log(JSON.stringify(out));
})();
`;

test("every route to a vault is refused before the read, anything else works", { skip: process.platform === "win32" }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "antitheft-guard-")));
  const vault = join(base, "vault");
  const out = join(base, "out");
  mkdirSync(vault);
  mkdirSync(out);
  writeFileSync(join(vault, "wallet.dat"), "seed");
  writeFileSync(join(out, "ok.txt"), "fine");
  const res = execFileSync(process.execPath, ["--require", guardFile, "-e", STEALER], {
    env: { ...process.env, ANTITHEFT_GUARD_STATE: state(vault), W: join(vault, "wallet.dat"), OUT: out, NODE_OPTIONS: "" },
    encoding: "utf8",
  });
  const got = JSON.parse(res.trim().split("\n").pop()!);
  for (const route of ["readFileSync", "promises", "callback", "stream", "esm", "binding", "copy", "readdir", "rename", "worker", "spawnCat", "execShell", "nodeChild"]) {
    assert.equal(got[route], "refused", `${route}: ${got[route]}`);
  }
  assert.equal(got.unrelated, "read");
});
