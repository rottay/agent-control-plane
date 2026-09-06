import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { TransportKind } from "@acp/contracts";
import type { ConfidenceLevel } from "@acp/contracts";

import { CONFIDENCE_ORDER } from "../quota/index.js";
import type { RoutingRecommendation, RoutingRefused, RoutingRequest } from "../routing/index.js";
import { rankAccounts } from "../routing/index.js";

/**
 * The versioned capability/policy registry, and the one seam that stamps it.
 *
 * Law 4 of the P8 addendum asks for a versioned registry that lives **outside
 * application code**: model release, eligible roles, measured quality, latency,
 * context, modality and tool support, transport availability, per-account quota
 * and reset confidence, cost where it applies, the evaluation date, and the
 * fallbacks a model is allowed. Its acceptance test is blunt — updating the
 * policy must change the eligible model chosen **without a source change**, and
 * must record which version of the policy chose it.
 *
 * So the registry is a JSON document, this module is the schema and the loader,
 * and `routeWithPolicy` is the seam that reads it. **How preference is
 * expressed is itself a document fact**, carried by `selection`. Under
 * `DOCUMENT_ORDER` the first eligible entry a candidate account can actually
 * serve is the one chosen, and reordering the array is a policy update that is
 * also the entire diff. Under `QUALITY_SCORE` the eligible entries this
 * registry has actually measured, at or above a declared confidence floor, are
 * ordered by that measurement. Changing which rule answers is an edit to the
 * document and to nothing else, which is what law 4 asks of a model switch.
 *
 * **An unmeasured entry is not orderable under a measuring rule.** It is not
 * defaulted to a number and not tailed after the measured ones: it is not a
 * candidate at all, and when a measuring rule finds eligible entries and can
 * measure none of them the seam refuses with `POLICY_NO_MEASURED_MODEL` rather
 * than relaxing to document order. A model has no position on an axis it was
 * never measured on -- the same fail-closed reading `CAPABILITY_UNKNOWN`
 * already takes in the router, and deliberately not the `UNKNOWN_TERM`
 * convention, which is a neutral value inside a mean and not a measurement.
 *
 * **The editorial law.** A content change to the registry **requires** a
 * version change. Same content under a new version is lawful — a re-cut, when
 * an evaluation is repeated and nothing moved. Same version under new content
 * is invalid, and it is invalid in the way that matters most: every
 * `capabilityPolicyVersion` already written into a `ResolvedRoute` or an event
 * becomes a lie about what was in force. A loader sees one document and cannot
 * know its history, so this law is not enforceable here — the architecture
 * fence enforces it instead, by pinning each published version to the digest of
 * the content it published. Changing bytes without changing the version fails
 * the fence.
 *
 * **Hermeticity.** `loadPolicyRegistry` takes an explicit absolute path. There
 * is no default, no discovery and no environment read — the same law the owner
 * file's loader holds, for the same reason: a loader that can be called with no
 * arguments is a loader a test calls with no arguments.
 *
 * What this module deliberately does **not** do is apply the owner file's
 * ownership and permission ladder. That ladder exists because the owner file
 * names where credentials live; this document is committed repository data that
 * every contributor reads, and demanding `0600` of it would fail on any shared
 * checkout while protecting nothing.
 */

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export type PolicyRefusal =
  // the caller did not supply what it must
  | "PATH_NOT_SUPPLIED"
  | "PATH_NOT_ABSOLUTE"
  // the thing found there is not admissible
  | "POLICY_FILE_ABSENT"
  | "POLICY_FILE_NOT_REGULAR"
  | "POLICY_FILE_TOO_LARGE"
  // the bytes are not a policy registry
  | "POLICY_FILE_NOT_JSON"
  | "POLICY_FILE_INVALID"
  | "POLICY_UNKNOWN_KEY"
  | "POLICY_DUPLICATE_MODEL"
  | "POLICY_FALLBACK_UNKNOWN"
  // the registry cannot answer the question asked of it
  | "POLICY_NO_ELIGIBLE_MODEL"
  // eligible entries exist, and the measuring rule in force measured none of
  // them. Distinct from the line above on purpose: "the registry has nothing
  // for this role and transport" and "the registry has candidates it never
  // measured" are different facts about the document, and collapsing them
  // would hide which one a reader has to fix.
  | "POLICY_NO_MEASURED_MODEL"
  // the request is not an object at all (F4, V2-B1b D9)
  | "POLICY_REQUEST_INVALID"
  // the request names a transport the kernel does not know (F2, V2-B1b D8)
  | "POLICY_TRANSPORT_UNKNOWN";

