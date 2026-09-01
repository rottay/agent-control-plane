import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

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
 * and `routeWithPolicy` is the seam that reads it. Preference is expressed as
 * document order: the first eligible entry a candidate account can actually
 * serve is the one chosen. Reordering the array is a policy update; it is also
 * the entire diff.
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
  | "POLICY_NO_ELIGIBLE_MODEL";

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

const DOCUMENT_KEYS: readonly string[] = Object.freeze(["evaluatedAt", "models", "policyVersion"]);

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
  /** Preference order. The first entry a candidate can serve is the one chosen. */
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
  /** The transport kind the execution will use, checked against the entry. */
  readonly transportKind: string;
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
  readonly recommendation: RoutingRecommendation;
}

export type PolicyRouteOutcome = PolicyRouteChoice | PolicyRefused | RoutingRefused;

/** Is this entry usable for the role and transport asked for? */
function eligible(entry: PolicyEntry, role: string, transportKind: string): boolean {
  return entry.eligibleRoles.includes(role) && entry.transports.includes(transportKind);
}

/**
 * Choose a model from the policy, then rank accounts for it.
 *
 * The order of operations is the design. The policy chooses **which model**,
 * because that is a policy question and updating it must not require a source
 * change; the router chooses **which account**, because that is a quota and
 * capability question the policy cannot see. Neither reaches into the other.
 *
 * A model is tried when the role and the transport make it eligible. If the
 * router refuses it for every account, the entry's declared fallbacks are tried
 * in order — and the choice records which entry the fallback came from, so a
 * fallback is never silent. If nothing is left, the seam refuses rather than
 * relaxing the policy it was given.
 */
export function routeWithPolicy(
  request: PolicyRouteRequest,
  registry: PolicyRegistry,
): PolicyRouteOutcome {
  const { role, routing, transportKind } = request;

  const byModel = new Map(registry.models.map((entry) => [entry.model, entry]));
  const attempts: { readonly model: string; readonly from: string | null }[] = [];
  for (const entry of registry.models) {
    if (!eligible(entry, role, transportKind)) continue;
    attempts.push({ model: entry.model, from: null });
    for (const fallback of entry.allowedFallbacks) {
      const target = byModel.get(fallback);
      // A fallback still has to be eligible in its own right. Falling back onto
      // a model the role may not use would let a fallback quietly widen a
      // permission the policy withheld.
      if (target !== undefined && eligible(target, role, transportKind)) {
        attempts.push({ model: fallback, from: entry.model });
      }
    }
  }

  if (attempts.length === 0) return deny("POLICY_NO_ELIGIBLE_MODEL", "models");

  let lastRefusal: RoutingRefused | null = null;
  const tried = new Set<string>();
  for (const attempt of attempts) {
    if (tried.has(attempt.model)) continue;
    tried.add(attempt.model);

    const outcome = rankAccounts({
      ...routing,
      task: { ...routing.task, model: attempt.model },
    });
    if (outcome.ok) {
      return Object.freeze({
        ok: true as const,
        model: attempt.model,
        capabilityPolicyVersion: registry.policyVersion,
        viaFallbackFrom: attempt.from,
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
