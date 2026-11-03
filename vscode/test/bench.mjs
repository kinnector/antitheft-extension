// What the guard costs per call, in a Node process like the extension host: the same work with and
// without the guard booted (300 vault folders, none of them touched).
//
//   npm run build && node test/bench.mjs
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const guard = resolve(fileURLToPath(import.meta.url), "..", "..", "dist", "guard.js");
const dir = mkdtempSync(join(tmpdir(), "antitheft-bench-"));
mkdirSync(join(dir, "proj", "src"), { recursive: true });
for (let i = 0; i < 50; i++) writeFileSync(join(dir, "proj", "src", `f${i}.ts`), "export const x = 1;\n".repeat(20));
const salt = randomBytes(16);
const h = (k) => createHash("sha256").update(salt).update(k).digest("hex").slice(0, 32);
const dirs = Array.from({ length: 300 }, (_, i) => h(`/home/u/.config/vault-${i}`));
const state = JSON.stringify({ prefixes: { salt: salt.toString("hex"), dirs, files: [], rev: "b" }, windows: false, decoys: [], roots: [], ownId: "me.me", home: "/home/u" });

const work = String.raw`
const fs = require('fs'); const path = require('path');
const D = process.env.D; const files = fs.readdirSync(path.join(D, 'proj', 'src')).map(f => path.join(D, 'proj', 'src', f));
const uri = { $mid: 1, scheme: 'file', path: path.join(D, 'proj', 'src', 'f1.ts') };
const p = Promise.resolve(1); const noop = () => {};
const time = (n, f) => { for (let i = 0; i < 2000; i++) f(i); const t = process.hrtime.bigint(); for (let i = 0; i < n; i++) f(i); return Number(process.hrtime.bigint() - t) / n; };
const out = {
  readFileSync: time(40000, i => fs.readFileSync(files[i % files.length])),
  readdirSync: time(20000, () => fs.readdirSync(path.join(D, 'proj', 'src'))),
  statSync: time(40000, i => fs.statSync(files[i % files.length])),
  'JSON.stringify (file URI)': time(100000, i => JSON.stringify([i, 'openTextDocument', uri])),
  'JSON.stringify (plain)': time(100000, i => JSON.stringify({ a: i, b: 'text', c: [1, 2, 3] })),
  // scheduling a callback (the guard keeps where it was scheduled)
  'promise.then': time(100000, () => p.then(noop)),
  'setTimeout + clearTimeout': time(50000, () => clearTimeout(setTimeout(noop, 1000))),
  'process.nextTick': time(100000, () => process.nextTick(noop)),
};
console.log(JSON.stringify(out));
`;
const run = (withGuard) =>
  JSON.parse(execFileSync(process.execPath, [...(withGuard ? ["--require", guard] : []), "-e", work], { env: { ...process.env, D: dir, ANTITHEFT_GUARD_STATE: withGuard ? state : "" }, encoding: "utf8" }).trim());
const base = run(false);
const guarded = run(true);
console.log("ns per call        without   with guard   extra");
for (const k of Object.keys(base)) console.log(`${k.padEnd(26)} ${base[k].toFixed(0).padStart(7)} ${guarded[k].toFixed(0).padStart(12)} ${(guarded[k] - base[k]).toFixed(0).padStart(7)}`);