export const POLICY_REFUSALS: readonly PolicyRefusal[] = Object.freeze([
  "PATH_NOT_ABSOLUTE",
  "PATH_NOT_SUPPLIED",
  "POLICY_DUPLICATE_MODEL",
  "POLICY_FALLBACK_UNKNOWN",
  "POLICY_FILE_ABSENT",
  "POLICY_FILE_INVALID",
  "POLICY_FILE_NOT_JSON",
  "POLICY_FILE_NOT_REGULAR",
  "POLICY_FILE_TOO_LARGE",
  "POLICY_NO_ELIGIBLE_MODEL",
  "POLICY_NO_MEASURED_MODEL",
  "POLICY_REQUEST_INVALID",
  "POLICY_TRANSPORT_UNKNOWN",
  "POLICY_UNKNOWN_KEY",
]);

export interface PolicyRefused {
  readonly ok: false;
  readonly reason: PolicyRefusal;
  /** A JSON path or a shape observation. Never a value from the document. */
  readonly at: string;
}

function deny(reason: PolicyRefusal, at: string): PolicyRefused {
  return Object.freeze({ ok: false as const, reason, at });
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** A policy document is data, not a payload. It has no business being large. */
export const POLICY_FILE_MAX_BYTES = 256 * 1024;

/** How much the evaluation behind a field is worth. */
export type PolicyConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

const CONFIDENCES: readonly string[] = Object.freeze(["HIGH", "LOW", "MEDIUM", "UNKNOWN"]);

/** Tri-state support: a claim, or an honest absence of one. */
export type PolicySupport = "YES" | "NO" | "UNKNOWN";

const SUPPORTS: readonly string[] = Object.freeze(["NO", "UNKNOWN", "YES"]);

const ENTRY_KEYS: readonly string[] = Object.freeze([
  "allowedFallbacks",
  "contextTokens",
  "costPerMillionTokens",
  "eligibleRoles",
  "evaluatedAt",
  "latency",
  "model",
  "provider",
  "quality",
  "quotaConfidence",
  "release",
  "supports",
  "transports",
]);

const DOCUMENT_KEYS: readonly string[] = Object.freeze([
  "evaluatedAt",
  "models",
  "policyVersion",
  "selection",
]);

/**
 * How the document says its own preference is to be read.
 *
 * Two members, and an enum member is earned by the drill that needs it: there
 * is no `LATENCY`, `COST` or `CONTEXT` rule because nothing in this repository
 * measures those, and a rule nothing can feed is a promise rather than a
 * capability.
 */
export type PolicySelectionRule = "DOCUMENT_ORDER" | "QUALITY_SCORE";

export const POLICY_SELECTION_RULES: readonly PolicySelectionRule[] = Object.freeze([
  "DOCUMENT_ORDER",
  "QUALITY_SCORE",
]);

/**
 * The selection block, discriminated so no field rides under a rule that never
 * reads it.
 *
 * `DOCUMENT_ORDER` carries no floor, because there is no measurement to floor;
 * `QUALITY_SCORE` requires one, because "measured" without a threshold is a
 * claim about the document rather than a rule. The floor is `ConfidenceLevel`
 * and not `PolicyConfidence`: `UNKNOWN` is unrepresentable as a floor by type,
 * since a floor of `UNKNOWN` would admit exactly the unmeasured claims the
 * rule exists to exclude.
 */
export type PolicySelection =
  | { readonly by: "DOCUMENT_ORDER" }
  | { readonly by: "QUALITY_SCORE"; readonly minimumConfidence: ConfidenceLevel };

/**
 * One model, as the policy knows it.
 *
 * Every measurement is nullable and carries its own confidence, because the
 * honest seed for most of these is "not measured". A registry that defaulted an
 * unmeasured quality to a number would be inventing the evidence law 4 exists
 * to record.
 */
export interface PolicyEntry {
  readonly model: string;
  readonly provider: string;
  /** The model's release date, when it is known. */
  readonly release: string | null;
  readonly eligibleRoles: readonly string[];
  readonly quality: { readonly score: number | null; readonly confidence: PolicyConfidence };
  readonly latency: { readonly p50Seconds: number | null; readonly confidence: PolicyConfidence };
  readonly contextTokens: number | null;
  readonly supports: {
    readonly tools: PolicySupport;
    readonly vision: PolicySupport;
    readonly streaming: PolicySupport;
  };
  /** Transport kinds this model is reachable through. */
  readonly transports: readonly string[];
  /** How much the account's quota and reset picture can be trusted. */
  readonly quotaConfidence: PolicyConfidence;
  readonly costPerMillionTokens: number | null;
  readonly evaluatedAt: string;
  /** Models this one may fall back to, in order. Each must exist in the document. */
  readonly allowedFallbacks: readonly string[];
}

export interface PolicyRegistry {
  readonly policyVersion: string;
  readonly evaluatedAt: string;
  /** How the entries below are to be ordered. A document fact, not a default. */
  readonly selection: PolicySelection;
  /**
   * The entries, in document order.
   *
   * Document order is the editor's declared preference, and it is what
   * `DOCUMENT_ORDER` reads directly and what `QUALITY_SCORE` falls to when two
   * qualifying measurements tie. It is never an ordering of measurements on its
   * own: a document that has measured nothing states no preference beyond the
   * order it is written in, and says so by publishing `DOCUMENT_ORDER`.
   */
  readonly models: readonly PolicyEntry[];
}

export type PolicyLoadOutcome = { readonly ok: true; readonly registry: PolicyRegistry } | PolicyRefused;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

/** A finite, non-negative number, or an explicit null. Never a missing key. */
function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function unknownKeys(record: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) return key;
  }
  for (const key of allowed) {
    if (!Object.hasOwn(record, key)) return key;
  }
  return null;
}

