// The README screenshots' driver: opens antitheft's sidebar and each panel tab in turn, and writes "SHOT <name>"
// to the log once it has had time to draw; the runner captures the screen when it sees the line.
const fs = require("fs");
exports.activate = async function () {
  const vscode = require("vscode");
  const LOG = process.env.SHOTS_LOG;
  if (!LOG) return;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const say = (l) => fs.appendFileSync(LOG, l + "\n");
  await wait(9000);
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await vscode.commands.executeCommand("workbench.action.closePanel");
  await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
  await vscode.commands.executeCommand("workbench.view.extension.antitheft");
  for (const [cmd, name] of [["antitheft.openAlerts", "alerts"], ["antitheft.openVaults", "vaults"], ["antitheft.openExtensions", "extensions"], ["antitheft.openActivity", "activity"]]) {
    await vscode.commands.executeCommand(cmd);
    await wait(4000);
    say(`SHOT ${name}`);
    await wait(2500);
  }
  say("DONE");
};
