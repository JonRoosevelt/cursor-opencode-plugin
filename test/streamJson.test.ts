import { describe, expect, it } from "vitest";

import { consumeStreamJsonChunk, createStreamJsonState } from "../src/cursor/streamJson.js";

// Helpers that mirror the real cursor-agent stream-json output shapes.
const makePartialChunk = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    session_id: "test-session",
    timestamp_ms: Date.now() // presence of timestamp_ms marks it as a partial delta
  });

const makeFinalChunk = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    session_id: "test-session"
    // no timestamp_ms — this is the aggregate duplicate cursor-agent emits at end
  });

describe("consumeStreamJsonChunk", () => {
  // ── Real cursor-agent stream-json format ─────────────────────────────────

  it("extracts text from cursor-agent partial delta chunks (with timestamp_ms)", () => {
    const state = createStreamJsonState();
    const first = consumeStreamJsonChunk(state, `${makePartialChunk("Hello")}\n`);
    const second = consumeStreamJsonChunk(state, `${makePartialChunk(" world")}\n`);
    expect(first).toEqual(["Hello"]);
    expect(second).toEqual([" world"]);
  });

  it("skips the final aggregate message when partial chunks were already emitted", () => {
    const state = createStreamJsonState();
    consumeStreamJsonChunk(state, `${makePartialChunk("Hello")}\n`);
    consumeStreamJsonChunk(state, `${makePartialChunk(" world")}\n`);
    // Final aggregate message that cursor-agent emits after all partial chunks:
    const final = consumeStreamJsonChunk(state, `${makeFinalChunk("Hello world")}\n`);
    expect(final).toEqual([]); // must be dropped — already sent token-by-token
  });

  it("forwards final non-partial message when no partial chunks have been seen", () => {
    // Simulates running without --stream-partial-output or a single-token response.
    const state = createStreamJsonState();
    const result = consumeStreamJsonChunk(state, `${makeFinalChunk("Hello world")}\n`);
    expect(result).toEqual(["Hello world"]);
  });

  it("handles multiple partial chunks arriving in a single tcp chunk", () => {
    const state = createStreamJsonState();
    const combined = `${makePartialChunk("foo")}\n${makePartialChunk("bar")}\n${makeFinalChunk("foobar")}\n`;
    const result = consumeStreamJsonChunk(state, combined);
    expect(result).toEqual(["foo", "bar"]); // final aggregate skipped
  });

  // ── OpenAI-style SSE delta format (legacy / fallback) ───────────────────

  it("extracts OpenAI-style delta content lines", () => {
    const state = createStreamJsonState();
    const first = consumeStreamJsonChunk(state, '{"choices":[{"delta":{"content":"hello "}}]}\n');
    const second = consumeStreamJsonChunk(state, '{"choices":[{"delta":{"content":"world"}}]}\n');
    expect(first).toEqual(["hello "]);
    expect(second).toEqual(["world"]);
  });

  // ── Buffering ────────────────────────────────────────────────────────────

  it("buffers partial json lines until newline arrives", () => {
    const state = createStreamJsonState();
    const line = makePartialChunk("hello");
    const half = Math.floor(line.length / 2);
    const first = consumeStreamJsonChunk(state, line.slice(0, half));
    const second = consumeStreamJsonChunk(state, `${line.slice(half)}\n`);
    expect(first).toEqual([]);
    expect(second).toEqual(["hello"]);
  });

  // ── Non-JSON noise ───────────────────────────────────────────────────────

  it("ignores non-json output safely", () => {
    const state = createStreamJsonState();
    const chunks = consumeStreamJsonChunk(state, "plain log line\n");
    expect(chunks).toEqual([]);
  });

  it("ignores system/result type lines from cursor-agent", () => {
    const state = createStreamJsonState();
    const systemLine = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc",
      model: "gpt-5"
    });
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Hello world",
      session_id: "abc"
    });
    expect(consumeStreamJsonChunk(state, `${systemLine}\n`)).toEqual([]);
    expect(consumeStreamJsonChunk(state, `${resultLine}\n`)).toEqual([]);
  });
});
