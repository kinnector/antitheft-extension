# antitheft-extension: contributor guide

The editor side of antitheft. Two packages, one design:

- `vscode/` (TypeScript): VS Code, Cursor, Windsurf, VSCodium. `src/guard/` is the in-process guard
  (`core.ts` hooks, `matcher.ts` salted-hash vault test, `culprit.ts` names the extension from a stack,
  `boot.ts` = `dist/guard.js`, booted in workers and Node children). `src/session.ts` talks to antitheft
  (hello, heartbeat, reports, the alerts stream); `src/daemon/` is the socket client and the gating;
  `src/model.ts` turns events and alerts into what the screens show (pure, tested); `src/views/` and
  `src/webview/` are the status bar, sidebar and panel.
- `jetbrains/` (Java): the same for IntelliJ-platform IDEs, with a Java agent the plugin attaches to the
  running IDE.

Rules that matter:

- **Nothing runs before antitheft answers "protected" or "paused"** (`daemon/protection.ts`). Not installed
  and not running only show their state. Paused is connected (screens, alerts, extension controls), but the
  guard knows no vaults and refuses nothing; antitheft's `event: protection` on the alerts stream announces a
  pause, a resume or a licence change. Never poll for it.
- **Never hold a vault path in the editor's process.** Other extensions share it. Only antitheft's salted
  hashes (`/api/v1/ide/hello`), compared with `Matcher`.
- **The guard never decides alone what antitheft decides.** It refuses reads of vaults inside the editor
  and reports what extensions start and write; allowing, pausing and every setting stay in the antitheft
  app ("Open in antitheft").
- **One antitheft mark per surface: the one in the status row.** The view's title, the tool window's stripe and the
  status bar already say antitheft; no logo or wordmark row inside the sidebar, the panel or the tool window.
- **The vault list comes from `/api/v1/ide/vaults`** (names, states, the week's opens; no path), re-read on
  connect, a change of standing and alerts, at most every 20 s. Never `/api/v1/software` (it carries paths).
- **Webviews render with DOM calls only**, never `innerHTML`: extension names come from other
  extensions' manifests.
- **Colours are the editor's theme variables**; antitheft's marks (`media/`) are the branding; real icons
  (an extension's own, antitheft's for vaults and programs) before glyphs.
- **The guard's hooks are internals of Node and the editor** (`process.binding('fs')`, `spawn_sync`,
  `serializeRequest`): the self-check (`selfcheck.ts`) proves each one at start, and a missing one is
  reported, never ignored.
- No user-facing wording about how something was detected.
- **Design rhythm** (from unslop by Damir Sokolovsky, github.com/heydamir/unslop, CC BY 4.0; the header of
  `vscode/src/webview/style.css` keeps the credit): spaces in steps of 4; radius 6 for panels, 4 inside them;
  weights 400 and 500, 600 only for a title; labels and section titles in sentence case (only the panel's tabs
  keep the editor's own uppercase), status words shown with `word()`; no trailing period on a one-line caption;
  colour only where it means something (the standing, a refusal, a vault's state), no washes, gradients or
  glows; one easing curve; nothing loops. The status is a plain left-aligned row (mark, word, one line), never a
  tinted disc, a pulsing ring or a red frame.
  `test/webview.test.ts` checks the grid, the weights and the absence of gradients and loops.
- **Icons from antitheft are JSON** (`{content_type, data_base64}`, PNG or SVG; `daemon/client.ts` `imageData`). A
  vault's icon is its own (`/api/v1/icon/<id>`), else its app's brand mark (`/icon/actor?title=<id>`), else its
  category's (`/icon/category/<category>`), as the app's `ActorIcon` does. The guard's own health is never an
  activity row (only the status row's "Extension partly working").
- **Alerts look like the app's Alerts table**: severity as a dot and Critical / Warning / Blocked
  (a block is Blocked, green), the app's one-sentence title for every kind (`model.ts` `otherTitle`, from
  `ui/src/lib/alertTitles.ts`), the target, the actor's real icon (else the app's dashed initial, never a glyph
  tile) with the app's actor line ("Claude Code › rm": shells, init, sudo, timeout left out), when. Each tab has
  the app's page title and subtitle. Alerts are marked reviewed in antitheft (`/api/v1/alerts/{id}/reviewed`,
  `/alerts/reviewed {ids}`; the app sees it); the editor's own refusals have no record there, so the extension
  remembers those (globalState / PropertiesComponent `antitheft.reviewed`). The status row and the status bar
  lead to the alerts; under the status: "Extension working" and "antitheft installed / paused / not running /
  starting / not found". No progress bar on the vaults.
- **Not installed is a setup that is almost done, never a warning.** The standing reads "Almost there / One step
  left: install antitheft" (status bar "antitheft: one step left"), no coverage chips; below it three steps:
  added to the editor (done), Install antitheft (the step left, "Get antitheft" opens the fixed
  `GET_ANTITHEFT` address in the host, never one the webview names), Protected ("switches on by itself": the
  socket watcher and the retry notice the install, so there is no button for it), joined by one vertical
  hairline. Each step's mark is the extension's own status dot (as in "● Extension working"): ok colour done,
  link colour for the step left, muted next; never a checkmark, a ring or a step circle. Then what switches on.
  No fear headline, no "coming soon".
- **Activity can be cleared** (Activity tab, the sidebar's Recent): a time (`antitheft.activityClearedAt`), not a
  deletion; what still needs you stays on Alerts until it is reviewed.

README screenshots: `vscode/test/shots/run.mjs` (a demo daemon with made-up data, a lookalike "Claude Code
Assistant" as the thief, real extensions as manifest-only stubs, Dark Modern at 2x on Xvfb, cropped to the window)
writes `docs/screenshots/*.png`; `overview.png` is alerts.png with the app's own alert card over it, rendered by
`vscode/test/shots/popup/` (its header says how). The extension's README links them by their raw.githubusercontent.com address: an
editor's Details page shows only images from the web, never a file from the extension's folder or an inlined one.

Tests: `cd vscode && npm test` (unit tests and the guard end to end in a child Node process).
