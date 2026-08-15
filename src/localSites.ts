import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export type LocalSiteProvider = "herd" | "valet" | "generic";

export interface LocalSite {
  provider: LocalSiteProvider;
  path: string;
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
    let port: number;

    if (url.port) {
      port = Number(url.port);
    } else if (protocol === "https") {
      port = 443;
    } else {
      port = 80;
    }

    return {
      hostname: url.hostname,
      protocol,
      port,
    };
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

  return [object.sites, object.data, object.results]
    .map(collection => objectsFromJson(collection))
    .find(result => result.length > 0) || [];
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("sh", ["-lc", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

function parseHerdLinkLine(line: string, workspacePath: string): LocalSite | null {
  const columns = line
    .split("|")
    .map(value => value.trim())
    .filter(Boolean);

  if (columns.length < 4) {
    return null;
  }

  const [, , rawUrl, sitePath] = columns;

  if (!sitePath || !rawUrl || !isSamePath(sitePath, workspacePath)) {
    return null;
  }

  const parsed = parseUrl(rawUrl);

  return parsed
    ? {
        provider: "herd",
        path: sitePath,
        ...parsed,
      }
    : null;
}

async function detectHerdSites(workspacePath: string): Promise<LocalSite | null> {
  if (!(await commandExists("herd"))) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("herd", ["sites", "--json"], {
      maxBuffer: 1024 * 1024,
    });
    const rows = objectsFromJson(JSON.parse(stdout));

    const site = rows
      .map(row => {
        const sitePath = firstString(row, ["path", "directory", "sitePath"]);
        const rawUrl = firstString(row, ["url", "siteUrl", "host", "hostname"]);

        if (!sitePath || !rawUrl || !isSamePath(sitePath, workspacePath)) {
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
      .find(value => value !== null) || null;

    if (site) {
      return site;
    }
  } catch {
    // Fall through to herd links.
  }

  try {
    const { stdout } = await execFileAsync("herd", ["links"], {
      maxBuffer: 1024 * 1024,
    });

    return stdout
      .split(/\r?\n/)
      .filter(line => line.includes("|"))
      .map(line => parseHerdLinkLine(line, workspacePath))
      .find(value => value !== null) || null;
  } catch {
    return null;
  }
}

function parseValetLinkLine(
  line: string,
  workspacePath: string
): LocalSite | null {
  const match = line.match(/^\s*([^\s]+)\s*=>\s*(.+)$/);

  if (!match) {
    return null;
  }

  const [, hostname, sitePath] = match;
  const normalizedSitePath = sitePath.trim();

  if (!isSamePath(normalizedSitePath, workspacePath)) {
    return null;
  }

  return {
    provider: "valet",
    path: normalizedSitePath,
    hostname: hostname.endsWith(".test") ? hostname : `${hostname}.test`,
    protocol: "http",
    port: 80,
  };
}

async function detectValetSites(workspacePath: string): Promise<LocalSite | null> {
  if (!(await commandExists("valet"))) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("valet", ["links"], {
      maxBuffer: 1024 * 1024,
    });

    return stdout
      .split(/\r?\n/)
      .map(line => parseValetLinkLine(line, workspacePath))
      .find(value => value !== null) || null;
  } catch {
    return null;
  }
}

function genericSite(
  workspacePath: string,
  provider: LocalSiteProvider
): LocalSite {
  const name = path.basename(workspacePath).toLowerCase();
  const safeName = name.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");

  return {
    provider,
    path: workspacePath,
    hostname: `${safeName || "site"}.test`,
    protocol: "http",
    port: 80,
  };
}

export async function detectLocalSite(
  workspacePath?: string
): Promise<LocalSite | null> {
  if (!workspacePath) {
    return null;
  }

  const resolvedPath = fs.realpathSync.native(workspacePath);
  const herd = await detectHerdSites(resolvedPath);

  if (herd) {
    return herd;
  }

  const valet = await detectValetSites(resolvedPath);

  if (valet) {
    return valet;
  }

  if (await commandExists("herd")) {
    return genericSite(resolvedPath, "herd");
  }

  if (await commandExists("valet")) {
    return genericSite(resolvedPath, "valet");
  }

  return null;
}
