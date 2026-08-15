import * as vscode from "vscode";
import { CloudflareTunnel, CloudflareTunnelStatus } from "../tunnel";

export default class CloudflareTunnelTreeItem extends vscode.TreeItem {
  constructor(public tunnel: CloudflareTunnel) {
    super(tunnel.label, vscode.TreeItemCollapsibleState.None);
  }

  override description: string = this.tunnel.description;
  override contextValue: string = this.tunnel.status;

  // @ts-expect-error: TS2611
  override get iconPath(): vscode.ThemeIcon {
    if (this.tunnel.status === CloudflareTunnelStatus.running) {
      const runningIconColor = new vscode.ThemeColor("charts.orange");
      return new vscode.ThemeIcon("cloud", runningIconColor);
    }

    return new vscode.ThemeIcon("sync~spin");
  }

  // @ts-expect-error: TS2611
  override get tooltip(): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**Local site**: \`${this.tunnel.localOrigin}\``);
    tooltip.appendMarkdown(
      `\n\n**Public**: ${
        this.tunnel.tunnelUri
          ? `[${this.tunnel.shortTunnelUri}](${this.tunnel.tunnelUri})`
          : "Starting..."
      }`
    );
    tooltip.appendMarkdown(`\n\n**Status**: ${this.tunnel.status}`);

    if (this.tunnel.isQuickTunnel) {
      tooltip.appendMarkdown("\n\n**Mode**: Quick Tunnel");
    } else {
      tooltip.appendMarkdown(`\n\n**Public hostname**: ${this.tunnel.hostname}`);
      tooltip.appendMarkdown(`\n\n**Herd/Valet Host**: ${this.tunnel.localHostname}`);
      tooltip.appendMarkdown(`\n\n**Tunnel name**: ${this.tunnel.tunnelName}`);
    }

    return tooltip;
  }
}
