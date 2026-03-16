import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config/config.js";
import { createServer } from "../src/server/createServer.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock
}));

class MockChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = {
    write: vi.fn(),
    end: vi.fn()
  };
  readonly kill = vi.fn();
}

const baseConfig: AppConfig = {
  port: 8787,
  host: "127.0.0.1",
  defaultCwd: process.cwd(),
  cursorBinPath: "cursor-agent",
  requestTimeoutMs: 50,
  logLevel: "error",
  modelId: "cursor-agent/default",
  modelAliases: ["cursor-agent/default", "claude-4-6-sonnet"],
  acceptAnyModel: true,
  cursorPromptMode: "stdin",
  cursorPromptArg: "--prompt",
  cursorBaseArgs: [],
  maxStdoutBytes: 500_000,
  enableGreetingFastPath: true,
  greetingFastPathResponse: "Hi! What can I help you build or debug today?",
  promptMaxConversationMessages: 10,
  promptMaxMessageChars: 2_000,
  promptMaxChars: 12_000,
  responseCacheTtlMs: 60_000,
  responseCacheMaxEntries: 200,
  enableCursorSessions: false,
  cursorSessionFallbackToCwd: false,
  cursorSessionTtlMs: 1_800_000,
  cursorSessionMaxEntries: 500
};

const validBody = {
  model: "cursor-agent/default",
  messages: [{ role: "user", content: "please answer this test prompt" }],
  stream: false
};

