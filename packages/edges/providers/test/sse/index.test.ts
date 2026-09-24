import { describe, expect, it } from "vitest";

import { AdapterError } from "../../src/errors/index.js";
import {
  SSE_EVENT_MAX_CHARS,
  classifyResponse,
  classifyTransportFailure,
  discardBody,
  readSseEvents,
} from "../../src/sse/index.js";
import type { SseEvent } from "../../src/sse/index.js";
import { byteStream, splitBytes, sseEvent, synLocalStream, synMessagesStream, syntheticCanary } from "../testing/index.js";

const CONTEXT = { provider: "claude", taskId: "task-sse" } as const;

async function eventsOf(parts: readonly Uint8Array[]): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of readSseEvents(byteStream(parts), CONTEXT)) events.push(event);
  return events;
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    return error instanceof AdapterError ? error.code : "NOT_AN_ADAPTER_ERROR";
  }
  return "NO_THROW";
}

describe("the shared SSE byte reader (P-15/E, C-E9.2)", () => {
  const messages = synMessagesStream();
  const local = synLocalStream();

  it("frames events with their event field before or after the data, and ignores comments and unknown fields", async () => {
    const text = ": a comment\nretry: 10\n" + sseEvent("one", "first") + sseEvent("two", "second", true) + "data: a\ndata: b\n\n";
    expect(await eventsOf(splitBytes(text, []))).toEqual([
      { event: "first", data: "one" },
      { event: "second", data: "two" },
      { event: null, data: "a\nb" },
    ]);
  });

  it("gives the same events whatever the byte split, including inside an event and inside a multibyte character (N-E-24)", async () => {
    for (const text of [messages, local]) {
      const whole = await eventsOf(splitBytes(text, []));
      expect(whole.length).toBeGreaterThan(3);
      const bytes = new TextEncoder().encode(text);
      // The euro sign is three bytes; cut one byte into it.
      const euro = bytes.findIndex((byte, index) => byte === 0xe2 && bytes[index + 1] === 0x82 && bytes[index + 2] === 0xac);
      expect(euro).toBeGreaterThan(0);
      expect(await eventsOf(splitBytes(text, [euro + 1]))).toEqual(whole);
      expect(await eventsOf(splitBytes(text, [7, 40, euro + 1, euro + 2, bytes.length - 3]))).toEqual(whole);
      for (let step = 1; step < 64; step += 13) {
        const cuts = Array.from({ length: Math.floor(bytes.length / step) }, (_, index) => (index + 1) * step);
        expect(await eventsOf(splitBytes(text, cuts)), String(step)).toEqual(whole);
      }
    }
  });

  it("reads CRLF and bare CR line ends as LF, including a CRLF split across two reads", async () => {
    const whole = await eventsOf(splitBytes(messages, []));
    const crlf = synMessagesStream({ newline: "\r\n" });
    expect(await eventsOf(splitBytes(crlf, []))).toEqual(whole);
    const firstCr = new TextEncoder().encode(crlf).indexOf(13);
    expect(await eventsOf(splitBytes(crlf, [firstCr + 1]))).toEqual(whole);
    expect(await eventsOf(splitBytes(synMessagesStream({ newline: "\r" }), [5, 99]))).toEqual(whole);
  });

  it("flushes a final event that arrives without its blank line", async () => {
    expect(await eventsOf(splitBytes("data: last", []))).toEqual([{ event: null, data: "last" }]);
  });

  it("refuses bytes that are not UTF-8 as MALFORMED_EVENT, never a replacement character", async () => {
    const parts = [new TextEncoder().encode("data: a"), Uint8Array.of(0xff, 0xfe), new TextEncoder().encode("\n\n")];
    expect(await codeOf(() => eventsOf(parts))).toBe("MALFORMED_EVENT");
    // A multibyte sequence cut off by the end of the stream is not UTF-8 either.
    expect(await codeOf(() => eventsOf([Uint8Array.of(0x64, 0x61, 0x74, 0x61, 0x3a, 0xe2, 0x82)]))).toBe("MALFORMED_EVENT");
  });

  it("refuses an event larger than its bound rather than buffering it", async () => {
    const huge = "data: " + "x".repeat(SSE_EVENT_MAX_CHARS + 1) + "\n\n";
    expect(await codeOf(() => eventsOf(splitBytes(huge, [4096])))).toBe("MALFORMED_EVENT");
    const endless = "data: " + "x".repeat(SSE_EVENT_MAX_CHARS + 1);
    expect(await codeOf(() => eventsOf(splitBytes(endless, [4096])))).toBe("MALFORMED_EVENT");
  });

  it("cancels the body when the consumer stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("data: one\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const event of readSseEvents(body, CONTEXT)) {
      expect(event.data).toBe("one");
      break;
    }
    expect(cancelled).toBe(true);
  });
});

