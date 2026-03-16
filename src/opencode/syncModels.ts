import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AppConfig } from "../config/config.js";

type ModelEntry = {
  name: string;
};

type OpenCodeConfig = {
  provider?: {
    cursor?: {
      models?: Record<string, ModelEntry>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

const OPENCODE_CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode.json");

// Maps cursor-agent model slugs to human-readable names, using the display
// names returned by `cursor-agent models` when available.
const toDisplayName = (slug: string, rawName?: string): string => {
  if (rawName) {
    return rawName;
  }

  return slug
    .replace(/-/g, " ")
    .replace(/\bgpt\b/gi, "GPT")
    .replace(/\b(\d+\.\d+)\b/g, "$1")
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

// Parses lines like "slug - Human Name  (current)" into { slug, name }.
const parseModelLine = (line: string): { slug: string; name: string } | null => {
  const match = /^([a-z0-9][a-z0-9._-]*)\s+-\s+(.+?)(?:\s+\(.*\))?\s*$/i.exec(line);
  if (!match) {
    return null;
  }

  return { slug: match[1], name: match[2].trim() };
};

export const syncOpenCodeModels = async (config: AppConfig, logger: { info: (msg: string) => void; warn: (msg: string) => void }): Promise<void> => {
  if (!config.cursorDiscoverModels) {
    return;
  }

  // Read cursor-agent models output to get both slugs and display names.
  let rawStdout = "";
  try {
    await new Promise<void>((resolve, reject) => {

      const child = spawn(config.cursorBinPath, ["models"], {
        cwd: config.defaultCwd,
        stdio: "pipe",
        env: process.env
      });

      child.stdout.on("data", (chunk: Buffer) => {
        rawStdout += chunk.toString();
      });

      child.on("error", reject);
      child.on("close", (code: number) => {
        if (code !== 0) {
          reject(new Error(`cursor-agent models exited with code ${code}`));
        } else {
          resolve();
        }
      });
    });
  } catch (err) {
    logger.warn(`syncModels: failed to run cursor-agent models — ${String(err)}`);
    return;
  }

  // Parse slug + display name from each line.
  const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, "");
  const models: Record<string, ModelEntry> = {};

  for (const raw of rawStdout.split(/\r?\n/)) {
    const line = stripAnsi(raw).trim();
    const parsed = parseModelLine(line);
    if (parsed) {
      models[parsed.slug] = { name: toDisplayName(parsed.slug, parsed.name) };
    }
  }

  if (Object.keys(models).length === 0) {
    logger.warn("syncModels: no models parsed from cursor-agent output, skipping opencode.json update");
    return;
  }

  // Read existing opencode.json, update the cursor provider models block.
  let existing: OpenCodeConfig = {};
  try {
    const raw = await readFile(OPENCODE_CONFIG_PATH, "utf8");
    existing = JSON.parse(raw) as OpenCodeConfig;
  } catch {
    // File doesn't exist or isn't valid JSON — start fresh.
  }

  existing.provider ??= {};
  existing.provider.cursor ??= {};
  existing.provider.cursor.models = models;

  await writeFile(OPENCODE_CONFIG_PATH, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  logger.info(`syncModels: wrote ${Object.keys(models).length} models to ${OPENCODE_CONFIG_PATH}`);
};
