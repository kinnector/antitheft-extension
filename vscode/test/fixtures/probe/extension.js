// A test fixture: writes the editor's extension-management commands to the test log, so the extension
// knows which command disables one extension by id in this editor.
const fs = require("fs");
exports.activate = async function () {
  const vscode = require("vscode");
  const LOG = process.env.ANTITHEFT_TEST_LOG;
  if (!LOG) return;
  const all = await vscode.commands.getCommands(true);
  const wanted = all.filter((c) => /extension/i.test(c) && /(disable|enable|uninstall|open)/i.test(c));
  fs.appendFileSync(LOG, `[probe] ${vscode.env.appName} ${vscode.version} commands: ${wanted.join(" ")}\n`);
  // open antitheft's views once the stealer has run, so their code runs in the real editor
  setTimeout(async () => {
    for (const cmd of ["workbench.view.extension.antitheft", "antitheft.openAlerts", "antitheft.openActivity", "antitheft.openVaults", "antitheft.openExtensions"]) {
      try {
        await vscode.commands.executeCommand(cmd);
        fs.appendFileSync(LOG, `[probe] ran ${cmd}\n`);
        await new Promise((r) => setTimeout(r, 2500)); // let the view render and report before the next
      } catch (e) {
        fs.appendFileSync(LOG, `[probe] FAILED ${cmd}: ${e && e.message}\n`);
      }
    }
  }, Number(process.env.ANTITHEFT_TEST_DELAY_MS || 8000) + 6000);
};
