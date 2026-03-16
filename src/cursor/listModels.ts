import { spawn } from "node:child_process";

import type { AppConfig } from "../config/config.js";
import { AdapterError } from "../errors/adapterError.js";

const dedupe = (values: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    if (seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    output.push(trimmed);
  }

  return output;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readStringProperty = (value: unknown, key: string): string | null => {
  if (!isRecord(value)) {
    return null;
  }

  const property = value[key];
  if (typeof property !== "string") {
    return null;
  }

  return property;
};

const collectModelIdsFromJson = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }

  if (!isRecord(value) && !Array.isArray(value)) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectModelIdsFromJson(item));
  }

  const id = readStringProperty(value, "id");
  if (id) {
    return [id];
  }

  const model = readStringProperty(value, "model");
  if (model) {
    return [model];
  }

  if (Array.isArray(value.models)) {
    return collectModelIdsFromJson(value.models);
  }

  if (Array.isArray(value.data)) {
    return collectModelIdsFromJson(value.data);
  }

  const nestedValues = Object.values(value);
  return nestedValues.flatMap((item) => collectModelIdsFromJson(item));
};

// Strips ANSI escape sequences (cursor movement, color codes, etc.)
// eslint-disable-next-line no-control-regex
const ANSI_RE = new RegExp("\u001b\\[[0-9;]*[A-Za-z]", "g");
const stripAnsi = (value: string): string => value.replace(ANSI_RE, "");

// Matches lines like "gpt-5.3-codex - GPT-5.3 Codex" or "gpt-5.3-codex - GPT-5.3 Codex (current)"
// The model ID is the slug before the first " - ".
const MODEL_LINE_RE = /^([a-z0-9][a-z0-9._-]*)\s+-\s+.+$/i;

const parseModelIds = (stdout: string): string[] => {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    const modelIds = collectModelIdsFromJson(parsed);
    if (modelIds.length > 0) {
      return dedupe(modelIds);
    }
  } catch {
    // Fallback to plain-text line parsing.
  }

  const fromLines = trimmed
    .split(/\r?\n/g)
    .map((line) => stripAnsi(line).trim())
    .map((line) => {
      // Extract just the slug from "slug - Human Name" lines.
      const match = MODEL_LINE_RE.exec(line);
      if (match) {
        return match[1];
      }

      return null;
    })
    .filter((id): id is string => id !== null);

  return dedupe(fromLines);
};

export const listCursorModels = (config: AppConfig, cwd: string): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const child = spawn(config.cursorBinPath, config.cursorModelsArgs, {
      cwd,
      stdio: "pipe",
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settleResolve = (value: string[]): void => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
    };

    const settleReject = (error: AdapterError): void => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    const timeoutHandle = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
      settleReject(
        new AdapterError(
          "CURSOR_TIMEOUT",
          `Cursor model listing timed out after ${config.requestTimeoutMs}ms.`,
          504
        )
      );
    }, config.requestTimeoutMs);
    timeoutHandle.unref();

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeoutHandle);
      if (error.code === "ENOENT") {
        settleReject(
          new AdapterError(
            "CURSOR_BIN_NOT_FOUND",
            `Cursor binary not found at '${config.cursorBinPath}'.`,
            500
          )
        );
        return;
      }

      settleReject(new AdapterError("INTERNAL_ERROR", "Failed to list Cursor models.", 500));
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);

      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        settleReject(
          new AdapterError("CURSOR_NON_ZERO_EXIT", "Cursor model listing failed.", 502, {
            exitCode,
            stderr: stderr.trim()
          })
        );
        return;
      }

      const modelIds = parseModelIds(stdout);
      if (modelIds.length === 0) {
        settleReject(
          new AdapterError("CURSOR_MALFORMED_OUTPUT", "Cursor model listing returned no models.", 502, {
            stdout: stdout.trim(),
            stderr: stderr.trim()
          })
        );
        return;
      }

      settleResolve(modelIds);
    });
  });
