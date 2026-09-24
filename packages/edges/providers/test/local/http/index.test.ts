import { createHash } from "node:crypto";

import { findCredentialViolations } from "@acp/contracts";
import { afterEach, describe, expect, it } from "vitest";

// Imported before any substitute exists (N-E-23, C-E9.1).
import { LOCAL_CHAT_USAGE_SOURCE, createLocalChatClient } from "../../../src/local/http/index.js";
import type { LocalChatChunk, LocalChatClient, LocalChatRequest } from "../../../src/local/index.js";
import { AdapterError } from "../../../src/errors/index.js";
import type { FetchCall } from "../../testing/index.js";
import { bytesResponse, fetchSubstitute, splitBytes, synLocalStream, syntheticCanary } from "../../testing/index.js";

const CANARY = syntheticCanary("LOCALUNIT01");
const MODEL = "local-syn-1";
const BASE = "http://127.0.0.1:18080/v1";

const REQUEST: LocalChatRequest = {
  model: MODEL,
  taskId: "00000000-0000-4000-8000-0000000e0002",
  attempt: 2,
  identity: "anthropic/claude-opus-5/implementer/01",
  instructions: "summarise the packet",
};

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function client(credential: (() => string) | null = () => CANARY, baseUrl = BASE): LocalChatClient {
  return createLocalChatClient({ baseUrl, provider: "llama-cpp", models: [MODEL], credential, timeoutMs: 5_000 });
}

function install(answer: (call: FetchCall) => Response | Promise<Response>): ReturnType<typeof fetchSubstitute> {
  const substitute = fetchSubstitute(answer);
  restore = substitute.install();
  return substitute;
}

function reinstall(answer: (call: FetchCall) => Response | Promise<Response>): ReturnType<typeof fetchSubstitute> {
  restore?.();
  restore = null;
  return install(answer);
}

async function collect(target: LocalChatClient = client()): Promise<LocalChatChunk[]> {
  const chunks: LocalChatChunk[] = [];
  for await (const chunk of target.stream(REQUEST)) chunks.push(chunk);
  return chunks;
}

