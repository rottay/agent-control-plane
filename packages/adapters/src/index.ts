/**
 * Public surface of the Agent Control Plane provider adapters.
 *
 * This is P4A: the shared contract, the normalized event taxonomy, the config
 * and binary admissions, and one process boundary. The Claude, Kimi and Codex
 * descriptors arrived in P4B, P4C and P4D and are re-exported at the foot of
 * this file.
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

export type { AdapterErrorCode } from "./errors/index.js";
export { ADAPTER_ERROR_CODES, AdapterError } from "./errors/index.js";

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
} from "./contract/index.js";
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
} from "./contract/index.js";

export type { NormalizedEvent, NormalizedEventName } from "./events/index.js";
export {
  FROZEN_TYPE_BY_EVENT,
  NORMALIZED_EVENT_NAMES,
  TOKENS_USED_MAX,
  isReportableTokenCount,
  normalizedEvent,
  toNormalized,
} from "./events/index.js";

export {
  PAYLOAD_BYTES_MAX,
  PAYLOAD_STRING_MAX,
  boundString,
  hasPrivacyViolation,
  shapePayload,
} from "./redact/index.js";

export {
  BASE_ENV_KEYS,
  PROVIDER_CONFIG_ENV,
  admitConfigRoot,
  admitWorkdir,
  allowedEnvKeys,
  buildEnv,
} from "./config-root/index.js";

export type { InterruptRecord, LadderStep } from "./process/handle/index.js";
// `spawnAdmitted` and `ProcessHandle` are deliberately NOT exported. They are
// the boundary's internals, and a caller able to spawn directly could bypass
// the session controller — which is the one place read-only enforcement, the
// output budget and the state machine live. `admitBinary` is public because a
// caller must be able to construct an `AdmittedBinary` to make a request.
export { admitBinary } from "./process/spawn/index.js";

export type { AdapterSession } from "./session/index.js";
export { descriptorEnablesWrites, isReadOnlyIdentity, startSession } from "./session/index.js";

// P8-2: the CLI subscription binding of the contracts' `ModelExecutionPort`.
// The port is the only thing here that a control plane talks to; the session
// machinery above stays available because the drills and the daemon use it
// directly. Admitted binaries, configuration roots, working directories and
// budgets arrive per account at binding time, never inside the contract's
// strict `ExecutionRequest`.
export type { CliBinding, CliExecutionPortInput } from "./execution-port/index.js";
export {
  CLI_TRANSPORT_KIND,
  cliSessionId,
  createCliExecutionPort,
  toExecutionEvent,
} from "./execution-port/index.js";

// P4B: the Claude headless descriptor. Kimi and Codex arrive in P4C and P4D.
// Every Claude capability leaves P4 `UNKNOWN`: the adapter is complete, the
// warranty about the provider's protocol is what no authorized evidence could
// establish.
export { CLAUDE_STREAM_PROTOCOL, claudeAdapter } from "./providers/claude/index.js";

// P4C: the Kimi ACP descriptor, built against stable ACP v1 NDJSON. Live
// conformance is unclaimed and every Kimi capability leaves P4 `UNKNOWN`.
export { KIMI_ACP_PROTOCOL, KIMI_ACP_PROTOCOL_VERSION, kimiAdapter } from "./providers/kimi/index.js";

// P4D: the Codex App Server descriptor, built against the offline schema the
// Codex CLI generates for its own protocol. `CODEX_PROTOCOL_RECORD` is
// exported because what the evidence does *not* establish — the wire framing,
// the experimental method tier — is part of the surface a caller has to read,
// not a footnote. No handshake was performed, no conformance is claimed, and
// every Codex capability leaves P4 `UNKNOWN`.
export {
  CODEX_APP_SERVER_PROTOCOL,
  CODEX_PROTOCOL_RECORD,
  codexAdapter,
} from "./providers/codex/index.js";
