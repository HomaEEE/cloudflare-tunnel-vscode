import * as vscode from "vscode";
import { CloudflareTunnel, CloudflareTunnelStatus } from "../tunnel";
import { cloudflared } from "../cmd/cloudflared";
import { cloudflareTunnelProvider } from "../providers/tunnels";
import { cloudflareTunnelStatusBar } from "../statusbar/statusbar";
import { showErrorMessage, showInformationMessage } from "../utils";
import { globalState } from "../state/global";
import { config } from "../state/config";
import { detectLocalSite, LocalSite } from "../localSites";
import * as constants from "../constants";

const MAX_RECENT_LOCAL_ORIGINS = 10;

function normalizeBaseDomain(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/\.+$/, "")
    .toLowerCase();
}

function getSubdomain(hostname: string): string {
  const [firstLabel] = hostname.toLowerCase().split(".");
  const value = firstLabel.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");

  if (!value || value.startsWith("-") || value.endsWith("-")) {
    throw new Error(`Unable to derive a valid subdomain from ${hostname}.`);
  }

  return value;
}

function buildLocalOrigin(site: LocalSite): string {
  const defaultPort = site.protocol === "https" ? 443 : 80;
  const port = site.port === defaultPort ? "" : `:${site.port}`;

  return `${site.protocol}://${site.hostname}${port}`;
}

async function selectLocalOrigin(): Promise<{
  origin: string;
  hostname: string;
  protocol: "http" | "https";
  port: number;
}> {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const site = await detectLocalSite(workspacePath);

  if (site) {
    const origin = buildLocalOrigin(site);
    globalState.addRecentLocalOrigin(origin, MAX_RECENT_LOCAL_ORIGINS);

    return {
      origin,
      hostname: site.hostname,
      protocol: site.protocol,
      port: site.port,
    };
  }

  const recent = globalState.recentLocalOrigins;
  const items: vscode.QuickPickItem[] = [
    {
      label: "$(edit) Enter local origin...",
      description: "No Herd or Valet site was detected for this workspace",
    },
    ...recent.map(origin => ({
      label: origin,
      description: "Recent local origin",
    })),
  ];

  const selected = await vscode.window.showQuickPick(items, {
    title: "Local origin",
    placeHolder: "Select a recent origin or enter a new one",
    ignoreFocusOut: true,
  });

  if (!selected) {
    throw new Error("A local origin is required.");
  }

  let input: string | undefined;

  if (selected === items[0]) {
    input = await vscode.window.showInputBox({
      title: "Local origin",
      value: recent[0] || `${config.localHostname}:${config.defaultPort}`,
      placeHolder: "http://example.test or http://127.0.0.1:8080",
      prompt: "Enter the local origin that cloudflared should reach.",
      ignoreFocusOut: true,
    });
  } else {
    input = selected.label;
  }

  if (!input) {
    throw new Error("A local origin is required.");
  }

  const url = new URL(
    /^https?:\/\//i.test(input) ? input : `http://${input}`
  );
  const protocol = url.protocol === "https:" ? "https" : "http";
  const defaultPort = protocol === "https" ? 443 : 80;
  const port = url.port ? Number(url.port) : defaultPort;
  const origin = url.origin;

  globalState.addRecentLocalOrigin(origin, MAX_RECENT_LOCAL_ORIGINS);

  return {
    origin,
    hostname: url.hostname,
    protocol,
    port,
  };
}

async function resolvePublicHostname(
  localHostname: string
): Promise<string | null> {
  if (!globalState.isLoggedIn) {
    return null;
  }

  const baseDomain = normalizeBaseDomain(config.defaultHostname);

  if (!baseDomain) {
    return null;
  }

  const subdomain = getSubdomain(localHostname);
  const publicHostname = `${subdomain}.${baseDomain}`;

  if (cloudflareTunnelProvider.hasHostname(publicHostname)) {
    throw new Error(`Hostname is already in use: ${publicHostname}`);
  }

  return publicHostname;
}

async function createTunnel(): Promise<void> {
  try {
    const local = await selectLocalOrigin();
    const publicHostname = await resolvePublicHostname(local.hostname);

    const tunnel = new CloudflareTunnel(
      config.localHostname,
      local.port,
      publicHostname,
      local.origin,
      local.protocol
    );

    if (cloudflareTunnelProvider.hasLocalOrigin(local.origin)) {
      throw new Error(`A tunnel for ${local.origin} is already running.`);
    }

    cloudflareTunnelProvider.addTunnel(tunnel);
    tunnel.subscribe(cloudflareTunnelProvider);
    tunnel.subscribe(cloudflareTunnelStatusBar);

    try {
      await vscode.window.withProgress<void>(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Starting cloudflare tunnel for ${tunnel.url}. [(Show logs)](command:${constants.Commands.openOutputChannel})\n`,
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            void cloudflared.stop(tunnel);
            cloudflareTunnelProvider.removeTunnel(tunnel);
          });

          if (tunnel.hostname) {
            progress.report({ message: "Creating tunnel..." });
            await cloudflared.createTunnel(tunnel);

            progress.report({ message: "Creating tunnel config..." });
            cloudflared.createTunnelConfig(tunnel);

            progress.report({ message: "Creating route dns..." });
            await cloudflared.routeDns(tunnel);
          }

          progress.report({ message: "Starting tunnel..." });
          await cloudflared.startTunnel(tunnel);

          tunnel.process?.on("exit", () => {
            cloudflared.cleanupTunnelConfig(tunnel);
            cloudflareTunnelProvider.removeTunnel(tunnel);
          });
        }
      );

      tunnel.status = CloudflareTunnelStatus.running;

      await showInformationMessage(
        tunnel.hostname
          ? `Tunnel created: ${tunnel.hostname}`
          : "Quick Tunnel created",
        tunnel.tunnelUri
      );
    } catch (ex) {
      cloudflared.cleanupTunnelConfig(tunnel);
      cloudflareTunnelProvider.removeTunnel(tunnel);
      showErrorMessage(ex);
    }
  } catch (ex) {
    showErrorMessage(ex);
  }
}

export default createTunnel;