async function refusal(target: LocalChatClient = client()): Promise<AdapterError> {
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

function renderings(value: unknown, seen = new Set<unknown>()): string[] {
  if (seen.has(value)) return [];
  seen.add(value);
  const out = [rendered(value), (JSON.stringify(value) as string | undefined) ?? ""];
  if (value instanceof Error) {
    out.push(value.message, value.stack ?? "");
    out.push(...renderings((value as { cause?: unknown }).cause, seen));
    if (value instanceof AggregateError) for (const inner of value.errors as unknown[]) out.push(...renderings(inner, seen));
  }
  return out;
}

function streamed(text = synLocalStream(), cuts: readonly number[] = []): () => Response {
  return () => bytesResponse(splitBytes(text, cuts));
}

const HAPPY: readonly LocalChatChunk[] = [
  { kind: "started", resolvedModel: MODEL, protocolVersion: "openai-chat-completions" },
  { kind: "text", delta: "Hel" },
  { kind: "text", delta: "lo €" },
  {
    kind: "usage",
    stepIndex: 1,
    inputTokens: 9,
    outputTokens: 4,
    cacheWriteTokens: null,
    cacheReadTokens: null,
    totalTokens: 13,
    reportKind: "CUMULATIVE",
    isFinal: true,
    sourceObservationId: "chatcmpl-syn01",
  },
  { kind: "operationResult", status: "SUCCEEDED" },
];

describe("the local leaf's request (C-E9.3)", () => {
  it("detects its own canary in the header it would send (positive control)", () => {
    expect(findCredentialViolations({ value: "Bearer " + CANARY }).length).toBeGreaterThan(0);
  });

  it("calls a substitute installed after the module loaded, once (N-E-23)", async () => {
    const substitute = install(streamed());
    expect(await collect()).toEqual(HAPPY);
    expect(substitute.calls).toHaveLength(1);
  });

  it("posts the chat/completions body to the binding's base, with the bearer header when the auth is CREDENTIAL", async () => {
    const substitute = install(streamed());
    await collect();
    const [call] = substitute.calls;
    if (call === undefined) throw new Error("no call");
    expect(call.url).toBe(BASE + "/chat/completions");
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("manual");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(call.init.headers);
    expect([...headers.keys()].sort()).toEqual(["authorization", "content-type"]);
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("authorization")).toBe("Bearer " + CANARY);
    expect(JSON.parse(call.init.body as string)).toEqual({
      model: MODEL,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: REQUEST.instructions }],
    });
    const serialized = JSON.stringify({ url: call.url, body: call.init.body, headers: [...headers.entries()] });
    expect(serialized.split(CANARY)).toHaveLength(2);
  });

  it("sends no authorization header at all when the auth is NONE", async () => {
    const substitute = install(streamed());
    await collect(client(null));
    const headers = new Headers(substitute.calls[0]?.init.headers);
    expect([...headers.keys()]).toEqual(["content-type"]);
  });

  it("joins a base with a trailing slash once", async () => {
    const substitute = install(streamed());
    await collect(client(null, BASE + "/"));
    expect(substitute.calls[0]?.url).toBe(BASE + "/chat/completions");
  });

  it("calls the credential closure once per request, and the client keeps nothing of it", async () => {
    let calls = 0;
    const target = client(() => {
      calls += 1;
      return CANARY;
    });
    install(streamed());
    await collect(target);
    expect(calls).toBe(1);
    expect(Object.keys(target).sort()).toEqual(["models", "provider", "stream"]);
    expect(renderings(target).join("\n")).not.toContain(CANARY);
  });

  it("refuses options it cannot run with, and defaults none (NULL per field)", () => {
    const base = { baseUrl: BASE, provider: "llama-cpp", models: [MODEL], credential: null, timeoutMs: 5_000 };
    const bad: readonly Record<string, unknown>[] = [
      { ...base, baseUrl: null },
      { ...base, baseUrl: "" },
      { ...base, baseUrl: "127.0.0.1:8080" },
      { ...base, baseUrl: "ftp://127.0.0.1/" },
      { ...base, baseUrl: "http://user:" + CANARY + "@127.0.0.1/" },
      { ...base, baseUrl: "http://127.0.0.1/?key=1" },
      { ...base, baseUrl: "http://127.0.0.1/#x" },
      { ...base, provider: "" },
      { ...base, provider: null },
      { ...base, models: [] },
      { ...base, models: null },
      { ...base, models: [""] },
      { ...base, timeoutMs: 0 },
      { ...base, timeoutMs: null },
      { ...base, credential: CANARY },
      { ...base, credential: undefined },
    ];
    for (const options of bad) {
      let thrown: unknown = null;
      try {
        createLocalChatClient(options as never);
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown, JSON.stringify(Object.keys(options))).toBeInstanceOf(TypeError);
      expect(renderings(thrown).join("\n")).not.toContain(CANARY);
    }
  });
});

