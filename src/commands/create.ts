import * as vscode from "vscode";
import { CloudflareTunnel, CloudflareTunnelStatus } from "../tunnel";
import { cloudflared } from "../cmd/cloudflared";
import { cloudflareTunnelProvider } from "../providers/tunnels";
import { cloudflareTunnelStatusBar } from "../statusbar/statusbar";
import { showErrorMessage, showInformationMessage } from "../utils";
import { globalState } from "../state/global";
import { config } from "../state/config";
import { detectLocalSites, LocalSite } from "../localSites";
import * as constants from "../constants";

const MAX_RECENT_LOCAL_ORIGINS = 10;

interface LocalSiteItem extends vscode.QuickPickItem {
  site?: LocalSite;
  manual?: boolean;
}

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

function providerLabel(provider: LocalSite["provider"]): string {
  const labels: Record<LocalSite["provider"], string> = {
    herd: "Herd",
    valet: "Valet",
    mamp: "MAMP",
    generic: "Local",
  };

  return labels[provider];
}

async function selectLocalOrigin(): Promise<{
  origin: string;
  hostname: string;
  protocol: "http" | "https";
  port: number;
}> {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const sites = await detectLocalSites(workspacePath);
  const currentPath = workspacePath || "";

  const items: LocalSiteItem[] = [
    {
      label: "$(edit) Enter local origin...",
      description: "Manual hostname, URL or custom port",
      manual: true,
    },
    ...sites.map(site => ({
      label: site.hostname,
      description: `${providerLabel(site.provider)}${
        site.path === currentPath ? " • current workspace" : ""
      } • ${buildLocalOrigin(site)}`,
      detail: site.path,
      site,
    })),
  ];

  const selected = await vscode.window.showQuickPick(items, {
    title: "Local site",
    placeHolder:
      sites.length > 0
        ? "Select a Herd / Valet / MAMP site or enter an origin manually"
        : "No local sites detected — enter an origin manually",
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!selected) {
    throw new Error("Local site selection was cancelled.");
  }

  if (selected.manual) {
    const recent = globalState.recentLocalOrigins;
    const input = await vscode.window.showInputBox({
      title: "Local origin",
      value: recent[0] || `${config.localHostname}:${config.defaultPort}`,
      placeHolder: "example.test, http://example.test:8080",
      prompt:
        "Enter the local virtual host or service that cloudflared should proxy to.",
      ignoreFocusOut: true,
      validateInput: value => {
        if (!value.trim()) {
          return "Local origin is required.";
        }

        try {
          const url = new URL(
            /^https?:\/\//i.test(value) ? value : `http://${value}`
          );

          if (!url.hostname) {
            return "Enter a valid local hostname.";
          }

          if (url.pathname !== "/" || url.search || url.hash) {
            return "Enter hostname and optional port only; paths are not supported.";
          }

          return undefined;
        } catch {
          return "Enter a valid hostname or URL.";
        }
      },
    });

    if (!input) {
      throw new Error("Local origin input was cancelled.");
    }

    const url = new URL(
      /^https?:\/\//i.test(input) ? input : `http://${input}`
    );
    const { hostname } = url;
    const protocol = url.protocol === "https:" ? "https" : "http";
    const defaultPort = protocol === "https" ? 443 : 80;
    const port = url.port ? Number(url.port) : defaultPort;
    const origin = url.origin;

    globalState.addRecentLocalOrigin(origin, MAX_RECENT_LOCAL_ORIGINS);

    return { origin, hostname, protocol, port };
  }

  if (!selected.site) {
    throw new Error("The selected local site is invalid.");
  }

  const { site } = selected;
  const origin = buildLocalOrigin(site);

  globalState.addRecentLocalOrigin(origin, MAX_RECENT_LOCAL_ORIGINS);

  return {
    origin,
    hostname: site.hostname,
    protocol: site.protocol,
    port: site.port,
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

    if (cloudflareTunnelProvider.hasLocalOrigin(local.origin)) {
      throw new Error(`A tunnel for ${local.origin} is already running.`);
    }

    const tunnel = new CloudflareTunnel(
      config.localHostname,
      local.port,
      publicHostname,
      local.origin,
      local.protocol
    );

    cloudflareTunnelProvider.addTunnel(tunnel);
    tunnel.subscribe(cloudflareTunnelProvider);
    tunnel.subscribe(cloudflareTunnelStatusBar);

    try {
      await vscode.window.withProgress<void>(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Starting Cloudflare Tunnel for ${tunnel.localOrigin}. [(Show logs)](command:${constants.Commands.openOutputChannel})\n`,
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            cloudflared.stop(tunnel);
            cloudflareTunnelProvider.removeTunnel(tunnel);
          });

          if (tunnel.hostname) {
            progress.report({ message: `Creating ${tunnel.tunnelName}...` });
            await cloudflared.createTunnel(tunnel);

            progress.report({ message: "Creating local routing config..." });
            cloudflared.createTunnelConfig(tunnel);

            progress.report({
              message: `Routing ${tunnel.hostname} to ${tunnel.localHostname}...`,
            });
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
