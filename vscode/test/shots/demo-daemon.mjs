// A demo antitheft for the README screenshots: the routes the extension uses, answered with made-up but believable
// data (a lookalike "Claude Code Assistant" extension from a fake publisher that drops and starts a program, refused a wallet; real-looking
// vaults with their real icons, saved in ./icons from what antitheft serves). Nothing here is anyone's real data.
//
//   node demo-daemon.mjs <socket>

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [socket] = process.argv.slice(2);
const now = () => Math.floor(Date.now() / 1000);
const t0 = now();
const ago = (min) => t0 - min * 60;
const THIEF = "claude-ai-tools.claude-code-assistant";
const DROP = "/home/dev/.cache/claude-code-assistant/claude-helper";

const events = [
  { seq: 1, at: ago(52), kind: "spawn", extension_id: "ms-python.python", command: "/usr/bin/python3 -m pylsp", pid: 4101 },
  { seq: 2, at: ago(47), kind: "spawn", extension_id: "rust-lang.rust-analyzer", command: "/home/dev/.cargo/bin/rust-analyzer", pid: 4120 },
  { seq: 3, at: ago(31), kind: "spawn", extension_id: "ms-python.black-formatter", command: "/usr/bin/python3 -m black --version", pid: 4188 },
  { seq: 4, at: ago(7), kind: "write", extension_id: THIEF, path: DROP },
  { seq: 5, at: ago(7), kind: "spawn", extension_id: THIEF, command: `${DROP} --silent`, pid: 4242 },
  { seq: 6, at: ago(6), kind: "blocked", extension_id: THIEF, op: "readFileUtf8", vault: { id: "chrome:nkbihfbeogaeaoehlefnkodbefgpgknn", name: "MetaMask", category: "software_wallet" } },
].map((e) => ({ ide_id: "ide-demo-1", ...e }));

const program = { pid: 4242, image_path: DROP, app: "claude-helper" };
const alerts = [
  {
    id: 4108, category: "alert", reviewed: false, paused: false, count: 3, kind: "storage_access", extension_id: THIEF,
    first_seen_unix: ago(5), last_seen_unix: ago(4),
    data: { verdict: "denied", access_response: "kill", app_name: "Google Chrome", resource_id: "chrome", data_category: "passwords", actor_process: program, actor_chain: [] },
  },
  {
    id: 4107, category: "alert", reviewed: false, paused: false, count: 1, kind: "storage_access", extension_id: THIEF,
    first_seen_unix: ago(5), last_seen_unix: ago(5),
    data: { verdict: "denied", access_response: "kill", app_name: "Exodus", resource_id: "exodus", data_category: "wallet", actor_process: program, actor_chain: [] },
  },
];

