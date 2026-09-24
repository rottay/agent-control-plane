import { createHash } from "node:crypto";

import { findCredentialViolations } from "@acp/contracts";
import { afterEach, describe, expect, it } from "vitest";

// The leaf is imported before any substitute exists: a leaf that captured `fetch`
// at load would hold the real one and every call below would miss the substitute
// (N-E-23, C-E9.1).
import { ANTHROPIC_MESSAGES_USAGE_SOURCE, createAnthropicMessagesClient } from "../../../src/api-key/http/index.js";
import type { ApiStreamChunk, ApiStreamRequest, ApiStreamingClient } from "../../../src/api-key/index.js";
import { PROVIDER_NAMES } from "../../../src/contract/index.js";
import { claudeAdapter } from "../../../src/claude/index.js";
import { AdapterError } from "../../../src/errors/index.js";
import type { FetchCall } from "../../testing/index.js";
import { bytesResponse, fetchSubstitute, splitBytes, synMessagesStream, syntheticCanary } from "../../testing/index.js";

const CANARY = syntheticCanary("APIUNIT01");
const MODEL = "claude-syn-1";

const REQUEST: ApiStreamRequest = {
  model: MODEL,
  taskId: "00000000-0000-4000-8000-0000000e0001",
  attempt: 1,
  identity: "anthropic/claude-opus-5/implementer/01",
  instructions: "summarise the packet",
};

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function client(credential: () => string = () => CANARY): ApiStreamingClient {
  return createAnthropicMessagesClient({ models: [MODEL], credential, maxTokens: 256, timeoutMs: 5_000 });
}

/** Install a substitute answering every call with `answer`, and return it. */
function install(answer: (call: FetchCall) => Response | Promise<Response>): ReturnType<typeof fetchSubstitute> {
  const substitute = fetchSubstitute(answer);
  restore = substitute.install();
  return substitute;
}

async function collect(target: ApiStreamingClient = client()): Promise<ApiStreamChunk[]> {
  const chunks: ApiStreamChunk[] = [];
  for await (const chunk of target.stream(REQUEST)) chunks.push(chunk);
  return chunks;
}

async function refusal(target: ApiStreamingClient = client()): Promise<AdapterError> {
  try {
    await collect(target);
  } catch (error: unknown) {
    if (error instanceof AdapterError) return error;
    throw new Error("expected an AdapterError");
  }
  throw new Error("expected a refusal");
}

/** A value's own string form, or nothing when it has none. */
function rendered(value: unknown): string {
  try {
    return (value as { toString(): string }).toString();
  } catch {
    return "";
  }
}

/** Every text a value renders to, walked through `cause` and `errors[]` (sink 7). */
function renderings(value: unknown, seen = new Set<unknown>()): string[] {
  if (seen.has(value)) return [];
  seen.add(value);
  const out = [rendered(value), (JSON.stringify(value) as string | undefined) ?? ""];
  if (value instanceof Error) {
    out.push(value.message, value.stack ?? "", JSON.stringify(Object.getOwnPropertyNames(value).map((key) => [key, rendered((value as unknown as Record<string, unknown>)[key])])));
    out.push(...renderings((value as { cause?: unknown }).cause, seen));
    if (value instanceof AggregateError) for (const inner of value.errors as unknown[]) out.push(...renderings(inner, seen));
  }
  return out;
}

function streamed(text = synMessagesStream(), cuts: readonly number[] = []): () => Response {
  return () => bytesResponse(splitBytes(text, cuts));
}

const HAPPY: readonly ApiStreamChunk[] = [
  { kind: "started", resolvedModel: MODEL, protocolVersion: "2023-06-01" },
  { kind: "text", delta: "Hel" },
  { kind: "text", delta: "lo €" },
  {
    kind: "usage",
    stepIndex: 1,
    inputTokens: 11,
    outputTokens: 7,
    cacheWriteTokens: 2,
    cacheReadTokens: 3,
    totalTokens: 23,
    reportKind: "CUMULATIVE",
    isFinal: true,
    sourceObservationId: "msg_syn01",
  },
  { kind: "operationResult", status: "SUCCEEDED" },
];

