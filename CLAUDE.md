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
  starting / not found" (chips start with a capital A: "Antitheft installed"). No progress bar on the vaults.
- **No licence is never only in small print.** Paused by the licence: "Watching only / No licence on this computer",
  the chip "No licence, nothing blocked", one sentence of its own under the standing ("antitheft sees every read of
  your vaults but blocks none of them until this computer has a licence."), Get a licence as a PRIMARY button (the
  owner's pause keeps its link), the panel's bar the same, the status bar "antitheft: watching only" (eye). While
  anything but protected, nothing says "locked": the figure reads "vaults watched", the Vaults tab "N found,
  watched only: nothing is blocked". The paused mark is the "a." with a SOLID amber dot (light and dark files, like
  the alert's red one), never a hollow ring.
- **Two copies, one id: the store's and antitheft's own.** The marketplace listings (VS Code Marketplace, Open VSX,
  JetBrains Marketplace) are how people find the extension; antitheft installs ITS copy, built with the daemon it
  talks to (`antitheft-cli editors --install`: the VSIX through the editor's `--install-extension --force`, the
  JetBrains folder copied into `plugins/antitheft`), over a store copy if there is one. Same id everywhere
  (`kinnector.antitheft`, `pro.antitheft`), never a second entry. VS Code, Cursor, VSCodium and Antigravity IDE
  record a VSIX install as `pinned: true, source: "vsix"` and never auto-update a pinned extension (turning
  auto-update on or clicking Update unpins it). JetBrains has no pin: "Update plugins automatically" replaces any
  installed `pro.antitheft` from the Marketplace at the next restart. So the version can drift, and the hello
  carries an API number both ways: `api` in the request (`IDE_API`), `api` in the answer (absent = 1). 404 on hello
  with no antitheft error code (no such route: an antitheft from before the editor API) or an answer below
  `MIN_DAEMON_API` = standing `update-antitheft`; 426 `extension_outdated` (antitheft's `MIN_EXTENSION_API`) =
  `update-extension` (JetBrains `UPDATE_ANTITHEFT` / `UPDATE_PLUGIN`). Both are a step left ("Almost there / One
  step left: update ..."), never "not running", and the guard stays off. Raise `IDE_API` (here and in antitheft's
  `agent/src/ide/routes.rs`) only for a change an older counterpart would misread. The JetBrains zip carries its
  version in `antitheft/.antitheft-version` (`build.sh`), so a Marketplace copy reports its version too; the
  Marketplace unpacks the zip under its root folder name, so the zip's root must stay `antitheft`.
- **The JetBrains store build has no internal IDE API** (Marketplace approval refuses it; Plugin Verifier reports
  it). `./build.sh --store` writes `build-store/antitheft.zip`: `plugin/store/` replaces the matching files of
  `plugin/src/` and the build fails if `com.intellij.ide.plugins.PluginEnabler`/`PluginManagerCore` is still named.
  The only difference is `DirectDisable`: antitheft's own copy disables a plugin from an alert at once
  (`PluginEnabler`), the store copy sends the person to Settings > Plugins, as Uninstall always does. Everything else
  is one code path: installed plugins are read from `PathManager.getPluginsDir()` by `Plugins` (each one's
  `META-INF/plugin.xml` and `pluginIcon.svg`), because every IDE call that returns a descriptor by id or lists
  them is internal in 2026.2 (`PluginManagerCore.getPlugin`/`getPlugins`, `PluginManager.getLoadedPlugins`,
  `PluginUtils`). Never route around it with reflection: a reviewer reads that as evasion. Check with the verifier
  before a submission (`check-plugin build-store/antitheft.zip <IDE>`): store build = "Compatible" and nothing else.
- **Until antitheft answers, the same setup steps show, the step left marked** (`daemon/protection.ts` standings):
  not installed = Install antitheft; `no-access` (installed and running, but the socket, `root:kinnector 0660`,
  refuses this login: the installer's `usermod -a -G kinnector` only applies at the next login; told apart from
  "not running" by `access(2)` on the socket, `socketRefused`) = Continue in antitheft, with Open antitheft (starts the app on "/"; the app carries the person on); not running = Start antitheft
  with Check again. "What is antitheft?" only while not installed; no coverage chips until connected.
- **Not installed is a setup that is almost done, never a warning.** The standing reads "Almost there / One step
  left: install antitheft" (status bar "antitheft: one step left"), no coverage chips; below it three steps:
  added to the editor (done), Install antitheft (the step left, "Get antitheft" opens the fixed
  `GET_ANTITHEFT` address in the host, never one the webview names), Protected ("switches on by itself": the
  socket watcher and the retry notice the install, so there is no button for it), joined by one vertical
  hairline. Each step's mark is the extension's own status dot (as in "● Extension working"): ok colour done,
  link colour for the step left, muted next; never a checkmark, a ring or a step circle. Below the steps: "What
  is antitheft?", two short sentences ("Your wallets and passwords open only in their own apps. Anything else that
  tries, an extension included, is stopped and named.") and Learn more (the site, `GET_ANTITHEFT`, opened by the
  host). Then a REAL antitheft alert as a picture
  (`vscode/media/alert-example.webp` / `jetbrains/plugin/resources/icons/alert-example.png`, the app's own
  `AlertNotification` rendered by `vscode/test/shots/popup`, cropped to the card) that lands once per view, never
  with reduced motion. Never name what is only watched (SSH keys, `.env`, cloud CLI credentials). Tried and
  rejected: glyph-tile points, three things with glass or boxed icons, rows of brand-icon stacks, an alert
  rebuilt from the extension's own parts, a long paragraph (never read), a lone bold line, and title tricks (two
  beats, a typed code comment, a notification header, a question). No fear headline, no "coming soon".
