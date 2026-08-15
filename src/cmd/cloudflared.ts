import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventEmitter } from "events";
import { ChildProcess } from "child_process";
import logger from "../logger";
import CloudflaredDownloader from "./downloader";
import { CloudflareTunnel } from "../tunnel";
import ExecutableClient from "./executable";
import * as constants from "../constants";

// eslint-disable-next-line no-use-before-define
export let cloudflared: CloudflaredClient;

export class CloudflaredClient extends ExecutableClient {
  constructor(uri: vscode.Uri) {
    super(uri, constants.cloudflared);
  }

  async version(): Promise<string> {
    return this.exec(["--version"]);
  }

  private extractTunnelId(output: string, tunnelName: string): string | undefined {
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const line = output
      .split(/\r?\n/)
      .find(value => value.includes(tunnelName) && uuidPattern.test(value));

    return line?.match(uuidPattern)?.[0];
  }

  async createTunnel(tunnel: CloudflareTunnel): Promise<void> {
    const { tunnelName } = tunnel;
    const tunnels = await this.exec(["tunnel", "list"]);

    const existingId = this.extractTunnelId(tunnels, tunnelName);

    if (existingId) {
      tunnel.tunnelId = existingId;
      logger.info(`Using existing tunnel ${tunnelName} (${existingId})`);
      return;
    }

    logger.info(`Creating tunnel ${tunnelName}`);
    const output = await this.exec(["tunnel", "create", tunnelName]);
    const tunnelId = this.extractTunnelId(output, tunnelName) ?? output.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    )?.[0];

    if (!tunnelId) {
      throw new Error(`Unable to determine tunnel ID for ${tunnelName}.`);
    }

