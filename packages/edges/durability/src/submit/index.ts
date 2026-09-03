import {
  RESTATE_HANDLER_ADVANCE,
  RESTATE_HANDLER_READ_CACHE,
  RESTATE_OBJECT_NAME,
  deterministicUuid,
} from "@acp/runtime";
import type { DurableInvocation } from "@acp/runtime";

import type { RestateCacheState } from "../contracts/index.js";

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
 * What a nonblocking send returns: whether the server took it, and nothing else.
 *
 * The absence is the design (V2-B2-4a). Restate's `/send` reply body carries
 * its OWN invocation id — `{"invocationId":"inv_...","status":"Accepted"}` —
 * and that identity must never reach the ledger, a checkpoint, a read model or
 * a log, because a ledger that depended on an address the engine minted would
 * have handed the engine authority over its own coordinates. A rule stated in
 * prose is a rule review has to remember; a result type that cannot express
 * the id is one no careless caller can violate. So this shape has exactly two
 * members, and the fence pins that it still does.
 *
 * Nothing is lost by not carrying it. The invocation is already addressable by
 * the id THIS side derived before ingress, so a caller that wants to wait has
 * `attachAdvance` and a caller that wants the truth has the ledger.
 */
export interface SendResult {
  readonly ok: boolean;
  readonly status: number;
}

/**
 * Submit one invocation without waiting for it (V2-B2-4a).
 *
 * The same target and the same idempotency key as `submitAdvance`, with
 * `/send` appended: the server answers once it has durably accepted the
 * invocation, not once the work is done. A second `sendAdvance` for the same
 * invocation is the same call rather than a second one, for exactly the reason
 * a second `submitAdvance` is — the key governs, and it is derived.
 *
 * This is not fire-and-forget in the product sense. The outcome of the work is
 * a ledger fact whether anyone is listening or not; attaching is how a caller
 * WAITS, never how it learns.
 */
export async function sendAdvance(
  ingressUrl: string,
  invocation: DurableInvocation,
  timeoutMs = 30_000,
): Promise<SendResult> {
  assertLoopback(ingressUrl);
  const target = new URL(
    "/" + RESTATE_OBJECT_NAME + "/" + invocation.taskId + "/" + RESTATE_HANDLER_ADVANCE + "/send",
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
  // Read and drop. The body is consumed so the socket is released, and it is
  // dropped on the floor rather than returned: see `SendResult`.
  await response.text();
  return { ok: response.ok, status: response.status };
}

/**
 * What an attach returns.
 *
 * `body` is present here and absent from `SendResult`, and the asymmetry is
 * the point rather than an oversight. On this path the body IS the answer —
 * the handler's own `{"finalSequence":N}`, a ledger coordinate — or the
 * router's refusal text, which a caller has to be able to read in order to
 * tell a wrong address from an absent invocation.
 */
export interface AttachResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: string;
}

/**
 * Rejoin an invocation already in flight, by the id derived before ingress.
 *
 * The address is `/restate/invocation/:invocation_target/:idempotency_key/attach`,
 * where the target of a Virtual Object handler is its own three segments and
 * the key is `invocation.invocationId` — the value `submitAdvance` and
 * `sendAdvance` already send as `idempotency-key`, which `deriveInvocation`
 * computes from `(taskId, attempt)` alone.
 *
 * So there is no handle object and nothing to keep. A caller that lost its
 * memory RECOMPUTES the address rather than looking it up, which is what lets
 * reattachment survive a client restart with no durable client state — and it
 * is why no engine-minted identity is needed here, and therefore none is
 * persisted.
 *
 * Two limits belong to the observation channel and not to the work. A refused
 * or expired attach says nothing about whether the task advanced; the ledger
 * does. And the retention window that lets a completed invocation still answer
 * is engine configuration rather than a ledger fact, so a caller must never be
 * built to depend on it: when an attach cannot answer, read the ledger.
 */
