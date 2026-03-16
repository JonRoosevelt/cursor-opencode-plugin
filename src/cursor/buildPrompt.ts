import type { ChatCompletionRequest } from "../providers/openaiSchemas.js";
import { resolveSkillCommand } from "./resolveSkillCommand.js";

const normalizeContent = (value: string): string => value.replace(/\r\n/g, "\n").trim();

const messageToText = (content: ChatCompletionRequest["messages"][number]["content"]): string => {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }

        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
};

type BuildPromptOptions = {
  maxConversationMessages: number;
  maxMessageChars: number;
  maxPromptChars: number;
};

const trimMessage = (content: ChatCompletionRequest["messages"][number]["content"], maxChars: number): string => {
  const text = messageToText(content);
  const normalized = normalizeContent(text);
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const tail = normalized.slice(normalized.length - maxChars);
  return `[truncated]\n${tail}`;
};

const trimPrompt = (prompt: string, maxChars: number): string => {
  if (prompt.length <= maxChars) {
    return prompt;
  }

  const tail = prompt.slice(prompt.length - maxChars);
  return `[prompt truncated to last ${maxChars} chars]\n${tail}`;
};

export const buildCursorPrompt = (
  request: ChatCompletionRequest,
  options: BuildPromptOptions
): string => {
  const systemMessages = request.messages.filter((message) => message.role === "system");
  const latestSystem = systemMessages.at(-1);
  const conversationMessages = request.messages
    .filter((message) => message.role !== "system")
    .slice(-options.maxConversationMessages);

  const systemSection = (latestSystem ? [latestSystem] : [])
    .map((message) => trimMessage(message.content, options.maxMessageChars))
    .filter(Boolean)
    .join("\n\n");

  const lastUserMessage = conversationMessages
    .filter((message) => message.role === "user")
    .at(-1);

  const lastUserText = lastUserMessage ? messageToText(lastUserMessage.content) : "";
  const skillResolution = lastUserText ? resolveSkillCommand(lastUserText) : null;

  const conversationSection = conversationMessages
    .map((message) => `${message.role}: ${trimMessage(message.content, options.maxMessageChars)}`)
    .join("\n");

  const systemParts = [
    "[SYSTEM]",
    "You are being called through an adapter from OpenCode.",
    "Return only the final assistant response with no surrounding metadata.",
    systemSection || "(no explicit system message)"
  ];

  if (skillResolution) {
    systemParts.push(
      "",
      `[SKILL INSTRUCTIONS: /${skillResolution.commandName}]`,
      skillResolution.content
    );
  }

  const prompt = [...systemParts, "", "[CONVERSATION]", conversationSection].join("\n");

  return trimPrompt(prompt, options.maxPromptChars);
};