    tunnel.tunnelId = tunnelId;
  }

  async deleteTunnel(tunnel: CloudflareTunnel): Promise<void> {
    await this.exec(["tunnel", "delete", "-f", tunnel.tunnelName]);
  }

  async routeDns(tunnel: CloudflareTunnel): Promise<void> {
    if (!tunnel.hostname) {
      throw new Error("Cannot create a DNS route without a hostname.");
    }

    await this.exec([
      "tunnel",
      "route",
      "dns",
      "--overwrite-dns",
      tunnel.tunnelName,
      tunnel.hostname,
    ]);

    logger.info(
      `Creating route dns ${tunnel.hostname} for tunnel ${tunnel.tunnelName}`
    );
  }

  private createConfigPath(tunnel: CloudflareTunnel): string {
    return path.join(
      os.tmpdir(),
      `cloudflare-tunnel-vscode-${process.pid}-${Date.now()}.yml`
    );
  }

  createTunnelConfig(tunnel: CloudflareTunnel): void {
    if (!tunnel.tunnelId || !tunnel.hostname) {
      throw new Error("Tunnel credentials are not available.");
    }

    const configPath = this.createConfigPath(tunnel);
    const credentialsFile = path.join(
      os.homedir(),
      ".cloudflared",
      `${tunnel.tunnelId}.json`
    );

    const localServiceProtocol = tunnel.localProtocol === "https" ? "https" : "http";
    const originRequest = [
      `      httpHostHeader: ${tunnel.localHostname}`,
      ...(localServiceProtocol === "https" ? ["      noTLSVerify: true"] : []),
    ];

    const content = [
      `tunnel: ${tunnel.tunnelId}`,
      `credentials-file: ${JSON.stringify(credentialsFile)}`,
      "",
      "ingress:",
      `  - hostname: ${tunnel.hostname}`,
      `    service: ${localServiceProtocol}://127.0.0.1:${tunnel.port}`,
      "    originRequest:",
      ...originRequest,
      "  - service: http_status:404",
      "",
    ].join("\n");

    fs.writeFileSync(configPath, content, "utf8");
    tunnel.configPath = configPath;

    logger.info(`Created tunnel config ${configPath}`);
  }

  cleanupTunnelConfig(tunnel: CloudflareTunnel): void {
    if (!tunnel.configPath) {
      return;
    }

    try {
      fs.rmSync(tunnel.configPath, { force: true });
    } finally {
      tunnel.configPath = undefined;
    }
  }

  async startTunnel(tunnel: CloudflareTunnel): Promise<void> {
    const command = this.buildStartTunnelCommand(tunnel);

    tunnel.process = await this.spawn(command);
    this.subscribeForLogs(tunnel.process);
    tunnel.tunnelUri = await this.parseTunnelURI(tunnel);
  }

  private buildStartTunnelCommand(tunnel: CloudflareTunnel): string[] {
    if (tunnel.isQuickTunnel) {
      const command = ["tunnel", "--url", tunnel.url];

      if (tunnel.localProtocol === "https") {
        command.push("--no-tls-verify");
      }

      return command;
    }

    if (!tunnel.configPath) {
      throw new Error("Named tunnel configuration has not been created.");
    }

    return ["tunnel", "--config", tunnel.configPath, "run", tunnel.tunnelName];
  }

  private subscribeForLogs(process: ChildProcess | undefined): void {
    const logOutput = (data: Buffer) => {
      data
        .toString()
        .split("\n")
        .forEach((line: string) => logger.info(line));
    };

    process?.stdout?.on("data", logOutput);
    process?.stderr?.on("data", logOutput);
  }

  private parseTunnelURI(tunnel: CloudflareTunnel): Promise<string> {
    const process = tunnel.process!;

    return new Promise((resolve, reject) => {
      if (!process.stderr) {
        reject(new Error("cloudflared did not expose stderr."));
        return;
      }

      let isCancelled = false;

      const cancel = () => {
        if (!isCancelled) {
          process.stderr?.removeListener("data", onData);
        }
        isCancelled = true;
      };

      const onData = (data: Buffer) => {
        if (isCancelled) {
          return;
        }

        const lines = data.toString().split("\n");

        lines.forEach((line: string) => {
          const [, logLevel, ...extra] = line.split(" ");
          const info = extra
            .filter((word: string) => word && word !== " ")
            .join(" ");

          if (info.includes(".trycloudflare.com")) {
            const tunnelUri = info
              .split(" ")
              .find(word => word.endsWith(".trycloudflare.com"));

            if (tunnelUri) {
              cancel();
              resolve(tunnelUri);
              return;
            }
          }

          if (tunnel.hostname && info.includes("connIndex=")) {
            cancel();
            resolve(`https://${tunnel.hostname}`);
            return;
          }

          if (logLevel === "ERR") {
            void this.stop(tunnel);
            cancel();
            reject(new Error(info));
          }
        });
      };

      process.stderr.on("data", onData);
    });
  }

  async stop(tunnel: CloudflareTunnel): Promise<boolean> {
    return this.stopProcess(tunnel.process);
  }

  async login(emitter: EventEmitter): Promise<void> {
    const process = await this.spawn(["login"]);

    if (process.stdout && process.stderr) {
      process.stdout.on("data", (data: Buffer) => {
        data.toString().split("\n").forEach((line: string) => {
          logger.error(line);

          if (line.startsWith("You have an existing certificate")) {
            emitter.emit("error", new Error(line));
            emitter.emit("ended");
          }
        });
      });

      process.stderr.on("data", (data: Buffer) => {
        data.toString().split("\n").forEach((line: string) => {
          logger.info(line);

          if (line.includes(".cloudflare.com")) {
            emitter.emit("loginUrl", new URL(line));
          }

          if (line.endsWith(".pem")) {
            emitter.emit("credentialsFile", line);
            emitter.emit("ended");
          }
        });
      });
    }
  }

  async logout(credentialsFile: string): Promise<void> {
    if (credentialsFile) {
      fs.unlinkSync(credentialsFile);
    }
  }

  static async init(
    context: vscode.ExtensionContext
  ): Promise<CloudflaredClient> {
    const cloudflaredDownloader = new CloudflaredDownloader(context);
    const cloudflaredUri = await cloudflaredDownloader.get();

    cloudflared = new CloudflaredClient(cloudflaredUri);
    return cloudflared;
  }
}
