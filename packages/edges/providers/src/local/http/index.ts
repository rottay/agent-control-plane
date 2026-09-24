import type { UsageSourceDescriptor } from "../../contract/index.js";
import { AdapterError } from "../../errors/index.js";
import { isReportableTokenCount } from "../../events/index.js";
import { hasPrivacyViolation } from "../../redact/index.js";
import { classifyResponse, classifyTransportFailure, discardBody, readSseEvents } from "../../sse/index.js";
import type { SseContext } from "../../sse/index.js";
import type { LocalChatChunk, LocalChatClient, LocalChatRequest } from "../index.js";

import type { LocalChatClientOptions } from "./types/index.js";

/**
 * The OpenAI-compatible chat/completions client: the LOCAL_OR_SELF_HOSTED leg's
 * one real implementation (P-15 escalón E, ADR 0108).
 *
 * It implements the owned `LocalChatClient` interface and nothing wider
 * (`LOCAL_CLIENT_SHAPE` does not move). It is the second of the two files in this
 * package that may call `fetch`, once, in {@link sendCompletions}, looked up at the
 * call. It names no URL: the endpoint is the binding's base plus the protocol's one
 * path, so the composition, not this file, decides where a local server lives.
 *
 * **The credential, when there is one, stays inside this client.** A binding whose
 * auth is `NONE` hands in no closure and the request carries no `authorization`
 * header at all; one whose auth is `CREDENTIAL` hands in a closure that is called
 * inside the fetch site, into the one header this leaf names. The fetch site's
 * `catch` classifies by name alone (C-E7).
 *
 * **A local server is not trusted to be well-formed.** The model word and the
 * completion id are bounded before they become chunk fields (C-E8), an unknown frame
 * shape is `MALFORMED_EVENT`, and a non-2xx body is never read.
 */

/** The protocol's one path, appended to the binding's base. */
const COMPLETIONS_PATH = "/chat/completions";

/** The one header built from the credential closure. */
const CREDENTIAL_HEADER = "authorization";

/** The scheme word the credential header carries. */
const BEARER = "Bearer ";

/** What this leaf reports as `protocolVersion`: the protocol's name, since the server states none. */
const PROTOCOL = "openai-chat-completions";

/** The stream's terminal data line. */
const DONE = "[DONE]";

/** A server's model word, bounded before it becomes `resolvedModel`. */
const RESOLVED_MODEL = /^[A-Za-z0-9._:@/-]{1,120}$/;

