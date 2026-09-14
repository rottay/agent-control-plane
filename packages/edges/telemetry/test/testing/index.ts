import type { emitTelemetry } from "@acp/observation";

/**
 * The scripted peer this package's suites drive the transport against.
 *
 * **No socket, no bound port**, and that is a ruling rather than a convenience.
 * Three measured reasons, inherited verbatim from the tool edge because the
 * reasons are inherited verbatim: `node:http` and `node:net` are banned across
 * this package's `src` *and* `test` and would have to be weakened to do it any
 * other way; this repository has twice recorded that undici `fetch` is
 * intermittent against loopback inside a Vitest worker, so a green run would
 * prove less than it looked like; and the swap is the house precedent the
 * durability drills already use.
 *
 * The limitation is recorded rather than hidden: `OTLP_EXPORT_RECORD` reads
 * `SOCKET_EXERCISED: "NONE"` and `LIVE_CONFORMANCE: "NONE"`, the README says so
 * beside them, and the fence asserts the two cannot disagree.
 *
 * Not exported from the package barrel, and never will be — the suites reach it
 * by relative path, because a fake on a public surface is eventually mistaken
 * for evidence.
 */

/** What the peer answers with: a response, or a rejection of a named shape. */
export type ScriptedOtlpAnswer =
  | {
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
    }
  | {
      /**
       * The two ways a request fails without an answer.
       *
       * `TIMEOUT` rejects with the name `AbortSignal.timeout` really uses, so
       * the classification under test is the one production would take. A
       * generic `Error` here would let a transport that classified everything
       * as unreachable pass the timeout case.
       */
      readonly rejectAs: "UNREACHABLE" | "TIMEOUT";
    };

export interface ScriptedFetch {
  /** Every request the peer was handed, in order, for assertion. */
  readonly calls: () => readonly { readonly url: string; readonly init: RequestInit }[];
  readonly restore: () => void;
}

/** An abort as the platform announces it: by `name`, on a real `Error`. */
function abortError(): Error {
  const error = new Error("the request outlived its timeout");
  error.name = "TimeoutError";
  return error;
}

/** A rejection with no answer behind it, as a refused connection presents. */
function unreachableError(): Error {
  const error = new TypeError("the endpoint refused the connection");
  error.name = "TypeError";
  return error;
}

/**
 * Substitute `globalThis.fetch` with a peer that answers from a script.
 *
 * A list is consumed in order; anything past its end answers `500`, so a suite
 * that made an unexpected extra request fails on the assertion it wrote rather
 * than on an undefined read.
 */
export function scriptFetch(answers: readonly ScriptedOtlpAnswer[]): ScriptedFetch {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  let index = 0;

  globalThis.fetch = ((input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init: init ?? {} });
    const answer = answers[index++] ?? { status: 500 };
    if ("rejectAs" in answer) {
      return Promise.reject(answer.rejectAs === "TIMEOUT" ? abortError() : unreachableError());
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(answer.headers ?? {})) headers.set(name, value);
    return Promise.resolve(new Response(answer.body ?? null, { status: answer.status, headers }));
  }) as typeof globalThis.fetch;

  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ---------------------------------------------------------------------------
// The fixtures the suites project, and the one function that projects them
// ---------------------------------------------------------------------------

/**
 * The event shape, derived from the real producer rather than restated.
 *
 * This package may not name `@acp/contracts` — not in its manifest, not in its
 * imports, and the fence enforces both over `src` and `test` alike. So the type
 * is taken from the signature of the projection every fixture below is fed to.
 * Derived rather than declared: a field added upstream arrives here on its own,
 * and no second declaration can drift from the first.
 *
 * **Every fixture is projected through the REAL `emitTelemetry`.** Nothing here
 * hand-builds a `TelemetryEvent`: the type is branded with `emitTelemetry` as
 * its only mint site, so a hand-built one is not merely discouraged, it does
 * not typecheck. What these literals stand in for is the ledger — and the
 * causal half of this packet's evidence, where the events come out of a real
 * one, lives in the gateway's telemetry drill, which is the only place in this
 * repository where the real emitters, a real ledger and this package can meet.
 */
