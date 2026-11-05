# Distribution, versions and the antitheft protocol

Read before changing packaging, the hello/API numbers, the JetBrains store build, reports, or the ACP bridge.

## Two copies, one id

The marketplace listings (VS Code Marketplace, Open VSX, JetBrains Marketplace) are how people find the extension;
antitheft installs ITS copy, built with the daemon it talks to (`antitheft-cli editors --install`: the VSIX through the
editor's `--install-extension --force`, the JetBrains folder copied into `plugins/antitheft`), over a store copy if
there is one. Same id everywhere (`kinnector.antitheft`, `pro.antitheft`), never a second entry.

- VS Code, Cursor, VSCodium and Antigravity IDE record a VSIX install as `pinned: true, source: "vsix"` and never
  auto-update a pinned extension (turning auto-update on or clicking Update unpins it).
- JetBrains has no pin: "Update plugins automatically" replaces any installed `pro.antitheft` from the Marketplace at
  the next restart.
- The JetBrains zip carries its version in `antitheft/.antitheft-version` (`build.sh`). The Marketplace unpacks the zip
  under its root folder name, so the zip's root must stay `antitheft`.

## API numbers both ways

Versions can drift, so the hello carries an API number both ways: `api` in the request (`IDE_API`), `api` in the
answer (absent = 1).

- 404 on hello with no antitheft error code (an antitheft from before the editor API) or an answer below
  `MIN_DAEMON_API`: standing `update-antitheft`.
- 426 `extension_outdated` (antitheft's `MIN_EXTENSION_API`): `update-extension` (JetBrains `UPDATE_ANTITHEFT` /
  `UPDATE_PLUGIN`).
- Both show as a step left ("Almost there / One step left: update ..."), never "not running", and the guard stays off.
- Raise `IDE_API` (here and in antitheft's `agent/src/ide/routes.rs`) only for a change an older counterpart would misread.

## JetBrains store build

The store build has no internal IDE API (Marketplace approval refuses it; Plugin Verifier reports it).

- `./build.sh --store` writes `build-store/antitheft.zip`: `plugin/store/` replaces the matching files of
  `plugin/src/`, and the build fails if `com.intellij.ide.plugins.PluginEnabler`/`PluginManagerCore` is still named.
- The only difference is `DirectDisable`: antitheft's own copy disables a plugin from an alert at once
  (`PluginEnabler`); the store copy sends the person to Settings > Plugins, as Uninstall always does.
- Installed plugins are read from `PathManager.getPluginsDir()` by `Plugins` (each one's `META-INF/plugin.xml` and
  `pluginIcon.svg`), because every IDE call that returns or lists descriptors is internal in 2026.2. Never route around
  it with reflection: a reviewer reads that as evasion.
- Check before a submission: `check-plugin build-store/antitheft.zip <IDE>` must say "Compatible" and nothing else.

## Reports

Reports go out as they happen, every one (no polling, no batching by time): VS Code flushes the queue at once; the
JetBrains guard calls the plugin the moment it records an event (`Guard.onEvent`, set on connect, cleared on
disconnect; the 30 s sweep is only a backstop). A repeated launch is sent as `quiet: true`. Each item carries
`extension_name` and, once per connection, the extension's icon (`extension_icon`; VS Code: the manifest's `icon`
file; JetBrains: `META-INF/pluginIcon.svg`, ONLY from inside the plugin's own folder, compared as filesystem paths).
antitheft writes the extension onto its alerts.

## Vault list and icons

- The vault list comes from `/api/v1/ide/vaults` (names, states, the week's opens; no path), re-read on connect, a
  change of standing and alerts, at most every 20 s. Never `/api/v1/software` (it carries paths).
- The editor sees and counts only its own alerts and events (`/api/v1/ide/events`). REVIEWED goes to
  `POST /api/v1/ide/reviewed {ide_id, ids}` and marks them in this editor's own view only; `POST /api/v1/ide/clear
  {ide_id}` clears that view. The antitheft app's alert list (`/api/v1/alerts/reviewed`, `/api/v1/alerts/clear`)
  answers only the app.
- Icons from antitheft are JSON (`{content_type, data_base64}`, PNG or SVG; `daemon/client.ts` `imageData`).

## ACP agents behind the bridge (JetBrains)

When the IDE's agent code (`.acp.` packages, `com.agentclientprotocol.`, `Acp*` classes) starts an ACP agent
(claude-agent-acp, codex-acp, `agy acp`, `gemini --acp`, any `*-acp`), `Guard.bridgeAcpAgent` puts
`antitheft-cli acp --agent <id> --` in front of the same command while connected (`setBridge`,
`AntitheftService.bridgeProgram`). Never add entries of our own to an IDE's agent list (`~/.jetbrains/acp.json`). The
guard's refusal text tells an agent what happened and what to do (no access can be granted to a read the IDE makes).

## Reconnect

The JetBrains plugin reconnects by itself after a daemon restart (`scheduleRetry` clears its own future before
rechecking, every few seconds while installed).
