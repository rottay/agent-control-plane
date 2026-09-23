import { CLI_SUBSCRIPTION_PROVIDERS } from "@acp/contracts";
import type { ExecutionEvent, PROVIDER_PRESSURES, WorkerIdentityString } from "@acp/contracts";

import { AdapterError } from "../errors/index.js";

/**
 * The ports, the session state machine and the capability model.
 *
 * Nothing here performs I/O. A `ProviderAdapter` builds argv, reads a
 * handshake and turns bytes into events; it cannot spawn, cannot open a file
 * and cannot reach a ledger, because it is handed no means to. That is what
 * lets three providers share one process boundary without three chances to get
 * the boundary wrong.
 */

/**
 * The providers this package can speak to.
 *
 * Derived from `@acp/contracts` rather than declared here. There is one
 * canonical CLI provider vocabulary in the repository and it lives in the
 * package that imports nothing and that everything imports; an adapter's own
 * union restating it is a second list, and two lists drift. The direction is
 * the only lawful one — adapters already depend on contracts, and contracts
 * must never depend on adapters.
 */
export type ProviderName = (typeof CLI_SUBSCRIPTION_PROVIDERS)[number];

/**
 * What a provider said about the account's standing, classified.
 *
 * Derived from `@acp/contracts` for the reason `ProviderName` is, and spelled
 * here rather than exported from contracts as a companion type: the contract
 * owns one list, and each consumer names the union it needs from it. There is
 * no runtime copy of this one, because nothing in this package pins it as a
 * value — the classification tables are the only producers, and a test pins
 * each of them variant by variant.
 */
export type ProviderPressure = (typeof PROVIDER_PRESSURES)[number];

/**
 * The same vocabulary as a frozen runtime value.
 *
 * A copy of the canonical list, not a second declaration of it: the elements
 * and their order come from the contract, and a test pins the equality in both
 * directions so a name cannot be added or dropped on one side alone.
 */
export const PROVIDER_NAMES: readonly ProviderName[] = Object.freeze([
  ...CLI_SUBSCRIPTION_PROVIDERS,
]);

// ---------------------------------------------------------------------------
// Branded admissions
// ---------------------------------------------------------------------------

declare const binaryBrand: unique symbol;
declare const configRootBrand: unique symbol;
declare const workdirBrand: unique symbol;

/** An absolute, canonical, owner-checked regular file. Only `spawn/index.ts` mints it. */
export type AdmittedBinary = string & { readonly [binaryBrand]: true };

/** An admitted provider configuration root. Only `config-root/index.ts` mints it. */
export type AdmittedConfigRoot = string & { readonly [configRootBrand]: true };

/** An admitted working directory. Only `config-root/index.ts` mints it. */
export type AdmittedWorkdir = string & { readonly [workdirBrand]: true };

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type CapabilityState = "CONFIRMED" | "UNKNOWN" | "REFUSED";

export type CapabilityName =
  | "STREAMING"
  | "RESUME"
  | "MODEL_PIN"
  | "SESSION_ID"
  /** The provider's own cancel. NOT the signal floor, which is always present. */
  | "PROTOCOL_CANCEL";

export const CAPABILITY_NAMES: readonly CapabilityName[] = Object.freeze([
  "MODEL_PIN",
  "PROTOCOL_CANCEL",
  "RESUME",
  "SESSION_ID",
  "STREAMING",
]);

/**
 * Evidence carries its subject, and the subject is the whole point.
 *
 * A fake provider proves that *our* parser and session machinery work. It
 * proves nothing whatsoever about whether a real provider streams, resumes or
 * cancels. Without the subject field, "CONFIRMED requires evidence" is
 * satisfiable by evidence about ourselves — which is how a capability table
 * ends up describing the fixtures rather than the world.
 */
export type CapabilityEvidence =
  | { readonly kind: "PROTOCOL"; readonly detail: string }
  | { readonly kind: "RUNTIME"; readonly subject: "FAKE" | "REAL"; readonly detail: string }
  | { readonly kind: "NONE" };

export interface CapabilityRecord {
  readonly name: CapabilityName;
  readonly state: CapabilityState;
  readonly evidence: CapabilityEvidence;
}

/**
 * Is this evidence strong enough to confirm a provider capability?
 *
 * Protocol evidence, or a runtime drill against a real provider. Help text is
 * not evidence at all and never reaches this function; a fake-subject drill
 * reaches it and is refused.
 */
export function confirmsProviderCapability(evidence: CapabilityEvidence): boolean {
  if (evidence.kind === "PROTOCOL") return true;
  return evidence.kind === "RUNTIME" && evidence.subject === "REAL";
}