describe("the Messages leaf's request (C-E9.3)", () => {
  it("detects its own canary, so every absence below is evidence (positive control)", () => {
    expect(findCredentialViolations({ value: CANARY }).length).toBeGreaterThan(0);
  });

  it("calls a substitute installed after the module loaded, once (N-E-23)", async () => {
    const substitute = install(streamed());
    expect(await collect()).toEqual(HAPPY);
    expect(substitute.calls).toHaveLength(1);
  });

  it("posts exactly the Messages body with the three headers, the canary once, no redirect and its own timeout", async () => {
    const substitute = install(streamed());
    await collect();
    const [call] = substitute.calls;
    if (call === undefined) throw new Error("no call");
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("manual");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(call.init.headers);
    expect([...headers.keys()].sort()).toEqual(["anthropic-version", "content-type", "x-api-key"]);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBe(CANARY);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(call.init.body as string)).toEqual({
      model: MODEL,
      max_tokens: 256,
      stream: true,
      messages: [{ role: "user", content: REQUEST.instructions }],
    });
    // The canary travelled once, in its header, and nowhere else in the request.
    const serialized = JSON.stringify({ url: call.url, body: call.init.body, headers: [...headers.entries()] });
    expect(serialized.split(CANARY)).toHaveLength(2);
  });

  it("calls the credential closure once per request, and the client keeps nothing of it", async () => {
    let calls = 0;
    const target = client(() => {
      calls += 1;
      return CANARY;
    });
    expect(calls).toBe(0);
    install(streamed());
    await collect(target);
    expect(calls).toBe(1);
    // Sink 8: nothing retained on the client after the call.
    expect(Object.keys(target).sort()).toEqual(["models", "provider", "stream"]);
    expect(JSON.stringify(target)).not.toContain(CANARY);
    expect(renderings(target).join("\n")).not.toContain(CANARY);
  });

  it("speaks the registry's provider word, the only one admitApiRoute composes (E-ND-7)", () => {
    expect(client().provider).toBe("claude");
    expect(client().provider).toBe(claudeAdapter.provider);
    expect(PROVIDER_NAMES).toContain(client().provider);
  });

  it("refuses options it cannot run with, and defaults none (NULL per field)", () => {
    const base = { models: [MODEL], credential: () => CANARY, maxTokens: 256, timeoutMs: 5_000 };
    const bad: readonly Record<string, unknown>[] = [
      { ...base, models: [] },
      { ...base, models: null },
      { ...base, models: [""] },
      { ...base, models: [7] },
      { ...base, maxTokens: 0 },
      { ...base, maxTokens: null },
      { ...base, maxTokens: 1.5 },
      { ...base, timeoutMs: 0 },
      { ...base, timeoutMs: -1 },
      { ...base, timeoutMs: null },
      { ...base, credential: null },
      { ...base, credential: CANARY },
    ];
    for (const options of bad) {
      expect(() => createAnthropicMessagesClient(options as never), JSON.stringify(Object.keys(options))).toThrow(TypeError);
    }
    try {
      createAnthropicMessagesClient({ ...base, credential: CANARY } as never);
    } catch (error: unknown) {
      expect(renderings(error).join("\n")).not.toContain(CANARY);
    }
  });
});

