import { test } from "node:test";
import assert from "node:assert/strict";
import { commandLine, programOf } from "../src/commandLine";

test("a program in a folder with spaces stays one name", () => {
  const c = commandLine("C:\\Users\\U\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe", ["C:\\Users\\U\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe", "-e", "x"]);
  assert.equal(c, '"C:\\Users\\U\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" -e x');
  assert.equal(programOf(c), "Code.exe");
  assert.equal(programOf(commandLine("/Applications/Visual Studio Code.app/Contents/MacOS/Electron", ["/Applications/Visual Studio Code.app/Contents/MacOS/Electron"])), "Electron");
});

test("a shell running a script is shown as the script", () => {
  // child_process.exec on Unix
  assert.equal(programOf(commandLine("/bin/sh", ["/bin/sh", "-c", "curl -s https://x | sh"])), "curl");
  // child_process.exec on Windows: cmd /d /s /c "<line>", passed verbatim
  assert.equal(programOf(commandLine("C:\\WINDOWS\\system32\\cmd.exe", ["cmd.exe", "/d", "/s", "/c", '""C:\\Users\\U\\Temp Dir\\node-update.cmd" --quiet"'])), "node-update.cmd");
  // execFile("cmd.exe", ["/c", file])
  assert.equal(commandLine("cmd.exe", ["cmd.exe", "/c", "C:\\Users\\U\\AppData\\Local\\Temp\\x\\node-update.cmd"]), "C:\\Users\\U\\AppData\\Local\\Temp\\x\\node-update.cmd");
  assert.equal(programOf(commandLine("cmd.exe", ["cmd.exe", "/c", "C:\\a b\\node-update.cmd"])), "node-update.cmd");
  // PowerShell
  assert.equal(programOf(commandLine("powershell.exe", ["powershell.exe", "-NoProfile", "-Command", "iwr https://x -OutFile y.exe; ./y.exe"])), "iwr");
  assert.equal(programOf(commandLine("pwsh", ["pwsh", "-File", "C:\\a b\\run.ps1"])), "run.ps1");
});

test("a shell with no script is the shell, a plain launch is the program", () => {
  assert.equal(programOf(commandLine("/bin/bash", ["/bin/bash"])), "bash");
  assert.equal(programOf(commandLine("git", ["git", "status"])), "git");
  assert.equal(programOf(""), "");
});
