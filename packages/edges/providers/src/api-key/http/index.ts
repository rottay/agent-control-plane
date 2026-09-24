import type { UsageSourceDescriptor } from "../../contract/index.js";
import { AdapterError } from "../../errors/index.js";
import { isReportableTokenCount } from "../../events/index.js";
import { hasPrivacyViolation } from "../../redact/index.js";
import { classifyResponse, classifyTransportFailure, discardBody, readSseEvents } from "../../sse/index.js";
import type { SseContext } from "../../sse/index.js";
import type { ApiStreamChunk, ApiStreamRequest, ApiStreamingClient } from "../index.js";

import type { AnthropicMessagesClientOptions } from "./types/index.js";

/**
 * The Anthropic Messages client: the API_KEY leg's one real implementation (P-15
 * escalón E, ADR 0108).
 *
 * It implements the owned `ApiStreamingClient` interface and nothing wider, so no
 * vendor field reaches a contract (`API_CLIENT_SHAPE` does not move). It is one of the
 * two files in this package that may call `fetch` (the network amendment of the
 * providers row), and it calls it once, in {@link sendMessages}, at call time: the
 * global is looked up when the request is made, never captured when the module loads,
 * so a test that installs a substitute after import is the one the leaf calls (C-E9).
 *
 * **The credential stays inside this client.** The composition hands in a closure;
 * it is called inside the fetch site to build the one credential header, whose name is
 * this leaf's constant. It is never stored on the client, a request or an error, and
 * the fetch site's `catch` classifies a failure by its name alone — Node's `Headers`
 * quotes a value it refuses in its message, so no message is ever read (C-E7).
 *
 * **Provider text is bounded before it becomes a chunk.** The model the provider bound
 * travels verbatim as `resolvedModel` (C-E3) but only within its grammar, and the
 * message id likewise; anything else is `MALFORMED_EVENT` (C-E8). A non-2xx body is
 * never read.
 */

/** The provider word this client speaks: the registry's `MODEL_VERSION.provider`, by law (E-ND-7). */
const ANTHROPIC_MESSAGES_PROVIDER = "claude";

/** The one URL this leaf reaches. */
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** The API version header the Messages protocol requires, a fixed non-credential literal. */
const ANTHROPIC_VERSION = "2023-06-01";

/** The one header built from the credential closure. */
const CREDENTIAL_HEADER = "x-api-key";

/** A provider's model word, bounded before it becomes `resolvedModel`. */
const RESOLVED_MODEL = /^[A-Za-z0-9._:@/-]{1,120}$/;

/**
 * A provider's message id, bounded before it becomes `sourceObservationId`. Both
 * bounded fields are also held to the contracts' privacy guards here, so a
 * credential-shaped word inside the charset is refused at the leaf rather than
 * at the ledger's append guard, which stays the second line.
 */
