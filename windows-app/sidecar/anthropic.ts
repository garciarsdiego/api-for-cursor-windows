/**
 * Anthropic Messages API <-> OpenAI/Cursor adapter (sidecar-local, pure translation).
 *
 * Lets Claude Code (CLI) use Cursor's Composer via ANTHROPIC_BASE_URL: we convert an
 * Anthropic `/v1/messages` request into the OpenAI-shaped body that `worker/openai.ts`
 * `prepareChatRequest` already understands, run it through the existing Cursor SDK path,
 * then translate the resulting `CursorTextEvent` stream back into an Anthropic `Message`
 * (non-stream) or Anthropic SSE events (stream).
 *
 * See docs/superpowers/specs/2026-06-02-anthropic-endpoint-claude-code-design.md.
 */
import type { CursorTextEvent } from "../../worker/cursor";
import type { CursorToolCall } from "../../worker/types";

const PRIMARY_MODEL = "composer-2.5";

type Block = Record<string, unknown>;
type Msg = { role?: string; content?: unknown };

function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Map any Anthropic model name to a Composer model. We deliberately do NOT route
 * `haiku` to composer-2.5-fast: fast is 6x the cost, and Claude Code fires many cheap
 * haiku calls (titles, etc.), so that would invert the economics. */
export function mapModel(_model: unknown): string {
  return PRIMARY_MODEL;
}

/** Estimate tokens from a character count (count_tokens / usage are non-exact by design). */
export function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

/** Anthropic error envelope. */
export function anthropicError(message: string, type = "api_error"): { type: "error"; error: { type: string; message: string } } {
  return { type: "error", error: { type, message } };
}

/** Flatten an Anthropic `tool_result.content` (string OR array of blocks) to plain text. */
export function flattenToolResultContent(content: unknown, isError = false): string {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        if (!isRecord(b)) return typeof b === "string" ? b : "";
        if (b.type === "text" && typeof b.text === "string") return b.text;
        if (b.type === "image") return "[image]";
        return typeof b.text === "string" ? b.text : JSON.stringify(b);
      })
      .filter(Boolean)
      .join("\n");
  } else {
    text = content == null ? "" : String(content);
  }
  return isError ? `[tool error] ${text}` : text;
}

/** Anthropic `tool_choice` -> OpenAI `tool_choice` (undefined = omit). */
export function mapToolChoice(tc: unknown): unknown {
  if (!isRecord(tc)) return undefined;
  switch (tc.type) {
    case "auto":
      return undefined;
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return typeof tc.name === "string" ? { type: "function", function: { name: tc.name } } : undefined;
    default:
      return undefined;
  }
}

function imagePartFromBlock(block: Block): Record<string, unknown> | null {
  const source = isRecord(block.source) ? block.source : null;
  if (source && source.type === "base64" && typeof source.data === "string") {
    const mediaType = typeof source.media_type === "string" ? source.media_type : "image/png";
    return { type: "image_url", image_url: { url: `data:${mediaType};base64,${source.data}` } };
  }
  // url / file sources are best-effort: surface as text so we never crash.
  if (source && source.type === "url" && typeof source.url === "string") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return null;
}

/** Convert an Anthropic Messages request body into the OpenAI-shaped body that
 * `prepareChatRequest` consumes. May expand one Anthropic message into several OpenAI
 * messages (tool_result blocks become separate `tool` messages). */