describe("the Messages leaf's event mapping (C-E3)", () => {
  it("gives the same chunks whatever the byte split or line end (N-E-24)", async () => {
    const text = synMessagesStream();
    const bytes = new TextEncoder().encode(text);
    const euro = bytes.indexOf(0xe2);
    for (const variant of [
      streamed(text, [euro + 1]),
      streamed(text, Array.from({ length: 40 }, (_, index) => (index + 1) * 17)),
      streamed(synMessagesStream({ newline: "\r\n" }), [3, 200, 201]),
    ]) {
      install(variant);
      expect(await collect()).toEqual(HAPPY);
      restore?.();
      restore = null;
    }
  });

  it("carries the provider's model verbatim when it differs from the one asked for", async () => {
    install(streamed(synMessagesStream({ model: "claude-syn-1-20260901" })));
    const [started] = await collect();
    expect(started).toEqual({ kind: "started", resolvedModel: "claude-syn-1-20260901", protocolVersion: "2023-06-01" });
  });

  it("maps each stop reason by its closed table, and an unknown or absent one to no operation fact", async () => {
    const cases: readonly [string | null, string | undefined][] = [
      ["end_turn", "SUCCEEDED"],
      ["stop_sequence", "SUCCEEDED"],
      ["max_tokens", "FAILED"],
      ["tool_use", "FAILED"],
      ["pause_turn", undefined],
      ["refusal", undefined],
      // A prototype name is a word outside the table: it decides nothing and refuses nothing (V3).
      ["constructor", undefined],
      ["toString", undefined],
      ["__proto__", undefined],
      [null, undefined],
    ];
    for (const [stopReason, status] of cases) {
      install(streamed(synMessagesStream({ stopReason })));
      const result = (await collect()).find((chunk) => chunk.kind === "operationResult");
      expect(result, String(stopReason)).toEqual(status === undefined ? undefined : { kind: "operationResult", status });
      restore?.();
      restore = null;
    }
  });

  it("states no operation fact when the stream ends without message_stop, never SUCCEEDED", async () => {
    install(streamed(synMessagesStream({ terminal: false })));
    const chunks = await collect();
    expect(chunks.some((chunk) => chunk.kind === "operationResult")).toBe(false);
    expect(chunks.some((chunk) => chunk.kind === "usage")).toBe(true);
  });

  it("reports an absent class as null, never 0, with no total; and no report when no usage is carried", async () => {
    install(streamed(synMessagesStream({ startUsage: { input_tokens: 5 }, endUsage: { output_tokens: 2 } })));
    const usage = (await collect()).find((chunk) => chunk.kind === "usage");
    expect(usage).toMatchObject({ inputTokens: 5, outputTokens: 2, cacheWriteTokens: null, cacheReadTokens: null, totalTokens: null });
    restore?.();
    install(streamed(synMessagesStream({ startUsage: null, endUsage: null })));
    expect((await collect()).some((chunk) => chunk.kind === "usage")).toBe(false);
  });

  it("refuses a usage class that is negative, fractional or not a number", async () => {
    for (const bad of [-1, 1.5, "7", Number.MAX_SAFE_INTEGER]) {
      install(streamed(synMessagesStream({ endUsage: { output_tokens: bad } })));
      expect((await refusal()).code, String(bad)).toBe("MALFORMED_EVENT");
      restore?.();
      restore = null;
    }
  });

  it("bounds the provider's model and message id before they become fields (N-E-16', N-E-22a/b)", async () => {
    const bad: readonly Parameters<typeof synMessagesStream>[0][] = [
      { model: "m".repeat(121) },
      { model: "claude syn" },
      { model: "" },
      { model: CANARY + "\n" },
      { id: "i".repeat(201) },
      { id: "msg/syn" },
      { id: "" },
      // Inside the charset and still credential-shaped: refused at the leaf (Fable C3).
      { model: CANARY },
      { id: CANARY },
    ];
    for (const options of bad) {
      install(streamed(synMessagesStream(options)));
      const error = await refusal();
      expect(error.code, JSON.stringify(options)).toBe("MALFORMED_EVENT");
      expect(renderings(error).join("\n")).not.toContain(CANARY);
      restore?.();
      restore = null;
    }
    for (const frame of [
      { type: "message_start", message: { id: "msg_1" } },
      { type: "message_start", message: { id: "msg_1", model: 7 } },
    ]) {
      install(() => bytesResponse(splitBytes("data: " + JSON.stringify(frame) + "\n\n", [])));
      expect((await refusal()).code).toBe("MALFORMED_EVENT");
      restore?.();
      restore = null;
    }
  });

  it("refuses an unknown frame, a non-string text delta, a frame before message_start and a non-JSON line (N-E-17, N-E-18)", async () => {
    const start = 'data: {"type":"message_start","message":{"id":"msg_1","model":"m"}}\n\n';
    for (const text of [
      start + 'data: {"type":"checkpoint","digest":"x"}\n\n',
      start + 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":7}}\n\n',
      start + 'data: {"type":"content_block_delta","delta":{"type":"image_delta"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n',
      start + "data: not json\n\n",
      start + "data: [1]\n\n",
      start + start,
    ]) {
      install(() => bytesResponse(splitBytes(text, [])));
      expect((await refusal()).code, text).toBe("MALFORMED_EVENT");
      restore?.();
      restore = null;
    }
  });

  it("maps an in-stream error frame to a closed word, never the vendor's text", async () => {
    const start = 'data: {"type":"message_start","message":{"id":"msg_1","model":"m"}}\n\n';
    const cases: readonly [string, string][] = [
      ["overloaded_error", "PROVIDER_RATE_LIMITED"],
      ["rate_limit_error", "PROVIDER_RATE_LIMITED"],
      ["api_error", "PROVIDER_HTTP_ERROR"],
      [CANARY, "PROVIDER_HTTP_ERROR"],
    ];
    for (const [type, code] of cases) {
      const frame = JSON.stringify({ type: "error", error: { type, message: CANARY } });
      install(() => bytesResponse(splitBytes(start + "event: error\ndata: " + frame + "\n\n", [])));
      const error = await refusal();
      expect(error.code).toBe(code);
      expect(renderings(error).join("\n")).not.toContain(CANARY);
      restore?.();
      restore = null;
    }
  });
});

