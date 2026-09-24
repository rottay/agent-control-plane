import type {
  CapabilityOutcome,
  ParseCursor,
  ParseOutcome,
  ProviderAdapter,
  ProviderSignal,
  SessionDescriptor,
  SessionRequest,
} from "../../src/contract/index.js";
import { EMPTY_CURSOR, unknownCapabilities } from "../../src/contract/index.js";
import { AdapterError } from "../../src/errors/index.js";
import type {
  ApiStreamChunk,
  ApiStreamRequest,
  ApiStreamingClient,
} from "../../src/api-key/index.js";
import type {
  LocalChatChunk,
  LocalChatRequest,
  LocalChatClient,
} from "../../src/local/index.js";

/**
 * A scripted stand-in for a provider.
 *
 * Every negative in this package is driven by this rather than by a real
 * provider: no auth, no network, no account, no product path. What it proves
 * is *our* machinery — the parser, the budget, the ladder, the state machine.
 *
 * It deliberately proves nothing about any real provider, and the capability
 * model refuses to let it: evidence produced here carries `subject: "FAKE"`,
 * which can never confirm a provider capability. This module is **not** part
 * of the package's closed public surface; tests import it by relative path.
 */

/** One newline-delimited JSON record per signal, which is all the fake speaks. */
export interface FakeScript {
  readonly lines: readonly string[];
  readonly exitCode: number;
  /** Emit to stderr instead of stdout, to exercise the shared budget. */
  readonly toStderr?: boolean;
  /** Ignore SIGINT, so the escalation ladder has to do real work. */
  readonly ignoreSigint?: boolean;
  /** Delay before exiting, in milliseconds. */
  readonly lingerMs?: number;
  /**
   * End by the child's own signal instead of an exit code (P-07 escalón C): a
   * child that dies of a signal it raised is a different fact from one our
   * ladder killed, and the session must report which.
   */
  readonly selfSignal?: "SIGTERM" | "SIGINT";
}

/** The Node program the fake runs. Written as argv, never as a shell string. */
export function fakeProviderArgv(script: FakeScript): readonly string[] {
  const program = [
    script.ignoreSigint === true ? "process.on('SIGINT', () => {});" : "",
    "const out = " + (script.toStderr === true ? "process.stderr" : "process.stdout") + ";",
    "const lines = " + JSON.stringify([...script.lines]) + ";",
    "for (const line of lines) out.write(line + '\\n');",
    script.selfSignal !== undefined
      ? // Raised only once the output has been flushed, so the stream is whole.
        "out.write('', () => setTimeout(() => process.kill(process.pid, " +
        JSON.stringify(script.selfSignal) +
        "), " +
        String(script.lingerMs ?? 0) +
        "));"
      : script.lingerMs !== undefined && script.lingerMs > 0
        ? "setTimeout(() => process.exit(" + String(script.exitCode) + "), " + String(script.lingerMs) + ");"
        : "process.exit(" + String(script.exitCode) + ");",
  ].join("\n");
  return Object.freeze(["-e", program]);
}

/** Turn one JSON record into a provider signal, or refuse it. */
function readRecord(raw: string): ProviderSignal | "UNKNOWN" | "MALFORMED" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return "MALFORMED";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "MALFORMED";
  const record = parsed as Record<string, unknown>;
  const type = record["type"];
  if (typeof type !== "string") return "MALFORMED";

  switch (type) {
    case "started": {
      const model = record["resolvedModel"];
      const version = record["protocolVersion"];
      if (typeof model !== "string" || typeof version !== "string") return "MALFORMED";
      return { kind: "started", resolvedModel: model, protocolVersion: version };
    }
    case "step": {
      // The fake's one-number step, read as a usage report whose class split is
      // unknown (P-15/D2): its total, never a 0 in a class nobody reported.
      const tokens = record["tokensUsed"];
      const index = record["stepIndex"];
      if (typeof tokens !== "number" || typeof index !== "number") return "MALFORMED";
      return {
        kind: "step",
        stepIndex: index,
        inputTokens: null,
        outputTokens: null,
        cacheWriteTokens: null,
        cacheReadTokens: null,
        totalTokens: tokens,
        reportKind: "CUMULATIVE",
        isFinal: true,
        sourceObservationId: "fake/step-" + String(index),
      };
    }
    case "checkpoint": {
      const digest = record["digest"];
      if (typeof digest !== "string") return "MALFORMED";
      return { kind: "checkpoint", digest };
    }
    case "authRequired": {
      const reason = record["reason"];
      if (typeof reason !== "string") return "MALFORMED";
      return { kind: "authRequired", reason };
    }
    case "state": {
      const toState = record["toState"];
      if (typeof toState !== "string") return "MALFORMED";
      return { kind: "state", toState };
    }
    case "write": {
      const target = record["target"];
      if (typeof target !== "string") return "MALFORMED";
      return { kind: "write", target };
    }
    default:
      return "UNKNOWN";
  }
}

