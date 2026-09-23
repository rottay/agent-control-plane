import {
  ExecutionEvent,
  ExecutionRequest,
  PROVIDER_PRESSURES,
  ResolvedRoute,
  findCredentialViolations,
} from "@acp/contracts";
import type {
  ExecutionOutputSink,
  ExecutionRefusal,
  ExecutionRefused,
  ExecutionSession,
  HealthProbe,
  ModelExecutionPort,
} from "@acp/contracts";

import type {
  AdmittedBinary,
  AdmittedConfigRoot,
  AdmittedWorkdir,
  ProviderAdapter,
  ProviderPressure,
  SessionLimits,
  SessionRequest,
} from "../contract/index.js";
import { AdapterError } from "../errors/index.js";
import type { NormalizedEvent } from "../events/index.js";
import type { ApiKeyBinding } from "../api-key/index.js";
import { API_TRANSPORT_KIND, admitApiRoute, apiExecutionEvents } from "../api-key/index.js";
import type { LocalBinding } from "../local/index.js";
import { LOCAL_TRANSPORT_KIND, admitLocalRoute, localExecutionEvents } from "../local/index.js";
import type { AgentHarness, HarnessEntry } from "../harness/index.js";
import { createAgentHarness } from "../harness/index.js";
import type { AdapterSession } from "../session/index.js";
import { startSession } from "../session/index.js";

/**
 * The owned execution boundary, and the transports bound to it.
 *
 * `ModelExecutionPort` is the contract every transport implements. This module
 * is the one factory that builds it: `CLI_SUBSCRIPTION` over the landed
 * session machinery, `API_KEY` over an injected streaming client, and
 * `LOCAL_OR_SELF_HOSTED` over an injected client of the same shape bound to a
 * local or self-hosted server instead. It adds no authority of its own —
 * routing, quota, leases and evidence stay with the control plane — and turns
 * a route into an execution and an execution's output into normalized events,
 * in that order and nothing else.
 *
 * **One factory, not one per transport.** A second factory would let a caller
 * hold a port that silently serves only some of the routes it is handed, and
 * the legs would drift on exactly the laws they are supposed to share: the
 * terminal shape of a stream, the refusal vocabulary, the session naming.
 * Those laws are written once here and applied to every leg.
 *
 * **The API and local transports are optional at construction, and that is
 * law 6.** The CLI binding is always present; `apiBindings` and
 * `localBindings` may each be absent entirely, and a port built without one
 * serves the routes it does have exactly as before and refuses the missing
 * kind with a classified reason. So subscription operation does not depend on
 * an API key, an AI Gateway, a paid API account or a local server — by
 * construction, not by assertion.
 *
 * **The transport is a wall, not a preference.** `start` executes the
 * transport the route names or refuses. It never downgrades an API route to a
 * CLI one, never substitutes a provider, and never starts a fresh execution
 * when a caller asked to reattach. Each of those would be a silent success in
 * a place where the caller believes something else happened.
 *
 * **A live execution is owned, and owning it makes two answers possible that
 * were not (V2-B4a).** The CLI leg registers every child it spawns with an
 * `AgentHarness` under the durable execution name, and the entry outlives the
 * *stream* — so a caller that stops reading no longer strands a running child
 * that nothing can name, interrupt or reap. On that foundation the leg can
 * grant a reattach that rejoins the live session with no second spawn, and
 * must refuse a plain start that names an execution already in flight
 * (`EXECUTION_IN_FLIGHT`). Both are refusals of the same silence: one caller
 * believing it reattached when it started fresh, another believing it started
 * fresh when it reattached.
 *
 * **What is still refused, and will be until a durable boundary exists.**
 * Reattach is *live and in-process only*. A provider child does outlive the
 * daemon on POSIX, but its pipes do not: `spawnAdmitted` gives the child's
 * stdio to this process, so a new process cannot re-open the stream, cannot
 * re-derive the `ParseCursor`, and cannot recover what was emitted in between.
 * The one "resume" the adapters have is `claude --resume`, which is a fresh
 * spawn — precisely the second execution this boundary exists to prevent —
 * and `RESUME` is `UNKNOWN` under the capability law, so no drill here could
 * confirm it. Cross-process reattach therefore stays `REATTACH_UNAVAILABLE`,
 * and ADR 0019 names what would have to exist first.
 *
 * **Where the admitted values come from.** The binary, the configuration root,
 * the working directory and the session budgets are *not* fields of
 * `ExecutionRequest`, and this module does not add a parallel request type to
 * smuggle them in. They arrive at binding time — one `CliBinding` per
 * `accountId`, built by whoever admitted them — because they are facts about
 * an account's installed transport, not about a task. The contract's request
 * stays strict and transport-neutral, which is what lets P8-3's API transport
 * implement the same boundary without inheriting a CLI's vocabulary.
 *
 * **What this transport cannot say.** Two limits are properties of the landed
 * CLI machinery rather than choices made here, and both are asserted in the
 * conformance fixture rather than left as prose:
 *
 * 1. **`write` never reaches this boundary.** The adapters' normalization maps
 *    a write-class signal to nothing at all: for a reviewer identity the
 *    session is killed on it, and for a writer identity it is dropped before
 *    normalization. So a CLI execution emits no `write` event — not because
 *    the port filters one, but because it is never handed one. The contract's
 *    `write` kind is reachable by other transports; on this one it is a gap,
 *    reported rather than papered over.
 * 2. **Three facts, synthesized here and never fused** (P-07 escalón C, ADR
 *    0099). `completed` is transport success and nothing more: no CLI provider
 *    signal carries completion, so a session reaching `CLOSED` cleanly emits
 *    exactly one, carrying the last `stepIndex` the stream reported; a session
 *    that ends in `FAILED` emits `error` instead, and never both. Before that one
 *    terminal come, in this order and only when observed, `processExited` — how
 *    the child ended, including the ladder's own SIGKILL on a failed session —
 *    and `operationResult` — what the operation said. Absent means not
 *    observable: never exit 0, never success.
 */

