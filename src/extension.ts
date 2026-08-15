import * as vscode from "vscode";
import { CloudflaredClient } from "./cmd/cloudflared";
import commands from "./commands/index";
import { cloudflareTunnelProvider } from "./providers/tunnels";
import { GlobalState } from "./state/global";
import * as constants from "./constants";
import { setContext } from "./utils";

let cloudflared: CloudflaredClient;

export async function activate(context: vscode.ExtensionContext) {
  // Set context as a global as some tests depend on it
  // @ts-expect-error: TS7017
  global.testExtensionContext = context;

  const globalState = GlobalState.init(context);

  cloudflared = await CloudflaredClient.init(context);

  commands.forEach(callback => {
    const commandId = `${constants.prefix}.${callback.name}`;
    const command = vscode.commands.registerCommand(commandId, callback);
    context.subscriptions.push(command);
  });

  vscode.window.registerTreeDataProvider(
    constants.Views.list,
    cloudflareTunnelProvider
  );

  setContext(constants.Context.isLoggedIn, globalState.isLoggedIn);
}

export async function deactivate() {
  const { tunnels } = cloudflareTunnelProvider;

  for (const tunnel of tunnels) {
    if (tunnel.process) {
      await cloudflared.stop(tunnel);
    }

    cloudflared.cleanupTunnelConfig(tunnel);

    if (!tunnel.isQuickTunnel) {
      await cloudflared.deleteTunnel(tunnel);
    }
  }
}
