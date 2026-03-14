# Cursor OpenCode Adapter (MVP)

Local adapter that exposes Cursor Agent CLI as an OpenAI-style chat completion endpoint so OpenCode can call it as if it were a model provider.

## What this ships

- OpenAI-compatible subset endpoints:
  - `GET /health`
  - `GET /v1/models`
  - `POST /v1/chat/completions`
- One fake model id: `cursor-agent/default` (configurable)
- Prompt flattening from `messages[]` into a Cursor-ready text block
- Safe subprocess execution with argument arrays (no shell interpolation)
- Timeout handling with process termination
- Stable error codes for common failure modes
- Integration-style tests with mocked subprocess behavior

## Requirements

- Node.js `>=20`
- Local Cursor Agent binary path configured in `CURSOR_BIN_PATH`

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy and edit env:

```bash
cp .env.example .env
```

3. Start dev server:

```bash
npm run dev
```

## Quick API checks

### Health

```bash
curl http://127.0.0.1:8787/health
```

### Models

```bash
curl http://127.0.0.1:8787/v1/models
```

### Chat completion

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cursor-agent/default",
    "messages": [
      { "role": "system", "content": "Be concise." },
      { "role": "user", "content": "Say hello." }
    ],
    "stream": false
  }'
```

## Feasibility spike script (Phase 0)

Run a single prompt directly through the runner:

```bash
npx tsx scripts/feasibility.ts "Say hello in one sentence"
```

## OpenCode wiring idea

Configure OpenCode to use this local endpoint as an OpenAI-compatible provider:

- Base URL: `http://127.0.0.1:8787/v1`
- Model: `cursor-agent/default`
- API key: any dummy value if OpenCode requires one

## Current assumptions

- Cursor CLI is callable as a local binary and can run headlessly.
- Prompt delivery mode may differ by Cursor version; use:
  - `CURSOR_PROMPT_MODE=stdin` (default), or
  - `CURSOR_PROMPT_MODE=arg` with `CURSOR_PROMPT_ARG`.
- Model compatibility can be widened with:
  - `CURSOR_ACCEPT_ANY_MODEL=true` (default)
  - `CURSOR_MODEL_ALIASES=cursor-agent/default,claude-4-6-sonnet`
- For low-latency greetings:
  - `ENABLE_GREETING_FAST_PATH=true` (default)
  - `GREETING_FAST_PATH_RESPONSE=Hi! What can I help you build or debug today?`
- For faster non-trivial prompts:
  - `PROMPT_MAX_CONVERSATION_MESSAGES=10`
  - `PROMPT_MAX_MESSAGE_CHARS=2000`
  - `PROMPT_MAX_CHARS=12000`
  - `RESPONSE_CACHE_TTL_MS=60000`
  - `RESPONSE_CACHE_MAX_ENTRIES=200`
- For Cursor session reuse:
  - `ENABLE_CURSOR_SESSIONS=true`
  - `CURSOR_SESSION_FALLBACK_TO_CWD=true` (single warm session per cwd when no conversation id)
  - `CURSOR_SESSION_TTL_MS=1800000`
  - `CURSOR_SESSION_MAX_ENTRIES=500`
  - Include `metadata.conversationId` (or `threadId`/`sessionId`) in request payload
- If Cursor cannot emit structured output, adapter falls back to trimmed stdout.

## Tests

Run:

```bash
npm test
```