const OBSERVATION_ID = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * How this leaf normalizes usage, stated once (ADR 0108; decision 138's mould).
 *
 * One report per run, CUMULATIVE and final, at `message_delta`: the input and cache
 * classes arrive in `message_start.message.usage`, the output class in
 * `message_delta.usage`, each cumulative. A class a frame does not carry is `null`
 * (UNKNOWN), never 0; the total is the sum only when all four are known. The
 * observation id is the message's own id; `stepIndex` is 1, one message per run. A
 * stream that carries no usage object at all yields no report.
 */
const ANTHROPIC_USAGE_NORMALIZATION_POLICY = Object.freeze({
  policyVersion: 1,
  adapter: "anthropic-messages",
  frames: Object.freeze({ input: "message_start.message.usage", output: "message_delta.usage" }),
  classes: Object.freeze({
    inputTokens: "input_tokens",
    outputTokens: "output_tokens",
    cacheWriteTokens: "cache_creation_input_tokens",
    cacheReadTokens: "cache_read_input_tokens",
  }),
  absentClass: "UNKNOWN",
  totalTokens: "SUM_WHEN_ALL_KNOWN",
  reportKind: "CUMULATIVE",
  isFinal: true,
  sourceObservationId: "MESSAGE_ID",
  stepIndex: 1,
  absentUsage: "NO_REPORT",
});

/**
 * The Messages API's usage source, declared once: the provider's own count
 * (`PROVIDER_AUTHORITATIVE`). The digest is a pinned literal over the policy's
 * canonical JSON; the providers suite recomputes it (L-P15A-1).
 */
export const ANTHROPIC_MESSAGES_USAGE_SOURCE: UsageSourceDescriptor = Object.freeze({
  source: "anthropic-messages-api",
  sourceClass: "PROVIDER_AUTHORITATIVE",
  normalizationPolicy: ANTHROPIC_USAGE_NORMALIZATION_POLICY,
  normalizationPolicySha256: "a99a54f24370b6da21dc43c9f5ccfceebad1aa8bba1d6a68dbf62cfa71054deb",
});

/**
 * The stop reasons, a closed table: a word here decides the operation's status; a
 * word outside it decides nothing (no `operationResult`, NOT_OBSERVABLE, the P-07
 * decider's row 5), never SUCCEEDED (C-E3).
 */
const STOP_REASONS: Readonly<Record<string, "SUCCEEDED" | "FAILED">> = Object.freeze({
  end_turn: "SUCCEEDED",
  stop_sequence: "SUCCEEDED",
  max_tokens: "FAILED",
  tool_use: "FAILED",
});

/** The vendor's in-stream error types this leaf names; any other is a plain HTTP error. */
const RATE_LIMITED_TYPES: ReadonlySet<string> = new Set(["rate_limit_error", "overloaded_error"]);

/** Create the Messages client. Every option is required and checked; none is defaulted. */
export function createAnthropicMessagesClient(options: AnthropicMessagesClientOptions): ApiStreamingClient {
  const models = options.models;
  if (!Array.isArray(models) || models.length === 0 || !models.every((model) => typeof model === "string" && model !== "")) {
    throw new TypeError("the Messages client serves a non-empty list of model words");
  }
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1) {
    throw new TypeError("the Messages client needs a positive maxTokens");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new TypeError("the Messages client needs a positive timeoutMs");
  }
  if (typeof options.credential !== "function") {
    throw new TypeError("the Messages client needs its credential closure");
  }
  const credential = options.credential;
  const maxTokens = options.maxTokens;
  const timeoutMs = options.timeoutMs;
  return Object.freeze({
    provider: ANTHROPIC_MESSAGES_PROVIDER,
    models: Object.freeze([...options.models]),
    stream: (request: ApiStreamRequest): AsyncIterable<ApiStreamChunk> =>
      streamMessages(request, { credential, maxTokens, timeoutMs }),
  });
}

interface CallSettings {
  readonly credential: () => string;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}

/**
 * The one fetch site (L-P15E-1).
 *
 * `fetch` is read at the call. The credential closure is called here and nowhere
 * else, into the one header this leaf names; every other header is a literal. A
 * redirect is never followed, the request carries its own timeout, and a failure is
 * classified by name into a closed word — the caught value is never read beyond that.
 */