/**
 * The fake's adapter: newline-framed JSON, with a carry-over partial record.
 *
 * The partial is what makes the framing honest. A chunk boundary lands wherever
 * the operating system put it, not where a record ends, so a parser that
 * assumed whole records per chunk would work in every test and fail in every
 * real stream.
 */
export const fakeAdapter: ProviderAdapter = {
  provider: "claude",

  describe(request: SessionRequest): SessionDescriptor {
    return {
      provider: "claude",
      argv: ["-e", "process.exit(0);"],
      env: { PATH: "/usr/bin:/bin" },
      cwd: request.workdir,
      // This stand-in is its own transport, not an impersonation of one: it
      // declares `STDIN` because the fake subject it drives reads stdin.
      delivery: { kind: "STDIN" },
    };
  },

  parse(chunk: string, cursor: ParseCursor): ParseOutcome {
    const buffered = cursor.partial + chunk;
    const parts = buffered.split("\n");
    const partial = parts.pop() ?? "";
    const events: ProviderSignal[] = [];
    let index = cursor.recordIndex;

    for (const line of parts) {
      if (line.trim() === "") continue;
      const outcome = readRecord(line);
      if (outcome === "UNKNOWN") {
        return { ok: false, code: "UNKNOWN_EVENT", detail: "record " + String(index) };
      }
      if (outcome === "MALFORMED") {
        return { ok: false, code: "MALFORMED_EVENT", detail: "record " + String(index) };
      }
      events.push(outcome);
      index += 1;
    }
    return { ok: true, events, cursor: { partial, recordIndex: index } };
  },

  negotiate(): CapabilityOutcome {
    // A fake never confirms a provider capability. Everything stays UNKNOWN.
    return { ok: true, capabilities: unknownCapabilities(), protocolVersion: "fake-1" };
  },
};

export { EMPTY_CURSOR };
/**
 * A real adapter's parser, driven by a scripted process. (P8-2, N1.)
 *
 * The conformance fixture has to answer one question: do the three landed CLI
 * adapters normalize the same logical scenario into the same trail? Answering
 * it with three *fake* parsers would answer a different question — whether one
 * fake agrees with itself. So the adapter under test stays real: its `parse`,
 * its `negotiate` and its `provider` are the shipped ones, and only `describe`
 * is replaced, so the child process is a scripted Node program speaking that
 * provider's own wire format instead of a provider binary nobody may run here.
 *
 * What this proves is exactly the parsers and the normalization. It proves
 * nothing about any real provider, which is why the capability model still
 * refuses to let evidence from here confirm anything.
 */
export function scriptedAdapter(base: ProviderAdapter, script: FakeScript): ProviderAdapter {
  return {
    ...base,
    describe(request: SessionRequest): SessionDescriptor {
      return {
        provider: base.provider,
        argv: fakeProviderArgv(script),
        env: { PATH: "/usr/bin:/bin" },
        cwd: request.workdir,
        // Asked of the real adapter, never restated here (V2-B1c). This
        // function replaces the argv so a fake subject can be driven; it must
        // not also replace what the transport says about delivery, or a
        // Codex- or Kimi-shaped fake would accept an instruction the real
        // adapter refuses and the pre-spawn refusal would be proved against a
        // fixture that disagrees with production. A copied provider table here
        // would drift the moment an adapter changed its declaration.
        delivery: base.describe(request).delivery,
      };
    },
  };
}

/**
 * A scripted stand-in for a provider API. (P8-3.)
 *
 * The API transport has no process to fake, so the fake is the client itself:
 * a scripted implementation of the owned `ApiStreamingClient` interface. The
 * acceptance criterion admits exactly this ("fake or real"), and what it proves
 * is the same thing the CLI leg's fake proves — our normalization and our
 * boundary — not anything about a provider's API.
 *
 * The `secret` parameter is the point of the credential drill: it stands where
 * a real implementation would hold an API key, closed over by the
 * implementation and reachable by nothing the interface exposes. A test spends
 * it into the stream's own text and then proves it never reaches the emitted
 * trail.
 */
