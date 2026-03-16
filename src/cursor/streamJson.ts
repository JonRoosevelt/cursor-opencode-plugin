type StreamJsonState = {
  buffer: string;
  /** Number of partial assistant chunks already emitted for this response. */
  partialChunksSeen: number;
};

const extractTextFromContentPart = (value: unknown): string[] => {
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  if (typeof record.text === "string" && record.text.length > 0) {
    return [record.text];
  }

  if (typeof record.content === "string" && record.content.length > 0) {
    return [record.content];
  }

  return [];
};

const extractTextFromContent = (value: unknown): string[] => {
  if (typeof value === "string") {
    return value.length > 0 ? [value] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap(extractTextFromContentPart);
};

/**
 * Extract assistant text from a single parsed JSON line.
 *
 * Returns `{ texts, isPartial }` where `isPartial` is true when the line
 * carries a `timestamp_ms` field — which cursor-agent emits only on the
 * per-token delta chunks produced by `--stream-partial-output`, not on the
 * final aggregate assistant message that follows them.
 */
const extractAssistantText = (
  value: unknown
): { texts: string[]; isPartial: boolean } => {
  if (!value || typeof value !== "object") {
    return { texts: [], isPartial: false };
  }

  const record = value as Record<string, unknown>;

  // cursor-agent stream-json format:
  // { type: "assistant", message: { role: "assistant", content: [{type:"text",text:"..."}] }, timestamp_ms? }
  // Partial delta chunks include `timestamp_ms`; the final aggregate message does not.
  const isPartial = typeof record.timestamp_ms === "number";

  const message = record.message;
  if (message && typeof message === "object") {
    const messageRecord = message as Record<string, unknown>;
    if (messageRecord.role === "assistant") {
      const texts = extractTextFromContent(messageRecord.content);
      if (texts.length > 0) {
        return { texts, isPartial };
      }
    }
  }

  // OpenAI-style SSE delta: { choices: [{ delta: { content: "..." } }] }
  const choices = record.choices;
  if (Array.isArray(choices)) {
    const openAiDelta = choices.flatMap((choice) => {
      if (!choice || typeof choice !== "object") {
        return [];
      }

      const choiceRecord = choice as Record<string, unknown>;
      const delta = choiceRecord.delta;
      if (!delta || typeof delta !== "object") {
        return [];
      }

      const deltaRecord = delta as Record<string, unknown>;
      if (typeof deltaRecord.content === "string" && deltaRecord.content.length > 0) {
        return [deltaRecord.content];
      }

      return [];
    });

    if (openAiDelta.length > 0) {
      return { texts: openAiDelta, isPartial };
    }
  }

  // Generic delta envelope: { delta: "..." } or { delta: { text|content: "..." } }
  const delta = record.delta;
  if (typeof delta === "string" && delta.length > 0) {
    return { texts: [delta], isPartial };
  }

  if (delta && typeof delta === "object") {
    const deltaRecord = delta as Record<string, unknown>;
    if (typeof deltaRecord.text === "string" && deltaRecord.text.length > 0) {
      return { texts: [deltaRecord.text], isPartial };
    }

    if (typeof deltaRecord.content === "string" && deltaRecord.content.length > 0) {
      return { texts: [deltaRecord.content], isPartial };
    }
  }

  // Bare assistant message: { role: "assistant", content: ... }
  const role = record.role;
  if (role === "assistant") {
    const fromContent = extractTextFromContent(record.content);
    if (fromContent.length > 0) {
      return { texts: fromContent, isPartial };
    }
  }

  return { texts: [], isPartial: false };
};

export const createStreamJsonState = (): StreamJsonState => ({
  buffer: "",
  partialChunksSeen: 0
});

export const consumeStreamJsonChunk = (state: StreamJsonState, chunk: string): string[] => {
  state.buffer += chunk;

  const assistantChunks: string[] = [];
  while (true) {
    const newlineIndex = state.buffer.indexOf("\n");
    if (newlineIndex < 0) {
      break;
    }

    const rawLine = state.buffer.slice(0, newlineIndex);
    state.buffer = state.buffer.slice(newlineIndex + 1);

    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      const { texts, isPartial } = extractAssistantText(parsed);
      if (texts.length === 0) {
        continue;
      }

      if (isPartial) {
        // Real incremental delta — forward it and track that we've seen partials.
        state.partialChunksSeen += texts.length;
        assistantChunks.push(...texts);
      } else if (state.partialChunksSeen === 0) {
        // No partial chunks have arrived yet — this is a non-streaming final
        // message (e.g. when --stream-partial-output is not in effect), so
        // forward it as the sole chunk.
        assistantChunks.push(...texts);
      }
      // else: this is the aggregate duplicate that cursor-agent emits after all
      // partial chunks — skip it to avoid sending the full text a second time.
    } catch {
      // Ignore non-JSON lines emitted by the CLI.
    }
  }

  return assistantChunks;
};
