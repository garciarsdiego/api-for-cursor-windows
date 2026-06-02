# Anthropic Messages endpoint for Claude Code — Design

Status: approved design (2026-06-02). Target app version: 0.2.0 (new feature).

## Goal

Let **Claude Code (CLI)** use Cursor's Composer models through the local server, by adding an
**Anthropic Messages-compatible** endpoint. The user sets:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
ANTHROPIC_API_KEY=<their Cursor key, or "cursor-local" if saved in the app>
```

and runs `claude`. Scope: **text chat AND tool use** (Claude Code is agentic — it drives a
client-side tool loop), delivered together.

## Non-goals (v1)

- Claude **Desktop** (the chat app) — it needs request interception, out of scope.
- Parallel tool calls — the bridge captures one tool call per run, so we emit at most one
  `tool_use` block per turn (Claude Code handles this sequentially).
- Prompt caching, `count_tokens` exactness, vision fidelity beyond what the OpenAI path already
  supports, batch/`thinking` blocks.

## Architecture — Anthropic ↔ OpenAI adapter (reuse the proven pipeline)

We do NOT build a new model pipeline. We add a thin translation layer that converts the
Anthropic request into the EXISTING OpenAI/Cursor path (`prepareChatRequest` →
`createCursorSdkCompletion` → tool path → the 0.1.2 fresh-session + auto-retry stream), then
translates the resulting `CursorTextEvent` stream back into Anthropic `Message`/SSE.

```
Claude Code ──Anthropic /v1/messages──▶ anthropic.ts adapter
   request → OpenAI-shaped body → prepareChatRequest → createCursorSdkCompletion (bridge)
   CursorTextEvent stream  → anthropic.ts → Anthropic Message (non-stream) | Anthropic SSE
```

New code:
- `windows-app/sidecar/anthropic.ts` — pure translation (request → internal; events → Message;
  events → SSE; token estimate; error shape). No Cloudflare/Tauri deps; unit-testable.
- `windows-app/sidecar/server.ts` — two routes (`POST /v1/messages`, `POST /v1/messages/count_tokens`),
  `x-api-key` auth, model mapping; reuse `handleSdkRoute`'s factory (fresh session + auto-retry).

The shared `worker/` layer is NOT modified (Anthropic support is a Windows-app concern).

## Endpoints

- `POST /v1/messages` — core. Non-stream → `Message` object; `stream:true` → Anthropic SSE.
- `POST /v1/messages/count_tokens` → `{ "input_tokens": <estimate> }` (char-based, reusing the
  existing usage estimator). Claude Code calls this before sending.
- Reuse existing `GET /health`. (No `/v1/models` change needed for Claude Code.)

## Auth & model mapping

- Accept the Cursor key from **`x-api-key`** header (Claude Code's `ANTHROPIC_API_KEY`) OR
  `Authorization: Bearer`. The literal `cursor-local` (or empty) falls back to
  `process.env.CURSOR_API_KEY` (Credential Manager), like the OpenAI path. Extend `resolveApiKey`.
- Map any incoming `model` → `composer-2.5`; map names containing `haiku` → `composer-2.5-fast`.
  Echo the **requested** model string back in the response `model` field (Claude Code is lenient).

## Request translation (Anthropic → internal)

Build an OpenAI-shaped chat body, then call `prepareChatRequest`:
- `system` (string or `[{type:"text",text}]`) → a leading OpenAI `system` message.
- `messages[]`, each `content` is a string or an array of blocks:
  - `text` → text content.
  - `image` (`source.type:"base64"`) → OpenAI `image_url` data URL (reuse existing image limits).
  - `tool_use` (assistant) → OpenAI assistant `tool_calls` (`id`, `function.name`, `arguments`).
  - `tool_result` (user, `tool_use_id`, `content`) → OpenAI `tool` message (`tool_call_id`, content).
- `tools[]` (`{name, description, input_schema}`) → OpenAI tools (`{type:"function", function:{name,
  description, parameters: input_schema}}`).
- Params: `max_tokens` (required by Anthropic) → carried/ignored as the OpenAI path allows;
  `temperature`, `stop_sequences` → mapped where supported; `stream` → drives SSE vs object.

## Response translation (internal → Anthropic)

Consume the `CursorTextEvent` stream (`text` | `tool_call` | `done`).

**Non-stream `Message`:**
```json
{ "id": "msg_…", "type": "message", "role": "assistant", "model": "<requested>",
  "content": [ {"type":"text","text":"…"} , {"type":"tool_use","id":"toolu_…","name":"…","input":{…}} ],
  "stop_reason": "end_turn" | "tool_use", "stop_sequence": null,
  "usage": {"input_tokens": N, "output_tokens": M} }
