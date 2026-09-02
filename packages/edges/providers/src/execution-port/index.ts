import { ExecutionEvent, ExecutionRequest, ResolvedRoute } from "@acp/contracts";
import type {
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
  SessionLimits,
  SessionRequest,
} from "../contract/index.js";
import { AdapterError } from "../errors/index.js";
import type { NormalizedEvent } from "../events/index.js";
import type { ApiKeyBinding } from "../api-key/index.js";
import { API_TRANSPORT_KIND, admitApiRoute, apiExecutionEvents } from "../api-key/index.js";
import type { LocalBinding } from "../local/index.js";
import { LOCAL_TRANSPORT_KIND, admitLocalRoute, localExecutionEvents } from "../local/index.js";
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
 * 2. **`completed` is synthesized here, not reported.** No CLI provider signal
 *    carries completion. The port's law is that a session reaching `CLOSED`
 *    cleanly emits exactly one `completed`, carrying the last `stepIndex` the
 *    stream reported, so usage can be reconciled against it. A session that
 *    ends in `FAILED` emits `error` instead, and never both.
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
}

/** The subscription-CLI transport kind, served over the session machinery. */
export const CLI_TRANSPORT_KIND = "CLI_SUBSCRIPTION";

function refuse(refusal: ExecutionRefusal, at: string): ExecutionRefused {
  return Object.freeze({ ok: false as const, refusal, at });
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

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
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
      const stepIndex = count(payload["stepIndex"]);
      const tokensUsed = count(payload["tokensUsed"]);
      if (stepIndex === null || tokensUsed === null) {
        return { kind: "UNEXPRESSIBLE", detail: "step.completed lost stepIndex or tokensUsed" };
      }
      return { kind: "EVENT", event: { kind: "usage", stepIndex, tokensUsed } };
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

async function* terminated(
  inner: AsyncIterable<ExecutionEvent>,
  finish: () => Promise<string | null>,
): AsyncIterable<ExecutionEvent> {
  let lastStepIndex = 0;
  try {
    for await (const event of inner) {
      if (event.kind === "usage") lastStepIndex = event.stepIndex;
      yield event;
    }
  } catch (error: unknown) {
    if (error instanceof StreamFailure) {
      yield errorEvent(error.message);
      return;
    }
    yield errorEvent(error instanceof AdapterError ? error.code : "UNCLASSIFIED");
    return;
  }

  const failure = await finish();
  if (failure !== null) {
    yield errorEvent(failure);
    return;
  }
  yield { kind: "completed", stepIndex: lastStepIndex };
}

/**
 * Build the execution port.
 *
 * The returned object is the whole surface: the CLI sessions it starts are
 * held only so `interrupt` can find them, and each is forgotten as soon as its
 * stream ends.
 */
export function createExecutionPort(input: ExecutionPortInput): ModelExecutionPort {
  const bindings = input.bindings;
  const apiBindings = input.apiBindings;
  const localBindings = input.localBindings;
  const live = new Map<string, AdapterSession>();

  /** The CLI leg's mapping. Throws on anything it cannot express. */
  async function* cliEvents(session: AdapterSession, route: ResolvedRoute): AsyncIterable<ExecutionEvent> {
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
      yield parsed.data;
    }
  }

  async function* cliStream(
    session: AdapterSession,
    route: ResolvedRoute,
    sessionId: string,
  ): AsyncIterable<ExecutionEvent> {
    const finish = async (): Promise<string | null> => {
      if (session.state === "FAILED") {
        // The session tore its own child down; wait for that to finish before
        // reporting, so a caller that stops reading here is not racing a kill.
        await session.settled();
        return "session failed: " + (session.health().classifiedError ?? "UNCLASSIFIED");
      }
      await session.close();
      return null;
    };
    try {
      yield* terminated(cliEvents(session, route), finish);
    } finally {
      // However the stream ended — completed, failed, or abandoned by a caller
      // that stopped reading — the session stops being interruptible by name.
      live.delete(sessionId);
    }
  }

  return {
    // `async` with nothing awaited, deliberately: the contract declares these
    // as promise-returning because other transports will need to be, and a
    // method that returned a bare value on one transport and a promise on
    // another would make every caller write two paths. It also makes a throw a
    // rejection rather than a synchronous blow-up mid-await-chain.
    // eslint-disable-next-line @typescript-eslint/require-await
    async start(route: ResolvedRoute, request: ExecutionRequest): Promise<ExecutionSession | ExecutionRefused> {
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

      if (asked.reattach !== null) {
        // Neither landed transport can rejoin. Refusing is the contract's
        // stated law; starting a fresh execution while the caller believes it
        // reattached is the one failure this boundary must never produce, and
        // it is checked before the transports so no transport can forget it.
        return refuse("REATTACH_UNAVAILABLE", "request.reattach");
      }

      const sessionId = executionSessionId(asked.taskId, asked.attempt, admitted.accountId);

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
        if (apiBindings === undefined) {
          // Law 6, as a refusal rather than a promise: this port was built
          // without the API transport, so it does not have one. Nothing about
          // the CLI leg changes, which is the whole content of "subscription
          // operation does not depend on an API key".
          return refuse("TRANSPORT_UNAVAILABLE", "route.transportKind");
        }
        const admittedApi = admitApiRoute(admitted, apiBindings);
        if (!admittedApi.ok) return admittedApi;

        const apiRequest = {
          model: admitted.model,
          taskId: asked.taskId,
          attempt: asked.attempt,
          identity: asked.identity,
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
              apiExecutionEvents(admittedApi.binding, admitted, apiRequest),
              () => Promise.resolve(null),
            ),
        });
        }

        case LOCAL_TRANSPORT_KIND: {
        if (localBindings === undefined) {
          // The same law-6 refusal as the API leg, for the same reason: this
          // port was built without the local transport, so it does not have
          // one.
          return refuse("TRANSPORT_UNAVAILABLE", "route.transportKind");
        }
        const admittedLocal = admitLocalRoute(admitted, localBindings);
        if (!admittedLocal.ok) return admittedLocal;

        const localRequest = {
          model: admitted.model,
          taskId: asked.taskId,
          attempt: asked.attempt,
          identity: asked.identity,
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
              localExecutionEvents(admittedLocal.binding, admitted, localRequest),
              () => Promise.resolve(null),
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
      };

      let session: AdapterSession;
      try {
        session = startSession(binding.adapter, sessionRequest);
      } catch (error: unknown) {
        // A refused spawn is a transport that cannot serve this route. The
        // adapter's own classified code travels in `at`; it is ours, not the
        // provider's output.
        const code = error instanceof AdapterError ? error.code : "UNCLASSIFIED";
        return refuse("TRANSPORT_UNAVAILABLE", "startSession/" + code);
      }

      live.set(sessionId, session);
      return Object.freeze({
        ok: true as const,
        sessionId,
        route: admitted,
        events: (): AsyncIterable<ExecutionEvent> => cliStream(session, admitted, sessionId),
      });
    },

    async interrupt(sessionId: string): Promise<void> {
      const session = live.get(sessionId);
      // Idempotent, and structurally incapable of touching a foreign process:
      // the port can only interrupt a session it started and still holds.
      if (session === undefined) return;
      await session.interrupt();
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
