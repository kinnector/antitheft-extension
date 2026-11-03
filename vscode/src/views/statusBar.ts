// The status-bar item: antitheft's standing in one word, or the alerts that need you. A click opens those alerts
// (the panel's Alerts tab) when there are some, the sidebar otherwise.

import * as vscode from "vscode";
import type { Session } from "../session";

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("antitheft.status", vscode.StatusBarAlignment.Right, 100);

  constructor(private readonly session: Session, private readonly needsYou: () => number, private readonly latest: () => string | null = () => null) {
    this.item.name = "antitheft";
    this.item.command = "workbench.view.extension.antitheft";
    this.update();
    this.item.show();
  }

  update(): void {
    const p = this.session.protection;
    const n = this.needsYou();
    this.item.backgroundColor = undefined;
    this.item.command = "workbench.view.extension.antitheft";
    switch (p.standing) {
      case "checking":
        this.item.text = "$(loading~spin) antitheft";
        this.item.tooltip = "antitheft: checking";
        break;
      case "not-installed":
        this.item.text = "$(shield) antitheft: one step left";
        this.item.tooltip = "Almost there: install antitheft and this editor is protected.";
        break;
      case "not-running":
        this.item.text = "$(circle-slash) antitheft";
        this.item.tooltip = "antitheft is installed but not running.";
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        break;
      case "paused":
        this.item.text = "$(debug-pause) antitheft paused";
        this.item.tooltip = p.pausedBy === "license" ? "antitheft is watching only: no licence on this computer." : "Protection is paused. Resume it in the antitheft app.";
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        if (n) {
          this.item.text = `$(debug-pause) antitheft paused · ${n} ${n === 1 ? "alert" : "alerts"}`;
          this.item.command = "antitheft.openAlerts";
        }
        break;
      case "protected":
        this.item.text = n ? `$(shield) ${n} ${n === 1 ? "alert" : "alerts"}` : "$(shield) antitheft";
        this.item.tooltip = n ? `${this.latest() ?? `${n} ${n === 1 ? "alert needs" : "alerts need"} you`}\nClick to see ${n === 1 ? "it" : "them"}` : "antitheft is protecting this editor";
        if (n) {
          this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
          this.item.command = "antitheft.openAlerts";
        }
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
