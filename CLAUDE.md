# antitheft-extension: contributor guide

The editor side of antitheft. Two packages, one design:

- `vscode/` (TypeScript): VS Code, Cursor, Windsurf, VSCodium. `src/guard/` is the in-process guard
  (`core.ts` hooks, `matcher.ts` salted-hash vault test, `culprit.ts` names the extension from a stack, `boot.ts` =
  `dist/guard.js`, booted in workers and Node children, `selfcheck.ts`). `src/session.ts` talks to antitheft (hello,
  heartbeat, reports, the alerts stream); `src/daemon/` is the socket client and the gating (`protection.ts`
  standings); `src/model.ts` turns events and alerts into what the screens show (pure, tested); `src/views/` and
  `src/webview/` are the status bar, sidebar and panel.
- `jetbrains/` (Java): the same for IntelliJ-platform IDEs, with a Java agent the plugin attaches to the running IDE.
  `./build.sh` builds antitheft's own copy, `./build.sh --store` the Marketplace copy.

## Read before working on

| Task | Read |
| --- | --- |
| any screen, wording, icon, alert row, setup step, the tool window, README screenshots | `docs/ui-design.md` |
| packaging, store submission, the hello and API numbers, reports, vault list, ACP bridge | `docs/distribution-and-protocol.md` |

## Rules that matter

- **Nothing runs before antitheft answers "protected" or "paused"** (`daemon/protection.ts`). Not installed and not
  running only show their state. Paused is connected (screens, alerts, extension controls), but the guard knows no
  vaults and refuses nothing. antitheft's `event: protection` on the alerts stream announces a pause, a resume or a
  licence change. Never poll for it.
- **Never hold a vault path in the editor's process.** Other extensions share it. Only antitheft's salted hashes
  (`/api/v1/ide/hello`), compared with `Matcher`. The vault list comes from `/api/v1/ide/vaults` (no paths), never
  `/api/v1/software`.
- **The guard never decides alone what antitheft decides.** It refuses reads of vaults inside the editor and reports
  what extensions start and write; allowing, pausing and every setting stay in the antitheft app ("Open in antitheft").
- **Webviews render with DOM calls only**, never `innerHTML`: extension names come from other extensions' manifests.
- **The guard's hooks are internals of Node and the editor** (`process.binding('fs')`, `spawn_sync`,
  `serializeRequest`): `selfcheck.ts` proves each one at start, and a missing one is reported, never ignored.
- **Reports go out as they happen, every one**: no polling, no batching by time.
- **One id, two copies** (store and antitheft's own); never a second entry. Raise `IDE_API` (here and in antitheft's
  `agent/src/ide/routes.rs`) only for a change an older counterpart would misread.
- **The JetBrains store build uses no internal IDE API and no reflection** to get around it; the verifier must say
  "Compatible" and nothing else.
- **Never add entries of our own to an IDE's agent list**; ACP agents run behind `antitheft-cli acp` transparently.
- No user-facing wording about how something was detected. Never name what is only watched (SSH keys, `.env`, cloud
  CLI credentials) as protected; while not protected nothing says "locked".
- One antitheft mark per surface (the status row). Colours are the editor's theme variables; no gradients, glows or
  loops; spaces in steps of 4 (`test/webview.test.ts` checks).

## Tests

`cd vscode && npm test` (unit tests and the guard end to end in a child Node process). JetBrains suite:
`cd jetbrains && node test/run.mjs <IDE folder> --xvfb`. README screenshots: `vscode/test/shots/run.mjs` (see `docs/ui-design.md`).
