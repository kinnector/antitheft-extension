import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { appIsRunning, appLaunch, isAppRoute } from "../src/daemon/launch";

test("only antitheft's own pages are opened", () => {
  for (const ok of ["/", "/alerts", "/alerts?id=7", "/activity", "/settings", "/vaults/x"]) assert.ok(isAppRoute(ok), ok);
  for (const bad of ["", "alerts", "//evil", "/account", "/alertsx", "https://x", "/alerts id", "/" + "a".repeat(200)]) assert.ok(!isAppRoute(bad), bad);
});

test("the installed app is started on the page, where each installer puts it", () => {
  const has = (...p: string[]) => (x: string) => p.includes(x);
  assert.deepEqual(appLaunch("/alerts?id=7", "linux", has("/usr/local/bin/antitheft"), {}), { command: "/usr/local/bin/antitheft", args: ["--open", "/alerts?id=7"] });
  assert.deepEqual(appLaunch("/", "linux", has("/usr/lib/antitheft/current/antitheft"), {}), { command: "/usr/lib/antitheft/current/antitheft", args: ["--open", "/"] });
  assert.deepEqual(appLaunch("/", "darwin", has("/Applications/Antitheft.app"), {}), { command: "/usr/bin/open", args: ["-a", "/Applications/Antitheft.app", "--args", "--open", "/"] });
  assert.deepEqual(appLaunch("/activity", "win32", has("D:\\PF\\Antitheft\\antitheft.exe"), { ProgramW6432: "D:\\PF" }), { command: "D:\\PF\\Antitheft\\antitheft.exe", args: ["--open", "/activity"] });
  assert.equal(appLaunch("/", "linux", has(), {}), null, "not installed");
  assert.equal(appLaunch("https://x", "linux", has("/usr/local/bin/antitheft"), {}), null, "never anything but an app page");
});

test("a running app is seen among this user's processes on Linux", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "at-proc-"));
  const proc = (pid: string, exe: string) => {
    fs.mkdirSync(path.join(root, pid));
    fs.symlinkSync(exe, path.join(root, pid, "exe"));
  };
  proc("10", "/usr/bin/bash");
  assert.equal(appIsRunning(root, "linux"), false);
  proc("20", "/usr/lib/antitheft/versions/0.1.2/antitheft");
  assert.equal(appIsRunning(root, "linux"), true);
  assert.equal(appIsRunning(path.join(root, "missing"), "linux"), true, "cannot look: trust the service");
  assert.equal(appIsRunning(root, "darwin"), true);
  fs.rmSync(root, { recursive: true, force: true });
});
