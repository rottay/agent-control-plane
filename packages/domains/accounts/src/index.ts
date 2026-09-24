/**
 * Public surface of the Agent Control Plane accounts domain.
 *
 * This is P5A through P5D: the owner-file loader, the admission law, the
 * read-only registry, the quota estimator with its reset calendar, the
 * quota-aware router, and the switching policy — all exported.
 *
 * Importing this module has no side effects. `loadAccountsFile` reads when it
 * is called, and only then, from a path the caller supplies — there is no
 * default path anywhere in this package and no environment variable is
 * consulted, including `HOME`.
 *
 * Nothing here resolves a credential. `authProfileRef` and `credentialRef` are
 * opaque locators that this package carries and never dereferences; the
 * material they name stays outside this repository in P5 and in every phase
 * this package can reach.
 *
 * Nothing here writes. `@acp/ledger` is a declared dependency because the quota
 * observations P5D reasons over originate in the event log; the switching policy
 * takes them as injected values and no production source in this package
 * contains an append — the architecture fence asserts it.
 *
 * Nothing here reads a clock. The quota estimator takes the current instant as
 * an injected parameter at every entry point, so an estimate depends on what it
 * was given rather than on when it ran.
 */

export type { AccountsRefusal, AccountsRefused } from "./errors/index.js";
export { ACCOUNTS_REFUSALS } from "./errors/index.js";

export type { AccountsFile, AccountsRegistry, LoadOutcome } from "./registry/index.js";
export {
  ACCOUNTS_FILE_KEYS,
  ACCOUNTS_FILE_MAX_BYTES,
  admitOwnerFile,
  buildRegistry,
  loadAccountsFile,
} from "./registry/index.js";

// P5B: quota estimation and the reset calendar. Pure, clock-injected, and
// refusing rather than defaulting when the data to estimate from is absent.
export type {
  QuotaEstimate,
  QuotaEstimateInput,
  QuotaOutcome,
  QuotaRefusal,
  QuotaRefused,
  ResetCalendar,
  ResetOutcome,
  QuotaObservation,
} from "./quota/index.js";
export {
  CONFIDENCE_ORDER,
  OBSERVATIONS_MAX,
  QUOTA_REFUSALS,
  TOKENS_USED_MAX,
  estimateQuota,
  resetCalendar,
  usageObservationsFrom,
  weakerConfidence,
} from "./quota/index.js";

// P5C: the quota-aware router. Pure, clock-injected and deterministic; it
// recommends and reserves nothing. An account without margin for the next
// atomic step plus its checkpoint is refused by name rather than ranked last.
export type {
  CandidateEvidence,
  EvidenceSample,
  RankedAccount,
  RejectedAccount,
  RoutingConfig,
  RoutingOutcome,
  RoutingRecommendation,
  RoutingRefusal,
  RoutingRefused,
  RoutingRequest,
  RoutingTerm,
  TaskProfile,
} from "./routing/index.js";
export {
  CANDIDATES_MAX,
  DEFAULT_ROUTING_CONFIG,
  EVIDENCE_ABSENT,
  ROUTING_REFUSALS,
  ROUTING_TERMS,
  rankAccounts,
} from "./routing/index.js";

// P5D: the switching policy. It recommends and never acts: an ordered plan of
// named steps, candidate events as values, and a classified refusal for
// anything it was not given the standing to decide. Quota and selection are
// composed from P5B and P5C rather than re-decided here.
export type {
  PressureObservation,
  PressureSummary,
  PressureTriggerOutcome,
  PressureTriggerRefusal,
  SwitchAccountStatus,
  SwitchEvent,
  SwitchOutcome,
  SwitchPlan,
  SwitchRefusal,
  SwitchRefused,
  SwitchRequest,
  SwitchStep,
  SwitchTrigger,
} from "./switching/index.js";
// V2-B1f/F4b: the fold that turns recorded pressure into the one trigger a
// decision may be made on. It lives beside `decideSwitch` because the
// fail-closed `isTrigger` predicate is module-private and must stay that way.
export {
  PRESSURE_TRIGGER_REFUSALS,
  SWITCH_REFUSALS,
  SWITCH_STEPS,
  SWITCH_TRIGGERS,
  decideSwitch,
  foldPressureTrigger,
} from "./switching/index.js";

// P8-5: the versioned capability/policy registry (law 4). The document is data
// under `policy/`, outside application code; this package carries its schema,
// its loader and the one seam that reads it. `routeWithPolicy` is the **only**
// producer of `capabilityPolicyVersion` — `rankAccounts` still knows nothing
// about a policy, and anything that later builds a `ResolvedRoute` takes the
// version from the seam's outcome rather than reading the registry again.
//
// V2-B5: the selection rule is a document fact too (ADR 0047), so a switch from
// document order to measured quality is an edit to the document and to nothing
// else. The rule vocabulary is exported because a producer of documents — the
// evaluation loop that will eventually write a score — needs the closed set
// without reaching into the module, and `PolicySelection` is exported because
// `PolicyRegistry` already names it.
export type {
  PolicyConfidence,
  PolicyEntry,
  PolicyLoadOutcome,
  PolicyRefusal,
  PolicyRefused,
  PolicyRegistry,
  PolicyRouteChoice,
  PolicyRouteOutcome,
  PolicyRouteRequest,
  PolicySelection,
  PolicySelectionRule,
  PolicySupport,
} from "./policy/index.js";
export {
  POLICY_FILE_MAX_BYTES,
  POLICY_REFUSALS,
  POLICY_SELECTION_RULES,
  buildPolicyRegistry,
  loadPolicyRegistry,
  routeWithPolicy,
} from "./policy/index.js";

// V2-B1a: the resolution entry point. `resolveRoute` composes the policy's
// choice onto the seam type the adapters execute — provider from the chosen
// registry entry, account from the ranking, transport from the request, model
// and policy version from the choice, and the instant from the caller, never
// from a clock. What it returns is `ResolvedRoute`, owned by `@acp/contracts`:
// a consumer imports the function from here and the type from the kernel. The
// type is deliberately not re-exported from this barrel, and the fence's pin
// refuses a barrel that carries the name.
export { resolveRoute } from "./resolution/index.js";

// V2-B1e: the operator-state fold, moved here from the gateway so that both
// doors that need it — the gateway's read model and the CLI's election — derive
// effective state through one implementation. The gateway keeps a delegating
// wrapper over its own ledger row type and no copy of the law;
// `L-V2B1E-1` in the architecture fence is what keeps the count at one.
export type { EffectiveState } from "./operator-state/index.js";
export { ACCOUNT_ACTIONS_MAX, foldEffectiveState } from "./operator-state/index.js";

// P-14 A: the GLOBAL assignment resolver (ADR 0085). A role resolves from the
// registry the ledger folds, handed in as this module's own structural reading,
// or it is refused by name: no default, no fallback to the policy file above,
// and no import of it. Transport eligibility and a version retired after its
// assignment was admitted are decided here, because the append door cannot see
// either. The vector the reading was taken at travels on every outcome.
export type {
  AssignmentModelVersion,
  AssignmentOutcome,
  AssignmentProposal,
  AssignmentReading,
  AssignmentRefusal,
  AssignmentRefused,
  AssignmentRequest,
  AssignmentResolution,
  AssignmentWatermark,
  GlobalAssignment,
} from "./assignment/index.js";
export { ASSIGNMENT_REFUSALS, resolveAssignment } from "./assignment/index.js";