/** The admitted transport values for one account. */
export interface CliBinding {
  /** The provider adapter this account's transport speaks. */
  readonly adapter: ProviderAdapter;
  readonly binary: AdmittedBinary;
  readonly configRoot: AdmittedConfigRoot;
  readonly workdir: AdmittedWorkdir;
  /** Budgets belong to the transport that owns them, never to the request. */
  readonly limits: SessionLimits;
}

export interface ExecutionPortInput {
  /**
   * The CLI subscription bindings: one per `accountId`, resolved at
   * construction.
   *
   * A route naming an account with no binding is refused rather than served
   * from a default: a default binary is how one account's subscription
   * quietly spends another's quota.
   */
  readonly bindings: ReadonlyMap<string, CliBinding>;
  /**
   * The API_KEY bindings, when this port serves that transport at all.
   *
   * Optional, and its absence is meaningful rather than empty: a port built
   * without it does not have the API transport, and says so with
   * `TRANSPORT_UNAVAILABLE` at `route.transportKind` — the same answer it
   * gives for a transport nobody has implemented. An empty map is the
   * different statement "this port serves API routes, for no account yet".
   */
  readonly apiBindings?: ReadonlyMap<string, ApiKeyBinding>;
  /**
   * The LOCAL_OR_SELF_HOSTED bindings, when this port serves that transport
   * at all.
   *
   * Optional in exactly the same sense and for exactly the same reason as
   * `apiBindings`: absence means this port does not have the local transport,
   * not that it has one nobody has configured yet.
   */
  readonly localBindings?: ReadonlyMap<string, LocalBinding>;
  /**
   * The owned session lifecycle (V2-B4a).
   *
   * Optional for the same reason and with the same safeguard as
   * `recordUsage?` on `ExecutionEffectsInput`: every existing construction
   * site — the two drill children, the daemon suites, this package's own —
   * keeps compiling untouched, and the optionality is made safe by a fence law
   * (L-B4A-2) asserting the production daemon passes one, not by hope.
   *
   * Absent is not "no lifecycle". The port builds a private harness and
   * behaves exactly as it does with an injected one; what the caller gives up
   * is the ability to reap the children at its own unwind, which is precisely
   * what the daemon needs and a test usually does not.
   */
  readonly harness?: AgentHarness | undefined;
}

/** The subscription-CLI transport kind, served over the session machinery. */
export const CLI_TRANSPORT_KIND = "CLI_SUBSCRIPTION";

function refuse(refusal: ExecutionRefusal, at: string): ExecutionRefused {
  return Object.freeze({ ok: false as const, refusal, at });
}

/**
 * What the API and local legs refuse before they build a client request
 * (P-06/CORR, ADR 0096), or null when the request can be carried.
 *
 * Those legs hand their client one string, so they can carry text and nothing
 * else: a request naming any other class is refused rather than sent without
 * the part the leg cannot express. And the instruction crosses to the client,
 * so it gets the scan the CLI session runs before it writes one to a
 * child (`startSession`): a credential-shaped instruction is refused here, not
 * sent. Both answer with `TRANSPORT_UNAVAILABLE`, the member the CLI leg returns
 * for the same two conditions, and `at` names the field, on the port's
 * `request.reattach` convention. One helper for both legs, so it is one rule.
 */
