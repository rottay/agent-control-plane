import { CLI_SUBSCRIPTION_PROVIDERS } from "@acp/contracts";
import type { WorkerIdentityString } from "@acp/contracts";

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
}

export interface SessionDescriptor {
  readonly provider: ProviderName;
  readonly argv: readonly string[];
  /** Exactly the variables this provider is allowed; nothing is inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: AdmittedWorkdir;
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
  /** A write-class action. Fatal for a reviewer identity. */
  | { readonly kind: "write"; readonly target: string };

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
