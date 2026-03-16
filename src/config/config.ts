import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { AdapterError } from "../errors/adapterError.js";

export type PromptMode = "stdin" | "arg";

export type AppConfig = {
  port: number;
  host: string;
  defaultCwd: string;
  cursorBinPath: string;
  requestTimeoutMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  modelId: string;
  modelAliases: string[];
  acceptAnyModel: boolean;
  cursorModelArg: string;
  cursorDiscoverModels: boolean;
  cursorModelsArgs: string[];
  cursorModelsCacheTtlMs: number;
  cursorPromptMode: PromptMode;
  cursorPromptArg: string;
  cursorBaseArgs: string[];
  maxStdoutBytes: number;
  enableGreetingFastPath: boolean;
  greetingFastPathResponse: string;
  promptMaxConversationMessages: number;
  promptMaxMessageChars: number;
  promptMaxChars: number;
  responseCacheTtlMs: number;
  responseCacheMaxEntries: number;
  enableCursorSessions: boolean;
  cursorSessionFallbackToCwd: boolean;
  cursorSessionTtlMs: number;
  cursorSessionMaxEntries: number;
};

const parseInteger = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
};

const parseArgs = (raw: string | undefined): string[] => {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // fall through and use plain tokenization.
  }

  return raw
    .split(" ")
    .map((item) => item.trim())
    .filter(Boolean);
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
};

const parseAliases = (raw: string | undefined, canonicalModelId: string): string[] => {
  if (!raw) {
    return [canonicalModelId];
  }

  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.includes(canonicalModelId)) {
    return values;
  }

  return [canonicalModelId, ...values];
};

export const loadConfig = (): AppConfig => {
  const defaultCwd = resolve(process.env.DEFAULT_CWD ?? process.cwd());
  if (!existsSync(defaultCwd)) {
    throw new AdapterError(
      "INVALID_WORKING_DIRECTORY",
      `Configured DEFAULT_CWD does not exist: ${defaultCwd}`,
      500
    );
  }

  const promptMode = process.env.CURSOR_PROMPT_MODE === "arg" ? "arg" : "stdin";
  const modelId = process.env.CURSOR_MODEL_ID ?? "cursor-agent/default";

  return {
    port: parseInteger(process.env.ADAPTER_PORT, 8787),
    host: process.env.ADAPTER_HOST ?? "127.0.0.1",
    defaultCwd,
    cursorBinPath: process.env.CURSOR_BIN_PATH ?? "cursor-agent",
    requestTimeoutMs: parseInteger(process.env.REQUEST_TIMEOUT_MS, 120000),
    logLevel: (process.env.LOG_LEVEL as AppConfig["logLevel"]) ?? "info",
    modelId,
    modelAliases: parseAliases(process.env.CURSOR_MODEL_ALIASES, modelId),
    acceptAnyModel: parseBoolean(process.env.CURSOR_ACCEPT_ANY_MODEL, true),
    cursorModelArg: process.env.CURSOR_MODEL_ARG ?? "--model",
    cursorDiscoverModels: parseBoolean(process.env.CURSOR_DISCOVER_MODELS, true),
    cursorModelsArgs: parseArgs(process.env.CURSOR_MODELS_ARGS ?? "models"),
    cursorModelsCacheTtlMs: parseInteger(process.env.CURSOR_MODELS_CACHE_TTL_MS, 300_000),
    cursorPromptMode: promptMode,
    cursorPromptArg: process.env.CURSOR_PROMPT_ARG ?? "--prompt",
    cursorBaseArgs: parseArgs(process.env.CURSOR_BASE_ARGS),
    maxStdoutBytes: parseInteger(process.env.MAX_STDOUT_BYTES, 500_000),
    enableGreetingFastPath: parseBoolean(process.env.ENABLE_GREETING_FAST_PATH, true),
    greetingFastPathResponse:
      process.env.GREETING_FAST_PATH_RESPONSE ?? "Hi! What can I help you build or debug today?",
    promptMaxConversationMessages: parseInteger(process.env.PROMPT_MAX_CONVERSATION_MESSAGES, 10),
    promptMaxMessageChars: parseInteger(process.env.PROMPT_MAX_MESSAGE_CHARS, 2_000),
    promptMaxChars: parseInteger(process.env.PROMPT_MAX_CHARS, 12_000),
    responseCacheTtlMs: parseInteger(process.env.RESPONSE_CACHE_TTL_MS, 60_000),
    responseCacheMaxEntries: parseInteger(process.env.RESPONSE_CACHE_MAX_ENTRIES, 200),
    enableCursorSessions: parseBoolean(process.env.ENABLE_CURSOR_SESSIONS, true),
    cursorSessionFallbackToCwd: parseBoolean(process.env.CURSOR_SESSION_FALLBACK_TO_CWD, true),
    cursorSessionTtlMs: parseInteger(process.env.CURSOR_SESSION_TTL_MS, 1_800_000),
    cursorSessionMaxEntries: parseInteger(process.env.CURSOR_SESSION_MAX_ENTRIES, 500)
  };
};