function refuseUncarriable(asked: ExecutionRequest): ExecutionRefused | null {
  if (asked.modalities.some((kind) => kind !== "text")) {
    return refuse("TRANSPORT_UNAVAILABLE", "request.modalities");
  }
  // Scanned as an object, as `startSession` scans it: the guard's value scan is
  // what must run over the content.
  if (findCredentialViolations({ instructions: asked.instructions }).length > 0) {
    return refuse("TRANSPORT_UNAVAILABLE", "request.instructions");
  }
  return null;
}

/** The first failing field of a parse, as a stable name for `at`. */
function firstPath(error: { readonly issues: readonly { readonly path: readonly PropertyKey[] }[] }): string {
  const issue = error.issues[0];
  if (issue === undefined || issue.path.length === 0) return "(root)";
  return issue.path.map((segment) => String(segment)).join(".");
}

/**
 * A durable name for one execution, whichever transport runs it.
 *
 * Derived from the coordinates the caller already holds, never minted from a
 * clock or a random source, so the same task and attempt on the same account
 * name the same execution on every run — which is the only way a later
 * `reattach` reference could ever mean anything. Shared across transports on
 * purpose: moving a route from CLI to API must preserve the task's identity,
 * and two naming schemes could not.
 */
export function executionSessionId(taskId: string, attempt: number, accountId: string): string {
  return taskId + "/" + String(attempt) + "/" + accountId;
}

type Mapping =
  | { readonly kind: "EVENT"; readonly event: ExecutionEvent }
  /** The landed normalization cannot produce this name; there is nothing to say. */
  | { readonly kind: "SILENT" }
  | { readonly kind: "UNEXPRESSIBLE"; readonly detail: string };

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The keys of one usage report, every one required, in the port member's order. */
const USAGE_REPORT_KEYS = [
  "stepIndex",
  "inputTokens",
  "outputTokens",
  "cacheWriteTokens",
  "cacheReadTokens",
  "totalTokens",
  "reportKind",
  "isFinal",
  "sourceObservationId",
] as const;

/**
 * The classified member, or nothing.
 *
 * Checked against the contract's own list rather than against a copy, so a
 * payload string the vocabulary does not contain is `UNEXPRESSIBLE` at the
 * boundary instead of a pressure nobody classified.
 */
function pressureOf(value: unknown): ProviderPressure | null {
  return typeof value === "string" &&
    (PROVIDER_PRESSURES as readonly string[]).includes(value)
    ? (value as ProviderPressure)
    : null;
}

/**
 * Turn one normalized adapter event into one execution event.
 *
 * The payload arrives already bounded and redacted, which means a field can be
 * *absent* — dropped by the privacy shaping — where the contract requires one.
 * That is `UNEXPRESSIBLE`, and it ends the stream with a classified error
 * rather than yielding a half-built event or quietly skipping it. A caller
 * that reads a trail must be able to trust that nothing was silently removed
 * from it.
 */
export function toExecutionEvent(normalized: NormalizedEvent, route: ResolvedRoute): Mapping {
  const payload = normalized.payload;
  switch (normalized.name) {
    case "session.started": {
      const resolvedModel = text(payload["resolvedModel"]);
      const protocolVersion = text(payload["protocolVersion"]);
      if (resolvedModel === null || protocolVersion === null) {
        return { kind: "UNEXPRESSIBLE", detail: "session.started lost resolvedModel or protocolVersion" };
      }
      // The route is echoed and `resolvedModel` is carried verbatim. The port
      // never rewrites one to match the other: they legitimately differ (the
      // route names the routing alias, the provider names what it bound), and
      // the difference is the evidence that no adapter substituted a model.
      return { kind: "EVENT", event: { kind: "started", route, resolvedModel, protocolVersion } };
    }
    case "step.completed": {
      // The usage report, field for field, held to the port's own member: every key
      // present, a class a count or `null` (UNKNOWN), never a 0 read into an absent
      // or malformed one (P-15/D2, ADR 0105). A report the member refuses is not
      // expressible, and is said so rather than carried.
      const candidate: Record<string, unknown> = { kind: "usage" };
      for (const key of USAGE_REPORT_KEYS) {
        if (!(key in payload)) {
          return { kind: "UNEXPRESSIBLE", detail: "step.completed lost " + key };
        }
        candidate[key] = payload[key];
      }
      const report = ExecutionEvent.safeParse(candidate);
      if (!report.success || report.data.kind !== "usage") {
        return { kind: "UNEXPRESSIBLE", detail: "step.completed carries a usage report the port refuses" };
      }
      return { kind: "EVENT", event: report.data };
    }
    case "checkpoint.emitted": {
      const digest = text(payload["digest"]);
      if (digest === null) return { kind: "UNEXPRESSIBLE", detail: "checkpoint.emitted lost digest" };
      return { kind: "EVENT", event: { kind: "checkpoint", digest } };
    }
    case "auth.required": {
      const reason = text(payload["reason"]);
      if (reason === null) return { kind: "UNEXPRESSIBLE", detail: "auth.required lost reason" };
      return { kind: "EVENT", event: { kind: "authRequired", reason } };
    }
    case "provider.state": {
      const toState = text(payload["toState"]);
      if (toState === null) return { kind: "UNEXPRESSIBLE", detail: "provider.state lost toState" };
      return { kind: "EVENT", event: { kind: "state", toState } };
    }
    case "quota.pressure": {
      const pressure = pressureOf(payload["pressure"]);
      if (pressure === null) {
        return { kind: "UNEXPRESSIBLE", detail: "quota.pressure lost pressure" };
      }
      // The provider is the normalizing adapter's own — the one whose parser
      // classified the frame — carried rather than re-derived from the route.
      // Post provider-per-binding the two cannot differ for a session that
      // opened, because `startExecution` refuses ROUTE_INVALID at
      // `route.provider` before `startSession`; carrying it keeps the
      // provenance with the classification instead of taking a second reading
      // at another layer.
      return {
        kind: "EVENT",
        event: { kind: "pressure", provider: normalized.provider, pressure },
      };
    }
    case "session.interrupted":
    case "session.failed":
      // Named in the normalized taxonomy, but `toNormalized` returns neither:
      // no provider signal maps to them. Writing a normalization for a stream
      // that cannot occur would be inventing behaviour and testing the
      // invention, so the port says nothing until something can produce them.
      return { kind: "SILENT" };
  }
}