/**
 * Read the selection block, refusing by name at every step.
 *
 * The order is deliberate: the rule is established first, because the exact
 * keys a lawful block carries depend on which rule it names. A floor under
 * `DOCUMENT_ORDER` and a missing floor under `QUALITY_SCORE` are then both
 * `POLICY_UNKNOWN_KEY` at the field itself -- the loader's standing law that a
 * key it would silently ignore and a key it would silently invent are the same
 * kind of defect.
 */
function readSelection(raw: unknown, at: string): PolicySelection | PolicyRefused {
  if (!isRecord(raw)) return deny("POLICY_FILE_INVALID", at);

  const by = raw["by"];
  if (typeof by !== "string" || !(POLICY_SELECTION_RULES as readonly string[]).includes(by)) {
    return deny("POLICY_FILE_INVALID", at + ".by");
  }
  const rule = by as PolicySelectionRule;

  const allowed = rule === "QUALITY_SCORE" ? ["by", "minimumConfidence"] : ["by"];
  const stray = unknownKeys(raw, allowed);
  if (stray !== null) return deny("POLICY_UNKNOWN_KEY", at + "." + stray);

  if (rule === "DOCUMENT_ORDER") return Object.freeze({ by: rule });

  const floor = raw["minimumConfidence"];
  if (typeof floor !== "string" || !(CONFIDENCE_ORDER as readonly string[]).includes(floor)) {
    return deny("POLICY_FILE_INVALID", at + ".minimumConfidence");
  }
  return Object.freeze({ by: rule, minimumConfidence: floor as ConfidenceLevel });
}