describe("the local leaf's event mapping (C-E3)", () => {
  it("gives the same chunks whatever the byte split or line end (N-E-24)", async () => {
    const text = synLocalStream();
    const euro = new TextEncoder().encode(text).indexOf(0xe2);
    for (const variant of [
      streamed(text, [euro + 1]),
      streamed(text, Array.from({ length: 30 }, (_, index) => (index + 1) * 19)),
      streamed(synLocalStream({ newline: "\r\n" }), [2, 150, 151]),
    ]) {
      reinstall(variant);
      expect(await collect()).toEqual(HAPPY);
    }
  });

  it("maps each finish reason by its closed table, and an unknown or absent one to no operation fact", async () => {
    const cases: readonly [string | null, string | undefined][] = [
      ["stop", "SUCCEEDED"],
      ["length", "FAILED"],
      ["tool_calls", "FAILED"],
      ["content_filter", undefined],
      // A prototype name is a word outside the table: it decides nothing and refuses nothing (V3).
      ["constructor", undefined],
      ["toString", undefined],
      ["__proto__", undefined],
      [null, undefined],
    ];
    for (const [finishReason, status] of cases) {
      reinstall(streamed(synLocalStream({ finishReason })));
      const result = (await collect()).find((chunk) => chunk.kind === "operationResult");
      expect(result, String(finishReason)).toEqual(status === undefined ? undefined : { kind: "operationResult", status });
    }
  });

  it("states no operation fact when the stream ends without [DONE]", async () => {
    install(streamed(synLocalStream({ terminal: false })));
    expect((await collect()).some((chunk) => chunk.kind === "operationResult")).toBe(false);
  });

  it("yields no usage report when the server sends none, never zeros", async () => {
    install(streamed(synLocalStream({ usage: null })));
    expect((await collect()).some((chunk) => chunk.kind === "usage")).toBe(false);
  });

  it("reports the cache classes UNKNOWN, a missing class null, and a stated total only when it covers the known classes", async () => {
    const cases: readonly [Record<string, unknown>, Record<string, unknown>][] = [
      [{ prompt_tokens: 9 }, { inputTokens: 9, outputTokens: null, totalTokens: null }],
      [{ prompt_tokens: 9, completion_tokens: 4 }, { inputTokens: 9, outputTokens: 4, totalTokens: null }],
      [{ prompt_tokens: 9, completion_tokens: 4, total_tokens: 12 }, { totalTokens: null }],
      [{ prompt_tokens: 9, completion_tokens: 4, total_tokens: 20 }, { totalTokens: 20 }],
    ];
    for (const [usage, expected] of cases) {
      reinstall(streamed(synLocalStream({ usage })));
      const report = (await collect()).find((chunk) => chunk.kind === "usage");
      expect(report, JSON.stringify(usage)).toMatchObject({ ...expected, cacheWriteTokens: null, cacheReadTokens: null });
    }
  });

  it("falls back to the run's coordinates for an observation id when the server sends none", async () => {
    install(streamed(synLocalStream({ id: null })));
    const report = (await collect()).find((chunk) => chunk.kind === "usage");
    expect(report).toMatchObject({ sourceObservationId: REQUEST.taskId + "/2/final" });
  });

  it("bounds the server's model and completion id before they become fields (N-E-22a/b)", async () => {
    for (const options of [
      { model: "m".repeat(121) },
      { model: "local syn" },
      { model: "" },
      { model: CANARY + "\n" },
      { id: "i".repeat(201) },
      { id: "cmpl/1" },
      { id: "" },
      // Inside the charset and still credential-shaped: refused at the leaf (Fable C3).
      { model: CANARY },
      { id: CANARY },
    ]) {
      reinstall(streamed(synLocalStream(options)));
      const error = await refusal();
      expect(error.code, JSON.stringify(options)).toBe("MALFORMED_EVENT");
      expect(renderings(error).join("\n")).not.toContain(CANARY);
    }
  });

  it("refuses a malformed frame, a non-string delta, a repeated usage object and an in-stream error (N-E-17, N-E-18)", async () => {
    const head = 'data: {"model":"m","choices":[]}\n\n';
    const cases: readonly [string, string][] = [
      [head + "data: not json\n\n", "MALFORMED_EVENT"],
      [head + 'data: {"choices":{}}\n\n', "MALFORMED_EVENT"],
      [head + 'data: {"choices":[7]}\n\n', "MALFORMED_EVENT"],
      [head + 'data: {"choices":[{"delta":{"content":7}}]}\n\n', "MALFORMED_EVENT"],
      [head + 'data: {"choices":[{"finish_reason":7}]}\n\n', "MALFORMED_EVENT"],
      [head + 'data: {"usage":{"prompt_tokens":-1}}\n\n', "MALFORMED_EVENT"],
      [head + 'data: {"usage":{"prompt_tokens":1}}\n\ndata: {"usage":{"prompt_tokens":1}}\n\n', "MALFORMED_EVENT"],
      ["data: [DONE]\n\n", "MALFORMED_EVENT"],
      [head + 'data: {"error":{"message":"' + CANARY + '"}}\n\n', "PROVIDER_HTTP_ERROR"],
    ];
    for (const [text, code] of cases) {
      reinstall(() => bytesResponse(splitBytes(text, [])));
      const error = await refusal();
      expect(error.code, text).toBe(code);
      expect(renderings(error).join("\n")).not.toContain(CANARY);
    }
  });
});

