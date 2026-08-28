/**
 * Public surface of the Agent Control Plane provider adapters.
 *
 * This is P4A: the shared contract, the normalized event taxonomy, the config
 * and binary admissions, and one process boundary. The Claude, Kimi and Codex
 * descriptors are P4B, P4C and P4D and are not exported yet.
 *
 * Importing this module has no side effects. `startSession` spawns when it is
 * called, and only then, through the single authority in `process/spawn.ts`.
 * Adapters emit **normalized** events; they never open, append to or even name
 * a ledger. The caller constructs any full `ControlPlaneEvent` — idempotency
 * key, attempt, `fromState`/`toState` and the change-of-state law — so no
 * contract refinement is ever an adapter's to satisfy.
 *
 * `src/testing/fake-provider.ts` is deliberately **not** exported: it is test
 * scaffolding, imported by relative path, and a fake that appeared on the
 * public surface would eventually be mistaken for evidence.
 *
 * No adapter writes product in P4, for any role.
 */

export type { AdapterErrorCode } from "./errors.js";
export { ADAPTER_ERROR_CODES, AdapterError } from "./errors.js";

export type {
  AdmittedBinary,
  AdmittedConfigRoot,
  AdmittedWorkdir,
  CapabilityEvidence,
  CapabilityName,
  CapabilityOutcome,
  CapabilityRecord,
  CapabilityState,
  ParseCursor,
  ParseOutcome,
  ProviderAdapter,
  ProviderName,
  ProviderSignal,
  SessionDescriptor,
  SessionLimits,
  SessionRequest,
  SessionState,
} from "./contract.js";
export {
  CAPABILITY_NAMES,
  EMPTY_CURSOR,
  LEGAL_TRANSITIONS,
  PROVIDER_NAMES,
  SESSION_STATES,
  capability,
  confirmsProviderCapability,
  isLegalTransition,
  unknownCapabilities,
} from "./contract.js";

export type { NormalizedEvent, NormalizedEventName } from "./events.js";
export {
  FROZEN_TYPE_BY_EVENT,
  NORMALIZED_EVENT_NAMES,
  TOKENS_USED_MAX,
  isReportableTokenCount,
  normalizedEvent,
  toNormalized,
} from "./events.js";

export {
  PAYLOAD_BYTES_MAX,
  PAYLOAD_STRING_MAX,
  boundString,
  hasPrivacyViolation,
  shapePayload,
} from "./redact.js";

export {
  BASE_ENV_KEYS,
  PROVIDER_CONFIG_ENV,
  admitConfigRoot,
  admitWorkdir,
  allowedEnvKeys,
  buildEnv,
} from "./config-root.js";

export type { InterruptRecord, LadderStep } from "./process/handle.js";
// `spawnAdmitted` and `ProcessHandle` are deliberately NOT exported. They are
// the boundary's internals, and a caller able to spawn directly could bypass
// the session controller — which is the one place read-only enforcement, the
// output budget and the state machine live. `admitBinary` is public because a
// caller must be able to construct an `AdmittedBinary` to make a request.
export { admitBinary } from "./process/spawn.js";

export type { AdapterSession } from "./session.js";
export { descriptorEnablesWrites, isReadOnlyIdentity, startSession } from "./session.js";