describe("the Messages leaf's status table and failures (C-E7, ADR 0108 §3.1)", () => {
  /** A body that records whether it was read or cancelled, carrying the canary. */
  function watchedBody(): { body: ReadableStream<Uint8Array>; read: () => boolean; cancelled: () => boolean } {
    let read = false;
    let cancelled = false;
    let served = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (served) return;
          served = true;
          read = true;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { type: "authentication_error", message: CANARY } })));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { body, read: () => read, cancelled: () => cancelled };
  }

  it("answers 401 and 403 with authRequired from the status alone; the vendor body is never read (N-E-15, N-E-22c)", async () => {
    for (const [status, reason] of [
      [401, "AUTHENTICATION_ERROR"],
      [403, "PERMISSION_DENIED"],
    ] as const) {
      const watched = watchedBody();
      install(() => new Response(watched.body, { status, headers: { "content-type": "application/json" } }));
      const chunks = await collect();
      expect(chunks).toEqual([{ kind: "authRequired", reason }]);
      expect(watched.read()).toBe(false);
      expect(watched.cancelled()).toBe(true);
      expect(JSON.stringify(chunks)).not.toContain(CANARY);
      restore?.();
      restore = null;
    }
  });

  it("refuses a redirect without following it, one call only (N-E-13)", async () => {
    for (const status of [301, 302, 307, 308]) {
      const substitute = install(() => new Response(null, { status, headers: { location: "https://elsewhere.invalid/" } }));
      expect((await refusal()).code).toBe("REDIRECT_REFUSED");
      expect(substitute.calls).toHaveLength(1);
      restore?.();
      restore = null;
    }
  });

  it("maps 429, 529, 408, 4xx and 5xx to closed words with no retry and no body read", async () => {
    const cases: readonly [number, string][] = [
      [429, "PROVIDER_RATE_LIMITED"],
      [529, "PROVIDER_RATE_LIMITED"],
      [408, "PROVIDER_HTTP_ERROR"],
      [400, "PROVIDER_HTTP_ERROR"],
      [404, "PROVIDER_HTTP_ERROR"],
      [500, "PROVIDER_HTTP_ERROR"],
      [503, "PROVIDER_HTTP_ERROR"],
    ];
    for (const [status, code] of cases) {
      const watched = watchedBody();
      const substitute = install(() => new Response(watched.body, { status }));
      const error = await refusal();
      expect(error.code, String(status)).toBe(code);
      expect(substitute.calls).toHaveLength(1);
      expect(watched.read()).toBe(false);
      expect(renderings(error).join("\n")).not.toContain(CANARY);
      restore?.();
      restore = null;
    }
  });

  it("refuses a 2xx that is not an event stream as PROTOCOL_UNSUPPORTED, unread", async () => {
    const watched = watchedBody();
    install(() => new Response(watched.body, { status: 200, headers: { "content-type": "application/json" } }));
    expect((await refusal()).code).toBe("PROTOCOL_UNSUPPORTED");
    expect(watched.read()).toBe(false);
  });

  it("names a timeout REQUEST_TIMEOUT, with no partial success (N-E-14)", async () => {
    install(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    expect((await refusal()).code).toBe("REQUEST_TIMEOUT");
  });

  it("fails every hostile transport failure closed, and no rendering of the error carries the canary (N-E-21)", async () => {
    const hostile: readonly (() => never)[] = [
      () => {
        throw new TypeError("fetch failed: " + CANARY);
      },
      () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNRESET", detail: CANARY } });
      },
      () => {
        throw new AggregateError([new Error(CANARY)]);
      },
    ];
    for (const thrower of hostile) {
      install(thrower);
      const error = await refusal();
      expect(error.code).toBe("PROVIDER_UNREACHABLE");
      expect(error.cause).toBeUndefined();
      expect(renderings(error).join("\n")).not.toContain(CANARY);
      restore?.();
      restore = null;
    }
  });

  it("classifies Node's own refusal of a header value, which quotes the value, without carrying it", async () => {
    // The substitute builds real `Headers`, as `fetch` would: a value with a line feed
    // makes Node throw a TypeError whose message quotes it (a trailing one is trimmed).
    const bad = CANARY + "\nX";
    let quoted = false;
    install((call) => {
      try {
        void new Headers(call.init.headers);
      } catch (thrown: unknown) {
        // Positive control: the instrument's own error does carry the value.
        quoted = thrown instanceof TypeError && thrown.message.includes(CANARY);
        throw thrown;
      }
      return bytesResponse(splitBytes(synMessagesStream(), []));
    });
    const error = await refusal(client(() => bad));
    expect(quoted).toBe(true);
    expect(error.code).toBe("PROVIDER_UNREACHABLE");
    expect(renderings(error).join("\n")).not.toContain(CANARY);
  });

  it("names a reset mid-stream PROVIDER_UNREACHABLE, after the chunks already read", async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode('data: {"type":"message_start","message":{"id":"msg_1","model":"m"}}\n\n'));
          return;
        }
        controller.error(new TypeError("terminated: " + CANARY));
      },
    });
    install(() => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const seen: ApiStreamChunk[] = [];
    let caught: unknown = null;
    try {
      for await (const chunk of client().stream(REQUEST)) seen.push(chunk);
    } catch (error: unknown) {
      caught = error;
    }
    expect(seen).toEqual([{ kind: "started", resolvedModel: "m", protocolVersion: "2023-06-01" }]);
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as AdapterError).code).toBe("PROVIDER_UNREACHABLE");
    expect(renderings(caught).join("\n")).not.toContain(CANARY);
  });

  it("stops seeing a substitute once it is restored, and the guard counts a late call", async () => {
    const real = globalThis.fetch;
    const substitute = install(streamed());
    const installed = globalThis.fetch;
    await collect();
    restore?.();
    restore = null;
    expect(globalThis.fetch).toBe(real);
    expect(substitute.callsAfterRestore()).toBe(0);
    // A leaf that had captured the substitute would call it here; the guard sees it.
    await expect(installed("https://api.anthropic.com/v1/messages")).rejects.toThrow();
    expect(substitute.callsAfterRestore()).toBe(1);
    expect(substitute.calls).toHaveLength(1);
  });
});

describe("the Messages usage source", () => {
  it("declares its source once: the provider's own count, under a policy whose digest is pinned and recomputed here", () => {
    expect(ANTHROPIC_MESSAGES_USAGE_SOURCE.source).toBe("anthropic-messages-api");
    expect(ANTHROPIC_MESSAGES_USAGE_SOURCE.sourceClass).toBe("PROVIDER_AUTHORITATIVE");
    const canonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonical)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
            )
          : value;
    const digest = createHash("sha256")
      .update(JSON.stringify(canonical(ANTHROPIC_MESSAGES_USAGE_SOURCE.normalizationPolicy)), "utf8")
      .digest("hex");
    expect(ANTHROPIC_MESSAGES_USAGE_SOURCE.normalizationPolicySha256).toBe(digest);
    expect(ANTHROPIC_MESSAGES_USAGE_SOURCE.normalizationPolicySha256).toBe("a99a54f24370b6da21dc43c9f5ccfceebad1aa8bba1d6a68dbf62cfa71054deb");
    expect(Object.isFrozen(ANTHROPIC_MESSAGES_USAGE_SOURCE)).toBe(true);
  });
});