```
`stop_reason` = `tool_use` when a `tool_call` was emitted, else `end_turn`.

**Streaming SSE** (exact event order Claude Code expects), each as `event: <type>\ndata: <json>\n\n`:
1. `message_start` — `{message:{id,type,role,model,content:[],stop_reason:null,usage:{input_tokens:N,output_tokens:0}}}`
2. For text: `content_block_start` (index 0, `{type:"text",text:""}`) → one or more
   `content_block_delta` (`{type:"text_delta", text:"…"}`) → `content_block_stop`.
3. For a tool call: `content_block_start` (next index, `{type:"tool_use", id, name, input:{}}`) →
   `content_block_delta` (`{type:"input_json_delta", partial_json:"<args json>"}`) → `content_block_stop`.
4. `message_delta` — `{delta:{stop_reason, stop_sequence:null}, usage:{output_tokens:M}}`.
5. `message_stop`.
   Also send SSE `ping` events are optional; we will emit `message_start` immediately so Claude Code
   sees the stream open before the bridge's first token.

## Tool flow

Reuse the SDK tool path (`clientTools` from the converted `tools`, `allowToolCall`). When Composer
emits a `tool_call`, we surface it as a `tool_use` block (generate `toolu_<uuid>`, `name`, `input` =
the args object). Claude Code executes it and sends `tool_result` on the next request, which we
render back into the prompt. Full conversation (incl. tool history) is resent by Claude Code each
turn, so we use a **fresh SDK session + full prompt** per request (stateless) + the existing
auto-retry. (No incrementalPrompt for `/v1/messages` in v1 — Claude Code is stateless-friendly.)

## Errors

On failure return the Anthropic error shape with the right HTTP status:
```json
{ "type": "error", "error": { "type": "invalid_request_error"|"authentication_error"|"api_error",
  "message": "…" } }
```
Map our `unauthorized` → 401 `authentication_error`; bridge/SDK failures → 5xx `api_error`. For
streaming, if a failure occurs mid-stream after `message_start`, emit an SSE `error` event.

## Testing

- **Unit** (`anthropic.test.ts`): request conversion (system/text/image/tool_use/tool_result/tools),
  non-stream `Message` shape, SSE event sequence (text-only and text+tool_use), error shape,
  `count_tokens`.
- **Smoke** (build the sidecar): `POST /v1/messages` with no key → structured `authentication_error`;
  with `stream:true` and a bogus key → `message_start` then `error` event (proves the SSE shape).
- **Live**: user points `ANTHROPIC_BASE_URL` at the app, runs Claude Code, verifies a chat answers
  and a simple tool task (e.g., "read file X") triggers a `tool_use` round-trip.

## Risks (called out in the design discussion)

- **Tool-calling fidelity:** Composer was not trained on Claude Code's exact tool schemas; emitted
  tool calls may be imperfect → the agentic loop may be flaky. Only measurable live.
- **One tool per turn** (bridge captures one tool call + cancels the run); sequential, not broken.
- Claude Code sends a large system prompt + many tools; prompt size/latency may be higher.

## Out-of-scope / future

- Parallel tool calls, prompt caching, `thinking` blocks, Claude Desktop interception, Linux build.

## Implementation outline (files)

1. `windows-app/sidecar/anthropic.ts` — translators + token estimate + error shape (+ unit tests).
2. `windows-app/sidecar/server.ts` — `POST /v1/messages`, `POST /v1/messages/count_tokens`,
   `x-api-key` in `resolveApiKey`, model mapping, reuse the retrying SDK stream factory.
3. Bump app to **0.2.0**; README + CHANGELOG (new "Claude Code" section); roadmap update.
4. Build installer, live-verify with Claude Code, release `v0.2.0-win`.