describe("adapter server", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns normalized assistant message for successful run", async () => {
    spawnMock.mockImplementationOnce(() => {
      const child = new MockChildProcess();
      setTimeout(() => {
        child.stdout.emit("data", "<<<CURSOR_FINAL>>>hello from cursor<<<END_CURSOR_FINAL>>>");
        child.emit("close", 0);
      }, 0);
      return child;
    });

    const server = createServer({ config: baseConfig });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: validBody
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.choices[0].message.content).toBe("hello from cursor");

    await server.close();
  });

  it("maps missing binary error into stable adapter error", async () => {
    spawnMock.mockImplementationOnce(() => {
      const child = new MockChildProcess();
      setTimeout(() => {
        child.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
      }, 0);
      return child;
    });

    const server = createServer({ config: baseConfig });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: validBody
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("CURSOR_BIN_NOT_FOUND");

    await server.close();
  });

  it("kills process and returns timeout error when run hangs", async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const server = createServer({
      config: {
        ...baseConfig,
        requestTimeoutMs: 20
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: validBody
    });

    expect(response.statusCode).toBe(504);
    expect(response.json().error.code).toBe("CURSOR_TIMEOUT");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    await server.close();
  });

  it("returns malformed output error when cursor exits with empty output", async () => {
    spawnMock.mockImplementationOnce(() => {
      const child = new MockChildProcess();
      setTimeout(() => {
        child.stderr.emit("data", "some logs");
        child.emit("close", 0);
      }, 0);
      return child;
    });

    const server = createServer({ config: baseConfig });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: validBody
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("CURSOR_MALFORMED_OUTPUT");

    await server.close();
  });

  it("rejects unknown model when acceptAnyModel is disabled", async () => {
    const server = createServer({
      config: {
        ...baseConfig,
        acceptAnyModel: false,
        modelAliases: ["cursor-agent/default"]
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        ...validBody,
        model: "claude-4-6-sonnet"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("UNKNOWN_MODEL");

    await server.close();
  });

  it("streams incremental SSE chunks using cursor stream-json output", async () => {
    spawnMock.mockImplementationOnce((_bin: string, args: string[]) => {
      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--print");
      const child = new MockChildProcess();
      setTimeout(() => {
        child.stdout.emit("data", '{"choices":[{"delta":{"content":"streamed "}}]}\n');
        child.stdout.emit("data", '{"choices":[{"delta":{"content":"answer"}}]}\n');
        child.emit("close", 0);
      }, 0);
      return child;
    });

    const server = createServer({ config: baseConfig });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        ...validBody,
        stream: true
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain('"object":"chat.completion.chunk"');
    expect(response.body).toContain('"content":"streamed "');
    expect(response.body).toContain('"content":"answer"');
    expect(response.body).toContain("data: [DONE]");

    await server.close();
  });

  it("serves simple greeting without spawning cursor", async () => {
    const server = createServer({ config: baseConfig });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "claude-4-6-sonnet",
        messages: [{ role: "user", content: "hi" }],
        stream: false
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe(
      "Hi! What can I help you build or debug today?"
    );
    expect(spawnMock).not.toHaveBeenCalled();

    await server.close();
  });

  it("serves repeated identical request from cache", async () => {
    spawnMock.mockImplementationOnce(() => {
      const child = new MockChildProcess();
      setTimeout(() => {
        child.stdout.emit("data", "cached answer");
        child.emit("close", 0);
      }, 0);
      return child;
    });

    const server = createServer({ config: baseConfig });
    const payload = {
      model: "claude-4-6-sonnet",
      messages: [{ role: "user", content: "what is caching?" }],
      stream: false
    };

    const firstResponse = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload
    });
    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.headers["x-adapter-cache"]).toBe("miss");

    const secondResponse = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload
    });
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.headers["x-adapter-cache"]).toBe("hit");
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await server.close();
  });

  it("creates and reuses cursor chat session when conversation id is provided", async () => {
    spawnMock
      .mockImplementationOnce((_bin: string, args: string[]) => {
        expect(args).toEqual(["create-chat"]);
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stdout.emit("data", "11111111-1111-4111-8111-111111111111\n");
          child.emit("close", 0);
        }, 0);
        return child;
      })
      .mockImplementationOnce((_bin: string, args: string[]) => {
        expect(args).toContain("--resume");
        expect(args).toContain("11111111-1111-4111-8111-111111111111");
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stdout.emit("data", "first session answer");
          child.emit("close", 0);
        }, 0);
        return child;
      })
      .mockImplementationOnce((_bin: string, args: string[]) => {
        expect(args).toContain("--resume");
        expect(args).toContain("11111111-1111-4111-8111-111111111111");
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stdout.emit("data", "second session answer");
          child.emit("close", 0);
        }, 0);
        return child;
      });

    const server = createServer({
      config: {
        ...baseConfig,
        responseCacheTtlMs: 0,
        enableCursorSessions: true,
        cursorSessionFallbackToCwd: false
      }
    });

    const payload = {
      model: "claude-4-6-sonnet",
      messages: [{ role: "user", content: "give me detail" }],
      stream: false,
      metadata: {
        conversationId: "conv-123"
      }
    };

    const first = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-adapter-session"]).toBe("on");

    const second = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-adapter-session"]).toBe("on");
    expect(spawnMock).toHaveBeenCalledTimes(3);

    await server.close();
  });

  it("can fall back to cwd session key when enabled", async () => {
    spawnMock
      .mockImplementationOnce(() => {
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stdout.emit("data", "22222222-2222-4222-8222-222222222222\n");
          child.emit("close", 0);
        }, 0);
        return child;
      })
      .mockImplementationOnce(() => {
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stdout.emit("data", "fallback session answer");
          child.emit("close", 0);
        }, 0);
        return child;
      });

    const server = createServer({
      config: {
        ...baseConfig,
        enableCursorSessions: true,
        cursorSessionFallbackToCwd: true,
        responseCacheTtlMs: 0
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "claude-4-6-sonnet",
        messages: [{ role: "user", content: "session fallback test" }],
        stream: false
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-adapter-session"]).toBe("on");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(["create-chat"]);
    expect(spawnMock.mock.calls[1]?.[1]).toContain("--resume");
    expect(spawnMock.mock.calls[1]?.[1]).toContain("22222222-2222-4222-8222-222222222222");

    await server.close();
  });

  it("does not persist a fresh session id when non-stream retry also fails", async () => {
    spawnMock
      .mockImplementationOnce((_bin: string, args: string[]) => {
        expect(args).toEqual(["create-chat"]);
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stdout.emit("data", "11111111-1111-4111-8111-111111111111\n");
          child.emit("close", 0);
        }, 0);
        return child;
      })
      .mockImplementationOnce((_bin: string, args: string[]) => {
        expect(args).toContain("--resume");
        expect(args).toContain("11111111-1111-4111-8111-111111111111");
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stderr.emit("data", "first run failed");
          child.emit("close", 2);
        }, 0);
        return child;
      })
      .mockImplementationOnce((_bin: string, args: string[]) => {
        expect(args).toEqual(["create-chat"]);
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stdout.emit("data", "22222222-2222-4222-8222-222222222222\n");
          child.emit("close", 0);
        }, 0);
        return child;
      })
      .mockImplementationOnce((_bin: string, args: string[]) => {
        expect(args).toContain("--resume");
        expect(args).toContain("22222222-2222-4222-8222-222222222222");
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stderr.emit("data", "retry failed");
          child.emit("close", 2);
        }, 0);
        return child;
      })
      .mockImplementationOnce((_bin: string, args: string[]) => {
        expect(args).toEqual(["create-chat"]);
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stdout.emit("data", "33333333-3333-4333-8333-333333333333\n");
          child.emit("close", 0);
        }, 0);
        return child;
      })
      .mockImplementationOnce((_bin: string, args: string[]) => {
        expect(args).toContain("--resume");
        expect(args).toContain("33333333-3333-4333-8333-333333333333");
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stdout.emit("data", "session recovered");
          child.emit("close", 0);
        }, 0);
        return child;
      });

    const server = createServer({
      config: {
        ...baseConfig,
        responseCacheTtlMs: 0,
        enableCursorSessions: true,
        cursorSessionFallbackToCwd: false
      }
    });

    const payload = {
      model: "claude-4-6-sonnet",
      messages: [{ role: "user", content: "session recovery" }],
      stream: false,
      metadata: {
        conversationId: "conv-retry"
      }
    };

    const first = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload
    });
    expect(first.statusCode).toBe(502);
    expect(first.json().error.code).toBe("CURSOR_NON_ZERO_EXIT");

    const second = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().choices[0].message.content).toBe("session recovered");
    expect(spawnMock).toHaveBeenCalledTimes(6);

    await server.close();
  });

  it("retries streaming with a fresh parser state when first attempt ends mid-line", async () => {
    spawnMock
      .mockImplementationOnce(() => {
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stdout.emit("data", "11111111-1111-4111-8111-111111111111\n");
          child.emit("close", 0);
        }, 0);
        return child;
      })
      .mockImplementationOnce(() => {
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stdout.emit("data", '{"choices":[{"delta":{"content":"half');
          child.stderr.emit("data", "first stream failed");
          child.emit("close", 2);
        }, 0);
        return child;
      })
      .mockImplementationOnce(() => {
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stdout.emit("data", "22222222-2222-4222-8222-222222222222\n");
          child.emit("close", 0);
        }, 0);
        return child;
      })
      .mockImplementationOnce((_bin: string, args: string[]) => {
        expect(args).toContain("--output-format");
        expect(args).toContain("stream-json");
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stdout.emit("data", '{"choices":[{"delta":{"content":"hello "}}]}\n');
          child.stdout.emit("data", '{"choices":[{"delta":{"content":"world"}}]}\n');
          child.emit("close", 0);
        }, 0);
        return child;
      });

    const server = createServer({
      config: {
        ...baseConfig,
        responseCacheTtlMs: 0,
        enableCursorSessions: true,
        cursorSessionFallbackToCwd: false
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "claude-4-6-sonnet",
        messages: [{ role: "user", content: "stream retry test" }],
        stream: true,
        metadata: {
          conversationId: "conv-stream-buffer"
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"content":"hello "');
    expect(response.body).toContain('"content":"world"');
    expect(response.body).toContain("data: [DONE]");

    await server.close();
  });

  it("emits SSE error and done when streaming retry with fresh session fails", async () => {
    spawnMock
      .mockImplementationOnce(() => {
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stdout.emit("data", "11111111-1111-4111-8111-111111111111\n");
          child.emit("close", 0);
        }, 0);
        return child;
      })
      .mockImplementationOnce(() => {
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stderr.emit("data", "first stream failed");
          child.emit("close", 2);
        }, 0);
        return child;
      })
      .mockImplementationOnce(() => {
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stdout.emit("data", "22222222-2222-4222-8222-222222222222\n");
          child.emit("close", 0);
        }, 0);
        return child;
      })
      .mockImplementationOnce(() => {
        const child = new MockChildProcess();
        setTimeout(() => {
          child.stderr.emit("data", "retry stream failed");
          child.emit("close", 2);
        }, 0);
        return child;
      });

    const server = createServer({
      config: {
        ...baseConfig,
        responseCacheTtlMs: 0,
        enableCursorSessions: true,
        cursorSessionFallbackToCwd: false
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "claude-4-6-sonnet",
        messages: [{ role: "user", content: "stream retry fail test" }],
        stream: true,
        metadata: {
          conversationId: "conv-stream-fail"
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"error":{"code":"CURSOR_NON_ZERO_EXIT"');
    expect(response.body).toContain("data: [DONE]");

    await server.close();
  });
});