function readEntry(raw: unknown, at: string): PolicyEntry | PolicyRefused {
  if (!isRecord(raw)) return deny("POLICY_FILE_INVALID", at);

  // Exact keys in both directions: an unexpected key is a field this loader
  // would silently ignore, and a missing one is a default this loader would
  // silently invent. Both are how a registry stops describing what it claims.
  const stray = unknownKeys(raw, ENTRY_KEYS);
  if (stray !== null) return deny("POLICY_UNKNOWN_KEY", at + "." + stray);

  if (!isNonEmptyString(raw["model"])) return deny("POLICY_FILE_INVALID", at + ".model");
  if (!isNonEmptyString(raw["provider"])) return deny("POLICY_FILE_INVALID", at + ".provider");
  if (raw["release"] !== null && !isNonEmptyString(raw["release"])) {
    return deny("POLICY_FILE_INVALID", at + ".release");
  }
  if (!isNonEmptyString(raw["evaluatedAt"])) return deny("POLICY_FILE_INVALID", at + ".evaluatedAt");

  const roles = raw["eligibleRoles"];
  if (!Array.isArray(roles) || !roles.every(isNonEmptyString)) {
    return deny("POLICY_FILE_INVALID", at + ".eligibleRoles");
  }
  const transports = raw["transports"];
  if (!Array.isArray(transports) || !transports.every(isNonEmptyString)) {
    return deny("POLICY_FILE_INVALID", at + ".transports");
  }
  const fallbacks = raw["allowedFallbacks"];
  if (!Array.isArray(fallbacks) || !fallbacks.every(isNonEmptyString)) {
    return deny("POLICY_FILE_INVALID", at + ".allowedFallbacks");
  }

  const quality = raw["quality"];
  if (
    !isRecord(quality) ||
    unknownKeys(quality, ["confidence", "score"]) !== null ||
    !isNullableNumber(quality["score"]) ||
    !CONFIDENCES.includes(String(quality["confidence"]))
  ) {
    return deny("POLICY_FILE_INVALID", at + ".quality");
  }

  const latency = raw["latency"];
  if (
    !isRecord(latency) ||
    unknownKeys(latency, ["confidence", "p50Seconds"]) !== null ||
    !isNullableNumber(latency["p50Seconds"]) ||
    !CONFIDENCES.includes(String(latency["confidence"]))
  ) {
    return deny("POLICY_FILE_INVALID", at + ".latency");
  }

  const supports = raw["supports"];
  if (
    !isRecord(supports) ||
    unknownKeys(supports, ["streaming", "tools", "vision"]) !== null ||
    !SUPPORTS.includes(String(supports["tools"])) ||
    !SUPPORTS.includes(String(supports["vision"])) ||
    !SUPPORTS.includes(String(supports["streaming"]))
  ) {
    return deny("POLICY_FILE_INVALID", at + ".supports");
  }

  if (!isNullableNumber(raw["contextTokens"])) return deny("POLICY_FILE_INVALID", at + ".contextTokens");
  if (!isNullableNumber(raw["costPerMillionTokens"])) {
    return deny("POLICY_FILE_INVALID", at + ".costPerMillionTokens");
  }
  if (!CONFIDENCES.includes(String(raw["quotaConfidence"]))) {
    return deny("POLICY_FILE_INVALID", at + ".quotaConfidence");
  }

  return Object.freeze({
    model: raw["model"],
    provider: raw["provider"],
    release: raw["release"],
    eligibleRoles: Object.freeze([...roles]),
    quality: Object.freeze({
      score: quality["score"],
      confidence: quality["confidence"] as PolicyConfidence,
    }),
    latency: Object.freeze({
      p50Seconds: latency["p50Seconds"],
      confidence: latency["confidence"] as PolicyConfidence,
    }),
    contextTokens: raw["contextTokens"],
    supports: Object.freeze({
      tools: supports["tools"] as PolicySupport,
      vision: supports["vision"] as PolicySupport,
      streaming: supports["streaming"] as PolicySupport,
    }),
    transports: Object.freeze([...transports]),
    quotaConfidence: raw["quotaConfidence"] as PolicyConfidence,
    costPerMillionTokens: raw["costPerMillionTokens"],
    evaluatedAt: raw["evaluatedAt"],
    allowedFallbacks: Object.freeze([...fallbacks]),
  });
}

/**
 * Validate a parsed document into a frozen registry.
 *
 * Exported because a caller that already holds the bytes — a test, a future
 * ingress that receives a policy rather than reading one — should not have to
 * write them to a file to have them checked.
 */