describe("the transport failure classifier reads a name and nothing else (C-E7)", () => {
  const canary = syntheticCanary("SSE01");

  it("keeps an adapter error's own code", () => {
    expect(classifyTransportFailure(new AdapterError("MALFORMED_EVENT", CONTEXT))).toBe("MALFORMED_EVENT");
  });

  it("names a timeout by its error name", () => {
    expect(classifyTransportFailure(new DOMException("x", "TimeoutError"))).toBe("REQUEST_TIMEOUT");
    expect(classifyTransportFailure(new DOMException("x", "AbortError"))).toBe("REQUEST_TIMEOUT");
  });

  it("fails every other value closed to PROVIDER_UNREACHABLE, whatever its message or cause says (N-E-21)", () => {
    const hostile = [
      new TypeError("fetch failed: " + canary),
      new TypeError("fetch failed", { cause: { code: "ECONNRESET", detail: canary } }),
      new AggregateError([new Error(canary)]),
      canary,
      null,
      undefined,
      { name: 42 },
      Object.defineProperty({}, "message", {
        get() {
          throw new Error("the classifier read a message");
        },
      }),
    ];
    for (const value of hostile) expect(classifyTransportFailure(value)).toBe("PROVIDER_UNREACHABLE");
  });
});

describe("the status table (C-E7, ADR 0108 §3.1)", () => {
  const response = (status: number, contentType = "text/event-stream"): Response =>
    new Response(status === 204 || status === 304 ? null : "body", { status, headers: { "content-type": contentType } });

  it("maps every status row to its closed verdict, before a byte of the body is read", () => {
    expect(classifyResponse(response(200))).toEqual({ kind: "STREAM" });
    expect(classifyResponse(response(200, "text/event-stream; charset=utf-8"))).toEqual({ kind: "STREAM" });
    expect(classifyResponse(response(200, "application/json"))).toEqual({ kind: "REFUSED", code: "PROTOCOL_UNSUPPORTED" });
    for (const status of [301, 302, 303, 307, 308]) {
      expect(classifyResponse(response(status))).toEqual({ kind: "REFUSED", code: "REDIRECT_REFUSED" });
    }
    expect(classifyResponse(response(401))).toEqual({ kind: "AUTH_REQUIRED", reason: "AUTHENTICATION_ERROR" });
    expect(classifyResponse(response(403))).toEqual({ kind: "AUTH_REQUIRED", reason: "PERMISSION_DENIED" });
    expect(classifyResponse(response(429))).toEqual({ kind: "REFUSED", code: "PROVIDER_RATE_LIMITED" });
    expect(classifyResponse(response(529))).toEqual({ kind: "REFUSED", code: "PROVIDER_RATE_LIMITED" });
    for (const status of [400, 404, 408, 409, 413, 500, 502, 503]) {
      expect(classifyResponse(response(status))).toEqual({ kind: "REFUSED", code: "PROVIDER_HTTP_ERROR" });
    }
  });

  it("releases a refused body without reading it", async () => {
    let cancelled = false;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulled += 1;
      },
      cancel() {
        cancelled = true;
      },
    });
    await discardBody(new Response(body, { status: 500 }));
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(1);
    await expect(discardBody(new Response(null, { status: 204 }))).resolves.toBeUndefined();
  });
});