export type ProjectableEvents = Parameters<typeof emitTelemetry>[0];
type ProjectableEvent = ProjectableEvents[number];

/**
 * The contract version the fixtures declare.
 *
 * A literal, and it has to be: reading it from `@acp/contracts` is exactly the
 * import this package may not make.
 *
 * **It stays at `"2.2.0"` across the bumps to `"2.3.0"`** (P-18/protocolo C,
 * ADR 0076), **to `"2.4.0"`** (P-18/protocolo F, ADR 0078), **to `"2.5.0"`**
 * (P-36/local D, ADR 0084) **and to `"2.6.0"`** (P-32/captura B, ADR 0089), and that is the
 * mechanism working rather than a fixture nobody updated. These fixtures are *stored history*: what reads them is
 * `ControlPlaneEvent`, which admits `SUPPORTED_CONTRACT_VERSIONS`, and a set
 * that stopped admitting `"2.2.0"` would make every event any earlier build
 * recorded unreadable. The issuer's rule — only the version in force is
 * emitted — governs `AdmittedContractVersion` and the ledger's append door, and
 * neither is what these fixtures exercise.
 *
 * An earlier note here claimed a bump upstream would turn this into a compile
 * error. That was true while the contract answered reading and writing with one
 * `z.literal`; it is not true now, and the note is corrected rather than left
 * to be believed.
 */
const FIXTURE_CONTRACT_VERSION = "2.2.0";

const FIXTURE_TASK_ID = "5f5f5f5f-5f5f-4f5f-8f5f-5f5f5f5f5f01";
const FIXTURE_TRACE_UUID = "5f5f5f5f-5f5f-4f5f-8f5f-5f5f5f5f5faa";
const FIXTURE_ROOT_EVENT_ID = "11111111-1111-4111-8111-111111111111";
const FIXTURE_CHILD_EVENT_ID = "22222222-2222-4222-8222-222222222222";
const FIXTURE_IDENTITY = "claude/opus/implementer/01";

/**
 * A root and the event it caused, in one correlation.
 *
 * More than one span, and more than one attribute per span, deliberately: a
 * determinism assertion over a one-row table is vacuous, and so is an encoding
 * assertion that only ever saw a string.
 *
 * The child is a `TOKEN_USAGE_RECORDED` carrying `tokens`, which is the one
 * event type whose count is promoted — so the integer branch of the value
 * encoding is driven by the rule that really promotes it rather than by a
 * number pushed into an arbitrary key.
 */
const FIXTURE_ROOT: ProjectableEvent = {
  contractVersion: FIXTURE_CONTRACT_VERSION,
  eventId: FIXTURE_ROOT_EVENT_ID,
  taskId: FIXTURE_TASK_ID,
  attempt: 1,
  transitionId: "run.started",
  idempotencyKey: FIXTURE_TASK_ID + "/1/run.started",
  type: "RUN_STARTED",
  fromState: "RESERVED",
  toState: "RUNNING",
  emittedBy: FIXTURE_IDENTITY,
  occurredAt: "2026-09-06T09:00:00.000Z",
  recordedAt: "2026-09-06T09:00:00.250Z",
  correlationId: FIXTURE_TRACE_UUID,
  causationId: null,
  payload: {
    route: {
      provider: "claude",
      model: "opus",
      accountId: "acct-fixture-a",
      transportKind: "CLI_SUBSCRIPTION",
      capabilityPolicyVersion: "2026-08-30.1",
      resolvedAt: "2026-09-06T09:00:00.000Z",
    },
  },
};

/**
 * A root and the event it caused, in one correlation.
 *
 * More than one span, and more than one attribute per span, deliberately: a
 * determinism assertion over a one-row table is vacuous, and so is an encoding
 * assertion that only ever saw a string.
 *
 * The child is a `TOKEN_USAGE_RECORDED` carrying `tokens`, which is the one
 * event type whose count is promoted -- so the integer branch of the value
 * encoding is driven by the rule that really promotes it rather than by a
 * number pushed into an arbitrary key.
 */