describe("the local leaf's status table and failures (C-E7)", () => {
  it("answers 401 and 403 with authRequired, and refuses the rest with closed words, one call each", async () => {
    const cases: readonly [number, string][] = [
      [301, "REDIRECT_REFUSED"],
      [307, "REDIRECT_REFUSED"],
      [429, "PROVIDER_RATE_LIMITED"],
      [408, "PROVIDER_HTTP_ERROR"],
      [500, "PROVIDER_HTTP_ERROR"],
    ];
    for (const [status, reason] of [
      [401, "AUTHENTICATION_ERROR"],
      [403, "PERMISSION_DENIED"],
    ] as const) {
      reinstall(() => new Response(JSON.stringify({ error: CANARY }), { status }));
      const chunks = await collect();
      expect(chunks).toEqual([{ kind: "authRequired", reason }]);
    }
    for (const [status, code] of cases) {
      const substitute = reinstall(() => new Response(JSON.stringify({ error: CANARY }), { status }));
      const error = await refusal();
      expect(error.code, String(status)).toBe(code);
      expect(substitute.calls).toHaveLength(1);
      expect(renderings(error).join("\n")).not.toContain(CANARY);
    }
    reinstall(() => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    expect((await refusal()).code).toBe("PROTOCOL_UNSUPPORTED");
  });

  it("fails timeouts and hostile transport failures closed, carrying nothing (N-E-14, N-E-21)", async () => {
    reinstall(() => {
      throw new DOMException("timeout", "TimeoutError");
    });
    expect((await refusal()).code).toBe("REQUEST_TIMEOUT");
    for (const thrower of [
      () => {
        throw new TypeError("fetch failed: " + CANARY);
      },
      () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED", detail: CANARY } });
      },
      () => {
        throw new AggregateError([new Error(CANARY)]);
      },
    ]) {
      reinstall(thrower);
      const error = await refusal();
      expect(error.code).toBe("PROVIDER_UNREACHABLE");
      expect(renderings(error).join("\n")).not.toContain(CANARY);
    }
  });
});

describe("the local usage source", () => {
  it("declares its source once: the server's own count, under a policy whose digest is pinned and recomputed here", () => {
    expect(LOCAL_CHAT_USAGE_SOURCE.source).toBe("openai-compatible-local");
    expect(LOCAL_CHAT_USAGE_SOURCE.sourceClass).toBe("PROVIDER_AUTHORITATIVE");
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
      .update(JSON.stringify(canonical(LOCAL_CHAT_USAGE_SOURCE.normalizationPolicy)), "utf8")
      .digest("hex");
    expect(LOCAL_CHAT_USAGE_SOURCE.normalizationPolicySha256).toBe(digest);
    expect(LOCAL_CHAT_USAGE_SOURCE.normalizationPolicySha256).toBe("56e91fec6d0ec424ed821f49e4de66e3a3eb0de735b5c956f677d8e834e46ac7");
    expect(Object.isFrozen(LOCAL_CHAT_USAGE_SOURCE)).toBe(true);
  });
});
