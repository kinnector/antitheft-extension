import { test } from "node:test";
import assert from "node:assert/strict";
import { CulpritFinder, stackFiles } from "../src/guard/culprit";

const pick = (c: { id: string; builtin: boolean } | null) => (c ? { id: c.id, builtin: c.builtin } : null);

const roots = [
  { path: "/home/u/.vscode/extensions/devtools-hub.solidity-snippets-pro-1.4.2", id: "devtools-hub.solidity-snippets-pro", builtin: false },
  { path: "/home/u/.vscode/extensions/kinnector.antitheft-0.1.0", id: "kinnector.antitheft", builtin: false },
  { path: "/usr/share/code/resources/app/extensions/git", id: "vscode.git", builtin: true },
];

test("the first frame in an extension's folder names it, never this extension", () => {
  const f = new CulpritFinder(roots, "kinnector.antitheft", false);
  const stack = [
    "Error",
    "    at refuse (/home/u/.vscode/extensions/kinnector.antitheft-0.1.0/dist/extension.js:1:200)",
    "    at Object.readFileSync (node:fs:484:20)",
    "    at steal (/home/u/.vscode/extensions/devtools-hub.solidity-snippets-pro-1.4.2/out/main.js:10:5)",
    "    at async Promise.all (index 0)",
  ].join("\n");
  assert.deepEqual(pick(f.fromStack(stack)), { id: "devtools-hub.solidity-snippets-pro", builtin: false });
});

test("built-in extensions are named as built-in, unknown code as none", () => {
  const f = new CulpritFinder(roots, "kinnector.antitheft", false);
  assert.deepEqual(pick(f.fromStack("Error\n    at x (/usr/share/code/resources/app/extensions/git/dist/main.js:2:27526)")), { id: "vscode.git", builtin: true });
  assert.equal(f.fromStack("Error\n    at Timeout._onTimeout (evalmachine.<anonymous>:1:89)\n    at listOnTimeout (node:internal/timers:588:17)"), null);
});

test("a file: URL frame and a Windows frame", () => {
  const f = new CulpritFinder([{ path: "C:\\Users\\U\\.vscode\\extensions\\evil.ext-1.0.0", id: "evil.ext", builtin: false }], "kinnector.antitheft", true);
  assert.deepEqual(pick(f.fromStack("Error\n    at f (file:///C:/Users/U/.vscode/extensions/evil.ext-1.0.0/x.mjs:1:1)")), { id: "evil.ext", builtin: false });
  assert.deepEqual(pick(f.fromStack("Error\n    at f (c:\\users\\u\\.vscode\\extensions\\evil.ext-1.0.0\\x.js:1:1)")), { id: "evil.ext", builtin: false });
});

test("a nested extension folder wins over the folder that holds it", () => {
  const f = new CulpritFinder([{ path: "/x", id: "outer.ext", builtin: false }, { path: "/x/inner", id: "inner.ext", builtin: false }], "me.me", false);
  assert.equal(f.fromStack("Error\n    at f (/x/inner/a.js:1:1)")?.id, "inner.ext");
});

test("eval'd code names the extension that evaluated it", () => {
  const f = new CulpritFinder(roots, "kinnector.antitheft", false);
  const stack = "Error\n    at eval (eval at steal (/home/u/.vscode/extensions/devtools-hub.solidity-snippets-pro-1.4.2/x.js:3:9), <anonymous>:1:1)\n    at listOnTimeout (node:internal/timers:588:17)";
  assert.equal(f.fromStack(stack)?.id, "devtools-hub.solidity-snippets-pro");
  // code a guard tagged with the compiling extension's folder (vm)
  assert.equal(f.fromStack("Error\n    at Timeout._onTimeout (/home/u/.vscode/extensions/devtools-hub.solidity-snippets-pro-1.4.2/[runtime code]:1:89)")?.id, "devtools-hub.solidity-snippets-pro");
});

test("stack frames are read from both V8 shapes", () => {
  assert.deepEqual(stackFiles("Error\n    at a (/p/a.js:1:2)\n    at /p/b.js:3:4\n    at node:fs:1:1"), ["/p/a.js", "/p/b.js", "node:fs"]);
});

test("code an extension loads from outside its folder is its own, even under another extension's name", () => {
  const f = new CulpritFinder(roots, "kinnector.antitheft", false);
  const evil = { id: "devtools-hub.solidity-snippets-pro", builtin: false, path: roots[0].path };
  f.adopt("/tmp/devtools-hub-cache/payload.js", evil);
  assert.equal(f.fromStack("Error\n    at Timeout.run (/tmp/devtools-hub-cache/payload.js:3:9)")?.id, evil.id);
  // vm code compiled under a file name inside the git extension's folder still names its compiler
  f.adopt("/usr/share/code/resources/app/extensions/git/dist/fake.js", evil);
  assert.equal(f.fromStack("Error\n    at x (/usr/share/code/resources/app/extensions/git/dist/fake.js:1:1)")?.id, evil.id);
  assert.equal(f.fromStack("Error\n    at x (/usr/share/code/resources/app/extensions/git/dist/main.js:1:1)")?.id, "vscode.git");
  // a file in the extension's own folder is not adopted (it is already its own)
  f.adopt(roots[0].path + "/out/x.js", evil);
  assert.equal(f.fromStack(`Error\n    at x (${roots[0].path}/out/x.js:1:1)`)?.id, evil.id);
});