/**
 * Why an execution ended badly, as one of the four names the contract allows.
 *
 * The closed vocabulary has no member for "the transport produced something
 * this boundary could not normalize", and `TRANSPORT_UNAVAILABLE` is the only
 * one of the four that is true of it: the transport did not serve this route
 * to completion. The narrower cause travels in `detail`, which is our own
 * classified text and never provider output.
 */
const STREAM_FAILURE: ExecutionRefusal = "TRANSPORT_UNAVAILABLE";

function errorEvent(detail: string): ExecutionEvent {
  return { kind: "error", refusal: STREAM_FAILURE, detail: detail.slice(0, 400) };
}

/**
 * The terminal law, written once and applied to every transport.
 *
 * A stream ends in exactly one of two ways: `completed`, carrying the last
 * `stepIndex` the transport reported so usage can be reconciled against it, or
 * `error`, carrying a classified refusal. Never both, never neither.
 *
 * No CLI or API signal carries completion, so the boundary synthesizes it —
 * which is precisely why it has to be synthesized in one place. Two transports
 * each deciding when a stream was "done" is two definitions of done, and the
 * one that drifts is the one nobody is reading.
 *
 * `inner` reports failure by throwing; `finish` reports a failure the iteration
 * itself could not see, because a CLI session records its own death in its
 * state rather than by raising.
 */
/**
 * An in-stream failure that carries its own classified detail.
 *
 * `AdapterError` classifies by code, which is right for the machinery's own
 * refusals; this carries the sentence for the cases where the code alone would
 * not tell a reader which field went missing.
 */
class StreamFailure extends Error {}

/**
 * `seed` is the last step the **execution** reported before this stream
 * existed (V2-B4a).
 *
 * A per-generator counter starting at zero was right while a stream and an
 * execution were the same thing. They are not any more: a reattached stream
 * drains the rest of an execution whose earlier steps were delivered to an
 * abandoned one, and a `completed` carrying `0` would make the contract's "the
 * last step the transport reported, for reconciliation against usage" false on
 * exactly the path this packet adds. The CLI leg passes the entry's running
 * value; the API and local legs pass nothing, because neither can reattach.
 */
/**
 * What a transport knows once its stream has ended (P-07 escalón C, ADR 0099):
 * the failure it could not raise, how its process ended when it owns one, and
 * what the operation said when it said anything. `null` is "not observed", never
 * a default.
 */
interface StreamEnd {
  readonly failure: string | null;
  readonly exit: { readonly exitCode: number | null; readonly signal: string | null } | null;
  readonly operation: "SUCCEEDED" | "FAILED" | null;
}

/** The end of a stream whose transport owns no process and reports nothing more. */
const NOTHING_MORE: StreamEnd = Object.freeze({ failure: null, exit: null, operation: null });

