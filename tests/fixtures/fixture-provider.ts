/**
 * Deterministic in-process model provider for B2b real-host acceptance.
 *
 * Registers a "fixture" provider whose `streamSimple` never touches the network: every
 * response is scripted from the conversation itself, so the real Pi host (loader, event
 * bus, extension runner, SessionManager, agent loop, TUI) runs end to end with zero
 * provider credentials and zero billed calls. Loaded through `pi -e <this file>`.
 *
 * Protocol (the last user message decides the scripted turn):
 *   FIXTURE:ECHO:<text>            stream <text> back as plain text
 *   FIXTURE:STREAM:<text>          same, but in FIXTURE_CHUNKS deltas with
 *                                  FIXTURE_STREAM_DELAY_MS between them
 *   FIXTURE:REPLY:<word>          reply with `«<word>-START»` as ONE first delta, then
 *                                  FIXTURE_CHUNKS body deltas, then one `«END» delta
 *                                  (total deltas = FIXTURE_CHUNKS + 2, exactly)
 *   FIXTURE:LONGREPLY:<word>       same shape, but FIXTURE_LONG_CHUNKS body deltas with
 *                                  FIXTURE_LONG_DELAY_MS between them (a long stream for
 *                                  during-stream typing measurements)
 *   FIXTURE:FILLER:<paragraphs>    reply with <paragraphs> deterministic ~100-token
 *                                  paragraphs (for growing context between compactions)
 *   FIXTURE:TOOL:read:<path>       emit one `read` tool call; the follow-up call (after
 *                                  the tool result) replies "FIXTURE:DONE"
 *   FIXTURE:TOOL:bash:<command>    emit one `bash` tool call; follow-up "FIXTURE:DONE"
 *   FIXTURE:TOOL:fail:<command>    emit one `bash` call that exits non-zero
 *   anything else                  reply "FIXTURE:OK"
 *
 * Compaction and branch summarization requests (detected by Pi's summarization system
 * prompt) always return the fixed summary "FIXTURE-SUMMARY", which is what makes the
 * repeated-same-summary compaction scenario reproducible.
 *
 * Usage numbers are deterministic: call #n (counted per process) reports
 * input=1000+n, output=100+2n, cacheRead=300+3n, cacheWrite=7+n, cost.total=(n+1)/100.
 * An independent oracle can therefore sum the session file without knowing this script,
 * but repeated runs of the same scenario produce identical numbers.
 *
 * Environment:
 *   FIXTURE_STREAM_DELAY_MS  inter-delta delay for FIXTURE:STREAM (default 0)
 *   FIXTURE_CHUNKS           delta count for FIXTURE:STREAM (default 8)
 *   FIXTURE_LOG              append one JSON line per model call to this path
 *
 * Abort semantics: the options.signal from the host is honored mid-stream; an aborted
 * stream stops without its terminator and ends with the "error"/"aborted" event a
 * real provider emits, so abort/retry acceptance runs against realistic partials.
 */
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SUMMARIZATION_MARKER = "You are a context summarization assistant";
const MODEL_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

let calls = 0;

function logCall(record) {
  const path = process.env.FIXTURE_LOG;
  if (!path) return;
  try {
    const line = JSON.stringify({ ...record, at: new Date().toISOString() }) + "\n";
    appendFileSync(path, line);
  } catch { /* diagnostics only */ }
}

function usageFor(n) {
  const usage = {
    input: 1000 + n,
    output: 100 + 2 * n,
    cacheRead: 300 + 3 * n,
    cacheWrite: 7 + n,
    totalTokens: 1000 + n + 100 + 2 * n + 300 + 3 * n + 7 + n,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: (n + 1) / 100 },
  };
  return usage;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lastUserText(context) {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content.filter((block) => block?.type === "text").map((block) => block.text).join("");
    }
    return "";
  }
  return "";
}

