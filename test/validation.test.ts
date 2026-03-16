import { describe, expect, it } from "vitest";
import { chatCompletionRequestSchema } from "../src/providers/openaiSchemas.js";

describe("openaiSchemas validation", () => {
  it("accepts valid request with string content", () => {
    const valid = {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }]
    };
    expect(chatCompletionRequestSchema.parse(valid)).toEqual(valid);
  });

  it("accepts request with array content", () => {
    const withArray = {
      model: "gpt-4",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "what is in this image?" }]
        }
      ]
    };
    expect(chatCompletionRequestSchema.parse(withArray)).toEqual(withArray);
  });

  it("accepts assistant message with tool calls and null content", () => {
    const withToolCalls = {
      model: "gpt-4",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "get_weather", arguments: "{}" }
            }
          ]
        }
      ]
    };
    expect(chatCompletionRequestSchema.parse(withToolCalls)).toEqual(withToolCalls);
  });

  it("accepts assistant/system/tool messages with empty string content", () => {
    const roles = ["assistant", "system", "tool"] as const;
    for (const role of roles) {
      const withEmptyContent = {
        model: "gpt-4",
        messages: [{ role, content: "" }]
      };
      expect(chatCompletionRequestSchema.parse(withEmptyContent)).toEqual(withEmptyContent);
    }
  });

  it("rejects user message with empty string content", () => {
    const invalid = {
      model: "gpt-4",
      messages: [{ role: "user", content: "" }]
    };
    expect(() => chatCompletionRequestSchema.parse(invalid)).toThrow("content must be a non-empty string or array");
  });

  it("rejects user message with empty array content", () => {
    const invalid = {
      model: "gpt-4",
      messages: [{ role: "user", content: [] }]
    };
    expect(() => chatCompletionRequestSchema.parse(invalid)).toThrow("content must be a non-empty string or array");
  });
});