async function* terminated(
  inner: AsyncIterable<ExecutionEvent>,
  finish: () => Promise<StreamEnd>,
  seed = 0,
): AsyncIterable<ExecutionEvent> {
  let lastStepIndex = seed;
  // An operation fact the transport reported in-stream is held, not yielded, so
  // it is emitted in the fixed order — after the process fact, before the one
  // terminal — and at most once.
  let reported: "SUCCEEDED" | "FAILED" | null = null;
  try {
    for await (const event of inner) {
      if (event.kind === "usage") lastStepIndex = event.stepIndex;
      if (event.kind === "operationResult") {
        if (reported !== null) throw new StreamFailure("the operation reported its outcome twice");
        reported = event.status;
        continue;
      }
      yield event;
    }
  } catch (error: unknown) {
    // No `processExited` on this path: the stream failed before its process
    // was observed to end, and an absent exit is NOT_OBSERVABLE, never 0.
    if (error instanceof StreamFailure) {
      yield errorEvent(error.message);
      return;
    }
    yield errorEvent(error instanceof AdapterError ? error.code : "UNCLASSIFIED");
    return;
  }

  const end = await finish();
  if (end.exit !== null) {
    yield { kind: "processExited", exitCode: end.exit.exitCode, signal: end.exit.signal };
  }
  if (end.failure !== null) {
    yield errorEvent(end.failure);
    return;
  }
  if (reported !== null && end.operation !== null) {
    yield errorEvent("the operation reported its outcome twice");
    return;
  }
  const operation = reported ?? end.operation;
  if (operation !== null) yield { kind: "operationResult", status: operation };
  yield { kind: "completed", stepIndex: lastStepIndex };
}

/**
 * Build the execution port.
 *
 * The returned object is the whole surface. The CLI sessions it starts are
 * owned by an `AgentHarness` under their durable execution name, and the
 * entry's lifetime is the **session's**, not the stream's: it is released when
 * the session reaches `CLOSED` or `FAILED`, so a stream that is abandoned
 * leaves a child that is still named, still rejoinable through `reattach`,
 * still reachable by `interrupt`, and still reaped by the owner's `closeAll`
 * at unwind. A plain start naming a live execution is refused rather than
 * doubling it.
 */
