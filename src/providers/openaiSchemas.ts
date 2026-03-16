import { z } from "zod";

export const chatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

// content can be a string, null (if assistant message with tool_calls),
// or an array of content parts (e.g. for vision or multi-modal)
export const contentPartSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    image_url: z.any().optional()
  })
  .passthrough();

export const chatMessageSchema = z
  .object({
    role: chatRoleSchema,
    content: z.union([z.string(), z.array(contentPartSchema)]).nullable().optional()
  })
  .passthrough()
  .refine((msg) => {
    const hasToolCalls =
      "tool_calls" in msg && Array.isArray((msg as Record<string, unknown>).tool_calls);
    // assistant messages with tool_calls may legitimately have empty/null content
    if (msg.role === "assistant" && hasToolCalls) return true;

    // if content is missing, it's only allowed for assistant messages with tool_calls (already handled above)
    if (msg.content === undefined || msg.content === null) return false;

    // content as string: can be empty for assistant/system if needed, but OpenAI usually wants non-empty
    // However, some clients (e.g. Cursor) might send empty strings for some messages.
    // Let's be a bit more lenient if it's a string, or at least allow it if it's not the only content.
    if (typeof msg.content === "string") {
      // For user messages, content usually must be non-empty.
      if (msg.role === "user") return msg.content.length > 0;
      // For others, we'll allow empty string to be safe against weird client behavior.
      return true;
    }

    // content as array: must have at least one part
    if (Array.isArray(msg.content)) {
      return msg.content.length > 0;
    }

    return false;
  }, "content must be a non-empty string or array");

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
