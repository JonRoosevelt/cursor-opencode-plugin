import { z } from "zod";

export const chatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

// content can be empty string or null when the message has tool_calls (valid OpenAI API behavior)
export const chatMessageSchema = z
  .object({
    role: chatRoleSchema,
    content: z.string().nullable().optional()
  })
  .passthrough()
  .refine((msg) => {
    const hasToolCalls =
      "tool_calls" in msg && Array.isArray((msg as Record<string, unknown>).tool_calls);
    // assistant messages with tool_calls may legitimately have empty/null content
    if (msg.role === "assistant" && hasToolCalls) return true;
    // all other messages must have non-empty string content
    return typeof msg.content === "string" && msg.content.length > 0;
  }, "content must be a non-empty string");

export const chatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(chatMessageSchema).min(1),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().optional(),
    metadata: z.record(z.unknown()).optional()
  })
  .passthrough();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