export function createExecutionPort(input: ExecutionPortInput): ModelExecutionPort {
  const bindings = input.bindings;
  const apiBindings = input.apiBindings;
  const localBindings = input.localBindings;
  // The one live-session registry (L-B4A-1). The port holds no second map of
  // its own: two registries are two answers to "is this child still ours", and
  // the answer that loses is the one holding a process nobody reaps.
  const harness = input.harness ?? createAgentHarness();

  /** The CLI leg's mapping. Throws on anything it cannot express. */
  async function* cliEvents(
    session: AdapterSession,
    route: ResolvedRoute,
    entry: HarnessEntry,
  ): AsyncIterable<ExecutionEvent> {
    for await (const normalized of session.events()) {
      const mapped = toExecutionEvent(normalized, route);
      if (mapped.kind === "SILENT") continue;
      if (mapped.kind === "UNEXPRESSIBLE") throw new StreamFailure(mapped.detail);
      const parsed = ExecutionEvent.safeParse(mapped.event);
      if (!parsed.success) {
        // The boundary emits contract-valid events or it emits an error. A
        // provider whose digest is not a digest does not get to put a
        // malformed event into the control plane's evidence.
        throw new StreamFailure(normalized.name + " failed the contract at " + firstPath(parsed.error));
      }
      // The execution's running step, kept on the entry rather than in this
      // generator, so a stream that reattaches later can seed itself from what
      // the execution already reported instead of from zero.
      if (parsed.data.kind === "usage") entry.lastStepIndex = parsed.data.stepIndex;
      yield parsed.data;
    }
  }

  /**
   * Drain one CLI session, under the lifetime law (V2-B4a).
   *
   * The change from B1b is which object's death ends the registry entry. It
   * used to be this generator's: the `finally` deleted the session by name,
   * so a caller that stopped reading left a running provider child nothing
   * could name, interrupt or reap. ADR 0010 already said abandoning the
   * iteration is not cancellation; deleting the only handle to the child was
   * the operational consequence of pretending otherwise.
   *
   * Now the entry's lifetime is the **session's**. The `finally` records only
   * that nobody is draining any more; the entry is released when the session
   * actually reaches a terminal state, which is what `finish` observes. An
   * abandoned stream therefore leaves an entry that is live, named,
   * reattachable and interruptible — and `closeAll` reaps it at unwind, so the
   * invisible leak is not traded for a visible one.
   */
  async function* cliStream(
    session: AdapterSession,
    route: ResolvedRoute,
    sessionId: string,
    entry: HarnessEntry,
  ): AsyncIterable<ExecutionEvent> {
    const finish = async (): Promise<StreamEnd> => {
      if (session.state === "FAILED") {
        // The session tore its own child down; wait for that to finish before
        // reporting, so a caller that stops reading here is not racing a kill.
        // The exit is then the ladder's own SIGKILL, or the child's own status
        // when it had already ended. A failed session's verdict is not reported:
        // the session did not end in a state that vouches for it.
        await session.settled();
        harness.release(sessionId);
        return {
          failure: "session failed: " + (session.health().classifiedError ?? "UNCLASSIFIED"),
          exit: session.exit(),
          operation: null,
        };
      }
      await session.close();
      harness.release(sessionId);
      return { failure: null, exit: session.exit(), operation: session.operation() };
    };
    try {
      yield* terminated(cliEvents(session, route, entry), finish, entry.lastStepIndex);
    } finally {
      // Only that this stream is over. Whether the *session* is over is
      // `finish`'s question, and an abandoned iteration never asks it.
      entry.attached = false;
    }
  }

  return {
    // `async` with nothing awaited, deliberately: the contract declares these
    // as promise-returning because other transports will need to be, and a
    // method that returned a bare value on one transport and a promise on
    // another would make every caller write two paths. It also makes a throw a
    // rejection rather than a synchronous blow-up mid-await-chain.
    // eslint-disable-next-line @typescript-eslint/require-await
    async start(
      route: ResolvedRoute,
      request: ExecutionRequest,
      sink?: ExecutionOutputSink,
    ): Promise<ExecutionSession | ExecutionRefused> {
      const parsedRoute = ResolvedRoute.safeParse(route);
      if (!parsedRoute.success) return refuse("ROUTE_INVALID", "route." + firstPath(parsedRoute.error));
      const parsedRequest = ExecutionRequest.safeParse(request);
      if (!parsedRequest.success) {
        // Classified as the route being unexecutable rather than invented as a
        // fifth refusal name: the boundary was handed something it cannot run,
        // and `at` names the field so the caller is not left guessing.
        return refuse("ROUTE_INVALID", "request." + firstPath(parsedRequest.error));
      }
      const admitted = parsedRoute.data;
      const asked = parsedRequest.data;

      const sessionId = executionSessionId(asked.taskId, asked.attempt, admitted.accountId);

      // V2-B4a moved the reattach decision from here into each leg. It used to
      // be one global refusal before the dispatch, which was right while no
      // transport could rejoin anything. One now can, and a check that is
      // global cannot say "this leg can, that leg cannot" without becoming a
      // second dispatch. Each branch below therefore states its own refusal as
      // its first statement, and L-B4A-3 counts the three so a fourth leg
      // cannot be added that quietly forgets one. The observable precedence is
      // unchanged: the API and local legs still refuse a reattach before they
      // notice they have no binding at all.

      // Dispatched with a switch rather than a chain of `if`s so the
      // exhaustiveness is the compiler's to check. The alternative the auditor
      // weighed — a trailing `!==` guard — is provably dead code today: after
      // the two non-CLI cases return, TypeScript narrows `transportKind` to
      // the CLI literal, and lint rejects the comparison as always false. The
      // `never` default below is the same protection that survives being
      // right: add a fourth kind to the contract and the assignment stops
      // compiling, so it cannot fall through to a CLI spawn unnoticed.
      switch (admitted.transportKind) {
        case API_TRANSPORT_KIND: {
        // First statement of the block, before the binding is even consulted:
        // this transport cannot rejoin an execution, whatever else is true of
        // the route.
        if (asked.reattach !== null) return refuse("REATTACH_UNAVAILABLE", "request.reattach");
        if (apiBindings === undefined) {
          // Law 6, as a refusal rather than a promise: this port was built
          // without the API transport, so it does not have one. Nothing about
          // the CLI leg changes, which is the whole content of "subscription
          // operation does not depend on an API key".
          return refuse("TRANSPORT_UNAVAILABLE", "route.transportKind");
        }
        const admittedApi = admitApiRoute(admitted, apiBindings);
        if (!admittedApi.ok) return admittedApi;
        // After the route is admitted and before the client is touched: a
        // refusal here means zero client calls.
        const apiUncarriable = refuseUncarriable(asked);
        if (apiUncarriable !== null) return apiUncarriable;

        const apiRequest = {
          model: admitted.model,
          taskId: asked.taskId,
          attempt: asked.attempt,
          identity: asked.identity,
          instructions: asked.instructions,
        };
        return Object.freeze({
          ok: true as const,
          sessionId,
          route: admitted,
          events: (): AsyncIterable<ExecutionEvent> =>
            // The same terminal law as the CLI leg, applied to a different
            // producer. `finish` has nothing to add: an API stream that ended
            // without throwing ended cleanly.
            terminated(
              apiExecutionEvents(admittedApi.binding, admitted, apiRequest, sink),
              () => Promise.resolve(NOTHING_MORE),
            ),
        });
        }

        case LOCAL_TRANSPORT_KIND: {
        // The API leg's refusal, for the same reason: a local or self-hosted
        // server hands back no handle this port could rejoin.
        if (asked.reattach !== null) return refuse("REATTACH_UNAVAILABLE", "request.reattach");
        if (localBindings === undefined) {
          // The same law-6 refusal as the API leg, for the same reason: this
          // port was built without the local transport, so it does not have
          // one.
          return refuse("TRANSPORT_UNAVAILABLE", "route.transportKind");
        }
        const admittedLocal = admitLocalRoute(admitted, localBindings);
        if (!admittedLocal.ok) return admittedLocal;
        // The API leg's preflight, for the same reason and in the same place.
        const localUncarriable = refuseUncarriable(asked);
        if (localUncarriable !== null) return localUncarriable;

        const localRequest = {
          model: admitted.model,
          taskId: asked.taskId,
          attempt: asked.attempt,
          identity: asked.identity,
          instructions: asked.instructions,
        };
        return Object.freeze({
          ok: true as const,
          sessionId,
          route: admitted,
          events: (): AsyncIterable<ExecutionEvent> =>
            // The same terminal law again, applied to the local leg's
            // producer: a local stream that ended without throwing ended
            // cleanly, exactly like the API one.
            terminated(
              localExecutionEvents(admittedLocal.binding, admitted, localRequest, sink),
              () => Promise.resolve(NOTHING_MORE),
            ),
        });
        }

        case CLI_TRANSPORT_KIND:
          // Falls through to the CLI leg below, which is the rest of `start`.
          break;

        default: {
          // Unreachable while the contract names exactly these three kinds.
          // Typed `never`, so a fourth kind is a compile error here rather
          // than a silent fall-through — and still a classified refusal at
          // runtime if one ever arrives from a build that skipped the check.
          const unreachable: never = admitted.transportKind;
          return refuse("TRANSPORT_UNAVAILABLE", "route.transportKind/" + String(unreachable));
        }
      }

      // The CLI leg's own reattach decision, and the only grant in the port.
      //
      // Every condition below is a way the rejoin would hand a caller a child
      // that is not the one it asked for. They share **one** `at` string, on
      // purpose: the distinctions are ours, not the caller's, and a caller
      // that could tell "wrong identity" from "already attached" could branch
      // on a difference it has no lawful action for. What it can act on is
      // that this execution is not rejoinable, which is what it is told.
      const held = harness.lookup(sessionId);
      if (asked.reattach !== null) {
        const rejoinable =
          // A caller may not name another task's execution: the port holds no
          // authority to hand out somebody else's child.
          asked.reattach === sessionId &&
          held !== null &&
          // One queue, one reader. `Session.events()` shifts from a single
          // queue and a second concurrent reader starves the first, so a
          // second drain is refused rather than fanned out.
          !held.attached &&
          held.identity === asked.identity &&
          held.route.provider === admitted.provider &&
          held.route.model === admitted.model &&
          held.route.accountId === admitted.accountId &&
          held.route.transportKind === admitted.transportKind &&
          held.route.capabilityPolicyVersion === admitted.capabilityPolicyVersion &&
          held.route.resolvedAt === admitted.resolvedAt &&
          // The sink is bound when the child is spawned (P-07 escalón C, ADR 0099).
          // A rejoin asking for one would get only the tail of the output, and an
          // assembler fed a tail would build an incomplete result, so it is refused.
          sink === undefined;
        if (!rejoinable) return refuse("REATTACH_UNAVAILABLE", "request.reattach");

        // Granted. No binding lookup and no `startSession`: the child was
        // admitted when it was spawned, and requiring the binding again would
        // let a binding removed since orphan a live child. The route returned
        // is the entry's — the one the child is actually running — never the
        // caller's copy of it.
        const entry = held;
        return Object.freeze({
          ok: true as const,
          sessionId,
          route: entry.route,
          events: (): AsyncIterable<ExecutionEvent> => {
            entry.attached = true;
            return cliStream(entry.session, entry.route, sessionId, entry);
          },
        });
      }

      if (held !== null) {
        // The mirror of the silent restart, and refused for the same reason.
        // Spawning a second child under one name would double the execution
        // and lose the first; handing back the live one would be a silent
        // rejoin the caller never asked for. `at` names `request.reattach`
        // because that is the field that was wrong: it was null when it needed
        // to name the execution already in flight.
        return refuse("EXECUTION_IN_FLIGHT", "request.reattach");
      }

      const binding = bindings.get(admitted.accountId);
      if (binding === undefined) return refuse("TRANSPORT_UNAVAILABLE", "route.accountId");
      if (binding.adapter.provider !== admitted.provider) {
        return refuse("ROUTE_INVALID", "route.provider");
      }

      const sessionRequest: SessionRequest = {
        identity: asked.identity,
        taskId: asked.taskId,
        attempt: asked.attempt,
        modelAlias: admitted.model,
        binary: binding.binary,
        configRoot: binding.configRoot,
        workdir: binding.workdir,
        resumeSessionId: null,
        limits: binding.limits,
        // Carried through unchanged (V2-B1c). The port neither renders nor
        // bounds it: the value was bounded at `ExecutionRequest`, and a second
        // policy here could disagree with the first about what was asked.
        instructions: asked.instructions,
        // And the classes it was composed from, for the same reason and with the
        // same discipline: carried, never inspected (P-06/C). The port does not
        // decide what a transport can take — the adapter's `describe` does.
        modalities: asked.modalities,
      };

      let session: AdapterSession;
      try {
        session = startSession(binding.adapter, sessionRequest, sink);
      } catch (error: unknown) {
        // A refused spawn is a transport that cannot serve this route. The
        // adapter's own classified code travels in `at`; it is ours, not the
        // provider's output.
        const code = error instanceof AdapterError ? error.code : "UNCLASSIFIED";
        return refuse("TRANSPORT_UNAVAILABLE", "startSession/" + code);
      }

      harness.register(sessionId, { session, route: admitted, identity: asked.identity });
      const registered = harness.lookup(sessionId);
      if (registered === null) {
        // Unreachable: a session is `STARTING` the moment `startSession`
        // returns, and only `CLOSED`/`FAILED` read as absent. Typed as a
        // refusal rather than a non-null assertion, so a future lifetime rule
        // that made a fresh registration invisible would surface as a
        // classified answer instead of a crash mid-stream.
        return refuse("TRANSPORT_UNAVAILABLE", "harness.register");
      }
      const entry = registered;
      return Object.freeze({
        ok: true as const,
        sessionId,
        route: admitted,
        events: (): AsyncIterable<ExecutionEvent> => {
          entry.attached = true;
          return cliStream(session, admitted, sessionId, entry);
        },
      });
    },

    async interrupt(sessionId: string): Promise<void> {
      // Delegated whole to the harness, which is the one registry (L-B4A-1).
      // Idempotent, and structurally incapable of touching a foreign process:
      // it can only reach a session this port started and still owns — and
      // now it reaches one whose stream was abandoned, which is exactly the
      // child that used to become unnameable.
      await harness.interrupt(sessionId);
    },

    // Read-only by construction: this probe never spawns, so there is nothing
    // to await. See the note on `start` for why it stays promise-returning.
    // eslint-disable-next-line @typescript-eslint/require-await
    async healthProbe(route: ResolvedRoute): Promise<HealthProbe> {
      const parsed = ResolvedRoute.safeParse(route);
      // Event-supplied, never a clock read: a probe stamped with the current
      // time could not be compared against one taken yesterday.
      const checkedAt = parsed.success ? parsed.data.resolvedAt : "1970-01-01T00:00:00.000Z";
      const failed = (classifiedError: string): HealthProbe =>
        Object.freeze({ status: "FAILED" as const, checkedAt, latencyMs: null, classifiedError });

      if (!parsed.success) return failed("ROUTE_INVALID");

      // The same compiler-checked exhaustiveness as `start`: a fourth
      // transport kind breaks the `never` assignment rather than being
      // answered for out of the CLI leg's binding table.
      switch (parsed.data.transportKind) {
        case API_TRANSPORT_KIND: {
          if (apiBindings === undefined) return failed("TRANSPORT_UNAVAILABLE");
          const admittedApi = admitApiRoute(parsed.data, apiBindings);
          if (!admittedApi.ok) return failed(admittedApi.refusal);
          break;
        }
        case LOCAL_TRANSPORT_KIND: {
          if (localBindings === undefined) return failed("TRANSPORT_UNAVAILABLE");
          const admittedLocal = admitLocalRoute(parsed.data, localBindings);
          if (!admittedLocal.ok) return failed(admittedLocal.refusal);
          break;
        }
        case CLI_TRANSPORT_KIND: {
          const binding = bindings.get(parsed.data.accountId);
          if (binding === undefined) return failed("TRANSPORT_UNAVAILABLE");
          break;
        }
        default: {
          const unreachable: never = parsed.data.transportKind;
          return failed("TRANSPORT_UNAVAILABLE/" + String(unreachable));
        }
      }

      // A binding exists, and nothing was spawned to ask. `UNKNOWN` is the
      // honest answer: the probe is read-only by construction, and reporting
      // `OK` from the mere presence of a binding would be reporting the
      // configuration rather than the transport. A route names an account, not
      // an execution, so a live session is deliberately not consulted here —
      // one task's health is not the account's.
      return Object.freeze({
        status: "UNKNOWN" as const,
        checkedAt,
        latencyMs: null,
        classifiedError: null,
      });
    },
  };
}