export function buildPolicyRegistry(parsed: unknown): PolicyLoadOutcome {
  if (!isRecord(parsed)) return deny("POLICY_FILE_INVALID", "<root>");
  const stray = unknownKeys(parsed, DOCUMENT_KEYS);
  if (stray !== null) return deny("POLICY_UNKNOWN_KEY", "<root>." + stray);

  if (!isNonEmptyString(parsed["policyVersion"])) return deny("POLICY_FILE_INVALID", "policyVersion");
  if (!isNonEmptyString(parsed["evaluatedAt"])) return deny("POLICY_FILE_INVALID", "evaluatedAt");

  const selection = readSelection(parsed["selection"], "selection");
  if ("ok" in selection) return selection;

  const rawModels = parsed["models"];
  if (!Array.isArray(rawModels) || rawModels.length === 0) return deny("POLICY_FILE_INVALID", "models");

  const models: PolicyEntry[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of rawModels.entries()) {
    const entry = readEntry(raw, "models[" + String(index) + "]");
    if ("ok" in entry) return entry;
    if (seen.has(entry.model)) return deny("POLICY_DUPLICATE_MODEL", "models[" + String(index) + "].model");
    seen.add(entry.model);
    models.push(entry);
  }

  // A fallback naming a model the document does not carry is a dangling
  // reference, and a router that followed one would be routing to something
  // this policy never described.
  for (const [index, entry] of models.entries()) {
    for (const fallback of entry.allowedFallbacks) {
      if (!seen.has(fallback)) {
        return deny("POLICY_FALLBACK_UNKNOWN", "models[" + String(index) + "].allowedFallbacks");
      }
    }
  }

  return Object.freeze({
    ok: true as const,
    registry: Object.freeze({
      policyVersion: parsed["policyVersion"],
      evaluatedAt: parsed["evaluatedAt"],
      selection,
      models: Object.freeze(models),
    }),
  });
}

/**
 * Load a policy registry from an explicit absolute path.
 *
 * No default, no discovery, no environment. See the module doc.
 */
export function loadPolicyRegistry(path?: unknown): PolicyLoadOutcome {
  if (typeof path !== "string" || path === "") return deny("PATH_NOT_SUPPLIED", "<root>");
  if (!isAbsolute(path)) return deny("PATH_NOT_ABSOLUTE", "<root>");

  let stats;
  try {
    stats = statSync(path);
  } catch {
    return deny("POLICY_FILE_ABSENT", "<root>");
  }
  if (!stats.isFile()) return deny("POLICY_FILE_NOT_REGULAR", "<root>");
  if (stats.size > POLICY_FILE_MAX_BYTES) return deny("POLICY_FILE_TOO_LARGE", "<root>");

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return deny("POLICY_FILE_ABSENT", "<root>");
  }
  // The bytes actually read, not the size the stat promised.
  if (Buffer.byteLength(text, "utf8") > POLICY_FILE_MAX_BYTES) {
    return deny("POLICY_FILE_TOO_LARGE", "<root>");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return deny("POLICY_FILE_NOT_JSON", "<root>");
  }
  return buildPolicyRegistry(parsed);
}

// ---------------------------------------------------------------------------
// The one stamping seam
// ---------------------------------------------------------------------------

export interface PolicyRouteRequest {
  /** The worker role the task will run under. Eligibility is stated per role. */
  readonly role: string;
  /**
   * Everything the router needs.
   *
   * `routing.task.model` is **ignored**: the policy chooses the model, which is
   * the whole point of law 4. It stays on the type because this seam hands the
   * request to `rankAccounts` with the chosen model substituted in, and a
   * parallel model-less request type would be a second shape of the same thing.
   */
  readonly routing: RoutingRequest;
  /**
   * The transport kind the execution will use, checked against the entry.
   *
   * The kernel's closed vocabulary, not a free string (F2, V2-B1b D8): the
   * type is contracts-owned, and `routeWithPolicy` validates the value at
   * runtime before it scans a single entry, so an unknown kind is refused by
   * its own name rather than surfacing as "no eligible model".
   */
  readonly transportKind: TransportKind;
}

