import { describe, expect, it } from "vitest";

import { buildCursorPrompt } from "../src/cursor/buildPrompt.js";

describe("buildCursorPrompt", () => {
  it("keeps conversation messages ordered and role-prefixed", () => {
    const prompt = buildCursorPrompt({
      model: "cursor-agent/default",
      messages: [
        { role: "system", content: "System note." },
        { role: "user", content: "First question." },
        { role: "assistant", content: "First answer." },
        { role: "user", content: "Follow up question." }
      ]
    }, {
      maxConversationMessages: 10,
      maxMessageChars: 2000,
      maxPromptChars: 12000
    });

    expect(prompt).toContain("[SYSTEM]");
    expect(prompt).toContain("System note.");
    expect(prompt).toContain("[CONVERSATION]");
    expect(prompt).toContain("user: First question.");
    expect(prompt).toContain("assistant: First answer.");
    expect(prompt).toContain("user: Follow up question.");

    const first = prompt.indexOf("user: First question.");
    const second = prompt.indexOf("assistant: First answer.");
    const third = prompt.indexOf("user: Follow up question.");
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
  });

  it("handles array content correctly by extracting text parts", () => {
    const prompt = buildCursorPrompt({
      model: "cursor-agent/default",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "this is some text" },
            { type: "image_url", image_url: { url: "http://example.com/image.png" } },
            { type: "text", text: "more text" }
          ]
        }
      ]
    }, {
      maxConversationMessages: 10,
      maxMessageChars: 2000,
      maxPromptChars: 12000
    });

    expect(prompt).toContain("user: this is some text\nmore text");
  });

  it("handles empty assistant messages and null/undefined content", () => {
    const prompt = buildCursorPrompt({
      model: "cursor-agent/default",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: null, tool_calls: [] } as any,
        { role: "user", content: "follow up" }
      ]
    }, {
      maxConversationMessages: 10,
      maxMessageChars: 2000,
      maxPromptChars: 12000
    });

    expect(prompt).toContain("user: hello");
    expect(prompt).toContain("assistant: ");
    expect(prompt).toContain("user: follow up");
  });
});
