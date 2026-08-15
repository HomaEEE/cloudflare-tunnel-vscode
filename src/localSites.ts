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

    return {
      hostname: url.hostname,
      protocol: url.protocol === "https:" ? "https" : "http",
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    };
  } catch {
    return null;
  }
}

function firstString(object: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function objectsFromJson(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item)
    );
  }

  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    const collections = [object.sites, object.data, object.results];

    for (const collection of collections) {
      const result = objectsFromJson(collection);
      if (result.length > 0) {
        return result;
      }
    }
  }

  return [];
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("sh", ["-lc", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
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

    for (const row of rows) {
      const sitePath = firstString(row, ["path", "directory", "sitePath"]);
      if (!sitePath || !isSamePath(sitePath, workspacePath)) {
        continue;
      }

      const rawUrl = firstString(row, ["url", "siteUrl", "host", "hostname"]);
      if (!rawUrl) {
        continue;
      }

      const parsed = parseUrl(rawUrl.includes("://") ? rawUrl : `http://${rawUrl}`);
      if (!parsed) {
        continue;
      }

      return {
        provider: "herd",
        path: sitePath,
        ...parsed,
      };
    }
  } catch {
    // Fall back to the table output below.
  }

  try {
    const { stdout } = await execFileAsync("herd", ["links"], {
      maxBuffer: 1024 * 1024,
    });
    const lines = stdout.split(/\r?\n/).filter(line => line.includes("|"));

    for (const line of lines) {
      const columns = line
        .split("|")
        .map(value => value.trim())
        .filter(Boolean);

      if (columns.length < 4 || !columns[3]) {
        continue;
      }

      const sitePath = columns[3];
      const rawUrl = columns[2];

      if (!isSamePath(sitePath, workspacePath) || !rawUrl) {
        continue;
      }

      const parsed = parseUrl(rawUrl);
      if (!parsed) {
        continue;
      }

      return {
        provider: "herd",
        path: sitePath,
        ...parsed,
      };
    }
  } catch {
    // Use the deterministic folder fallback below.
  }

  return null;
}

async function detectValetSites(workspacePath: string): Promise<LocalSite | null> {
  if (!(await commandExists("valet"))) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("valet", ["links"], {
      maxBuffer: 1024 * 1024,
    });
    const lines = stdout.split(/\r?\n/);

    for (const line of lines) {
      const match = line.match(/^\s*([^\s]+)\s*=>\s*(.+)$/);
      if (!match) {
        continue;
      }

      const [, hostname, sitePath] = match;
      if (!isSamePath(sitePath.trim(), workspacePath)) {
        continue;
      }

      return {
        provider: "valet",
        path: sitePath.trim(),
        hostname: hostname.endsWith(".test") ? hostname : `${hostname}.test`,
        protocol: "http",
        port: 80,
      };
    }
  } catch {
    // Use the deterministic folder fallback below.
  }

  return null;
}

function genericSite(workspacePath: string, provider: LocalSiteProvider): LocalSite {
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

export async function detectLocalSite(workspacePath?: string): Promise<LocalSite | null> {
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