/** A server's completion id, bounded before it becomes `sourceObservationId`. */
const OBSERVATION_ID = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * How this leaf normalizes usage, stated once (ADR 0108; decision 138's mould).
 *
 * The request asks for usage (`stream_options.include_usage`), and a server that
 * honours it sends one `usage` object, the completion's whole count: one CUMULATIVE
 * final report. The protocol has no cache classes, so both are `null` (UNKNOWN), never
 * 0; the total is the server's own `total_tokens` when it states one no smaller than
 * the known classes, else `null`. The observation id is the completion id; a server
 * that sends none gets the run's coordinates (`taskId/attempt/final`), because the
 * contract requires an id and a replay of the same run is the same report. That form
 * contains `/`, which `OBSERVATION_ID` excludes, so it can never collide with a
 * server's id; and `PROVIDER_AUTHORITATIVE` qualifies the counts, which are the
 * server's, not the id. A server that sends no usage object yields no report at all.
 */
const LOCAL_USAGE_NORMALIZATION_POLICY = Object.freeze({
  policyVersion: 1,
  adapter: "openai-compatible-chat",
  request: "stream_options.include_usage",
  field: "usage",
  classes: Object.freeze({
    inputTokens: "prompt_tokens",
    outputTokens: "completion_tokens",
    cacheWriteTokens: "UNKNOWN",
    cacheReadTokens: "UNKNOWN",
  }),
  absentClass: "UNKNOWN",
  totalTokens: "SOURCE_TOTAL_WHEN_AT_LEAST_KNOWN_SUM",
  reportKind: "CUMULATIVE",
  isFinal: true,
  sourceObservationId: "COMPLETION_ID_ELSE_TASK_ATTEMPT_FINAL",
  stepIndex: 1,
  absentUsage: "NO_REPORT",
});

/**
 * A local server's usage source, declared once: the server's own count, stated as
 * such (`PROVIDER_AUTHORITATIVE`, E-ND-8). The digest is a pinned literal over the
 * policy's canonical JSON; the providers suite recomputes it (L-P15A-1).
 */
export const LOCAL_CHAT_USAGE_SOURCE: UsageSourceDescriptor = Object.freeze({
  source: "openai-compatible-local",
  sourceClass: "PROVIDER_AUTHORITATIVE",
  normalizationPolicy: LOCAL_USAGE_NORMALIZATION_POLICY,
  normalizationPolicySha256: "56e91fec6d0ec424ed821f49e4de66e3a3eb0de735b5c956f677d8e834e46ac7",
});

/** The finish reasons, a closed table; a word outside it decides nothing (C-E3). */
const FINISH_REASONS: Readonly<Record<string, "SUCCEEDED" | "FAILED">> = Object.freeze({
  stop: "SUCCEEDED",
  length: "FAILED",
  tool_calls: "FAILED",
});

/**
 * Admit a base URL: `http:` or `https:`, no userinfo, no query, no fragment; a
 * trailing slash is dropped so the path joins once.
 */
function admitBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !URL.canParse(value)) {
    throw new TypeError("the local chat client needs an absolute base URL");
  }
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("the local chat client's base URL is http(s) with no userinfo, query or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

/** Create the local chat client. Every option is required and checked; none is defaulted. */
export function createLocalChatClient(options: LocalChatClientOptions): LocalChatClient {
  const endpoint = admitBaseUrl(options.baseUrl) + COMPLETIONS_PATH;
  if (typeof options.provider !== "string" || options.provider === "") {
    throw new TypeError("the local chat client needs its provider word");
  }
  const models = options.models;
  if (!Array.isArray(models) || models.length === 0 || !models.every((model) => typeof model === "string" && model !== "")) {
    throw new TypeError("the local chat client serves a non-empty list of model words");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new TypeError("the local chat client needs a positive timeoutMs");
  }
  if (options.credential !== null && typeof options.credential !== "function") {
    throw new TypeError("the local chat client's credential is a closure or null");
  }
  const provider = options.provider;
  const settings: CallSettings = Object.freeze({
    endpoint,
    credential: options.credential,
    timeoutMs: options.timeoutMs,
  });
  return Object.freeze({
    provider,
    models: Object.freeze([...options.models]),
    stream: (request: LocalChatRequest): AsyncIterable<LocalChatChunk> => streamCompletions(request, provider, settings),
  });
}

interface CallSettings {
  readonly endpoint: string;
  readonly credential: (() => string) | null;
  readonly timeoutMs: number;
}

/**
 * The one fetch site (L-P15E-2).
 *
 * `fetch` is read at the call. The credential closure, when the binding has one, is
 * called here and nowhere else, into the one header this leaf names; the other header
 * is a literal. A redirect is never followed, the request carries its own timeout, and
 * a failure is classified by name into a closed word.
 */
async function sendCompletions(request: LocalChatRequest, settings: CallSettings, context: SseContext): Promise<Response> {
  try {
    return await fetch(settings.endpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(settings.timeoutMs),
      headers:
        settings.credential === null
          ? { "content-type": "application/json" }
          : { "content-type": "application/json", [CREDENTIAL_HEADER]: BEARER + settings.credential() },
      body: JSON.stringify({
        model: request.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: request.instructions }],
      }),
    });
  } catch (failure: unknown) {
    throw new AdapterError(classifyTransportFailure(failure), context);
  }
}

/** A JSON object from an event's data, or `MALFORMED_EVENT`. */
function objectOf(data: string, context: SseContext): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new AdapterError("MALFORMED_EVENT", context);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AdapterError("MALFORMED_EVENT", context);
  }
  return parsed as Record<string, unknown>;
}

/** A usage class the server may omit: absent is `null` (UNKNOWN), present must be a reportable count. */
function tokenClass(usage: Record<string, unknown>, key: string, context: SseContext): number | null {
  if (!(key in usage) || usage[key] === null) return null;
  const count = usage[key];
  if (!isReportableTokenCount(count)) throw new AdapterError("MALFORMED_EVENT", context);
  return count;
}

