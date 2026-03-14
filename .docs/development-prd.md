# PRD: Cursor Agent Adapter for OpenCode

## 1. Overview

Build a local adapter that makes **Cursor Agent CLI** appear to **OpenCode** as a normal model connector.

The adapter will expose a model-shaped interface to OpenCode, but internally it will invoke Cursor Agent in headless mode and return the final response back to OpenCode.

This is **not** a true model provider. It is a compatibility layer that wraps an agent as if it were a model.

## 2. Goal

Let a user select something like `cursor-agent/default` inside OpenCode and have requests executed by Cursor Agent running locally.

## 3. Non-Goals

* Perfect parity with real LLM providers
* Full token-level streaming fidelity
* Full function-calling compatibility on day one
* Exact usage/accounting metrics
* Multi-user or cloud deployment
* Support for every Cursor CLI feature in v1

## 4. Primary User Story

As a developer using OpenCode,
I want to choose a local model entry that actually routes prompts to Cursor Agent,
so I can use Cursor’s agent capabilities inside my existing OpenCode workflow.

## 5. Success Criteria

### MVP success

* OpenCode can call a local adapter endpoint as if it were a model provider
* The adapter can launch Cursor Agent CLI for a request
* The adapter returns a final text response to OpenCode
* The adapter works against the current project directory
* Errors are surfaced clearly

### V1 success

* Supports conversation context across turns
* Supports streamed partial output where feasible
* Supports configurable timeouts and safety limits
* Supports logging and replay for debugging
* Supports multiple fake model names mapped to different Cursor modes/configs

## 6. Key Assumption

Cursor Agent CLI can be run locally in a reliable non-interactive mode and can return machine-consumable output, or at least output that can be normalized by the adapter.

This assumption should be validated first.

## 7. Constraints

* OpenCode expects a provider/model abstraction, not an arbitrary CLI tool
* Cursor Agent is an agent workflow, not a raw inference API
* There may be mismatches in streaming, state, tool calling, approvals, and usage reporting
* The integration should stay local-first and avoid unnecessary network dependencies

## 8. Product Scope

### In scope for MVP

* Local HTTP server adapter
* One fake provider endpoint
* One fake model, e.g. `cursor-agent/default`
* Prompt-to-final-text request handling
* Configurable working directory
* Basic structured logs
* Timeout handling
* Error mapping

### In scope for V1

* Streaming bridge
* Session persistence
* Configurable profiles
* Per-project config
* Better output normalization
* Basic health endpoint
* Integration test harness

### Out of scope initially

* Full OpenAI API parity beyond required fields
* True token accounting
* Rich tool calling translation
* Hosted/shared deployment
* GUI

## 9. User Experience

### Desired UX

1. User configures OpenCode to talk to a local provider endpoint.
2. OpenCode shows a model like `cursor-agent/default`.
3. User selects that model.
4. User sends a prompt in OpenCode.
5. Adapter receives the request.
6. Adapter converts the request into a Cursor Agent CLI invocation.
7. Cursor runs in the target repo.
8. Adapter returns the final answer to OpenCode.

### Optional later UX

* `cursor-agent/fast`
* `cursor-agent/safe`
* `cursor-agent/review`
* `cursor-agent/codebase`

These can map to different flags, prompts, or policies.

## 10. Functional Requirements

### FR1 — Provider-compatible endpoint

The system must expose an HTTP API that OpenCode can use as a model provider.

### FR2 — Fake model registration

The system must expose at least one model identifier that OpenCode can select.

### FR3 — Request translation

The system must translate incoming chat/model requests into a Cursor Agent CLI command.

### FR4 — Working directory support

The system must run Cursor Agent against a configurable project directory.

### FR5 — Response normalization

The system must convert Cursor output into a clean assistant response for OpenCode.

### FR6 — Timeout and cancellation

The system must support request timeout and process termination.

### FR7 — Logging

The system must log inbound request metadata, command execution, exit codes, latency, and normalized output.

### FR8 — Configurability

The system must support config through env vars and/or a local config file.

### FR9 — Error mapping

The system must map CLI failures into clear API errors.

### FR10 — Minimal session support

The system should support either stateless requests or a lightweight session mapping mechanism.

## 11. Non-Functional Requirements

### Reliability

* The adapter should fail clearly and recover cleanly on the next request.
* Zombie subprocesses must be avoided.

### Security