export function anthropicToChatBody(body: unknown): Record<string, unknown> {
  const record = isRecord(body) ? body : {};
  const out: Record<string, unknown> = { model: PRIMARY_MODEL, stream: record.stream === true };
  const messages: Array<Record<string, unknown>> = [];

  // system: string or array of text blocks (ignore cache_control / unknown keys).
  const system = record.system;
  if (typeof system === "string" && system.trim()) {
    messages.push({ role: "system", content: system });
  } else if (Array.isArray(system)) {
    const text = system
      .map((b) => (isRecord(b) && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) messages.push({ role: "system", content: text });
  }

  for (const raw of asArray<Msg>(record.messages)) {
    const role = raw?.role === "assistant" ? "assistant" : "user";
    const content = raw?.content;

    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }

    const blocks = asArray<Block>(content);
    if (role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const b of blocks) {
        if (!isRecord(b)) continue;
        if (b.type === "text" && typeof b.text === "string") parts.push({ type: "text", text: b.text });
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: typeof b.id === "string" ? b.id : `toolu_${toolCalls.length}`,
            type: "function",
            function: { name: typeof b.name === "string" ? b.name : "", arguments: JSON.stringify(b.input ?? {}) }
          });
        }
      }
      const assistant: Record<string, unknown> = { role: "assistant", content: parts.length ? parts : null };
      if (toolCalls.length) assistant.tool_calls = toolCalls;
      messages.push(assistant);
      continue;
    }

    // user: tool_result blocks -> separate `tool` messages; text/image -> a user message.
    const userParts: Array<Record<string, unknown>> = [];
    for (const b of blocks) {
      if (!isRecord(b)) continue;
      if (b.type === "tool_result") {
        messages.push({
          role: "tool",
          tool_call_id: typeof b.tool_use_id === "string" ? b.tool_use_id : "",
          content: flattenToolResultContent(b.content, b.is_error === true)
        });
      } else if (b.type === "text" && typeof b.text === "string") {
        userParts.push({ type: "text", text: b.text });
      } else if (b.type === "image") {
        const img = imagePartFromBlock(b);
        if (img) userParts.push(img);
        else userParts.push({ type: "text", text: "[unsupported image source]" });
      }
    }
    if (userParts.length) messages.push({ role: "user", content: userParts });
  }

  out.messages = messages;

  const tools = asArray<Block>(record.tools)
    .filter(isRecord)
    .map((t) => ({
      type: "function",
      function: {
        name: typeof t.name === "string" ? t.name : "",
        ...(typeof t.description === "string" ? { description: t.description } : {}),
        parameters: t.input_schema ?? { type: "object", properties: {} }
      }
    }));
  if (tools.length) out.tools = tools;
  const toolChoice = mapToolChoice(record.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;

  return out;
}

function toolUseBlock(toolCall: CursorToolCall): Record<string, unknown> {
  return {
    type: "tool_use",
    id: `toolu_${crypto.randomUUID().replaceAll("-", "")}`,
    name: toolCall.name,
    input: isRecord(toolCall.arguments) ? toolCall.arguments : {}
  };
}

/** Build a non-stream Anthropic `Message` object. */
export function anthropicMessage(opts: {
  id: string;
  model: string;
  text: string;
  toolCalls: CursorToolCall[];
  inputTokens: number;
  outputTokens: number;
}): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (opts.text) content.push({ type: "text", text: opts.text });
  for (const tc of opts.toolCalls) content.push(toolUseBlock(tc));
  return {
    id: opts.id,
    type: "message",
    role: "assistant",
    model: opts.model,
    content,
    stop_reason: opts.toolCalls.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: opts.inputTokens, output_tokens: opts.outputTokens }
  };
}

/** Translate a `CursorTextEvent` stream into the ordered Anthropic SSE event objects.
 * The caller serializes each as `event: <event>\ndata: <JSON.stringify(data)>\n\n`. */
export async function* anthropicSseEvents(opts: {
  id: string;
  model: string;
  inputTokens: number;
  stream: AsyncIterable<CursorTextEvent>;
}): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  yield {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: opts.id,
        type: "message",
        role: "assistant",
        model: opts.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: opts.inputTokens, output_tokens: 1 }
      }
    }
  };

  let textIndex = -1; // index of the open text block, or -1
  let nextIndex = 0;
  let outputChars = 0;
  let sawTool = false;

  for await (const event of opts.stream) {
    if (event.type === "text" && event.text) {
      if (textIndex === -1) {
        textIndex = nextIndex++;
        yield { event: "content_block_start", data: { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } } };
      }
      outputChars += event.text.length;
      yield { event: "content_block_delta", data: { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: event.text } } };
    } else if (event.type === "tool_call" && event.toolCall) {
      if (textIndex !== -1) {
        yield { event: "content_block_stop", data: { type: "content_block_stop", index: textIndex } };
        textIndex = -1;
      }
      const idx = nextIndex++;
      const block = toolUseBlock(event.toolCall);
      const input = block.input as Record<string, unknown>;
      yield { event: "content_block_start", data: { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } } };
      yield { event: "content_block_delta", data: { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } } };
      yield { event: "content_block_stop", data: { type: "content_block_stop", index: idx } };
      sawTool = true;
    } else if (event.type === "done") {
      break;
    }
  }

  if (textIndex !== -1) {
    yield { event: "content_block_stop", data: { type: "content_block_stop", index: textIndex } };
  }
  yield {
    event: "message_delta",
    data: { type: "message_delta", delta: { stop_reason: sawTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: estimateTokens(outputChars) } }
  };
  yield { event: "message_stop", data: { type: "message_stop" } };
}
