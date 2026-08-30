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
import type { AdapterSession } from "../session/index.js";
import { startSession } from "../session/index.js";

/**
 * The CLI subscription binding of the owned execution boundary.
 *
 * `ModelExecutionPort` is the contract every transport implements; this is the
 * implementation for the one transport that exists today, laid over the landed
 * session machinery. It adds no authority of its own: routing, quota, leases
 * and evidence stay with the control plane, and this module turns a route into
 * a process and provider bytes into normalized events, in that order and
 * nothing else.
 *
 * **The transport is a wall, not a preference.** `start` admits
 * `transportKind === "CLI_SUBSCRIPTION"` and refuses everything else with a
 * classified reason. It never downgrades an API route to a CLI one, never
 * substitutes a provider, and never starts a fresh execution when a caller
 * asked to reattach. Each of those would be a silent success in a place where
 * the caller believes something else happened.
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

export interface CliExecutionPortInput {
  /**
   * One binding per `accountId`, resolved at construction.
   *
   * A route naming an account with no binding is refused rather than served
   * from a default: a default binary is how one account's subscription
   * quietly spends another's quota.
   */
  readonly bindings: ReadonlyMap<string, CliBinding>;
}

/** The only transport kind this port serves. */
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
 * A durable name for one execution.
 *
 * Derived from the coordinates the caller already holds, never minted from a
 * clock or a random source, so the same task and attempt on the same account
 * name the same execution on every run — which is the only way a later
 * `reattach` reference could ever mean anything.
 */
export function cliSessionId(taskId: string, attempt: number, accountId: string): string {
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
 * Build the CLI subscription execution port.
 *
 * The returned object is the whole surface: the sessions it starts are held
 * only so `interrupt` can find them, and each is forgotten as soon as its
 * stream ends.
 */
export function createCliExecutionPort(input: CliExecutionPortInput): ModelExecutionPort {
  const bindings = input.bindings;
  const live = new Map<string, AdapterSession>();

  async function* stream(
    session: AdapterSession,
    route: ResolvedRoute,
    sessionId: string,
  ): AsyncIterable<ExecutionEvent> {
    let lastStepIndex = 0;
    try {
      for await (const normalized of session.events()) {
        const mapped = toExecutionEvent(normalized, route);
        if (mapped.kind === "SILENT") continue;
        if (mapped.kind === "UNEXPRESSIBLE") {
          yield errorEvent(mapped.detail);
          return;
        }
        const parsed = ExecutionEvent.safeParse(mapped.event);
        if (!parsed.success) {
          // The boundary emits contract-valid events or it emits an error. A
          // provider whose digest is not a digest does not get to put a
          // malformed event into the control plane's evidence.
          yield errorEvent(normalized.name + " failed the contract at " + firstPath(parsed.error));
          return;
        }
        if (parsed.data.kind === "usage") lastStepIndex = parsed.data.stepIndex;
        yield parsed.data;
      }

      if (session.state === "FAILED") {
        // The session tore its own child down; wait for that to finish before
        // reporting, so a caller that stops reading here is not racing a kill.
        await session.settled();
        yield errorEvent("session failed: " + (session.health().classifiedError ?? "UNCLASSIFIED"));
        return;
      }

      // The clean close, and the port's own law: reaching CLOSED without a
      // failure is what `completed` means on this transport.
      await session.close();
      yield { kind: "completed", stepIndex: lastStepIndex };
    } finally {
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

      if (admitted.transportKind !== CLI_TRANSPORT_KIND) {
        return refuse("TRANSPORT_UNAVAILABLE", "route.transportKind");
      }
      if (asked.reattach !== null) {
        // The landed CLI machinery has no rejoin. Refusing is the contract's
        // stated law; starting a fresh execution while the caller believes it
        // reattached is the one failure this boundary must never produce.
        return refuse("REATTACH_UNAVAILABLE", "request.reattach");
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

      const sessionId = cliSessionId(asked.taskId, asked.attempt, admitted.accountId);
      live.set(sessionId, session);
      return Object.freeze({
        ok: true as const,
        sessionId,
        route: admitted,
        events: (): AsyncIterable<ExecutionEvent> => stream(session, admitted, sessionId),
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
      if (parsed.data.transportKind !== CLI_TRANSPORT_KIND) return failed("TRANSPORT_UNAVAILABLE");
      const binding = bindings.get(parsed.data.accountId);
      if (binding === undefined) return failed("TRANSPORT_UNAVAILABLE");

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