export interface PolicyRouteChoice {
  readonly ok: true;
  /** The model the policy chose. Never one the caller named. */
  readonly model: string;
  /**
   * The version of the policy that chose it.
   *
   * **This is the only place this value is produced.** `rankAccounts` has no
   * idea a policy exists and stays that way; anything that later builds a
   * `ResolvedRoute` takes `capabilityPolicyVersion` from here rather than
   * reading the registry a second time. Two readers of one document is two
   * answers the moment the document is re-cut between them.
   */
  readonly capabilityPolicyVersion: string;
  /** Set when the chosen model came from another entry's declared fallbacks. */
  readonly viaFallbackFrom: string | null;
  /**
   * Why this entry, in the registry's own terms.
   *
   * The rule the document published, and the measurement and confidence of the
   * entry actually elected -- after a fallback, the fallback's own, never the
   * parent's. Under `DOCUMENT_ORDER` the measurement is whatever the entry
   * carries, which for an unmeasured registry is `null` with `UNKNOWN`: that
   * is the truth about the choice and not a gap in it.
   *
   * It stops here. `ResolvedRoute` is a closed six-field shape whose digest
   * rides every event, every ledger row and every resume, so a seventh field
   * would cascade through the contracts, the beats, the projection and the
   * continuity check and cost a `CONTRACT_VERSION` bump -- to carry a value
   * that is already recoverable, because the version names the document and
   * the document names the rule and the score.
   */
  readonly selectedBy: {
    readonly rule: PolicySelectionRule;
    readonly measurement: number | null;
    readonly confidence: PolicyConfidence;
  };
  readonly recommendation: RoutingRecommendation;
}

export type PolicyRouteOutcome = PolicyRouteChoice | PolicyRefused | RoutingRefused;

/** Is this entry usable for the role and transport asked for? */
function eligible(entry: PolicyEntry, role: string, transportKind: string): boolean {
  return entry.eligibleRoles.includes(role) && entry.transports.includes(transportKind);
}

/**
 * Has this entry been measured well enough for a measuring rule to order it?
 *
 * One ladder, imported rather than written again: `CONFIDENCE_ORDER` is
 * exported from the quota module for exactly this reason, and a second table
 * here would be a second authority on one ordering. `score === null` is
 * checked on its own, because a null score under `HIGH` confidence is a
 * document defect and not a confident zero.
 */
function measured(entry: PolicyEntry, minimumConfidence: ConfidenceLevel): boolean {
  if (entry.quality.score === null) return false;
  const { confidence } = entry.quality;
  if (confidence === "UNKNOWN") return false;
  return CONFIDENCE_ORDER.indexOf(confidence) >= CONFIDENCE_ORDER.indexOf(minimumConfidence);
}

/**
 * Choose a model from the policy, then rank accounts for it.
 *
 * The order of operations is the design. The policy chooses **which model**,
 * because that is a policy question and updating it must not require a source
 * change; the router chooses **which account**, because that is a quota and
 * capability question the policy cannot see. Neither reaches into the other.
 *
 * A model is tried when the role and the transport make it eligible. Those two
 * gates fire first and alone: `POLICY_NO_ELIGIBLE_MODEL` keeps meaning "the
 * registry has nothing for this role and transport", computed on eligibility
 * and never on measurement. The document's `selection` rule then orders what
 * survived — document order as written, or measured quality descending with
 * document order as the tie-break, which keeps the comparator total.
 *
 * If the router refuses a model for every account, the entry's declared
 * fallbacks are tried immediately after it and before the next entry in the
 * order — and the choice records which entry the fallback came from, so a
 * fallback is never silent. A fallback must be eligible in its own right, and
 * under a measuring rule it must qualify in its own right too: a declared
 * fallback is a permission the document granted, never an exemption from the
 * rule the document published. If nothing is left, the seam refuses rather
 * than relaxing the policy it was given.
 */