function scriptFor(context) {
  // A turn whose last message is a tool result is the follow-up call: finish the turn.
  const last = context.messages[context.messages.length - 1];
  if (last?.role === "toolResult") return { kind: "text", text: "FIXTURE:DONE" };
  const text = lastUserText(context);
  const echo = text.match(/^FIXTURE:ECHO:(.*)$/s);
  if (echo) return { kind: "text", text: echo[1] };
  const filler = text.match(/^FIXTURE:FILLER:(\d+)$/s);
  if (filler) return { kind: "filler", count: Number(filler[1]) || 1 };
  const reply = text.match(/^FIXTURE:(LONG)?REPLY:([A-Za-z0-9-]+)$/s);
  if (reply) {
    const word = reply[2];
    return { kind: reply[1] ? "longreply" : "reply", word };
  }
  const stream = text.match(/^FIXTURE:STREAM:(.*)$/s);
  if (stream) return { kind: "stream", text: stream[1] };
  const tool = text.match(/^FIXTURE:TOOL:(read|bash|fail):(.*)$/s);
  if (tool) {
    if (tool[1] === "read") return { kind: "tool", name: "read", arguments: { path: tool[2] } };
    if (tool[1] === "bash") return { kind: "tool", name: "bash", arguments: { command: tool[2] } };
    return { kind: "tool", name: "bash", arguments: { command: `${tool[2]}; exit 3` } };
  }
  if (text.includes("FIXTURE:DONE")) return { kind: "text", text: "FIXTURE:DONE" };
  return { kind: "text", text: "FIXTURE:OK" };
}
function fillerText(paragraphs) {
  const words = ["data", "stream", "context", "fixture", "token", "history", "window", "ledger", "branch", "summary"];
  let text = "";
  for (let p = 0; p < paragraphs; p++) {
    for (let w = 0; w < 80; w++) text += words[(p * 80 + w) % words.length] + " ";
    text = text.trimEnd() + "\n";
  }
  return text;
}

function emitText(stream, output, text, chunks, delayMs, signal) {
  // Exact split: `chunks` evenly sized pieces (floor/ceil distribution), so the delta
  // count is deterministic and equals the requested chunk count.
  const parts = [];
  for (let index = 0; index < chunks; index++) {
    const start = Math.floor((text.length * index) / chunks);
    const end = Math.floor((text.length * (index + 1)) / chunks);
    if (end > start) parts.push(text.slice(start, end));
  }
  output.content.push({ type: "text", text: "" });
  const contentIndex = output.content.length - 1;
  stream.push({ type: "text_start", contentIndex, partial: output });
  return (async () => {
    let accumulated = "";
    for (const part of parts) {
      if (signal?.aborted) return; // honor the host's abort signal mid-stream
      if (delayMs > 0) await sleep(delayMs);
      if (signal?.aborted) return;
      accumulated += part;
      const block = output.content[contentIndex];
      block.text = accumulated;
      stream.push({ type: "text_delta", contentIndex, delta: part, partial: output });
    }
    stream.push({ type: "text_end", contentIndex, content: accumulated, partial: output });
  })();
}

/**
 * Measurement reply: one atomic prefix delta, `chunks` evenly split body deltas, one
 * atomic terminator delta (total = chunks + 2). The prefix/terminator use characters
 * that never occur in the echoed command or the surrounding UI, so first-content and
 * completion detection are unambiguous at the terminal.
 */
function emitMeasured(stream, output, prefix, body, terminator, chunks, delayMs, signal) {
  output.content.push({ type: "text", text: "" });
  const contentIndex = output.content.length - 1;
  stream.push({ type: "text_start", contentIndex, partial: output });
  return (async () => {
    let accumulated = "";
    const emit = async (part) => {
      if (signal?.aborted) return; // honor the host's abort signal mid-stream
      if (delayMs > 0) await sleep(delayMs);
      if (signal?.aborted) return;
      accumulated += part;
      output.content[contentIndex].text = accumulated;
      stream.push({ type: "text_delta", contentIndex, delta: part, partial: output });
    };
    await emit(prefix);
    for (let index = 0; index < chunks; index++) {
      if (signal?.aborted) return;
      const start = Math.floor((body.length * index) / chunks);
      const end = Math.floor((body.length * (index + 1)) / chunks);
      if (end > start) await emit(body.slice(start, end));
    }
    await emit(terminator);
    stream.push({ type: "text_end", contentIndex, content: accumulated, partial: output });
  })();
}

