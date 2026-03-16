import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { resolve } from "node:path";

import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import type { AppConfig } from "../config/config.js";
import { buildCursorPrompt } from "../cursor/buildPrompt.js";
import { createCursorChat } from "../cursor/createChat.js";
import { listCursorModels } from "../cursor/listModels.js";
import { parseCursorOutput } from "../cursor/parseOutput.js";
import { runCursor, type RunCursorResult } from "../cursor/runCursor.js";
import { consumeStreamJsonChunk, createStreamJsonState } from "../cursor/streamJson.js";
import { AdapterError, asAdapterError } from "../errors/adapterError.js";
import {
  type ChatCompletionRequest,
  chatCompletionRequestSchema
} from "../providers/openaiSchemas.js";
import { SessionStore } from "../sessions/sessionStore.js";

type CreateServerInput = {
  config: AppConfig;
};

type CacheEntry = {
  expiresAt: number;
  assistantText: string;
};

type ModelsCacheEntry = {
  expiresAt: number;
  modelIds: string[];
};

const CONVERSATION_ID_CANDIDATE_KEYS = [
  "conversationId",
  "conversation_id",
  "threadId",
  "thread_id",
  "sessionId",
  "session_id",
  "chatId",
  "chat_id"
] as const;

const makeChatResponse = (assistantText: string, model: string) => ({
  id: `chatcmpl-${randomUUID()}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: assistantText
      },
      finish_reason: "stop"
    }
  ],
  usage: {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  }
});

const makeStreamChunk = (
  completionId: string,
  model: string,
  delta: Record<string, string>,
  finishReason: "stop" | null
) => ({
  id: completionId,
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [
    {
      index: 0,
      delta,
      finish_reason: finishReason
    }
  ]
});

const makeSseChatPayload = (assistantText: string, model: string): string => {
  const completionId = `chatcmpl-${randomUUID()}`;
  const events = [
    makeStreamChunk(completionId, model, { role: "assistant" }, null),
    makeStreamChunk(completionId, model, { content: assistantText }, null),
    makeStreamChunk(completionId, model, {}, "stop")
  ];

  const serializedEvents = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return `${serializedEvents}data: [DONE]\n\n`;
};

const writeSsePayload = (rawReply: ServerResponse, payload: unknown): void => {
  rawReply.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const extractMessageText = (message: ChatCompletionRequest["messages"][number]): string => {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
    .join("\n");
};

const PREFERRED_WORKING_DIRECTORY_KEYS = [
  "workspacePath",
  "workspace_path",
  "projectPath",
  "project_path",
  "repoPath",
  "repo_path",
  "root",
  "rootPath",
  "root_path"
] as const;

const CWD_WORKING_DIRECTORY_KEYS = ["cwd", "workingDirectory", "working_directory"] as const;

const PREFERRED_WORKING_DIRECTORY_HEADER_KEYS = [
  "x-workspace-path",
  "x-opencode-workspace-path",
  "x-project-path",
  "x-repo-path",
  "x-root-path"
] as const;

const CWD_WORKING_DIRECTORY_HEADER_KEYS = ["x-opencode-cwd", "x-working-directory", "x-cwd"] as const;

const WORKSPACE_PATH_FROM_MESSAGE_REGEX =
  /(Workspace|Project|Repo|Root)\s*(?:Path|Directory)?\s*:\s*(.+?)(?:\r?\n|$)/i;
const CWD_FROM_MESSAGE_REGEX = /\bcwd\s*:\s*(.+?)(?:\r?\n|$)/i;
const ABSOLUTE_PATH_IN_MESSAGE_REGEX = /(?:^|[\s"'`(])((?:\/[^/\s"'`()<>{}\[\]]+)+)(?=$|[\s"'`),.:;!?])/g;

const normalizeExistingDirectory = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (!existsSync(trimmed)) {
    return null;
  }

  return trimmed;
};

type WorkingDirectoryResolution = {
  cwd: string;
  source: string;
};

type WorkingDirectoryCandidate = {
  cwd: string;
  source: string;
  score: number;
};

const hasGitDirectory = (cwd: string): boolean => existsSync(resolve(cwd, ".git"));

const scorePathKey = (key: string): number => {
  const normalized = key.toLowerCase();
  if (normalized.includes("workspace")) {
    return 88;
  }

  if (normalized.includes("project") || normalized.includes("repo") || normalized.includes("root")) {
    return 82;
  }

  if (normalized.includes("workingdirectory") || normalized.includes("working_directory")) {
    return 58;
  }

  if (normalized === "cwd") {
    return 50;
  }

  if (normalized.includes("path")) {
    return 46;
  }

  return 40;
};

const collectNestedPathCandidates = (
  value: unknown,
  source: string,
  pushCandidate: (raw: unknown, source: string, score: number) => void
): void => {
  if (!value || typeof value !== "object") {
    return;
  }

  const queue: Array<{ value: unknown; source: string; depth: number }> = [
    { value, source, depth: 0 }
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    if (!current.value || typeof current.value !== "object") {
      continue;
    }

    if (current.depth >= 4) {
      continue;
    }

    if (Array.isArray(current.value)) {
      for (let index = 0; index < current.value.length; index += 1) {
        queue.push({
          value: current.value[index],
          source: `${current.source}[${index}]`,
          depth: current.depth + 1
        });
      }
      continue;
    }

    for (const [key, nestedValue] of Object.entries(current.value as Record<string, unknown>)) {
      const nestedSource = `${current.source}.${key}`;
      if (typeof nestedValue === "string") {
        const looksPathLike =
          key.toLowerCase().includes("path") ||
          key.toLowerCase().includes("cwd") ||
          key.toLowerCase().includes("workspace") ||
          key.toLowerCase().includes("project") ||
          key.toLowerCase().includes("repo") ||
          key.toLowerCase().includes("root");
        if (looksPathLike) {
          pushCandidate(nestedValue, nestedSource, scorePathKey(key));
        }
      }

      if (!nestedValue || typeof nestedValue !== "object") {
        continue;
      }

      queue.push({
        value: nestedValue,
        source: nestedSource,
        depth: current.depth + 1
      });
    }
  }
};

const collectMessagePathCandidates = (
  messageText: string,
  pushCandidate: (raw: unknown, source: string, score: number) => void
): void => {
  ABSOLUTE_PATH_IN_MESSAGE_REGEX.lastIndex = 0;
  let pathMatch = ABSOLUTE_PATH_IN_MESSAGE_REGEX.exec(messageText);
  while (pathMatch) {
    pushCandidate(pathMatch[1], "message.absolutePath", 70);
    pathMatch = ABSOLUTE_PATH_IN_MESSAGE_REGEX.exec(messageText);
  }
};

const resolveWorkingDirectory = (
  body: ChatCompletionRequest,
  headers: Record<string, string | string[] | undefined>,
  config: AppConfig,
  rememberedConversationCwd: string | null
): WorkingDirectoryResolution => {
  const candidates: WorkingDirectoryCandidate[] = [];
  const seen = new Set<string>();

  const pushCandidate = (raw: unknown, source: string, score: number): void => {
    const normalized = normalizeExistingDirectory(raw);
    if (!normalized) {
      return;
    }

    if (seen.has(`${source}:${normalized}`)) {
      return;
    }

    const gitBoost = hasGitDirectory(normalized) ? 5 : 0;
    const defaultCwdPenalty = normalized === config.defaultCwd ? -3 : 0;
    seen.add(`${source}:${normalized}`);
    candidates.push({
      cwd: normalized,
      source,
      score: score + gitBoost + defaultCwdPenalty
    });
  };

  for (const key of PREFERRED_WORKING_DIRECTORY_KEYS) {
    pushCandidate(body.metadata?.[key], `metadata.${key}`, 100);
  }

  for (const key of CWD_WORKING_DIRECTORY_KEYS) {
    pushCandidate(body.metadata?.[key], `metadata.${key}`, 60);
  }

  if (rememberedConversationCwd) {
    pushCandidate(rememberedConversationCwd, "conversationMemory", 80);
  }

  collectNestedPathCandidates(body.metadata, "metadata", pushCandidate);

  for (const key of PREFERRED_WORKING_DIRECTORY_KEYS) {
    pushCandidate((body as Record<string, unknown>)[key], `body.${key}`, 95);
  }

  for (const key of CWD_WORKING_DIRECTORY_KEYS) {
    pushCandidate((body as Record<string, unknown>)[key], `body.${key}`, 55);
  }

  collectNestedPathCandidates(body, "body", pushCandidate);

  for (const headerName of PREFERRED_WORKING_DIRECTORY_HEADER_KEYS) {
    const rawHeader = headers[headerName];
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    pushCandidate(headerValue, `header.${headerName}`, 90);
  }

  for (const headerName of CWD_WORKING_DIRECTORY_HEADER_KEYS) {
    const rawHeader = headers[headerName];
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    pushCandidate(headerValue, `header.${headerName}`, 50);
  }

  for (const message of body.messages) {
    const messageText = extractMessageText(message);
    if (!messageText) {
      continue;
    }

    const workspaceMatch = messageText.match(WORKSPACE_PATH_FROM_MESSAGE_REGEX);
    if (workspaceMatch) {
      pushCandidate(workspaceMatch[2], "message.workspacePath", 85);
    }

    const cwdMatch = messageText.match(CWD_FROM_MESSAGE_REGEX);
    if (cwdMatch) {
      pushCandidate(cwdMatch[1], "message.cwd", 45);
    }

    collectMessagePathCandidates(messageText, pushCandidate);
  }

  if (candidates.length === 0) {
    return {
      cwd: config.defaultCwd,
      source: "defaultCwd"
    };
  }

  candidates.sort((left, right) => right.score - left.score);
  return {
    cwd: candidates[0].cwd,
    source: candidates[0].source
  };
};

const resolveConversationId = (request: ChatCompletionRequest): string | null => {
  const metadata = request.metadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  for (const candidate of CONVERSATION_ID_CANDIDATE_KEYS) {
    const value = metadata[candidate];
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }

    return value.trim();
  }

  return null;
};

const isModelSupported = (
  requestedModel: string,
  input: { acceptAnyModel: boolean; modelAliases: string[] }
): boolean => {
  if (input.acceptAnyModel) {
    return true;
  }

  return input.modelAliases.includes(requestedModel);
};

const dedupeModelIds = (modelIds: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const modelId of modelIds) {
    const trimmed = modelId.trim();
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

const getGreetingFastPathResponse = (
  request: ChatCompletionRequest,
  config: AppConfig
): string | null => {
  if (!config.enableGreetingFastPath) {
    return null;
  }

  const nonSystemMessages = request.messages.filter((message) => message.role !== "system");
  if (nonSystemMessages.length !== 1) {
    return null;
  }

  const firstMessage = nonSystemMessages[0];
  if (firstMessage.role !== "user") {
    return null;
  }

  const content = firstMessage.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .join("");
  }

  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized.length > 20) {
    return null;
  }

  if (/^(hi|hello|hey|yo|sup|ola|oi|hiya|howdy)[!.?]*$/.test(normalized)) {
    return config.greetingFastPathResponse;
  }

  return null;
};

const resolveSessionKey = (
  request: ChatCompletionRequest,
  cwd: string,
  config: AppConfig
): string | null => {
  if (!config.enableCursorSessions) {
    return null;
  }

  const conversationId = resolveConversationId(request);
  if (conversationId) {
    return `${cwd}:${conversationId}`;
  }

  if (config.cursorSessionFallbackToCwd) {
    return `${cwd}:__default`;
  }

  return null;
};

export const createServer = ({ config }: CreateServerInput): FastifyInstance => {
  const responseCache = new Map<string, CacheEntry>();
  const sessionStore = new SessionStore(config.cursorSessionTtlMs, config.cursorSessionMaxEntries);
  const conversationCwdStore = new SessionStore(
    config.cursorSessionTtlMs,
    config.cursorSessionMaxEntries * 2
  );
  let modelsCache: ModelsCacheEntry | null = null;
  const server = Fastify({
    logger: {
      level: config.logLevel
    }
  });
  const serializeModelsListResponse = (modelIds: string[]) => ({
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "local"
    }))
  });
  const resolveAvailableModels = async (logger: FastifyBaseLogger): Promise<string[]> => {
    const now = Date.now();
    if (modelsCache && modelsCache.expiresAt > now) {
      return modelsCache.modelIds;
    }

    const fallbackModels = dedupeModelIds([config.modelId, ...config.modelAliases]);
    if (!config.cursorDiscoverModels || config.cursorModelsArgs.length === 0) {
      modelsCache = {
        modelIds: fallbackModels,
        expiresAt: now + config.cursorModelsCacheTtlMs
      };
      return fallbackModels;
    }

    try {
      const discoveredModels = await listCursorModels(config, config.defaultCwd);
      const resolvedModels = dedupeModelIds([...discoveredModels, ...fallbackModels]);
      modelsCache = {
        modelIds: resolvedModels,
        expiresAt: now + config.cursorModelsCacheTtlMs
      };
      return resolvedModels;
    } catch (error: unknown) {
      const adapterError = asAdapterError(error);
      logger.warn(
        {
          code: adapterError.code,
          statusCode: adapterError.statusCode,
          details: adapterError.details
        },
        "failed to discover cursor models, falling back to configured aliases"
      );
      modelsCache = {
        modelIds: fallbackModels,
        expiresAt: now + config.cursorModelsCacheTtlMs
      };
      return fallbackModels;
    }
  };

  server.setErrorHandler((error, _request, reply) => {
    const adapterError = asAdapterError(error);
    reply.status(adapterError.statusCode).send({
      error: {
        code: adapterError.code,
        message: adapterError.message
      }
    });
  });

  server.get("/health", async () => ({
    status: "ok",
    model: config.modelId
  }));

  server.get("/models", async () => serializeModelsListResponse(await resolveAvailableModels(server.log)));

  server.get("/v1/models", async () =>
    serializeModelsListResponse(await resolveAvailableModels(server.log))
  );

  server.post("/v1/chat/completions", async (request, reply) => {
    const startedAt = Date.now();
    let body: ChatCompletionRequest;

    try {
      body = chatCompletionRequestSchema.parse(request.body);
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        request.log.error(
          {
            rawBody: request.body,
            issues: error.issues
          },
          "request body validation failed"
        );
        throw new AdapterError("INVALID_REQUEST", "Request body validation failed.", 400, {
          issues: error.issues
        });
      }

      throw error;
    }

    let modelIdsForValidation = config.modelAliases;
    if (!config.acceptAnyModel) {
      modelIdsForValidation = await resolveAvailableModels(request.log);
    }

    if (
      !isModelSupported(body.model, {
        acceptAnyModel: config.acceptAnyModel,
        modelAliases: modelIdsForValidation
      })
    ) {
      throw new AdapterError(
        "UNKNOWN_MODEL",
        `Model '${body.model}' is not supported. Supported models: ${modelIdsForValidation.join(", ")}.`,
        400
      );
    }

    const conversationId = resolveConversationId(body);
    const rememberedConversationCwd = conversationId ? conversationCwdStore.get(conversationId) : null;
    const cwdResolution = resolveWorkingDirectory(
      body,
      request.headers,
      config,
      rememberedConversationCwd
    );
    const cwd = cwdResolution.cwd;
    if (conversationId && cwdResolution.source !== "defaultCwd") {
      conversationCwdStore.set(conversationId, cwd);
    }
    const sessionKey = resolveSessionKey(body, cwd, config);
    const flattenedPrompt = buildCursorPrompt(body, {
      maxConversationMessages: config.promptMaxConversationMessages,
      maxMessageChars: config.promptMaxMessageChars,
      maxPromptChars: config.promptMaxChars
    });
    const cacheKey = JSON.stringify({
      model: body.model,
      cwd,
      prompt: flattenedPrompt
    });
    const now = Date.now();
    const cached = responseCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      const durationMs = Date.now() - startedAt;
      reply.header("x-adapter-duration-ms", String(durationMs));
      reply.header("x-adapter-cache", "hit");
      reply.header("x-adapter-session", sessionKey ? "on" : "off");
      if (!body.stream) {
        reply.status(200).send(makeChatResponse(cached.assistantText, body.model));
        return;
      }

      reply
        .status(200)
        .header("Content-Type", "text/event-stream; charset=utf-8")
        .header("Cache-Control", "no-cache")
        .header("Connection", "keep-alive")
        .send(makeSseChatPayload(cached.assistantText, body.model));
      return;
    }

    responseCache.delete(cacheKey);

    const fastPathResponse = getGreetingFastPathResponse(body, config);
    if (fastPathResponse) {
      request.log.info(
        {
          model: body.model
        },
        "served greeting with fast path"
      );

      if (config.responseCacheTtlMs > 0) {
        responseCache.set(cacheKey, {
          assistantText: fastPathResponse,
          expiresAt: Date.now() + config.responseCacheTtlMs
        });
      }

      const durationMs = Date.now() - startedAt;
      reply.header("x-adapter-duration-ms", String(durationMs));
      reply.header("x-adapter-cache", "miss");
      reply.header("x-adapter-session", sessionKey ? "on" : "off");
      if (!body.stream) {
        reply.status(200).send(makeChatResponse(fastPathResponse, body.model));
        return;
      }

      reply
        .status(200)
        .header("Content-Type", "text/event-stream; charset=utf-8")
        .header("Cache-Control", "no-cache")
        .header("Connection", "keep-alive")
        .send(makeSseChatPayload(fastPathResponse, body.model));
      return;
    }

    request.log.info(
      {
        model: body.model,
        cwd,
        cwdSource: cwdResolution.source,
        messageCount: body.messages.length,
        hasSessionKey: Boolean(sessionKey)
      },
      "handling chat completion request"
    );
    if (cwdResolution.source === "defaultCwd") {
      request.log.warn(
        {
          metadataKeys:
            body.metadata && typeof body.metadata === "object" ? Object.keys(body.metadata).slice(0, 20) : [],
          requestTopLevelKeys: Object.keys(body).slice(0, 20),
          headerKeys: Object.keys(request.headers).slice(0, 20)
        },
        "no request workspace path signal found; using default cwd"
      );
    }

    let resumeChatId: string | undefined;
    let sessionChatIdToPersist: string | null = null;
    if (sessionKey) {
      const existingChatId = sessionStore.get(sessionKey);
      if (existingChatId) {
        resumeChatId = existingChatId;
      }

      if (!resumeChatId) {
        resumeChatId = await createCursorChat(config, cwd);
        sessionChatIdToPersist = resumeChatId;
      }
    }

    if (body.stream) {
      const completionId = `chatcmpl-${randomUUID()}`;
      let streamState = createStreamJsonState();
      const assistantParts: string[] = [];

      reply.hijack();
      reply.raw.statusCode = 200;
      reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("x-adapter-cache", "miss");
      reply.raw.setHeader("x-adapter-session", sessionKey ? "on" : "off");
      writeSsePayload(
        reply.raw,
        makeStreamChunk(completionId, body.model, { role: "assistant" }, null)
      );

      let streamResult: RunCursorResult | null = null;
      try {
        streamResult = await runCursor({
          prompt: flattenedPrompt,
          cwd,
          config,
          model: body.model,
          resumeChatId,
          streamJsonOutput: true,
          onStdoutChunk: (chunk) => {
            const assistantChunks = consumeStreamJsonChunk(streamState, chunk);
            if (assistantChunks.length === 0) {
              return;
            }

            for (const assistantChunk of assistantChunks) {
              assistantParts.push(assistantChunk);
              writeSsePayload(
                reply.raw,
                makeStreamChunk(completionId, body.model, { content: assistantChunk }, null)
              );
            }
          }
        });
      } catch (error: unknown) {
        const adapterError = asAdapterError(error);
        const canRetryWithFreshSession =
          adapterError.code === "CURSOR_NON_ZERO_EXIT" &&
          Boolean(sessionKey && resumeChatId) &&
          assistantParts.length === 0;
        if (canRetryWithFreshSession && sessionKey) {
          sessionStore.delete(sessionKey);
          const freshChatId = await createCursorChat(config, cwd);
          // A failed first attempt can leave trailing bytes in the parser buffer.
          // Start the retry with a fresh parser state to avoid corrupting first chunks.
          streamState = createStreamJsonState();
          assistantParts.length = 0;
          try {
            streamResult = await runCursor({
              prompt: flattenedPrompt,
              cwd,
              config,
              model: body.model,
              resumeChatId: freshChatId,
              streamJsonOutput: true,
              onStdoutChunk: (chunk) => {
                const assistantChunks = consumeStreamJsonChunk(streamState, chunk);
                if (assistantChunks.length === 0) {
                  return;
                }

                for (const assistantChunk of assistantChunks) {
                  assistantParts.push(assistantChunk);
                  writeSsePayload(
                    reply.raw,
                    makeStreamChunk(completionId, body.model, { content: assistantChunk }, null)
                  );
                }
              }
            });
            resumeChatId = freshChatId;
            sessionChatIdToPersist = freshChatId;
          } catch (retryError: unknown) {
            const retryAdapterError = asAdapterError(retryError);
            request.log.error(
              {
                code: retryAdapterError.code,
                statusCode: retryAdapterError.statusCode,
                details: retryAdapterError.details
              },
              "cursor streamed retry with fresh session failed"
            );
            writeSsePayload(reply.raw, {
              error: {
                code: retryAdapterError.code,
                message: retryAdapterError.message
              }
            });
            reply.raw.write("data: [DONE]\n\n");
            reply.raw.end();
            return;
          }
        } else {
          request.log.error(
            {
              code: adapterError.code,
              statusCode: adapterError.statusCode,
              details: adapterError.details
            },
            "cursor streamed request failed"
          );
          writeSsePayload(reply.raw, {
            error: {
              code: adapterError.code,
              message: adapterError.message
            }
          });
          reply.raw.write("data: [DONE]\n\n");
          reply.raw.end();
          return;
        }
      }

      if (!streamResult) {
        request.log.error(
          {
            model: body.model,
            cwd
          },
          "stream result missing unexpectedly"
        );
        writeSsePayload(reply.raw, {
          error: {
            code: "INTERNAL_ERROR",
            message: "Unexpected internal error."
          }
        });
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return;
      }

      if (assistantParts.length === 0) {
        const fallbackText = parseCursorOutput(streamResult.stdout, streamResult.stderr);
        assistantParts.push(fallbackText);
        writeSsePayload(
          reply.raw,
          makeStreamChunk(completionId, body.model, { content: fallbackText }, null)
        );
      }

      const assistantText = assistantParts.join("");
      if (sessionKey && sessionChatIdToPersist) {
        sessionStore.set(sessionKey, sessionChatIdToPersist);
      }
      if (config.responseCacheTtlMs > 0) {
        if (responseCache.size >= config.responseCacheMaxEntries) {
          const firstKey = responseCache.keys().next().value;
          if (firstKey) {
            responseCache.delete(firstKey);
          }
        }

        responseCache.set(cacheKey, {
          assistantText,
          expiresAt: Date.now() + config.responseCacheTtlMs
        });
      }

      request.log.info(
        {
          requestId: streamResult.requestId,
          exitCode: streamResult.exitCode,
          durationMs: streamResult.durationMs,
          outputLength: assistantText.length,
          usedSession: Boolean(resumeChatId),
          streamJson: true
        },
        "cursor streamed request completed"
      );

      const durationMs = Date.now() - startedAt;
      request.log.debug({ durationMs }, "stream response duration");
      writeSsePayload(reply.raw, makeStreamChunk(completionId, body.model, {}, "stop"));
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return;
    }

    let cursorResult;
    try {
      cursorResult = await runCursor({
        prompt: flattenedPrompt,
        cwd,
        config,
        model: body.model,
        resumeChatId
      });
    } catch (error: unknown) {
      const adapterError = asAdapterError(error);
      const canRetryWithFreshSession =
        adapterError.code === "CURSOR_NON_ZERO_EXIT" && Boolean(sessionKey && resumeChatId);
      if (!canRetryWithFreshSession || !sessionKey) {
        throw adapterError;
      }

      sessionStore.delete(sessionKey);
      const freshChatId = await createCursorChat(config, cwd);
      cursorResult = await runCursor({
        prompt: flattenedPrompt,
        cwd,
        config,
        model: body.model,
        resumeChatId: freshChatId
      });
      resumeChatId = freshChatId;
      sessionChatIdToPersist = freshChatId;
    }

    const assistantText = parseCursorOutput(cursorResult.stdout, cursorResult.stderr);
    if (sessionKey && sessionChatIdToPersist) {
      sessionStore.set(sessionKey, sessionChatIdToPersist);
    }
    if (config.responseCacheTtlMs > 0) {
      if (responseCache.size >= config.responseCacheMaxEntries) {
        const firstKey = responseCache.keys().next().value;
        if (firstKey) {
          responseCache.delete(firstKey);
        }
      }

      responseCache.set(cacheKey, {
        assistantText,
        expiresAt: Date.now() + config.responseCacheTtlMs
      });
    }

    request.log.info(
      {
        requestId: cursorResult.requestId,
        exitCode: cursorResult.exitCode,
        durationMs: cursorResult.durationMs,
        outputLength: assistantText.length,
        usedSession: Boolean(resumeChatId)
      },
      "cursor request completed"
    );

    const durationMs = Date.now() - startedAt;
    reply.header("x-adapter-duration-ms", String(durationMs));
    reply.header("x-adapter-cache", "miss");
    reply.header("x-adapter-session", sessionKey ? "on" : "off");
    reply.status(200).send(makeChatResponse(assistantText, body.model));
  });

  return server;
};
