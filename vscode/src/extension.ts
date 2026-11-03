// antitheft for VS Code, Cursor, Windsurf and VSCodium. A companion to the antitheft app: everything here
// waits until antitheft is installed and protecting (`session.ts`).

import * as vscode from "vscode";
import * as path from "path";
import { Session } from "./session";
import { StatusBar } from "./views/statusBar";
import { Views } from "./views/webviews";
import { disableExtension } from "./views/extensionActions";
import type { FeedItem } from "./model";

/** One notification per extension per this long. */
const NOTIFY_EVERY_MS = 5 * 60 * 1000;

export function activate(context: vscode.ExtensionContext): void {
  const session = new Session(context, path.join(context.extensionPath, "dist", "guard.js"));
  const views = new Views(context, session);
  const status = new StatusBar(session, () => views.needsYou(), () => views.feedItems.find((i) => i.needsYou)?.title ?? null);
  context.subscriptions.push(session, views, status);

  const seen = new Set<string>();
  let primed = false;
  const lastNotified = new Map<string, number>();
  const notify = (i: FeedItem): void => {
    const who = i.extensionId ?? "?";
    const now = Date.now();
    if (now - (lastNotified.get(who) ?? 0) < NOTIFY_EVERY_MS) return;
    lastNotified.set(who, now);
    const actions = i.extensionId && i.extensionId !== "unknown" ? ["Show", "Disable extension"] : ["Show"];
    void vscode.window.showWarningMessage(`antitheft: ${i.title}. ${i.label === "BLOCKED" ? "It was blocked." : i.detail}`, ...actions).then((choice) => {
      if (choice === "Show") views.open("alerts");
      else if (choice === "Disable extension" && i.extensionId) void disableExtension(i.extensionId, i.extensionName ?? i.extensionId);
    });
  };

  context.subscriptions.push(
    session.onDidChange(() => {
      views.post();
      status.update();
      // new things that need the person: a notification each (none for what was there when the editor started)
      for (const i of views.feedItems) {
        if (seen.has(i.key)) continue;
        seen.add(i.key);
        if (primed && i.needsYou) notify(i);
      }
      primed = true;
    }),
    vscode.commands.registerCommand("antitheft.openAlerts", () => views.open("alerts")),
    vscode.commands.registerCommand("antitheft.openActivity", () => views.open("activity")),
    vscode.commands.registerCommand("antitheft.openVaults", () => views.open("vaults")),
    vscode.commands.registerCommand("antitheft.openExtensions", () => views.open("extensions")),
    vscode.commands.registerCommand("antitheft.openApp", async () => {
      if (!(await session.openApp("/"))) void vscode.window.showInformationMessage("antitheft's app was not found on this computer. Start it from your applications, or install antitheft.");
    }),
    vscode.commands.registerCommand("antitheft.recheck", () => session.recheck()),
  );
  void session.start();
}

export function deactivate(): void {
  /* the session is disposed with the context */
}
