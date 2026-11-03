// Disable, uninstall, or show an extension: the editor's own extension management, only on the person's
// click, after a confirmation naming the extension. These are the editor's actions, not antitheft's
// decisions (those open the antitheft app).

import * as vscode from "vscode";

/** Command ids editors expose for disabling one extension by id, newest first. */
const DISABLE_COMMANDS = ["workbench.extensions.action.disableExtension", "workbench.extensions.disableExtension"];

export async function disableExtension(id: string, name: string): Promise<void> {
  const ok = await vscode.window.showWarningMessage(`Disable ${name}?`, { modal: true, detail: "It stops running in every window until you enable it again." }, "Disable");
  if (ok !== "Disable") return;
  const all = await vscode.commands.getCommands(true);
  const cmd = DISABLE_COMMANDS.find((c) => all.includes(c));
  if (cmd) {
    try {
      await vscode.commands.executeCommand(cmd, id);
      void vscode.window.showInformationMessage(`${name} is disabled.`, "Reload window").then((r) => r && vscode.commands.executeCommand("workbench.action.reloadWindow"));
      return;
    } catch {
      /* fall back to its page */
    }
  }
  // No command takes an id here: open its page, where Disable is one click.
  await showExtension(id);
  void vscode.window.showInformationMessage(`Click Disable on ${name}'s page.`);
}

export async function uninstallExtension(id: string, name: string): Promise<void> {
  const ok = await vscode.window.showWarningMessage(`Uninstall ${name}?`, { modal: true, detail: "It is removed from this editor." }, "Uninstall");
  if (ok !== "Uninstall") return;
  try {
    await vscode.commands.executeCommand("workbench.extensions.uninstallExtension", id);
    void vscode.window.showInformationMessage(`${name} is uninstalled.`, "Reload window").then((r) => r && vscode.commands.executeCommand("workbench.action.reloadWindow"));
  } catch (e) {
    void vscode.window.showErrorMessage(`${name} could not be uninstalled: ${String((e as Error)?.message ?? e)}`);
  }
}

export async function showExtension(id: string): Promise<void> {
  try {
    await vscode.commands.executeCommand("extension.open", id);
  } catch {
    await vscode.commands.executeCommand("workbench.extensions.search", `@id:${id}`);
  }
}