export interface FakeApiScript {
  readonly provider: string;
  readonly models: readonly string[];
  readonly chunks: readonly ApiStreamChunk[];
  /** Thrown after the listed chunks, to drive the failure path. */
  readonly failAfter?: boolean;
}

export function fakeApiClient(script: FakeApiScript, secret = "unused"): ApiStreamingClient {
  return {
    provider: script.provider,
    models: script.models,
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(request: ApiStreamRequest): AsyncIterable<ApiStreamChunk> {
      // The credential lives here, in the implementation's closure, and the
      // request cannot carry it: `ApiStreamRequest` has no field it would fit
      // in. That is the "credential-free by shape" claim, exercised.
      void secret;
      void request;
      for (const chunk of script.chunks) yield chunk;
      if (script.failAfter === true) {
        throw new AdapterError("MALFORMED_EVENT", { provider: script.provider, taskId: "" });
      }
    },
  };
}

/**
 * A scripted stand-in for a local or self-hosted server. (P8-4.)
 *
 * Same reasoning as the API leg's fake, applied to the OpenAI-compatible
 * chat/completions shape: the fake is the client itself, a scripted
 * implementation of the owned `LocalChatClient` interface, not a fake HTTP
 * server. What it proves is our normalization and our boundary, never
 * anything about a real local server.
 *
 * The `secret` parameter carries the same drill as the API leg's: it stands
 * where a real implementation would hold whatever an optional local bearer
 * token would be, closed over here and reachable by nothing the interface
 * exposes.
 */
export interface FakeLocalScript {
  readonly provider: string;
  readonly models: readonly string[];
  readonly chunks: readonly LocalChatChunk[];
  /** Thrown after the listed chunks, to drive the failure path. */
  readonly failAfter?: boolean;
}

export function fakeLocalClient(script: FakeLocalScript, secret = "unused"): LocalChatClient {
  return {
    provider: script.provider,
    models: script.models,
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(request: LocalChatRequest): AsyncIterable<LocalChatChunk> {
      // The credential lives here, in the implementation's closure, and the
      // request cannot carry it: `LocalChatRequest` has no field it would fit
      // in. That is the "credential-free by shape" claim, exercised.
      void secret;
      void request;
      for (const chunk of script.chunks) yield chunk;
      if (script.failAfter === true) {
        throw new AdapterError("MALFORMED_EVENT", { provider: script.provider, taskId: "" });
      }
    },
  };
}

/**
 * A synthetic credential for the leak drills (P-15/E, ADR 0108).
 *
 * Built by concatenation so no credential-shaped literal sits in the source, and
 * inside the resolver's value grammar (visible ASCII, 0x21-0x7E). It is shaped so the
 * contracts' detector trips on it: every absence read against it is preceded by that
 * positive control.
 */
export function syntheticCanary(tag: string): string {
  return "sk-" + "ant-" + "api03-" + "C".repeat(40) + tag;
}

/** One call the fetch substitute received, as the leaf made it. */
export interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * A stand-in for the global `fetch`, with the five honesty conditions of C-E9.
 *
 * It answers from a script with a real `Response` over bytes, records every call it
 * receives, and is installed on `globalThis` only by {@link FetchSubstitute.install},
 * whose returned restore puts the real `fetch` back and arms a guard: a call after the
 * restore is counted in `callsAfterRestore` and rejected, so a leaf that captured the
 * substitute cannot pass silently.
 */
export interface FetchSubstitute {
  readonly calls: readonly FetchCall[];
  readonly callsAfterRestore: () => number;
  readonly install: () => () => void;
}

export function fetchSubstitute(answer: (call: FetchCall) => Response | Promise<Response>): FetchSubstitute {
  const calls: FetchCall[] = [];
  let restored = false;
  let late = 0;
  const substitute = async (input: unknown, init?: RequestInit): Promise<Response> => {
    if (restored) {
      late += 1;
      throw new Error("the fetch substitute was called after it was restored");
    }
    const call = Object.freeze({ url: String(input), init: init ?? {} });
    calls.push(call);
    return answer(call);
  };
  return {
    calls,
    callsAfterRestore: () => late,
    install: () => {
      const real = globalThis.fetch;
      globalThis.fetch = substitute as typeof fetch;
      return () => {
        globalThis.fetch = real;
        restored = true;
      };
    },
  };
}

/** UTF-8 bytes of `text`, cut at the given byte offsets (C-E9.2). */
export function splitBytes(text: string, cuts: readonly number[]): readonly Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    if (cut <= at || cut >= bytes.length) continue;
    parts.push(bytes.slice(at, cut));
    at = cut;
  }
  parts.push(bytes.slice(at));
  return parts;
}