* No arbitrary shell interpolation from user prompts.
* Use argument arrays, not shell strings.
* Restrict writable paths if possible.
* Redact secrets from logs.

### Performance

* MVP target: first response initiation in under 2 seconds excluding Cursor execution time.
* Timeout defaults should be configurable.

### Maintainability

* Clear module boundaries
* Strong request/response schemas
* Integration tests around subprocess behavior

### Portability

* Should work on macOS and Linux first.
* Windows optional later.

## 12. Proposed Architecture

### Components

#### A. Adapter HTTP server

Receives provider-style requests from OpenCode.

#### B. Request normalizer

Extracts the relevant prompt, system message, and conversation context.

#### C. Cursor runner

Launches Cursor Agent CLI with safe subprocess execution.

#### D. Output parser

Transforms stdout/stderr/final result into provider-style response JSON.

#### E. Session manager

Optionally maps OpenCode conversation IDs to Cursor session IDs.

#### F. Config module

Loads model aliases, cwd rules, timeouts, logging options, and Cursor binary path.

## 13. API Strategy

Use one of these two approaches:

### Option A — OpenAI-compatible shim

Build a local server that implements the subset of the OpenAI Chat Completions or Responses API that OpenCode can consume.

**Pros**

* Easiest mental model
* Reusable with other tools
* Easier local testing

**Cons**

* May need extra compatibility fields
* Can tempt overbuilding

### Option B — Direct AI SDK/provider shim

Implement the minimum provider contract expected by the OpenCode side if that is easier in practice.

**Pros**

* Potentially less surface area
* Better fit if OpenCode is tolerant of provider specifics

**Cons**

* Tighter coupling to OpenCode internals
* Harder to reuse elsewhere

### Recommendation

Start with **Option A** unless OpenCode clearly makes another path simpler.

## 14. Request Mapping Design

### Input from OpenCode

Likely includes:

* model name
* messages array
* system prompt
* temperature and other model params
* maybe stream flag

### Translation to Cursor

For MVP:

* flatten messages into a single structured prompt
* include role separators
* prepend system instructions
* pass project cwd
* run Cursor headless/non-interactive

Example internal prompt shape:

```text
[SYSTEM]
You are being called through an adapter from OpenCode. Return only the final assistant response.

[CONVERSATION]
user: ...
assistant: ...
user: ...
```

### Output back to OpenCode

Return:

* assistant text
* finish reason
* synthetic usage fields if required, clearly marked or zeroed

## 15. Streaming Strategy

### MVP

No true streaming. Buffer until Cursor completes, then return one final response.

### V1

Attempt line-based or event-based pseudo-streaming if Cursor emits incremental output.

### Risk

Streaming may feel unnatural because agent progress output is not token output.

## 16. State Strategy

### MVP

Stateless mode. Every request includes enough context for Cursor.

### V1

Store session mappings:

* OpenCode conversation ID -> Cursor session ID

Need expiration and recovery rules.

## 17. Configuration

### Required config

* `CURSOR_BIN_PATH`
* `ADAPTER_PORT`
* `DEFAULT_CWD`
* `REQUEST_TIMEOUT_MS`
* `LOG_LEVEL`

### Optional config

* model alias map
* allowed repo roots
* max stdout size
* session persistence path
* redaction rules

## 18. Error Model

Map these failures clearly:

* Cursor binary not found
* auth/session unavailable
* command timeout
* non-zero exit
* malformed output
* unsupported request field
* working directory invalid

Each should produce:

* stable error code
* human-readable message
* raw diagnostics only in logs

## 19. Risks

### Risk 1 — Cursor CLI changes

The CLI interface or output format may change and break the adapter.

**Mitigation:** isolate CLI invocation and parsing behind a single module and pin supported versions.

### Risk 2 — No stable machine-readable output

Cursor may not provide consistent JSON output.

**Mitigation:** validate early; if needed, use strict delimiters and prompt Cursor to emit a bounded final block.

### Risk 3 — Session mismatch

OpenCode turn semantics may not map cleanly to Cursor sessions.

**Mitigation:** ship stateless MVP first.

### Risk 4 — Hanging subprocesses

Agent runs may stall.

**Mitigation:** hard timeouts, process group kill, and cleanup.

### Risk 5 — Tool/approval conflicts

Cursor may try to act autonomously in ways OpenCode users do not expect.

**Mitigation:** start with read-heavy or tightly controlled execution settings.

## 20. Technical Decisions to Validate Early

