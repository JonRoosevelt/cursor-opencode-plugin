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
});