/** A byte stream that yields each part as one read. */
export function byteStream(parts: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[index];
      index += 1;
      if (part === undefined) controller.close();
      else controller.enqueue(part);
    },
  });
}

/** A real `Response` whose body is the given byte parts. */
export function bytesResponse(
  parts: readonly Uint8Array[],
  init: { readonly status?: number; readonly contentType?: string } = {},
): Response {
  return new Response(byteStream(parts), {
    status: init.status ?? 200,
    headers: { "content-type": init.contentType ?? "text/event-stream" },
  });
}

/** One SSE event's text: an optional `event:` line (before or after `data:`), then a blank line. */
export function sseEvent(data: string, event?: string, eventAfterData = false, newline = "\n"): string {
  const lines = event === undefined ? ["data: " + data] : eventAfterData ? ["data: " + data, "event: " + event] : ["event: " + event, "data: " + data];
  return lines.join(newline) + newline + newline;
}

/** What a synthetic Messages stream says, each field overridable to drive a negative. */
export interface SynMessagesOptions {
  readonly model?: string;
  readonly id?: string;
  readonly text?: readonly string[];
  readonly startUsage?: Readonly<Record<string, unknown>> | null;
  readonly endUsage?: Readonly<Record<string, unknown>> | null;
  readonly stopReason?: string | null;
  readonly terminal?: boolean;
  readonly newline?: string;
}

/** A synthetic Anthropic Messages SSE stream, as text. */
export function synMessagesStream(options: SynMessagesOptions = {}): string {
  const newline = options.newline ?? "\n";
  const message: Record<string, unknown> = {
    id: options.id ?? "msg_syn01",
    type: "message",
    role: "assistant",
    model: options.model ?? "claude-syn-1",
  };
  if (options.startUsage !== null) {
    message["usage"] = options.startUsage ?? { input_tokens: 11, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 1 };
  }
  const events = [
    sseEvent(JSON.stringify({ type: "message_start", message }), "message_start", false, newline),
    sseEvent(JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), "content_block_start", true, newline),
    sseEvent(JSON.stringify({ type: "ping" }), "ping", false, newline),
    ...(options.text ?? ["Hel", "lo €"]).map((text) =>
      sseEvent(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }), "content_block_delta", false, newline),
    ),
    sseEvent(JSON.stringify({ type: "content_block_stop", index: 0 }), "content_block_stop", false, newline),
  ];
  const delta: Record<string, unknown> = { type: "message_delta", delta: { stop_reason: options.stopReason === undefined ? "end_turn" : options.stopReason } };
  if (options.endUsage !== null) delta["usage"] = options.endUsage ?? { output_tokens: 7 };
  events.push(sseEvent(JSON.stringify(delta), "message_delta", false, newline));
  if (options.terminal !== false) events.push(sseEvent(JSON.stringify({ type: "message_stop" }), "message_stop", false, newline));
  return events.join("");
}

/** What a synthetic chat/completions stream says, each field overridable to drive a negative. */
export interface SynLocalOptions {
  readonly model?: string;
  readonly id?: string | null;
  readonly text?: readonly string[];
  readonly finishReason?: string | null;
  readonly usage?: Readonly<Record<string, unknown>> | null;
  readonly terminal?: boolean;
  readonly newline?: string;
}

/** A synthetic OpenAI-compatible chat/completions SSE stream, as text. */
export function synLocalStream(options: SynLocalOptions = {}): string {
  const newline = options.newline ?? "\n";
  const base = (): Record<string, unknown> => {
    const frame: Record<string, unknown> = { object: "chat.completion.chunk", model: options.model ?? "local-syn-1" };
    if (options.id !== null) frame["id"] = options.id ?? "chatcmpl-syn01";
    return frame;
  };
  const events = (options.text ?? ["Hel", "lo €"]).map((content) =>
    sseEvent(JSON.stringify({ ...base(), choices: [{ index: 0, delta: { content }, finish_reason: null }] }), undefined, false, newline),
  );
  events.push(
    sseEvent(
      JSON.stringify({ ...base(), choices: [{ index: 0, delta: {}, finish_reason: options.finishReason === undefined ? "stop" : options.finishReason }] }),
      undefined,
      false,
      newline,
    ),
  );
  if (options.usage !== null) {
    events.push(
      sseEvent(JSON.stringify({ ...base(), choices: [], usage: options.usage ?? { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } }), undefined, false, newline),
    );
  }
  if (options.terminal !== false) events.push(sseEvent("[DONE]", undefined, false, newline));
  return events.join("");
}