async function sendMessages(request: ApiStreamRequest, settings: CallSettings, context: SseContext): Promise<Response> {
  try {
    return await fetch(MESSAGES_URL, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(settings.timeoutMs),
      headers: {
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        [CREDENTIAL_HEADER]: settings.credential(),
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: settings.maxTokens,
        stream: true,
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

function recordAt(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const field = value[key];
  return typeof field === "object" && field !== null && !Array.isArray(field) ? (field as Record<string, unknown>) : null;
}

/** A usage class: absent is `null` (UNKNOWN), present must be a non-negative integer. */
function tokenClass(usage: Record<string, unknown> | null, key: string, context: SseContext): number | null {
  if (usage === null || !(key in usage) || usage[key] === null) return null;
  const count = usage[key];
  if (!isReportableTokenCount(count)) {
    throw new AdapterError("MALFORMED_EVENT", context);
  }
  return count;
}

async function* streamMessages(request: ApiStreamRequest, settings: CallSettings): AsyncIterable<ApiStreamChunk> {
  const context: SseContext = { provider: ANTHROPIC_MESSAGES_PROVIDER, taskId: request.taskId };
  const response = await sendMessages(request, settings, context);
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

  let messageId: string | null = null;
  let started = false;
  let startUsage: Record<string, unknown> | null = null;
  let stopReason: string | null = null;
  try {
    for await (const event of readSseEvents(body, context)) {
      if (event.data === "") continue;
      const frame = objectOf(event.data, context);
      const type = frame["type"];
      switch (type) {
        case "ping":
        case "content_block_start":
        case "content_block_stop":
          break;
        case "message_start": {
          if (started) throw new AdapterError("MALFORMED_EVENT", context);
          const message = recordAt(frame, "message");
          const model = message?.["model"];
          const id = message?.["id"];
          if (typeof model !== "string" || !RESOLVED_MODEL.test(model) || hasPrivacyViolation({ resolvedModel: model })) {
            throw new AdapterError("MALFORMED_EVENT", context);
          }
          if (typeof id !== "string" || !OBSERVATION_ID.test(id) || hasPrivacyViolation({ sourceObservationId: id })) {
            throw new AdapterError("MALFORMED_EVENT", context);
          }
          started = true;
          messageId = id;
          startUsage = message === null ? null : recordAt(message, "usage");
          yield { kind: "started", resolvedModel: model, protocolVersion: ANTHROPIC_VERSION };
          break;
        }
        case "content_block_delta": {
          if (!started) throw new AdapterError("MALFORMED_EVENT", context);
          const delta = recordAt(frame, "delta");
          const deltaType = delta?.["type"];
          if (deltaType === "text_delta") {
            const text = delta?.["text"];
            if (typeof text !== "string") throw new AdapterError("MALFORMED_EVENT", context);
            yield { kind: "text", delta: text };
          } else if (deltaType === "input_json_delta" || deltaType === "thinking_delta" || deltaType === "signature_delta") {
            // Known vendor deltas this leg never forwards: tool input and thinking
            // are not output text, and there is no chunk kind for them here.
          } else {
            throw new AdapterError("MALFORMED_EVENT", context);
          }
          break;
        }
        case "message_delta": {
          if (!started || messageId === null) throw new AdapterError("MALFORMED_EVENT", context);
          const delta = recordAt(frame, "delta");
          const reason = delta?.["stop_reason"];
          if (reason !== undefined && reason !== null && typeof reason !== "string") {
            throw new AdapterError("MALFORMED_EVENT", context);
          }
          stopReason = typeof reason === "string" ? reason : null;
          const endUsage = recordAt(frame, "usage");
          // No usage object anywhere: no report at all (UNKNOWN), never a report of zeros.
          if (startUsage === null && endUsage === null) break;
          const inputTokens = tokenClass(startUsage, "input_tokens", context);
          const cacheWriteTokens = tokenClass(startUsage, "cache_creation_input_tokens", context);
          const cacheReadTokens = tokenClass(startUsage, "cache_read_input_tokens", context);
          const outputTokens = tokenClass(endUsage, "output_tokens", context);
          const classes = [inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens];
          const known = classes.filter((count): count is number => count !== null);
          const totalTokens = known.length === classes.length ? known.reduce((sum, count) => sum + count, 0) : null;
          yield {
            kind: "usage",
            stepIndex: 1,
            inputTokens,
            outputTokens,
            cacheWriteTokens,
            cacheReadTokens,
            totalTokens,
            reportKind: "CUMULATIVE",
            isFinal: true,
            sourceObservationId: messageId,
          };
          break;
        }
        case "message_stop": {
          if (!started) throw new AdapterError("MALFORMED_EVENT", context);
          // An own entry only: a word like `constructor` decides nothing, as any word outside the table.
          const status = stopReason !== null && Object.hasOwn(STOP_REASONS, stopReason) ? STOP_REASONS[stopReason] : undefined;
          if (status !== undefined) yield { kind: "operationResult", status };
          return;
        }
        case "error": {
          const error = recordAt(frame, "error");
          const errorType = error?.["type"];
          throw new AdapterError(
            typeof errorType === "string" && RATE_LIMITED_TYPES.has(errorType) ? "PROVIDER_RATE_LIMITED" : "PROVIDER_HTTP_ERROR",
            context,
          );
        }
        default:
          throw new AdapterError("MALFORMED_EVENT", context);
      }
    }
  } catch (failure: unknown) {
    throw new AdapterError(classifyTransportFailure(failure), context);
  }
  // The stream ended without `message_stop`: no operation fact, never SUCCEEDED.
}
