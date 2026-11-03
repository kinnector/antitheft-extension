// The README screenshots: the extension in a real editor on a virtual display at 2x, against the demo antitheft
// (demo-daemon.mjs, made-up data), with a throwaway profile and stub copies of a few real extensions (manifest and
// icon only, nothing runs). Writes ../../../docs/screenshots/<screen>.png, which both READMEs show.
//
//   npm run build:dev && node test/shots/run.mjs <editor binary>      (Linux, needs Xvfb and ffmpeg)

import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..", "..");
const out = path.resolve(ext, "..", "docs", "screenshots");
const [binary] = process.argv.slice(2);
if (!binary) {
  console.error("usage: run.mjs <editor binary>");
  process.exit(2);
}
const W = 1600, H = 1000, SCALE = 2, DISPLAY = ":97";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "antitheft-shots-")));
const socket = path.join(tmp, "s.sock");
const log = path.join(tmp, "log.txt");
fs.writeFileSync(log, "");
fs.mkdirSync(out, { recursive: true });

// a few real extensions, as the editor lists them: their manifest (no code) and their icon
const stubs = [];
const real = path.join(os.homedir(), ".vscode-oss", "extensions");
for (const prefix of ["ms-python.python-", "rust-lang.rust-analyzer-", "ms-python.black-formatter-", "ms-pyright.pyright-", "k--kato.intellij-idea-keybindings-"]) {
  const dir = fs.existsSync(real) ? fs.readdirSync(real).find((d) => d.startsWith(prefix)) : null;
  if (!dir) continue;
  const pj = JSON.parse(fs.readFileSync(path.join(real, dir, "package.json"), "utf8"));
  const stub = path.join(tmp, "stubs", dir);
  fs.mkdirSync(stub, { recursive: true });
  const keep = { name: pj.name, displayName: pj.displayName, publisher: pj.publisher, version: pj.version, description: pj.description, icon: pj.icon, engines: { vscode: "^1.80.0" } };
  fs.writeFileSync(path.join(stub, "package.json"), JSON.stringify(keep));
  for (const f of ["package.nls.json", pj.icon].filter(Boolean)) {
    const from = path.join(real, dir, f);
    if (fs.existsSync(from)) {
      fs.mkdirSync(path.dirname(path.join(stub, f)), { recursive: true });
      fs.copyFileSync(from, path.join(stub, f));
    }
  }
  stubs.push(stub);
}

const settings = {
  "workbench.colorTheme": "Default Dark Modern",
  "window.newWindowDimensions": "fullscreen",
  "window.titleBarStyle": "custom",
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.layoutControl.enabled": false,
  "editor.minimap.enabled": false,
  "update.mode": "none",
  "extensions.autoCheckUpdates": false,
  "extensions.ignoreRecommendations": true,
  "telemetry.telemetryLevel": "off",
  "chat.commandCenter.enabled": false,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "window.commandCenter": false,
};
fs.mkdirSync(path.join(tmp, "ud", "User"), { recursive: true });
fs.writeFileSync(path.join(tmp, "ud", "User", "settings.json"), JSON.stringify(settings, null, 2));
fs.mkdirSync(path.join(tmp, "dev-project"));

const daemon = spawn(process.execPath, [path.join(here, "demo-daemon.mjs"), socket], { stdio: "inherit" });
const xvfb = spawn("Xvfb", [DISPLAY, "-screen", "0", `${W * SCALE}x${H * SCALE}x24`, "-nolisten", "tcp"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));

const args = [
  "--no-sandbox", `--force-device-scale-factor=${SCALE}`, `--window-size=${W},${H}`,
  "--user-data-dir", path.join(tmp, "ud"), "--extensions-dir", path.join(tmp, "ext"),
  "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--disable-telemetry",
  `--extensionDevelopmentPath=${ext}`,
  `--extensionDevelopmentPath=${path.join(here, "fixtures", "driver")}`,
  `--extensionDevelopmentPath=${path.join(here, "fixtures", "claude-code-assistant")}`,
  ...stubs.map((s) => `--extensionDevelopmentPath=${s}`),
  path.join(tmp, "dev-project"),
];
const env = { ...process.env, DISPLAY, ANTITHEFT_SOCKET: socket, ANTITHEFT_DEV_ASSUME_SERVICE: "1", SHOTS_LOG: log };
const editor = spawn(binary, args, { env, detached: true, stdio: "ignore" });

const taken = new Set();
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  const lines = fs.readFileSync(log, "utf8").split("\n");
  for (const l of lines.filter((x) => x.startsWith("SHOT "))) {
    const name = l.slice(5).trim();
    if (taken.has(name)) continue;
    taken.add(name);
    const file = path.join(out, `${name}.png`);
    // the whole screen without the pointer, then cropped to the editor's window (the screen around it is black)
    const raw = path.join(tmp, `${name}.raw.png`);
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-draw_mouse", "0", "-video_size", `${W * SCALE}x${H * SCALE}`, "-i", `${DISPLAY}.0`, "-frames:v", "1", raw]);
    // cropdetect reports on stderr
    const detect = spawnSync("ffmpeg", ["-i", raw, "-vf", "cropdetect=limit=0:round=2:reset=0:skip=0", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const crop = [...String(detect).matchAll(/crop=(\d+:\d+:\d+:\d+)/g)].pop()?.[1];
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", raw, ...(crop ? ["-vf", `crop=${crop}`] : []), file]);
    console.log(`captured ${file}`);
  }
  if (lines.includes("DONE")) break;
  await new Promise((r) => setTimeout(r, 300));
}
try {
  process.kill(-editor.pid, "SIGTERM");
} catch {
  editor.kill();
}
daemon.kill();
xvfb.kill();
await new Promise((r) => setTimeout(r, 2000));
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
console.log(taken.size ? `${taken.size} screenshots in ${out}` : "NO SCREENSHOTS");
process.exit(taken.size ? 0 : 1);
