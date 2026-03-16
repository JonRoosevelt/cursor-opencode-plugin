import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import type { AppConfig } from "../config/config.js";
import { buildCursorPrompt } from "../cursor/buildPrompt.js";
import { createCursorChat } from "../cursor/createChat.js";
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

const resolveWorkingDirectory = (request: ChatCompletionRequest, config: AppConfig): string => {
  const cwd = request.metadata?.cwd;
  if (!cwd || typeof cwd !== "string") {
    return config.defaultCwd;
  }

  return cwd;
};

const isModelSupported = (requestedModel: string, config: AppConfig): boolean => {
  if (config.acceptAnyModel) {
    return true;
  }

  return config.modelAliases.includes(requestedModel);
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

  const normalized = firstMessage.content.trim().toLowerCase();
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

  const metadata = request.metadata;
  if (metadata && typeof metadata === "object") {
    const candidates = [
      "conversationId",
      "conversation_id",
      "threadId",
      "thread_id",
      "sessionId",
      "session_id",
      "chatId",
      "chat_id"
    ] as const;

    for (const candidate of candidates) {
      const value = metadata[candidate];
      if (typeof value !== "string" || !value.trim()) {
        continue;
      }

      return `${cwd}:${value.trim()}`;
    }
  }

  if (config.cursorSessionFallbackToCwd) {
    return `${cwd}:__default`;
  }

  return null;
};

export const createServer = ({ config }: CreateServerInput): FastifyInstance => {
  const responseCache = new Map<string, CacheEntry>();
  const sessionStore = new SessionStore(config.cursorSessionTtlMs, config.cursorSessionMaxEntries);

  const server = Fastify({
    logger: {
      level: config.logLevel
    }
  });

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

  server.get("/v1/models", async () => {
    return {
      object: "list",
      data: config.modelAliases.map((id) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "local"
      }))
    };
  });

  server.post("/v1/chat/completions", async (request, reply) => {
    const startedAt = Date.now();
    let body: ChatCompletionRequest;

    try {
      body = chatCompletionRequestSchema.parse(request.body);
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        throw new AdapterError("INVALID_REQUEST", "Request body validation failed.", 400, {
          issues: error.issues
        });
      }

      throw error;
    }

    if (!isModelSupported(body.model, config)) {
      throw new AdapterError(
        "UNKNOWN_MODEL",
        `Model '${body.model}' is not supported. Supported models: ${config.modelAliases.join(", ")}.`,
        400
      );
    }

    const cwd = resolveWorkingDirectory(body, config);
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
        messageCount: body.messages.length,
        hasSessionKey: Boolean(sessionKey)
      },
      "handling chat completion request"
    );

    let resumeChatId: string | undefined;
    if (sessionKey) {
      const existingChatId = sessionStore.get(sessionKey);
      if (existingChatId) {
        resumeChatId = existingChatId;
      }

      if (!resumeChatId) {
        const createdChatId = await createCursorChat(config, cwd);
        sessionStore.set(sessionKey, createdChatId);
        resumeChatId = createdChatId;
      }
    }

    if (body.stream) {
      const completionId = `chatcmpl-${randomUUID()}`;
      const streamState = createStreamJsonState();
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
          sessionStore.set(sessionKey, freshChatId);

          streamResult = await runCursor({
            prompt: flattenedPrompt,
            cwd,
            config,
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
      sessionStore.set(sessionKey, freshChatId);
      cursorResult = await runCursor({
        prompt: flattenedPrompt,
        cwd,
        config,
        resumeChatId: freshChatId
      });
    }

    const assistantText = parseCursorOutput(cursorResult.stdout, cursorResult.stderr);
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
