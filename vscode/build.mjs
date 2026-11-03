// Builds the extension: the extension host part, the guard that also boots alone in workers and Node
// children, and the webview. `--dev` keeps the development switches (environment variables read by
// src/dev.ts); a release build compiles them out. `--tests` also builds the unit tests into out-test/.
import { build } from "esbuild";
import { readdirSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dev = process.argv.includes("--dev");
const tests = process.argv.includes("--tests");
const define = { __DEV__: JSON.stringify(dev || tests) };
const common = { bundle: true, sourcemap: dev, minify: !dev && !tests, define, logLevel: "warning", target: "node18" };

rmSync("dist", { recursive: true, force: true });
await build({ ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", platform: "node", format: "cjs", external: ["vscode"] });
await build({ ...common, entryPoints: ["src/guard/boot.ts"], outfile: "dist/guard.js", platform: "node", format: "cjs" });
await build({ ...common, entryPoints: ["src/webview/main.ts"], outfile: "dist/webview.js", platform: "browser", format: "iife", target: "es2020" });
copyFileSync("src/webview/style.css", "dist/webview.css");

if (tests) {
  rmSync("out-test", { recursive: true, force: true });
  mkdirSync("out-test", { recursive: true });
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith(".test.ts")) files.push(join(d, e.name));
    }
  };
  walk("test");
  await build({ ...common, entryPoints: files, outdir: "out-test", platform: "node", format: "cjs", external: ["vscode", "jsdom"] });
}