export function routeWithPolicy(
  request: PolicyRouteRequest,
  registry: PolicyRegistry,
): PolicyRouteOutcome {
  // F4 (V2-B1b D9): the request is proved to be an object before anything is
  // read out of it -- the exact shape `rankAccounts` carries. Destructuring
  // first made `routeWithPolicy(null)` a TypeError, an uncatalogued crash where
  // the seam promises a classified refusal.
  const rawRequest: unknown = request;
  if (typeof rawRequest !== "object" || rawRequest === null) {
    return deny("POLICY_REQUEST_INVALID", "request");
  }
  const { role, routing, transportKind } = request;

  // F2 (V2-B1b D8): the transport is validated against the kernel's closed
  // vocabulary BEFORE the eligibility scan. An unknown kind would otherwise
  // make every entry ineligible and surface as `POLICY_NO_ELIGIBLE_MODEL`,
  // which must keep meaning "the registry could not serve a lawful request".
  // It never reaches `rankAccounts`.
  if (!TransportKind.safeParse(transportKind).success) {
    return deny("POLICY_TRANSPORT_UNKNOWN", "request.transportKind");
  }

  const byModel = new Map(registry.models.map((entry) => [entry.model, entry]));

  // Eligibility first, and on its own. `POLICY_NO_ELIGIBLE_MODEL` is a fact
  // about roles and transports; folding the selection rule into it would make
  // "the document measured nothing" indistinguishable from "the document has
  // no entry for this role", which are different edits to different lines.
  const admitted = registry.models.filter((entry) => eligible(entry, role, transportKind));
  if (admitted.length === 0) return deny("POLICY_NO_ELIGIBLE_MODEL", "models");

  const { selection } = registry;
  const qualifies = (entry: PolicyEntry): boolean =>
    selection.by === "DOCUMENT_ORDER" || measured(entry, selection.minimumConfidence);

  let ordered: readonly PolicyEntry[] = admitted;
  if (selection.by === "QUALITY_SCORE") {
    // The score is carried out of the filter rather than read again inside the
    // comparator, so no branch here can reach a null and no null is ever
    // substituted with a number to make one sortable.
    const ranked: { readonly entry: PolicyEntry; readonly index: number; readonly score: number }[] = [];
    for (const [index, entry] of admitted.entries()) {
      const { score } = entry.quality;
      if (score === null || !qualifies(entry)) continue;
      ranked.push({ entry, index, score });
    }
    if (ranked.length === 0) return deny("POLICY_NO_MEASURED_MODEL", "models");
    // Total by construction: two distinct entries always differ in index, so
    // the comparator never returns 0 for them and the sort does not depend on
    // the engine's stability. Ties break on document position -- the editor's
    // declared preference -- and never on the model's name.
    ranked.sort((left, right) => right.score - left.score || left.index - right.index);
    ordered = ranked.map((row) => row.entry);
  }

  const attempts: { readonly entry: PolicyEntry; readonly from: string | null }[] = [];
  for (const entry of ordered) {
    attempts.push({ entry, from: null });
    for (const fallback of entry.allowedFallbacks) {
      const target = byModel.get(fallback);
      // A fallback still has to be eligible in its own right. Falling back onto
      // a model the role may not use would let a fallback quietly widen a
      // permission the policy withheld -- and under a measuring rule, onto a
      // model the registry never measured would do the same to the rule.
      if (target !== undefined && eligible(target, role, transportKind) && qualifies(target)) {
        attempts.push({ entry: target, from: entry.model });
      }
    }
  }

  let lastRefusal: RoutingRefused | null = null;
  const tried = new Set<string>();
  for (const attempt of attempts) {
    if (tried.has(attempt.entry.model)) continue;
    tried.add(attempt.entry.model);

    const outcome = rankAccounts({
      ...routing,
      task: { ...routing.task, model: attempt.entry.model },
    });
    if (outcome.ok) {
      return Object.freeze({
        ok: true as const,
        model: attempt.entry.model,
        capabilityPolicyVersion: registry.policyVersion,
        viaFallbackFrom: attempt.from,
        selectedBy: Object.freeze({
          rule: selection.by,
          measurement: attempt.entry.quality.score,
          confidence: attempt.entry.quality.confidence,
        }),
        recommendation: outcome.recommendation,
      });
    }
    lastRefusal = outcome;
  }

  // Every eligible model was refused by the router. The router's own refusal
  // travels rather than being reclassified: it names which account failed and
  // why, and this seam has nothing truer to say than that.
  return lastRefusal ?? deny("POLICY_NO_ELIGIBLE_MODEL", "models");
}