export async function attachAdvance(
  ingressUrl: string,
  invocation: DurableInvocation,
  timeoutMs = 120_000,
): Promise<AttachResult> {
  assertLoopback(ingressUrl);
  const target = new URL(
    "/restate/invocation/" +
      RESTATE_OBJECT_NAME +
      "/" +
      invocation.taskId +
      "/" +
      RESTATE_HANDLER_ADVANCE +
      "/" +
      invocation.invocationId +
      "/attach",
    ingressUrl,
  );

  const response = await fetch(target, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { ok: response.ok, status: response.status, body: await response.text() };
}

/**
 * What a cancellation of the engine answers: whether it took, and nothing else.
 *
 * The same two members `SendResult` has, for a stronger version of the same
 * reason (V2-B2-4b). Cancelling reaches the admin API, which is addressed by
 * an invocation id Restate itself minted — the one value in this whole design
 * that must never become a coordinate anything keeps. A result type with
 * nowhere to put it is a rule no careless caller can break, and the fence
 * pins that this shape stays exactly `{ok, status}`.
 */
export interface CancelResult {
  readonly ok: boolean;
  readonly status: number;
}

/**
 * Stop the invocation these coordinates name (V2-B2-4b).
 *
 * Two calls, one scope. The engine's admin surface cancels by ITS invocation
 * id, which on its own would have inverted the authority this plane rests on:
 * the ledger would depend on an address the engine owns. It does not, because
 * the ingress resolves that id on demand from values this side already has —
 * measured against the pinned binary, `POST /restate/lookup` answers
 * `{"invocationId": "inv_..."}` for `(service, key, handler, idempotencyKey)`
 * alone, and the idempotency key is `deriveInvocation`'s output for
 * `(taskId, attempt)`.
 *
 * So the id is a local `const` in one function body and is gone when the
 * function returns. It is never stored, never logged, never appended, never
 * put in a read model and never handed back: the return type has no member it
 * could occupy. That is the whole reason the lookup is not a separate exported
 * function — a resolver that RETURNED the id would be a supply of engine
 * identities for anyone to keep.
 *
 * What the caller gets is the status. `200`/`202` mean the engine took the
 * cancellation, `404` means it has no such invocation and `409` means the
 * invocation already completed — all three are answers about the engine's
 * state, and only the driver, holding the ledger, may say what any of them
 * means for the task. A lookup that cannot answer THROWS rather than
 * returning a status about a call that was never made.
 */
export async function cancelAdvance(
  ingressUrl: string,
  adminUrl: string,
  invocation: DurableInvocation,
  timeoutMs = 30_000,
): Promise<CancelResult> {
  assertLoopback(ingressUrl);
  // The admin base is the one new host this packet talks to, and it is guarded
  // exactly like the ingress: ADR 0004 §6's loopback law is about the plane,
  // not about a particular port.
  assertLoopback(adminUrl);

  const lookup = await fetch(new URL("/restate/lookup", ingressUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      target: "idempotentInvocation",
      service: RESTATE_OBJECT_NAME,
      key: invocation.taskId,
      handler: RESTATE_HANDLER_ADVANCE,
      idempotencyKey: invocation.invocationId,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!lookup.ok) {
    // The status, never the body: a router error text is engine output.
    throw new Error("the invocation lookup answered " + String(lookup.status));
  }

  const resolved = parseLookupReply(await lookup.text());
  const cancelled = await fetch(
    new URL("/invocations/" + encodeURIComponent(resolved) + "/cancel", adminUrl),
    { method: "PATCH", signal: AbortSignal.timeout(timeoutMs) },
  );
  // Read and drop, exactly as `sendAdvance` does, and for the same reason: the
  // socket is released and nothing from the reply survives the call.
  await cancelled.text();
  return { ok: cancelled.ok, status: cancelled.status };
}

/**
 * The one place a lookup reply becomes an address, or a refusal to guess.
 *
 * Same discipline as `parseCacheReply`: a reply that is not a well-formed
 * answer throws rather than being coerced. Cancelling at an address derived
 * from a half-parsed body would be aiming a terminating operation at whatever
 * the string happened to be.
 */
function parseLookupReply(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("the invocation lookup returned a body that is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the invocation lookup returned something that is not a result");
  }
  const id = (parsed as Record<string, unknown>)["invocationId"];
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("the invocation lookup reply names no invocation");
  }
  return id;
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
