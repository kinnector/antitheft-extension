# UI design rules

Read before changing any screen: `vscode/src/views/`, `vscode/src/webview/`, `vscode/src/model.ts`, or the JetBrains
tool window.

## Rhythm

From unslop by Damir Sokolovsky (github.com/heydamir/unslop, CC BY 4.0; the header of `vscode/src/webview/style.css`
keeps the credit):

- spaces in steps of 4; radius 6 for panels, 4 inside them
- weights 400 and 500, 600 only for a title
- labels and section titles in sentence case (only the panel's tabs keep the editor's own uppercase); status words
  shown with `word()`; no trailing period on a one-line caption
- colour only where it means something (the standing, a refusal, a vault's state); no washes, gradients or glows
- one easing curve; nothing loops
- colours are the editor's theme variables; antitheft's marks (`media/`) are the branding; real icons (an
  extension's own, antitheft's for vaults and programs) before glyphs

`test/webview.test.ts` checks the grid, the weights and the absence of gradients and loops.

## Status and marks

- One antitheft mark per surface: the one in the status row. No logo or wordmark row inside the sidebar, the panel or
  the tool window.
- The status is a plain left-aligned row (mark, word, one line), never a tinted disc, a pulsing ring or a red frame.
- Under the status: "Extension working" and "antitheft installed / paused / not running / starting / not found"
  (chips start with a capital A: "Antitheft installed"). The status row and the status bar lead to the alerts.
- The guard's own health is never an activity row (only the status row's "Extension partly working").
- The paused mark is the "a." with a SOLID amber dot (light and dark files), never a hollow ring.
- No progress bar on the vaults.

## Words by platform

Only Linux refuses a read before the file opens. On Windows and macOS antitheft stops the program that reaches for a
vault, so nothing there says a read was blocked, refused or denied, or that a vault is locked: "Stopped" for the
severity, "stopped" in titles and figures, "vaults protected", "Other programs that reach for your N vaults are
stopped". One place decides: `vscode/src/words.ts` (`stopWords(platform)`, the platform is the editor's own) and
`Model.Words` in the JetBrains plugin. The guard's own refusal of a read inside the editor is a real refusal on every
system and keeps its words. Store descriptions and READMEs are true on all three ("kept for their own apps: other
programs are stopped, and on Linux refused before the file opens"). The examples below are Linux's.

## No licence is never only in small print

Paused by the licence: "Watching only / No licence on this computer", the chip "No licence, nothing blocked", one
sentence under the standing ("antitheft sees every read of your vaults but blocks none of them until this computer has
a licence."), Get a licence as a PRIMARY button (a user's own pause keeps its link), the panel's bar the same, the
status bar "antitheft: watching only" (eye). While anything but protected, nothing says "locked": the figure reads
"vaults watched", the Vaults tab "N found, watched only: nothing is blocked".

## Setup steps (until antitheft answers)

Standings from `daemon/protection.ts`; the same steps show with the step left marked.

- Not installed is a setup that is almost done, never a warning: "Almost there / One step left: install antitheft"
  (status bar "antitheft: one step left"), no coverage chips. Three steps: added to the editor (done), Install
  antitheft (the step left; "Get antitheft" opens the fixed `GET_ANTITHEFT` address in the host, never one the webview
  names), Protected ("switches on by itself": the socket watcher and retry notice the install, so no button). Joined by
  one vertical hairline. Each step's mark is the extension's status dot: ok colour done, link colour for the step left,
  muted next; never a checkmark, ring or step circle.
- Below the steps: "What is antitheft?", two short sentences ("Your wallets and passwords open only in their own apps.
  Anything else that tries, an extension included, is stopped and named.") and Learn more (`GET_ANTITHEFT`, opened by
  the host). Then a real antitheft alert as a picture (`vscode/media/alert-example.webp` /
  `jetbrains/plugin/resources/icons/alert-example.png`, the app's `AlertNotification` rendered by
  `vscode/test/shots/popup`, cropped to the card) that lands once per view, never with reduced motion.
- `no-access` (installed and running, but the socket `root:kinnector 0660` refuses this login; the installer's group
  change applies only at the next login; told apart from "not running" by `access(2)` on the socket, `socketRefused`):
  Continue in antitheft, with Open antitheft (starts the app on "/").
- Not running: Start antitheft with Check again. "What is antitheft?" only while not installed; no coverage chips until connected.
- Never name what is only watched (SSH keys, `.env`, cloud CLI credentials). No fear headline, no "coming soon".
- Do not use: glyph-tile points, three things with glass or boxed icons, rows of brand-icon stacks, an alert rebuilt
  from the extension's own parts, a long paragraph, a lone bold line, title tricks (two beats, a typed code comment, a
  notification header, a question).

## Alerts and activity

- Alerts look like the app's Alerts table: severity as a dot and Critical / Warning / Blocked (a block is Blocked,
  green), the app's one-sentence title for every kind (`model.ts` `otherTitle`, from antitheft's
  `ui/src/lib/alertTitles.ts`), the target, the actor's real icon (else the app's dashed initial, never a glyph tile)
  with the app's actor line ("Claude Code › rm": shells, init, sudo, timeout left out), when. Each tab has the app's
  page title and subtitle.
- **Who did it leads every alert row**: the extension's (plugin's) own icon first, else the program's (its launcher's
  when it has none, `iconSubject`), never the vault's; the vault's icon sits small beside the vault's name (JetBrains
  `iconFor` / `vaultIconFor`, VS Code `extIcon ?? programIcon`).
- Alerts are marked reviewed in antitheft (`/api/v1/alerts/{id}/reviewed`, `/alerts/reviewed {ids}`); the editor's own
  refusals have no record there, so the extension remembers those (globalState / PropertiesComponent `antitheft.reviewed`).
- Activity can be cleared (Activity tab, the sidebar's Recent): a time (`antitheft.activityClearedAt`), not a deletion;
  what still needs you stays on Alerts until reviewed.
- Vault icons: its own (`/api/v1/icon/<id>`), else its app's brand mark (`/icon/actor?title=<id>`), else its
  category's (`/icon/category/<category>`), as the app's `ActorIcon` does.

## JetBrains tool window

Content in a width-tracking `Page` (no sideways scrolling), scroll positions kept across a rebuild, one rebuild per
burst (`requestRender`); wrapping text uses `Para` (measures its height at its width); pictures `FitImage`; empty tabs
are the head plus one grey line.

## README screenshots

`vscode/test/shots/run.mjs` (a demo daemon with made-up data, a lookalike "Claude Code Assistant" as the thief, real
extensions as manifest-only stubs, Dark Modern at 2x on Xvfb, cropped to the window) writes `docs/screenshots/*.png`;
`overview.png` is alerts.png with the app's alert card over it, rendered by `vscode/test/shots/popup/` (its header
says how). The README links them by raw.githubusercontent.com address: an editor's Details page shows only images
from the web.
