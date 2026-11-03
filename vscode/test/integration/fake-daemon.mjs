// A stand-in for antitheft's API socket, for the editor integration test: answers the routes the extension
// uses, with ONE vault folder (given by its path, hashed like antitheft does), and writes every hello,
// heartbeat and report it receives to a JSON lines file the test reads.
//
//   node fake-daemon.mjs <socket> <vault-dir>[<path delimiter><vault-dir>...] <record.jsonl> [--paused]

import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const [socket, vaultArg, recordFile] = process.argv.slice(2);
const vaultDirs = vaultArg.split(path.delimiter).filter(Boolean);
const vaultDir = vaultDirs[0];
const paused = process.argv.includes("--paused");
const salt = crypto.randomBytes(16);
const hash = (k) => crypto.createHash("sha256").update(salt).update(k).digest("hex").slice(0, 32);
// as antitheft's ide::path_key: Windows paths case-folded with backslashes
const key = (p) => (process.platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p);
const prefixes = { salt: salt.toString("hex"), dirs: vaultDirs.map((d) => hash(key(d))), files: [], rev: "fake-1" };
const events = [];
let seq = 0;
const streams = new Set();
const record = (kind, body) => fs.appendFileSync(recordFile, JSON.stringify({ kind, at: Date.now(), body }) + "\n");

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const body = data ? JSON.parse(data) : null;
    switch (`${req.method} ${url.pathname}`) {
      case "GET /api/v1/status":
        return json(res, 200, { enforcement_paused: paused, protection_source_active: true, version: "0.1.1-fake" });
      case "POST /api/v1/ide/hello":
        record("hello", body);
        return json(res, 200, { ide_id: "ide-fake-1", heartbeat_secs: 15, prefixes, protection: { paused } });
      case "GET /api/v1/ide/vault-prefixes":
        return json(res, 200, prefixes);
      case "POST /api/v1/ide/health":
        record("health", body);
        return json(res, 200, { ok: true, rev: prefixes.rev, heartbeat_secs: 15, protection: { paused } });
      case "POST /api/v1/ide/report": {
        record("report", body);
        for (const it of body.items) {
          const hit = it.path ? vaultDirs.find((d) => key(it.path).startsWith(key(d))) : null;
          const vault = hit ? { id: path.basename(hit), name: hit === vaultDir ? "Exodus" : path.basename(hit), category: "wallet" } : null;
          events.push({ seq: ++seq, at: Math.floor(Date.now() / 1000), ide_id: body.ide_id, kind: it.kind, extension_id: it.extension_id, op: it.op, vault, path: it.path, command: it.command, pid: it.pid });
        }
        for (const s of streams) s.write(`event: alert\ndata: {"new":true}\n\n`);
        return json(res, 200, { accepted: body.items.length });
      }
      case "GET /api/v1/ide/events":
        return json(res, 200, { events, last_seq: seq, alerts: [] });
      // antitheft's icon routes answer JSON, {content_type, data_base64}
      case "GET /api/v1/icon/exodus":
      case "GET /api/v1/icon/category/ssh_material":
        return json(res, 200, { content_type: "image/png", data_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" });
      case "GET /api/v1/ide/vaults":
        return json(res, 200, {
          vaults: [
            { id: "exodus", name: "Exodus", vendor: "Exodus Movement", category: "software_wallet", kind: "wallets", parent: null, status: "protected", files: 3, locked: 3, week: { allowed: 12, refused: 1 } },
            { id: "openssh_client", name: "SSH keys", vendor: "", category: "ssh_material", kind: "secrets", parent: null, status: "watching", files: 4, locked: 0, week: { allowed: 30, refused: 0 } },
          ],
          week: { since_ms: 0, groups: [] },
          paused: false,
        });
      case "POST /api/v1/ide/open-app":
        record("open-app", body);
        return json(res, 200, { ok: true });
      case "GET /api/v1/alerts/stream":
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": hello\n\n");
        streams.add(res);
        req.on("close", () => streams.delete(res));
        return;
      default:
        return json(res, 404, { ok: false, error: "not here" });
    }
  });
});

try {
  fs.unlinkSync(socket);
} catch {}
server.listen(socket, () => record("listening", { socket }));
process.on("SIGTERM", () => process.exit(0));
