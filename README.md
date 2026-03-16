# Cursor OpenCode Adapter (MVP)

[![Release](https://img.shields.io/github/v/release/JonRoosevelt/cursor-opencode-plugin?display_name=tag)](https://github.com/JonRoosevelt/cursor-opencode-plugin/releases)
![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933)
![Status MVP](https://img.shields.io/badge/status-MVP-4c1)

Local adapter that exposes Cursor Agent CLI as an OpenAI-style chat completion endpoint so OpenCode can call it as if it were a model provider.

## What this ships

- OpenAI-compatible subset endpoints:
  - `GET /health`
  - `GET /models`
  - `GET /v1/models`
  - `POST /v1/chat/completions`
- Configurable model aliases, with optional dynamic model discovery from `cursor-agent`
- Prompt flattening from `messages[]` into a Cursor-ready text block
- Safe subprocess execution with argument arrays (no shell interpolation)
- Timeout handling with process termination
- Stable error codes for common failure modes
- Integration-style tests with mocked subprocess behavior

## Requirements

- Node.js `>=20`
- Cursor Agent CLI installed locally (`cursor-agent`)
- Local Cursor Agent binary path configured in `CURSOR_BIN_PATH`

Verify Cursor Agent is installed:

```bash
cursor-agent --version
```

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
curl http://127.0.0.1:8787/models
```

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

Create or update `~/.config/opencode/opencode.json` with a `cursor` provider entry like:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "cursor": {
      "name": "Cursor",
      "npm": "@ai-sdk/openai-compatible",
      "models": {
        "claude-4-6-sonnet": {
          "name": "Claude Sonnet 4.6"
        },
        "gpt-5.3-codex": {
          "name": "GPT-5.3 Codex"
        }
      },
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1"
      }
    }
  }
}
```

## Dynamic model sync

On startup, the adapter automatically calls `cursor-agent models`, parses the full model list, and writes it into the `provider.cursor.models` block of `~/.config/opencode/opencode.json`. This means OpenCode's model picker will show every model your Cursor account has access to without any manual config.

- Controlled by `CURSOR_DISCOVER_MODELS=true` (default). Set to `false` to disable.
- If the sync fails for any reason (cursor-agent not found, non-zero exit, etc.), the adapter logs a warning and leaves `opencode.json` untouched — models already configured there remain as the fallback.
- The sync runs once per adapter boot (not on every request).

## Current assumptions

- Cursor CLI is callable as a local binary and can run headlessly.
- For `stream=true`, the adapter requests Cursor stream output (`--output-format stream-json --print`) and forwards incremental SSE chunks as they arrive.
- Prompt delivery mode may differ by Cursor version; use:
  - `CURSOR_PROMPT_MODE=stdin` (default), or
  - `CURSOR_PROMPT_MODE=arg` with `CURSOR_PROMPT_ARG`.
- Model compatibility can be widened with:
  - `CURSOR_ACCEPT_ANY_MODEL=true` (default)
  - `CURSOR_MODEL_ALIASES=cursor-agent/default,claude-4-6-sonnet`
- Model forwarding and discovery:
  - `CURSOR_MODEL_ARG=--model`
  - `CURSOR_DISCOVER_MODELS=true` (default)
  - `CURSOR_MODELS_ARGS=models`
  - `CURSOR_MODELS_CACHE_TTL_MS=300000`
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
- Working directory resolution for each request:
  - First tries request metadata keys like `cwd`, `workspacePath`, `projectPath`, `repoPath`
  - Then checks equivalent top-level request fields and `x-opencode-cwd`/`x-workspace-path` headers
  - Finally attempts to extract `Workspace Path: ...` from message text before falling back to `DEFAULT_CWD`
- If Cursor cannot emit structured output, adapter falls back to trimmed stdout.

## Tests

Run:

```bash
npm test
```
