import {
  RESTATE_HANDLER_ADVANCE,
  RESTATE_HANDLER_READ_CACHE,
  RESTATE_OBJECT_NAME,
} from "../constants.js";
import type { DurableInvocation, RestateCacheState } from "../contracts.js";
import { deterministicUuid } from "../core/coordinates.js";

/**
 * Deterministic submission and registration, over global `fetch`.
 *
 * `fetch` rather than `@restatedev/restate-sdk-clients`: that package is not
 * installed and adding it is not authorised, and a global costs no import
 * allowance, so the runtime dependency surface stays exactly what P2A froze.
 *
 * L1: submission assigns identity. The invocation id and the submitted instant
 * are derived ONCE, here, before ingress, and the same value is sent as the
 * idempotency key. A resubmission after a crash therefore reuses the identity
 * rather than minting a new one, which is what makes a retry a replay.
 */

/** Derive the invocation identity. Pure, and stable across restarts. */
export function deriveInvocation(
  taskId: string,
  attempt: number,
  submittedAt: string,
  submissionDigest: string,
): DurableInvocation {
  return {
    taskId,
    attempt,
    invocationId: deterministicUuid("invocation/" + taskId + "/" + String(attempt)),
    submittedAt,
    submissionDigest,
  };
}

function assertLoopback(url: string): URL {
  const parsed = new URL(url);
  if (parsed.hostname !== "127.0.0.1") {
    throw new Error("refusing to talk to " + parsed.hostname + "; this plane is loopback only");
  }
  return parsed;
}

/**
 * Register the endpoint with the server's admin API.
 *
 * `force` is deliberately false: a registration that would replace a different
 * deployment should fail loudly rather than silently take it over.
 */
export async function registerDeployment(
  adminUrl: string,
  endpointUrl: string,
): Promise<{ readonly ok: boolean; readonly status: number; readonly body: string }> {
  assertLoopback(adminUrl);
  assertLoopback(endpointUrl);

  const response = await fetch(new URL("/deployments", adminUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uri: endpointUrl, force: false }),
    signal: AbortSignal.timeout(30_000),
  });
  return { ok: response.ok, status: response.status, body: await response.text() };
}

export interface SubmitResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: string;
}

/**
 * Submit one invocation through ingress, idempotently.
 *
 * The idempotency key is the derived invocation id, so a resubmission of the
 * same work is the same call rather than a second one.
 */
export async function submitAdvance(
  ingressUrl: string,
  invocation: DurableInvocation,
  timeoutMs = 120_000,
): Promise<SubmitResult> {
  assertLoopback(ingressUrl);
  const target = new URL(
    "/" + RESTATE_OBJECT_NAME + "/" + invocation.taskId + "/" + RESTATE_HANDLER_ADVANCE,
    ingressUrl,
  );

  const response = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": invocation.invocationId,
    },
    body: JSON.stringify(invocation),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { ok: response.ok, status: response.status, body: await response.text() };
}

/**
 * Read the object's cache through its shared handler, never through admin.
 *
 * Only a JSON literal `null` means "absent". Everything else that is not a
 * well-formed cache **throws**, so reconciliation classifies it as
 * `INDETERMINATE` rather than as absence.
 *
 * That distinction is the whole point. Absence is the reconstructible case and
 * resumes; a malformed reply is an unanswered question and must halt. Coercing
 * a half-parsed object into `null` would turn "I cannot tell what the driver
 * believes" into "the driver believes nothing", which is precisely the guess
 * this design refuses to make.
 */
export async function readCacheThroughHandler(
  ingressUrl: string,
  taskId: string,
): Promise<RestateCacheState | null> {
  assertLoopback(ingressUrl);
  const target = new URL(
    "/" + RESTATE_OBJECT_NAME + "/" + taskId + "/" + RESTATE_HANDLER_READ_CACHE,
    ingressUrl,
  );
  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error("the cache handler answered " + String(response.status));
  }
  return parseCacheReply(await response.text());
}

/** The one place a cache reply becomes a value, absence, or a refusal. */
export function parseCacheReply(text: string): RestateCacheState | null {
  const trimmed = text.trim();
  if (trimmed === "null") return null;
  if (trimmed === "") {
    throw new Error("the cache handler returned an empty body; absence must be an explicit null");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("the cache handler returned a body that is not JSON");
  }
  if (parsed === null) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the cache handler returned something that is not a cache object");
  }

  const record = parsed as Record<string, unknown>;
  const sequence = record["lastAppliedSequence"];
  const digest = record["lastAppliedEventSha256"];
  if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0) {
    throw new Error("the cache reply carries no usable lastAppliedSequence");
  }
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("the cache reply carries no usable lastAppliedEventSha256");
  }
  return { lastAppliedSequence: sequence, lastAppliedEventSha256: digest };
}
