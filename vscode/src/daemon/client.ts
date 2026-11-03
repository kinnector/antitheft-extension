// antitheft's local API, over its socket (a Unix socket on Linux and macOS, a named pipe on Windows). Plain
// HTTP, one request per connection. Nothing here holds a credential: antitheft decides what a caller may do.

import * as http from "http";
import { dev } from "../dev";

export const DEFAULT_SOCKET = process.platform === "win32" ? "\\\\.\\pipe\\kinnector-antitheft-api" : "/var/run/kinnector/antitheft.sock";

export function socketPath(): string {
  return dev.socket() ?? DEFAULT_SOCKET;
}

export interface Answer<T> {
  status: number;
  body: T;
}

export class DaemonError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

/** One request; `null` when antitheft does not answer (not installed, not running). */
export function request<T>(method: string, path: string, body?: unknown, timeoutMs = 5000): Promise<Answer<T> | null> {
  return new Promise((resolve) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        socketPath: socketPath(),
        path,
        method,
        agent: false,
        headers: { connection: "close", ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed as T });
        });
        res.on("error", () => resolve(null));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on("error", () => resolve(null));
    req.end(data);
  });
}

/** A JSON answer that must be 2xx, or a DaemonError with antitheft's own sentence. */
export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const a = await request<T & { error?: string; code?: string }>(method, path, body);
  if (!a) throw new DaemonError("antitheft is not running", 0);
  if (a.status < 200 || a.status >= 300) throw new DaemonError((a.body && a.body.error) || `antitheft answered ${a.status}`, a.status, a.body?.code);
  return a.body;
}

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/;

/** An icon answer as a data: URL: raw image bytes, or antitheft's JSON form `{content_type, data_base64}` (what its
 *  `/api/v1/icon/...` routes send). Image types only; anything else is null. */
export function imageData(contentType: string, body: Buffer): string | null {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (IMAGE_TYPES.test(type)) return `data:${type};base64,${body.toString("base64")}`;
  if (type !== "application/json") return null;
  try {
    const j = JSON.parse(body.toString("utf8")) as { content_type?: unknown; data_base64?: unknown };
    const t = typeof j.content_type === "string" ? j.content_type.toLowerCase() : "";
    if (!IMAGE_TYPES.test(t) || typeof j.data_base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(j.data_base64)) return null;
    return `data:${t};base64,${j.data_base64}`;
  } catch {
    return null;
  }
}

/** An image (an app's or a vault's icon) as a data: URL, or null. */
export function image(path: string, timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: socketPath(), path, method: "GET", agent: false, headers: { connection: "close" } }, (res) => {
      const type = String(res.headers["content-type"] ?? "");
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 512 * 1024) req.destroy();
        else chunks.push(c);
      });
      res.on("end", () => resolve(res.statusCode === 200 ? imageData(type, Buffer.concat(chunks)) : null));
      res.on("error", () => resolve(null));
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

export interface StreamHandle {
  close(): void;
}

/**
 * Server-sent events (`GET /api/v1/alerts/stream`). `onEvent` gets each event's name and data; `onEnd`
 * once, when the connection ends for any reason (the caller decides whether to reconnect).
 */
export function stream(path: string, onEvent: (name: string, data: string) => void, onEnd: () => void): StreamHandle {
  let ended = false;
  const end = () => {
    if (!ended) {
      ended = true;
      onEnd();
    }
  };
  const req = http.request({ socketPath: socketPath(), path, method: "GET", agent: false, headers: { accept: "text/event-stream", connection: "keep-alive" } }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      return end();
    }
    res.setEncoding("utf8");
    let buf = "";
    let name = "message";
    let data: string[] = [];
    res.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line === "") {
          if (data.length) onEvent(name, data.join("\n"));
          name = "message";
          data = [];
        } else if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (buf.length > 1 << 20) req.destroy();
    });
    res.on("end", end);
    res.on("error", end);
    res.on("close", end);
  });
  req.on("error", end);
  req.end();
  return { close: () => req.destroy() };
}