function streamFixture(model, context, options) {
  const stream = createAssistantMessageEventStream();
  const signal = options?.signal; // the host aborts in-flight requests through this
  const n = ++calls;
  const usage = usageFor(n);
  // Pi 0.99 normalizes systemPrompt into role=system transcript messages.
  const systemTexts = [context.systemPrompt, ...context.messages
    .filter((message) => message.role === "system")
    .map((message) => typeof message.content === "string" ? message.content :
      message.content.filter((block) => block.type === "text").map((block) => block.text).join(""))];
  const isSummary = systemTexts.some((text) => typeof text === "string" && text.startsWith(SUMMARIZATION_MARKER));
  const script = isSummary ? { kind: "text", text: "FIXTURE-SUMMARY" } : scriptFor(context);
  if (script.kind === "filler") {
    // Reported context tokens must exceed pi's keepRecentTokens for compaction to have
    // work to do; scale the reported output with the requested paragraph count.
    usage.output = Math.min(script.count * 100, 60_000);
    usage.input = 2_000;
    usage.cacheRead = 0;
    usage.cacheWrite = 0;
    usage.totalTokens = usage.input + usage.output;
  }
  const output = {
    role: "assistant",
    content: [],
    api: model.api ?? "openai-completions",
    provider: "fixture",
    model: model.id,
    usage,
    stopReason: "pending",
    timestamp: Date.now(),
  };
  logCall({ call: n, model: model.id, summary: isSummary, script: script.kind, usage: { ...usage } });
  (async () => {
    try {
      stream.push({ type: "start", partial: output });
      const delayMs = Number(process.env.FIXTURE_STREAM_DELAY_MS ?? "0") || 0;
      const chunks = Number(process.env.FIXTURE_CHUNKS ?? "8") || 8;
      const longDelayMs = Number(process.env.FIXTURE_LONG_DELAY_MS ?? "10") || 10;
      const longChunks = Number(process.env.FIXTURE_LONG_CHUNKS ?? "150") || 150;
      if (script.kind === "tool") {
        output.content.push({ type: "toolCall", id: `fixture-call-${n}`, name: script.name, arguments: { ...script.arguments } });
        stream.push({
          type: "toolcall_start",
          contentIndex: output.content.length - 1,
          partial: output,
        });
        stream.push({
          type: "toolcall_delta",
          contentIndex: output.content.length - 1,
          delta: JSON.stringify(script.arguments),
          partial: output,
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: output.content.length - 1,
          toolCall: { type: "toolCall", id: `fixture-call-${n}`, name: script.name, arguments: { ...script.arguments } },
          partial: output,
        });
        output.stopReason = "toolUse";
      } else if (script.kind === "reply" || script.kind === "longreply") {
        // Measurement-precise shape: one atomic first-content delta (the unique prefix,
        // never present in the echoed command), exactly `chunks` evenly split body
        // deltas, then one atomic terminator delta. Total deltas = chunks + 2.
        const prefix = `«${script.word}-START»`;
        const terminator = "«END»";
        const body = Array.from({ length: 24 }, (_, index) => `${script.word}-body-token-${index}`).join(" ");
        await emitMeasured(stream, output, prefix, body, terminator, script.kind === "longreply"
          ? longChunks : chunks, script.kind === "longreply" ? longDelayMs : delayMs, signal);
      } else {
        const body = script.kind === "filler" ? fillerText(script.count) : script.text;
        await emitText(stream, output, body, script.kind === "stream" ? chunks : 1, script.kind === "stream" ? delayMs : 0, signal);
      }
      if (signal?.aborted) {
        // An aborted stream stops without the terminator: the same partial-commit
        // semantics a real network provider shows when the host aborts mid-flight.
        output.stopReason = "aborted";
        stream.push({ type: "error", reason: "aborted", error: output });
        stream.end(output);
        return;
      }
      if (script.kind === "tool") {
        output.stopReason = "toolUse";
      } else {
        output.stopReason = "stop";
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end(output);
    } catch (error) {
      output.stopReason = "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: "error", error: output });
      stream.end(output);
    }
  })();
  return stream;
}

export default function fixtureProvider(pi: ExtensionAPI) {
  pi.registerProvider("fixture", {
    name: "Deterministic Fixture",
    baseUrl: "http://127.0.0.1:9", // never contacted: streamSimple is fully in-process
    apiKey: "fixture-not-a-secret",
    authHeader: true,
    api: "openai-completions",
    streamSimple: streamFixture,
    models: [
      {
        id: "fixture-alpha",
        name: "Fixture Alpha",
        reasoning: false,
        input: ["text"],
        cost: MODEL_COST,
        contextWindow: 200_000,
        maxTokens: 4_096,
      },
      {
        id: "fixture-beta",
        name: "Fixture Beta",
        reasoning: false,
        input: ["text"],
        cost: MODEL_COST,
        contextWindow: 128_000,
        maxTokens: 4_096,
      },
    ],
  });
}