1. Can Cursor Agent CLI run fully headless for repeated local requests?
2. Can it target a specific cwd predictably?
3. Can it emit reliably parseable final output?
4. Can one process per request perform acceptably?
5. What minimum API shape does OpenCode require from a provider endpoint?

## 21. Delivery Plan

### Phase 0 — Feasibility spike

Goal: prove the core loop works.

Tasks:

* Inspect how OpenCode connects to model providers
* Identify the simplest provider-compatible API surface
* Manually run Cursor CLI headless in a sample repo
* Capture stdout/stderr patterns
* Verify cwd behavior
* Verify timeout behavior
* Confirm whether machine-readable output exists

Deliverable:

* short feasibility note
* example request and example normalized response

Exit criteria:

* one prompt can be sent through a tiny local script to Cursor and parsed successfully

### Phase 1 — MVP adapter

Goal: create a working local adapter.

Tasks:

* Build HTTP server
* Add `/health`
* Add model listing endpoint if needed
* Add chat/completion endpoint
* Implement prompt flattening
* Implement subprocess runner
* Implement timeout and cancellation
* Implement response normalization
* Implement logs
* Add basic config loader
* Add manual test instructions

Deliverable:

* local service
* OpenCode config example
* one fake model name

Exit criteria:

* OpenCode can send a request and receive a final answer end-to-end

### Phase 2 — Hardening

Goal: make it usable for repeated development.

Tasks:

* Add integration tests
* Add session abstraction
* Add output size guards
* Add retry logic only where safe
* Add version checks for Cursor binary
* Improve error messages
* Add structured JSON logging

Exit criteria:

* stable across multiple repos and repeated requests

### Phase 3 — Better UX

Goal: reduce rough edges.

Tasks:

* Add pseudo-streaming
* Add multiple fake models/profiles
* Add per-project config
* Add prompt templates
* Add metrics/debug page

Exit criteria:

* good enough for daily personal use

## 22. Recommended Tech Stack

### Suggested stack

* TypeScript
* Node.js
* Fastify or Express
* Zod for schemas
* execa or child_process.spawn for subprocesses
* pino for logs

### Why

This should align well with local tool integration work and make it easier for another LLM to scaffold quickly.

## 23. Suggested Repo Structure

```text
adapter/
  src/
    server/
    routes/
    config/
    cursor/
    providers/
    sessions/
    utils/
    types/
  test/
  scripts/
  README.md
  package.json
```

## 24. Implementation Notes for the Builder LLM

Ask the builder to:

* prefer simple modules over abstractions
* avoid shell-based command construction
* keep the provider surface minimal
* write integration tests around subprocess mocks
* separate normalization logic from transport logic
* annotate all assumptions about Cursor CLI behavior

## 25. Open Questions

* What exact provider API shape does OpenCode accept most easily?
* Does Cursor CLI support a stable JSON output mode?
* Can auth/session state be reused across requests safely?
* How should usage/token fields be represented?
* Does OpenCode require streaming for a good UX?
* Should session persistence be file-based or memory-only initially?

## 26. Acceptance Test Cases

### AT1

Given the adapter is running,
when OpenCode requests `cursor-agent/default`,
then the adapter returns a valid assistant response.

### AT2

Given Cursor is missing,
when a request is made,
then the adapter returns a clear configuration error.

### AT3

Given Cursor hangs,
when timeout is reached,
then the adapter kills the process and returns a timeout error.

### AT4

Given the request includes prior conversation messages,
when the adapter runs,
then those messages are included in the flattened prompt in the expected order.

### AT5

Given Cursor returns noisy stdout,
when the adapter parses output,
then it extracts a clean final answer or fails with a parse error.

## 27. Definition of Done

The feature is done when:

* OpenCode can use a local fake model backed by Cursor Agent
* setup is documented clearly
* failures are debuggable
* subprocess cleanup is reliable
* basic integration tests pass

## 28. Build Order Recommendation

1. Feasibility script
2. Minimal parser
3. Local HTTP endpoint
4. OpenCode end-to-end wiring
5. Timeouts and cleanup
6. Logging
7. Tests
8. Session support
9. Streaming

## 29. Final Recommendation

Build this as a **local adapter service** with a **narrow MVP**.
Do **not** try to emulate a full model provider at first.
Focus on:

* one fake model
* one request type
* one repo at a time
* final text output only

That is the highest-probability path to something your local LLM can implement quickly and successfully.