export const ROOT_AND_CHILD: ProjectableEvents = [
  FIXTURE_ROOT,
  {
    contractVersion: FIXTURE_CONTRACT_VERSION,
    eventId: FIXTURE_CHILD_EVENT_ID,
    taskId: FIXTURE_TASK_ID,
    attempt: 1,
    transitionId: "usage.fixture.01",
    idempotencyKey: FIXTURE_TASK_ID + "/1/usage.fixture.01",
    type: "TOKEN_USAGE_RECORDED",
    fromState: "RUNNING",
    toState: "RUNNING",
    emittedBy: FIXTURE_IDENTITY,
    occurredAt: "2026-09-06T09:00:01.000Z",
    recordedAt: "2026-09-06T09:00:01.500Z",
    correlationId: FIXTURE_TRACE_UUID,
    causationId: FIXTURE_ROOT_EVENT_ID,
    payload: { accountId: "acct-fixture-a", tokens: 4_321 },
  },
];

/** The root's own ids, for a suite that asserts a fold rather than recalls it. */
export const FIXTURE_IDS = {
  correlationId: FIXTURE_TRACE_UUID,
  rootEventId: FIXTURE_ROOT_EVENT_ID,
  childEventId: FIXTURE_CHILD_EVENT_ID,
} as const;

/** One event whose correlation is null, so it folds to no span context at all. */
export const CONTEXTLESS: ProjectableEvents = [
  {
    ...FIXTURE_ROOT,
    eventId: "44444444-4444-4444-8444-444444444444",
    transitionId: "contextless.fixture.01",
    idempotencyKey: FIXTURE_TASK_ID + "/1/contextless.fixture.01",
    correlationId: null,
  },
];

/**
 * One event whose instants carry microseconds.
 *
 * `Date.parse` truncates to milliseconds, so this is the fixture that tells a
 * truncating implementation apart from a preserving one.
 */
export const SUB_MILLISECOND: ProjectableEvents = [
  {
    ...FIXTURE_ROOT,
    occurredAt: "2026-09-06T09:00:00.123456Z",
    recordedAt: "2026-09-06T09:00:00.123456789Z",
  },
];

/**
 * One event whose instants do not parse as timestamps.
 *
 * The contract would refuse this row; the projection's signature would not, and
 * that gap is precisely where a `NaN` reaches the wire if nobody counts it.
 */
export const UNPARSEABLE_INSTANT: ProjectableEvents = [
  { ...FIXTURE_ROOT, occurredAt: "not-an-instant" },
];

/**
 * One event carrying an attribute far past the body ceiling.
 *
 * `initiativeId` is on the projection's payload allowlist, so the weight really
 * travels as an attribute rather than being dropped on the way out. Built here,
 * once, so the two suites that need it agree on what "too large" means.
 */
export function overCeiling(bytes: number): ProjectableEvents {
  return [{ ...FIXTURE_ROOT, payload: { initiativeId: "x".repeat(bytes) } }];
}

/**
 * One event whose promoted payload keys carry a boolean and a non-integer.
 *
 * The projection's allowlist promotes `provider` and `accountId` by name and
 * admits any string, number or boolean under them, so these are values the real
 * fold really produces — not shapes invented to exercise a branch. Without
 * them the serializer would only ever have been driven over strings and
 * integers, which is not the type it accepts.
 */
export const MIXED_ATTRIBUTE_TYPES: ProjectableEvents = [
  {
    ...FIXTURE_ROOT,
    eventId: "33333333-3333-4333-8333-333333333333",
    transitionId: "pressure.fixture.01",
    idempotencyKey: FIXTURE_TASK_ID + "/1/pressure.fixture.01",
    type: "QUOTA_WARNING",
    payload: { provider: true, accountId: 1.5 },
  },
];

/**
 * The same chain with a credential planted on the root's payload.
 *
 * The refusal is the REAL gate's: `emitTelemetry` runs the credential guard on
 * the raw payload before anything is shaped, so this fixture exercises what a
 * consumer of a batch with a refusal actually sees — a count, and no
 * coordinates. Built here so the port suite asserts against the projection
 * rather than against its own idea of one.
 */
export const CREDENTIAL_REFUSED: ProjectableEvents = [
  { ...FIXTURE_ROOT, payload: { apiKey: "sk-" + "a".repeat(32) } },
  ...ROOT_AND_CHILD.slice(1),
];