- **Activity can be cleared** (Activity tab, the sidebar's Recent): a time (`antitheft.activityClearedAt`), not a
  deletion; what still needs you stays on Alerts until it is reviewed.
- **Who did it leads every alert row**: the extension's (plugin's) own icon first, else the program's (its launcher's
  when it has none, `iconSubject`), never the vault's; the vault's icon sits small beside the vault's name under the
  title (JetBrains `iconFor` / `vaultIconFor`, VS Code `extIcon ?? programIcon`).
- **Reports go out as they happen, every one** (no polling, no once-a-minute): VS Code flushes the queue at once; the
  JetBrains guard calls the plugin the moment it records an event (`Guard.onEvent`, set on connect, cleared on
  disconnect; the 30 s sweep is only a backstop). A repeated launch is sent as `quiet: true` (it names that process's
  alerts in antitheft, never listed again). Each item carries `extension_name` and, once per connection, the
  extension's icon (`extension_icon`, VS Code: the manifest's `icon` file; JetBrains: `META-INF/pluginIcon.svg`, ONLY
  from inside the plugin's own folder, compared as filesystem paths). antitheft writes the extension onto its alerts
  and the app shows it (antitheft CLAUDE.md "Which extension did it").
- **ACP agents run behind the bridge, transparently (JetBrains)**: when the IDE's agent code (`.acp.` packages,
  `com.agentclientprotocol.`, `Acp*` classes) starts an ACP agent (claude-agent-acp, codex-acp, agy acp, `gemini
  --acp`, any `*-acp`), `Guard.bridgeAcpAgent` puts `antitheft-cli acp --agent <id> --` in front of the same command,
  while connected (`setBridge`, `AntitheftService.bridgeProgram`). Never add entries of our own to an IDE's agent list
  (`~/.jetbrains/acp.json` entries were tried and REJECTED). The guard's refusal text tells an agent what happened and
  what to do (no access can be granted to a read the IDE makes).
- **The tool window (JetBrains)**: content in a width-tracking `Page` (no sideways scrolling), scroll positions kept
  across a rebuild, one rebuild per burst (`requestRender`); text that wraps uses `Para` (measures its height at its
  width; a JBLabel asked for one long line); pictures `FitImage`; empty tabs are the head plus one grey line. The plugin
  reconnects by itself after a daemon restart (`scheduleRetry` clears its own future before rechecking, every few
  seconds while installed).

README screenshots: `vscode/test/shots/run.mjs` (a demo daemon with made-up data, a lookalike "Claude Code
Assistant" as the thief, real extensions as manifest-only stubs, Dark Modern at 2x on Xvfb, cropped to the window)
writes `docs/screenshots/*.png`; `overview.png` is alerts.png with the app's own alert card over it, rendered by
`vscode/test/shots/popup/` (its header says how). The extension's README links them by their raw.githubusercontent.com address: an
editor's Details page shows only images from the web, never a file from the extension's folder or an inlined one.

Tests: `cd vscode && npm test` (unit tests and the guard end to end in a child Node process).