async function* streamCompletions(
  request: LocalChatRequest,
  provider: string,
  settings: CallSettings,
): AsyncIterable<LocalChatChunk> {
  const context: SseContext = { provider, taskId: request.taskId };
  const response = await sendCompletions(request, settings, context);
  const verdict = classifyResponse(response);
  if (verdict.kind !== "STREAM") {
    await discardBody(response);
    if (verdict.kind === "AUTH_REQUIRED") {
      yield { kind: "authRequired", reason: verdict.reason };
      return;
    }
    throw new AdapterError(verdict.code, context);
  }
  const body = response.body;
  if (body === null) throw new AdapterError("PROTOCOL_UNSUPPORTED", context);

  let started = false;
  let completionId: string | null = null;
  let finishReason: string | null = null;
  let usageReported = false;
  try {
    for await (const event of readSseEvents(body, context)) {
      if (event.data === "") continue;
      if (event.data === DONE) {
        if (!started) throw new AdapterError("MALFORMED_EVENT", context);
        // An own entry only: a word like `constructor` decides nothing, as any word outside the table.
        const status = finishReason !== null && Object.hasOwn(FINISH_REASONS, finishReason) ? FINISH_REASONS[finishReason] : undefined;
        if (status !== undefined) yield { kind: "operationResult", status };
        return;
      }
      const frame = objectOf(event.data, context);
      if ("error" in frame) throw new AdapterError("PROVIDER_HTTP_ERROR", context);

      if (!started) {
        const model = frame["model"];
        if (typeof model !== "string" || !RESOLVED_MODEL.test(model) || hasPrivacyViolation({ resolvedModel: model })) {
          throw new AdapterError("MALFORMED_EVENT", context);
        }
        started = true;
        yield { kind: "started", resolvedModel: model, protocolVersion: PROTOCOL };
      }
      const id = frame["id"];
      if (id !== undefined && id !== null) {
        if (typeof id !== "string" || !OBSERVATION_ID.test(id) || hasPrivacyViolation({ sourceObservationId: id })) {
          throw new AdapterError("MALFORMED_EVENT", context);
        }
        completionId = id;
      }

      const choices = frame["choices"];
      if (choices !== undefined && choices !== null) {
        if (!Array.isArray(choices)) throw new AdapterError("MALFORMED_EVENT", context);
        for (const choice of choices as readonly unknown[]) {
          if (typeof choice !== "object" || choice === null || Array.isArray(choice)) {
            throw new AdapterError("MALFORMED_EVENT", context);
          }
          const entry = choice as Record<string, unknown>;
          const delta = entry["delta"];
          if (delta !== undefined && delta !== null) {
            if (typeof delta !== "object" || Array.isArray(delta)) throw new AdapterError("MALFORMED_EVENT", context);
            const content = (delta as Record<string, unknown>)["content"];
            if (content !== undefined && content !== null) {
              if (typeof content !== "string") throw new AdapterError("MALFORMED_EVENT", context);
              if (content !== "") yield { kind: "text", delta: content };
            }
          }
          const reason = entry["finish_reason"];
          if (reason !== undefined && reason !== null) {
            if (typeof reason !== "string") throw new AdapterError("MALFORMED_EVENT", context);
            finishReason = reason;
          }
        }
      }

      const usage = frame["usage"];
      if (usage !== undefined && usage !== null) {
        if (typeof usage !== "object" || Array.isArray(usage) || usageReported) {
          throw new AdapterError("MALFORMED_EVENT", context);
        }
        usageReported = true;
        const counts = usage as Record<string, unknown>;
        const inputTokens = tokenClass(counts, "prompt_tokens", context);
        const outputTokens = tokenClass(counts, "completion_tokens", context);
        const stated = tokenClass(counts, "total_tokens", context);
        const knownSum = (inputTokens ?? 0) + (outputTokens ?? 0);
        yield {
          kind: "usage",
          stepIndex: 1,
          inputTokens,
          outputTokens,
          cacheWriteTokens: null,
          cacheReadTokens: null,
          totalTokens: stated !== null && stated >= knownSum ? stated : null,
          reportKind: "CUMULATIVE",
          isFinal: true,
          sourceObservationId: completionId ?? `${request.taskId}/${request.attempt}/final`,
        };
      }
    }
  } catch (failure: unknown) {
    throw new AdapterError(classifyTransportFailure(failure), context);
  }
  // The stream ended without `[DONE]`: no operation fact, never SUCCEEDED.
}
