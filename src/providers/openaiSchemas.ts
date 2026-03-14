import { z } from "zod";

export const chatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

export const chatMessageSchema = z.object({
  role: chatRoleSchema,
  content: z.string().min(1)
});

export const chatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().optional(),
  metadata: z.record(z.unknown()).optional()
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
