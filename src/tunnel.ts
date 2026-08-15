import { ChildProcess } from "child_process";
import { Publisher, Subscriber } from "./types";

export enum CloudflareTunnelStatus {
  starting = "Starting",
  running = "Running",
  stopping = "Stopping",
}

export class CloudflareTunnel implements Publisher {
  tunnelUri = "";
  tunnelId?: string;
  configPath?: string;
  process?: ChildProcess;
  #status: CloudflareTunnelStatus = CloudflareTunnelStatus.starting;
  private subscribers: Subscriber[] = [];

  constructor(
    public localHostname: string,
    public port: number,
    public hostname: string | null,
    public localOrigin: string,
    public localProtocol: "http" | "https" = "http"
  ) {
    this.localHostname = localHostname;
    this.port = port;
    this.hostname = hostname;
    this.localOrigin = localOrigin;
    this.localProtocol = localProtocol;
  }

  get url(): string {
    return this.localOrigin;
  }

  get localService(): string {
    return `${this.localProtocol}://${this.localHostname}:${this.port}`;
  }

  get label(): string {
    if (this.status === CloudflareTunnelStatus.running && this.tunnelUri) {
      return this.shortTunnelUri;
    }

    return this.hostname || this.localHostname;
  }

  get description(): string {
    const quickTunnel = this.isQuickTunnel ? "Quick Tunnel" : "Named Tunnel";

    return [
      this.localOrigin,
      this.hostname || "random Cloudflare URL",
      this.status,
      quickTunnel,
    ]
      .filter(Boolean)
      .join("\t");
  }

  get status(): CloudflareTunnelStatus {
    return this.#status;
  }

  set status(value: CloudflareTunnelStatus) {
    this.#status = value;
    this.notifySubscribers();
  }

  get tunnelName(): string {
    if (this.isQuickTunnel) {
      return "";
    }

    const name = this.hostname!
      .replace(/^https?:\/\//i, "")
      .replace(/[^a-zA-Z0-9.-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50);

    return `cloudflare-tunnel-vscode-${name || "local"}`;
  }

  get isQuickTunnel(): boolean {
    return this.hostname === null;
  }

  get shortTunnelUri(): string {
    return (this.tunnelUri || "").replace(/^https?:\/\//, "");
  }

  subscribe(subscriber: Subscriber): void {
    this.subscribers.push(subscriber);
    this.notifySubscribers();
  }

  notifySubscribers(): void {
    this.subscribers.forEach(subscriber => subscriber.refresh());
  }
}
