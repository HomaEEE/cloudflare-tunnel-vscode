import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export type LocalSiteProvider = "herd" | "valet" | "mamp" | "generic";

export interface LocalSite {
  provider: LocalSiteProvider;
  path?: string;
  hostname: string;
  protocol: "http" | "https";
  port: number;
}

function normalizePath(value: string): string {
  return path.normalize(value).replace(/[\\/]$/, "");
}

function isSamePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

function parseUrl(value: string): {
  hostname: string;
  protocol: "http" | "https";
  port: number;
} | null {
  try {
    const url = new URL(value);

    if (!url.hostname || !["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    const protocol = url.protocol === "https:" ? "https" : "http";
    const defaultPort = protocol === "https" ? 443 : 80;
    const port = url.port ? Number(url.port) : defaultPort;

    return { hostname: url.hostname, protocol, port };
  } catch {
    return null;
  }
}

function firstString(
  object: Record<string, unknown>,
  keys: string[]
): string | undefined {
  return keys
    .map(key => object[key])
    .find(
      (value): value is string =>
        typeof value === "string" && Boolean(value.trim())
    )
    ?.trim();
}

function objectsFromJson(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item)
    );
  }

  if (typeof value !== "object" || value === null) {
    return [];
  }

  const object = value as Record<string, unknown>;

  return (
    [object.sites, object.data, object.results]
      .map(collection => objectsFromJson(collection))
      .find(result => result.length > 0) || []
  );
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("sh", ["-lc", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

function deduplicateSites(sites: LocalSite[]): LocalSite[] {
  const seen = new Set<string>();

  return sites.filter(site => {
    const key = `${site.hostname.toLowerCase()}|${site.port}|${site.protocol}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function parseHerdLinks(output: string): LocalSite[] {
  return output
    .split(/\r?\n/)
    .map(line => {
      const columns = line
        .split("|")
        .map(value => value.trim())
        .filter(Boolean);

      if (columns.length < 4) {
        return null;
      }

      const [, , rawUrl, sitePath] = columns;

      if (!rawUrl) {
        return null;
      }

      const parsed = parseUrl(rawUrl);

      return parsed
        ? { provider: "herd" as const, path: sitePath, ...parsed }
        : null;
    })
    .filter((site): site is LocalSite => site !== null);
}

function parseHerdSitesJson(output: string): LocalSite[] {
  try {
    const rows = objectsFromJson(JSON.parse(output));

    return rows
      .map(row => {
        const sitePath = firstString(row, ["path", "directory", "sitePath"]);
        const rawUrl = firstString(row, [
          "url",
          "siteUrl",
          "host",
          "hostname",
        ]);

        if (!rawUrl) {
          return null;
        }

        const parsed = parseUrl(
          rawUrl.includes("://") ? rawUrl : `http://${rawUrl}`
        );

        return parsed
          ? {
              provider: "herd" as const,
              path: sitePath,
              ...parsed,
            }
          : null;
      })
      .filter((site): site is LocalSite => site !== null);
  } catch {
    return [];
  }
}

async function detectHerdSites(): Promise<LocalSite[]> {
  if (!(await commandExists("herd"))) {
    return [];
  }

  try {
    const { stdout } = await execFileAsync("herd", ["sites", "--json"], {
      maxBuffer: 1024 * 1024,
    });
    const sites = parseHerdSitesJson(stdout);

    if (sites.length > 0) {
      return sites;
    }
  } catch {
    // Fall through to links/parked output.
  }

  try {
    const { stdout } = await execFileAsync("herd", ["links"], {
      maxBuffer: 1024 * 1024,
    });
    return parseHerdLinks(stdout);
  } catch {
    return [];
  }
}

function parseValetLinks(output: string): LocalSite[] {
  return output
    .split(/\r?\n/)
    .map(line => {
      const match = line.match(/^\s*([^\s]+)\s*=>\s*(.+)$/);

      if (!match) {
        return null;
      }

      const [, hostname, sitePath] = match;
      const normalizedHostname = hostname.endsWith(".test")
        ? hostname
        : `${hostname}.test`;

      return {
        provider: "valet" as const,
        path: sitePath.trim(),
        hostname: normalizedHostname,
        protocol: "http" as const,
        port: 80,
      };
    })
    .filter((site): site is LocalSite => site !== null);
}

async function detectValetSites(): Promise<LocalSite[]> {
  if (!(await commandExists("valet"))) {
    return [];
  }

  try {
    const { stdout } = await execFileAsync("valet", ["links"], {
      maxBuffer: 1024 * 1024,
    });

    return parseValetLinks(stdout);
  } catch {
    return [];
  }
}

async function detectMampSites(): Promise<LocalSite[]> {
  if (process.platform !== "darwin") {
    return [];
  }

  try {
    const script = [
      'const app = Application("MAMP PRO");',
      "const hosts = app.listAllHosts();",
      "JSON.stringify(hosts.map(host => String(host)));",
    ].join("\n");

    const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script]);
    const hosts = JSON.parse(stdout.trim()) as string[];

    return hosts
      .filter(hostname => Boolean(hostname))
      .map(hostname => ({
        provider: "mamp" as const,
        hostname,
        protocol: "http" as const,
        port: 8888,
      }));
  } catch {
    return [];
  }
}

function genericSite(workspacePath: string): LocalSite {
  const name = path.basename(workspacePath).toLowerCase();
  const safeName = name.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");

  return {
    provider: "generic",
    path: workspacePath,
    hostname: `${safeName || "site"}.test`,
    protocol: "http",
    port: 80,
  };
}

export async function detectLocalSites(workspacePath?: string): Promise<LocalSite[]> {
  const [herdSites, valetSites, mampSites] = await Promise.all([
    detectHerdSites(),
    detectValetSites(),
    detectMampSites(),
  ]);

  const allSites = deduplicateSites([
    ...herdSites,
    ...valetSites,
    ...mampSites,
  ]);

  if (!workspacePath) {
    return allSites;
  }

  const resolvedPath = fs.realpathSync.native(workspacePath);
  const currentSites = allSites.filter(site =>
    site.path ? isSamePath(site.path, resolvedPath) : false
  );

  if (currentSites.length > 0) {
    return [
      ...currentSites,
      ...allSites.filter(site => !currentSites.includes(site)),
    ];
  }

  const herdAvailable = herdSites.length > 0;
  const valetAvailable = valetSites.length > 0;

  if (!herdAvailable && !valetAvailable && mampSites.length === 0) {
    return [genericSite(resolvedPath)];
  }

  return allSites;
}