const v = (id, name, vendor, category, kind, status, files, allowed, refused = 0, parent = null) => ({
  id, name, vendor, category, kind, parent, status, files, locked: status === "protected" ? files : status === "partial" ? 1 : 0, week: { allowed, refused },
});
const vaults = [
  v("chrome:nkbihfbeogaeaoehlefnkodbefgpgknn", "MetaMask", "", "software_wallet", "wallets", "protected", 3, 214, 1, "chrome"),
  v("chrome:acmacodkjbdgmoleebolmdjonilkdbch", "Rabby Wallet", "", "software_wallet", "wallets", "protected", 3, 96, 0, "chrome"),
  v("chrome:egjidjbpglichdcondbcbdnbeeppgdph", "Trust Wallet", "", "software_wallet", "wallets", "protected", 2, 41, 0, "chrome"),
  v("exodus", "Exodus", "Exodus Movement", "software_wallet", "wallets", "protected", 4, 380, 1),
  v("electrum", "Electrum", "Electrum Technologies", "software_wallet", "wallets", "protected", 2, 58),
  v("monero_wallet_cli", "Monero CLI wallet", "The Monero Project", "software_wallet", "wallets", "watching", 2, 6),
  v("bitwarden", "Bitwarden", "Bitwarden Inc.", "password_manager", "passwords", "protected", 2, 1240),
  v("1password", "1Password", "AgileBits", "password_manager", "passwords", "protected", 3, 2310),
  v("chrome:bhghoamapcdpbohphigoooaddinpkbai:totp", "Authenticator", "", "totp_vault", "passwords", "protected", 2, 37, 0, "chrome"),
  v("gnome_keyring", "GNOME Keyring", "GNOME", "os_keychain", "passwords", "partial", 3, 5120),
  v("chrome", "Google Chrome", "Google", "browser_vault", "vaults", "protected", 7, 18400, 3),
  v("brave", "Brave", "Brave Software", "browser_vault", "vaults", "protected", 12, 9310),
  v("firefox", "Mozilla Firefox", "Mozilla", "browser_vault", "vaults", "protected", 4, 6020),
  v("signal", "Signal", "Signal Messenger", "messaging", "vaults", "protected", 2, 880),
  v("dropbox", "Dropbox", "Dropbox", "cloud_sync_client", "vaults", "protected", 2, 1410),
  v("telegram_desktop", "Telegram Desktop", "Telegram", "messaging", "vaults", "watching", 2, 640),
  v("openssh_client", "SSH keys", "", "ssh_material", "secrets", "watching", 9, 162),
  v("aws_cli", "AWS CLI", "Amazon", "dev_credential", "secrets", "watching", 2, 44),
  v("gh_cli", "GitHub CLI", "GitHub", "dev_credential", "secrets", "watching", 2, 73),
];

const icon = (file) => {
  try {
    return fs.readFileSync(path.join(here, "icons", file), "utf8");
  } catch {
    return null;
  }
};

const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

const streams = new Set();
const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (p.startsWith("/api/v1/icon/category/")) {
      const body = icon(`category_${decodeURIComponent(p.slice(22))}.json`);
      return body ? send(res, 200, body) : send(res, 404, { error: "no icon" });
    }
    if (p === "/api/v1/icon/actor") {
      const title = url.searchParams.get("title");
      const body = title ? icon(`${title.replace(/:/g, "_")}.json`) : null;
      return body ? send(res, 200, body) : send(res, 404, { error: "no icon" });
    }
    if (p.startsWith("/api/v1/icon/")) {
      const body = icon(`${decodeURIComponent(p.slice(13)).replace(/:/g, "_")}.json`);
      return body ? send(res, 200, body) : send(res, 404, { error: "no live icon" });
    }
    switch (`${req.method} ${p}`) {
      case "GET /api/v1/status":
        return send(res, 200, { enforcement_paused: false, protection_source_active: true, version: "0.2.0" });
      case "POST /api/v1/ide/hello":
        return send(res, 200, { ide_id: "ide-demo-1", heartbeat_secs: 60, prefixes: { salt: "00".repeat(16), dirs: [], files: [], rev: "demo" }, protection: { paused: false } });
      case "POST /api/v1/ide/health":
        return send(res, 200, { ok: true, rev: "demo", heartbeat_secs: 60, protection: { paused: false } });
      case "GET /api/v1/ide/vault-prefixes":
        return send(res, 200, { salt: "00".repeat(16), dirs: [], files: [], rev: "demo" });
      case "POST /api/v1/ide/report":
        return send(res, 200, { accepted: 0 });
      case "GET /api/v1/ide/events":
        return send(res, 200, { events, last_seq: events.length, alerts });
      case "GET /api/v1/ide/vaults":
        return send(res, 200, { vaults, week: { since_ms: (t0 - 6 * 86400) * 1000, groups: [] }, paused: false });
      case "POST /api/v1/ide/open-app":
        return send(res, 200, { ok: true });
      case "GET /api/v1/alerts/stream":
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": demo\n\n");
        streams.add(res);
        req.on("close", () => streams.delete(res));
        return;
      default:
        return send(res, 404, { error: "not in the demo" });
    }
  });
});
try {
  fs.unlinkSync(socket);
} catch {
  /* none yet */
}
server.listen(socket, () => console.log(`demo antitheft on ${socket}`));