/**
 * Build a capability record, refusing a claim its evidence cannot support.
 *
 * Throws `CAPABILITY_UNPROVEN` rather than silently downgrading, because a
 * silently downgraded claim is indistinguishable from one nobody ever made.
 */
export function capability(
  name: CapabilityName,
  state: CapabilityState,
  evidence: CapabilityEvidence,
  context: { readonly provider: string; readonly taskId: string },
): CapabilityRecord {
  if (state === "CONFIRMED" && !confirmsProviderCapability(evidence)) {
    throw new AdapterError("CAPABILITY_UNPROVEN", context);
  }
  return Object.freeze({ name, state, evidence });
}

/** Every capability UNKNOWN with no evidence: the honest starting point. */
export function unknownCapabilities(): readonly CapabilityRecord[] {
  return Object.freeze(
    CAPABILITY_NAMES.map((name) =>
      Object.freeze({ name, state: "UNKNOWN" as const, evidence: { kind: "NONE" as const } }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------

export type SessionState =
  | "CREATED"
  | "STARTING"
  | "READY"
  | "STREAMING"
  | "INTERRUPTING"
  | "CLOSED"
  | "FAILED";

export const SESSION_STATES: readonly SessionState[] = Object.freeze([
  "CLOSED",
  "CREATED",
  "FAILED",
  "INTERRUPTING",
  "READY",
  "STARTING",
  "STREAMING",
]);

/** The only legal moves. Anything absent here is `ILLEGAL_TRANSITION`. */
export const LEGAL_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> =
  Object.freeze({
    CREATED: Object.freeze(["STARTING", "FAILED"] as SessionState[]),
    // CLOSED is reachable from STARTING: a process that spawned but never
    // completed its handshake still has a PID to reap, and refusing to close it
    // would be the one way this machine could leak the thing it exists to own.
    STARTING: Object.freeze(["READY", "FAILED", "INTERRUPTING", "CLOSED"] as SessionState[]),
    READY: Object.freeze(["STREAMING", "INTERRUPTING", "CLOSED", "FAILED"] as SessionState[]),
    STREAMING: Object.freeze(["STREAMING", "INTERRUPTING", "CLOSED", "FAILED"] as SessionState[]),
    INTERRUPTING: Object.freeze(["CLOSED", "FAILED"] as SessionState[]),
    CLOSED: Object.freeze([] as SessionState[]),
    FAILED: Object.freeze([] as SessionState[]),
  });

export function isLegalTransition(from: SessionState, to: SessionState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Requests, descriptors, parsing
// ---------------------------------------------------------------------------

export interface SessionLimits {
  /** Wall-clock ceiling for the whole session, passed to `spawn` as `timeout`. */
  readonly timeoutMs: number;
  /** Raw bytes across stdout+stderr, counted before decoding. */
  readonly outputBudgetBytes: number;
  /** How long a graceful step may take before the ladder escalates. */
  readonly interruptGraceMs: number;
  readonly termGraceMs: number;
}

export interface SessionRequest {
  readonly identity: WorkerIdentityString;
  readonly taskId: string;
  readonly attempt: number;
  readonly modelAlias: string;
  readonly binary: AdmittedBinary;
  readonly configRoot: AdmittedConfigRoot;
  readonly workdir: AdmittedWorkdir;
  readonly resumeSessionId: string | null;
  readonly limits: SessionLimits;
  /**
   * What the model is being asked to do (V2-B1c).
   *
   * Carried from `ExecutionRequest.instructions`, already bounded there. The
   * adapter never renders, templates or truncates it; the descriptor only
   * declares HOW a transport would deliver it, and `startSession` is the one
   * place that delivers.
   */
  readonly instructions: string;
  /**
   * The distinct block kinds the instruction was composed from (P-06/C, ADR 0095).
   *
   * Not the content, and never the bytes: the classes only, so a transport can say
   * whether it could carry them **before a process exists**. `describe` is pure and
   * this is what makes a modality refusal expressible there — an adapter cannot
   * decide what it cannot see, and handing it the blocks would put content on the
   * public side of the boundary, which §4.1 `:199-201` forbids.
   *
   * Always carries at least `"text"`, because a content list always has a text
   * block (escalón A's contract). A kind appearing here is a claim about what was
   * asked, not a request to transport bytes: the text is already inside
   * `instructions`, and every other class is refused by the preflight rather than
   * dropped from the composition.
   */
  readonly modalities: readonly string[];
}

export interface SessionDescriptor {
  readonly provider: ProviderName;
  readonly argv: readonly string[];
  /** Exactly the variables this provider is allowed; nothing is inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: AdmittedWorkdir;
  /**
   * How this transport takes the instruction — or that it cannot (V2-B1c).
   *
   * Declared, never performed: `describe` stays pure and does no I/O, and
   * `startSession` remains the only impure seam. The union is inline rather
   * than a named export so the package's pinned public surface does not move
   * for a field.
   *
   * `STDIN` is Claude's, and today only Claude's. Codex and Kimi declare
   * `UNSUPPORTED`, because their protocols need a handshake this plane has not
   * performed and their instruction frame needs an id the server has not yet
   * returned — so no frame carrying an instruction can be built purely here.
   * Declaring that is a statement about a transport's protocol, not about a
   * capability, and no capability moves off `UNKNOWN` for it.
   *
   * `MODALITY_UNSUPPORTED` is the third member and the second reason (P-06/C,
   * ADR 0095): the transport's protocol is fine and it is the **content's classes**
   * it cannot carry. It lives inside this union rather than beside it so it reuses
   * the one refusal point that already runs before the spawn, and it answers
   * `PROTOCOL_UNSUPPORTED` for ADR 0034's reason — the specificity belongs in this
   * `reason`, and minting an error code would move a pinned closed set for no
   * semantic gain. Naming a modality is not installing one: the text route works
   * end to end and every other class is refused here (contratos §4.1 `:202-203`).
   */
  readonly delivery:
    | { readonly kind: "STDIN" }
    | {
        readonly kind: "UNSUPPORTED";
        readonly reason: "HANDSHAKE_REQUIRED" | "MODALITY_UNSUPPORTED";
      };
}

export interface ParseCursor {
  /** Bytes of a record carried over from the previous chunk. */
  readonly partial: string;
  readonly recordIndex: number;
}

export const EMPTY_CURSOR: ParseCursor = Object.freeze({ partial: "", recordIndex: 0 });

export type ParseOutcome =
  | {
      readonly ok: true;
      readonly events: readonly ProviderSignal[];
      readonly cursor: ParseCursor;
    }
  | { readonly ok: false; readonly code: "UNKNOWN_EVENT" | "MALFORMED_EVENT"; readonly detail: string };

/**
 * What a provider said, before it becomes one of the frozen 21.
 *
 * Deliberately small: a provider signal this union cannot express is a STOP,
 * escalated to the DT, never a reason to widen `@acp/contracts`.
 */
export type ProviderSignal =
  | { readonly kind: "started"; readonly resolvedModel: string; readonly protocolVersion: string }
  | { readonly kind: "step"; readonly tokensUsed: number; readonly stepIndex: number }
  | { readonly kind: "checkpoint"; readonly digest: string }
  | { readonly kind: "authRequired"; readonly reason: string }
  | { readonly kind: "state"; readonly toState: string }
  /**
   * What the provider said about the account's standing, classified.
   *
   * Carries the classification and nothing else: no count, no ratio, no reset
   * instant, no retry-after, no provider message. An adapter that cannot say
   * which of the five it observed emits no pressure signal at all, which is
   * why the classification tables are total while emission stays narrow.
   */
  | { readonly kind: "pressure"; readonly pressure: ProviderPressure }
  /** A write-class action. Fatal for a reviewer identity. */
  | { readonly kind: "write"; readonly target: string }
  /**
   * Output text, as the provider produced it (P-07 escalón C, ADR 0099).
   *
   * Private: the session hands it to the caller's sink and it is never normalized,
   * so it reaches no event, no health report and no error.
   */
  | { readonly kind: "output"; readonly text: string }
  /**
   * What the operation itself said about its outcome, in the result contract's
   * vocabulary. Held by the session, at most once, and never normalized.
   */
  | {
      readonly kind: "operation";
      readonly status: Extract<ExecutionEvent, { readonly kind: "operationResult" }>["status"];
    };

export type CapabilityOutcome =
  | { readonly ok: true; readonly capabilities: readonly CapabilityRecord[]; readonly protocolVersion: string }
  | { readonly ok: false; readonly code: "PROTOCOL_UNSUPPORTED"; readonly detail: string };

export interface ProviderAdapter {
  readonly provider: ProviderName;
  /** Pure. Builds argv and the environment allowlist. No I/O. */
  describe(request: SessionRequest): SessionDescriptor;
  /** Pure. Bytes in, signals out, or a classified refusal. */
  parse(chunk: string, cursor: ParseCursor): ParseOutcome;
  /** Pure. What the handshake actually proved. */
  negotiate(handshake: unknown): CapabilityOutcome;
}
