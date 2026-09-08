#!/usr/bin/env node
/**
 * The producer of immutable versions of the capability registry (old-V2 B5, R15).
 *
 * The registry has had a schema, a loader, a seam that reads it and a fence law
 * that pins each published version to the digest of its bytes. What it never had
 * was a producer: the documented way to publish a measurement was a hand edit of
 * two data files. This module is that producer, and it is deliberately the
 * smallest thing that can be one.
 *
 * **It merges into the registry that exists. It never invents a second one.**
 * The model set, the provider, the roles, the transports, the fallbacks, the
 * cost and the selection rule are the editor's; a measurement may not appoint a
 * model or grant it a role. Only what an evaluation can actually measure moves:
 * quality, latency, context, modality and tool support, and the date the
 * measurement was taken -- on the document and on every entry it measured, since
 * a header that disagreed with its rows would attest two different runs.
 *
 * **It returns bytes and a digest. It writes nothing.** Publishing is the
 * operator's act: write the document, append the row to the pin, commit both.
 * A producer that could write the published paths could overwrite a version
 * some route already recorded, which is the one thing the editorial law exists
 * to prevent. `L-R15-3` in the architecture fence is what keeps the key tables
 * below in step with the loader's, in both directions, so this module cannot
 * drift into describing a document the loader would refuse.
 *
 * **It consumes an eval-output in this lane's own form, not a vendor's.** The
 * owner ruling of 2026-09-07 measured what a hosted evaluation runner would cost
 * this repository's dependency graph -- 798 packages, seven of them declaring
 * install-time lifecycle hooks -- and refused it. So the lane declares its own
 * shape, every key of it named below, and refuses by name any key outside that
 * table: an eval-output may not smuggle a runner's identifier, version or
 * metadata into a document the loader would refuse anyway. Any future runner,
 * whatever produces it, emits this shape or does not feed this producer. See
 * ADR 0056.
 *
 * **Nothing here has earned a confidence.** This lane knows no runner that ever
 * ran against a real subject, so a measurement arriving with a confidence above
 * `LOW` is refused rather than published. Restriction 5: `CONFIRMED` only by a
 * drill with a real subject.
 *
 * **No benchmark of a subscription without accounting for what it consumed.**
 * The accounting block is mandatory and it is written in `QuotaObservation`'s
 * vocabulary rather than a second one this lane invented (`L-R15-4` holds the
 * two together). A run that consumed subscription calls is refused
 * unconditionally: in R15 there is no lawful value of the owner authorization,
 * so law 8 is a refusal in code rather than a promise in prose.
 *
 * Dependency-free by construction: it imports nothing but Node's own modules --
 * no workspace package, no vendor -- reaches no network, and reads no file
 * except the paths an operator passes by argument when this file is invoked as
 * an entry point. There is no default path and no discovery: a producer that
 * could be called with no arguments is a producer something calls with no
 * arguments. Importing a workspace package would also give this lane a reason to
 * live inside the package graph, which is the one place restriction 6 says it
 * must not be.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The one document this producer produces, and the one pin that attests it. */
const POLICY_DOCUMENT_PATH = "packages/domains/accounts/policy/capability-policy.json";
const POLICY_PIN_PATH = "scripts/policy-version-digests.json";

/**
 * The loader's key tables, mirrored.
 *
 * Mirrored rather than imported: the loader is TypeScript inside a workspace
 * package, and this lane is outside the package graph on purpose. The fence
 * compares these two tables against the loader's, read as text, in both
 * directions -- so a key added on either side and not the other fails the build
 * rather than producing a document the loader refuses at load.
 */
const ADAPTER_ENTRY_KEYS = Object.freeze([
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
const ADAPTER_DOCUMENT_KEYS = Object.freeze([
  "evaluatedAt",
  "models",
  "policyVersion",
  "selection",
]);

/** What an evaluation may move. Everything else in an entry is the editor's. */
const MEASURED_ENTRY_KEYS = Object.freeze([
  "contextTokens",
  "evaluatedAt",
  "latency",
  "quality",
  "supports",
]);

/** The lane's own eval-output shape, exactly. */
const EVAL_OUTPUT_KEYS = Object.freeze(["accounting", "models"]);
const EVAL_MODEL_KEYS = Object.freeze([
  "contextTokens",
  "latency",
  "model",
  "quality",
  "supports",
]);
const EVAL_QUALITY_KEYS = Object.freeze(["confidence", "score"]);
const EVAL_LATENCY_KEYS = Object.freeze(["confidence", "p50Seconds"]);
const EVAL_SUPPORTS_KEYS = Object.freeze(["streaming", "tools", "vision"]);

/** The consumption record's shape, in the ledger's own vocabulary. */
const CONSUMPTION_KEYS = Object.freeze([
  "evaluatedAt",
  "perProvider",
  "runId",
  "subscriptionCalls",
]);
const CONSUMPTION_ENTRY_KEYS = Object.freeze([
  "calls",
  "observedAt",
  "provider",
  "tokensUsed",
  "transport",
]);

/**
 * The two names this lane shares with `QuotaObservation`, and shares on purpose.
 *
 * An eval run does not pass through the ledger, so it needs its own record --
 * but a second vocabulary for the same fact is two answers to one question the
 * moment they disagree. `L-R15-4` reads the interface and this table and holds
 * them equal in both directions.
 */
const CONSUMPTION_OBSERVATION_KEYS = Object.freeze(["observedAt", "tokensUsed"]);

/** The one seam an owner authorization would ever arrive through. */
const CONSUMPTION_AUTHORIZATION_KEYS = Object.freeze(["subscriptionAuthorization"]);

/** The transport whose consumption is owner-gated, spelled as the registry spells it. */
const SUBSCRIPTION_TRANSPORT = "CLI_SUBSCRIPTION";

/** The loader's vocabularies, as strings. This module imports no contract. */
const POLICY_CONFIDENCES = Object.freeze(["HIGH", "LOW", "MEDIUM", "UNKNOWN"]);
const POLICY_SUPPORTS = Object.freeze(["NO", "UNKNOWN", "YES"]);

/**
 * The ceiling on what a cut may publish, and why it is `LOW` rather than `HIGH`.
 *
 * `HIGH` and `MEDIUM` are both claims about a subject this lane has never met.
 * The seed is `UNKNOWN` everywhere for the same reason, and a producer that let
 * a run declare its own confidence would be inventing exactly the evidence the
 * record exists to hold. Raising this ceiling is owner-gated and takes a real
 * drill, not an edit here.
 */
const EARNED_CONFIDENCES = Object.freeze(["LOW", "UNKNOWN"]);

/** Every refusal this producer can return, by name. */
const EVAL_REFUSALS = Object.freeze([
  "EVAL_CONFIDENCE_UNEARNED",
  "EVAL_CONSUMPTION_UNACCOUNTED",
  "EVAL_MODEL_DUPLICATE",
  "EVAL_MODEL_UNKNOWN",
  "EVAL_OUTPUT_INVALID",
  "EVAL_REGISTRY_INVALID",
  "EVAL_SUBSCRIPTION_UNAUTHORIZED",
  "EVAL_UNKNOWN_KEY",
  "EVAL_VERSION_INVALID",
  "EVAL_VERSION_REUSED",
]);

function deny(reason, at) {
  return { ok: false, reason, at };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function isNullableNumber(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isCount(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A key the table does not carry, or `null`. */
function strayKey(record, allowed) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) return key;
  }
  return null;
}

/** A key the table requires and the record omits, or `null`. */
function missingKey(record, allowed) {
  for (const key of allowed) {
    if (!Object.hasOwn(record, key)) return key;
  }
  return null;
}

/**
 * The document as this producer serializes it: two-space indent, a trailing
 * newline, and the key order of the document it merged into.
 *
 * Key order is taken from `current` rather than sorted, because the digest is
 * meant to be a function of the inputs and of nothing else -- including nothing
 * about the order a runtime happened to enumerate an object in. A re-cut of the
 * same inputs is byte-identical, which is what makes the pin row reproducible.
 */
function serialize(document) {
  return JSON.stringify(document, null, 2) + "\n";
}

/** Validate the document being merged into. It is the schema, so it must satisfy it. */
function readCurrent(current) {
  if (!isRecord(current)) return deny("EVAL_REGISTRY_INVALID", "current");
  const stray = strayKey(current, ADAPTER_DOCUMENT_KEYS);
  if (stray !== null) return deny("EVAL_REGISTRY_INVALID", "current." + stray);
  const missing = missingKey(current, ADAPTER_DOCUMENT_KEYS);
  if (missing !== null) return deny("EVAL_REGISTRY_INVALID", "current." + missing);
  if (!isNonEmptyString(current.policyVersion)) {
    return deny("EVAL_REGISTRY_INVALID", "current.policyVersion");
  }
  if (!Array.isArray(current.models) || current.models.length === 0) {
    return deny("EVAL_REGISTRY_INVALID", "current.models");
  }
  for (const [index, entry] of current.models.entries()) {
    const at = "current.models[" + index + "]";
    if (!isRecord(entry)) return deny("EVAL_REGISTRY_INVALID", at);
    const entryStray = strayKey(entry, ADAPTER_ENTRY_KEYS);
    if (entryStray !== null) return deny("EVAL_REGISTRY_INVALID", at + "." + entryStray);
    const entryMissing = missingKey(entry, ADAPTER_ENTRY_KEYS);
    if (entryMissing !== null) return deny("EVAL_REGISTRY_INVALID", at + "." + entryMissing);
    if (!isNonEmptyString(entry.model)) return deny("EVAL_REGISTRY_INVALID", at + ".model");
  }
  return null;
}

/**
 * Read the consumption record, refusing by name at every step.
 *
 * Two refusals, and the split is the point. `EVAL_CONSUMPTION_UNACCOUNTED` says
 * the run did not say what it spent. `EVAL_SUBSCRIPTION_UNAUTHORIZED` says it
 * said, and what it said is not this packet's to authorize.
 */
function readAccounting(accounting) {
  const at = "evalOutput.accounting";
  if (!isRecord(accounting)) return deny("EVAL_CONSUMPTION_UNACCOUNTED", at);

  const stray = strayKey(accounting, CONSUMPTION_KEYS);
  if (stray !== null) return deny("EVAL_UNKNOWN_KEY", at + "." + stray);
  const missing = missingKey(accounting, CONSUMPTION_KEYS);
  if (missing !== null) return deny("EVAL_CONSUMPTION_UNACCOUNTED", at);

  if (!isNonEmptyString(accounting.runId)) {
    return deny("EVAL_CONSUMPTION_UNACCOUNTED", at + ".runId");
  }
  if (!isNonEmptyString(accounting.evaluatedAt)) {
    return deny("EVAL_CONSUMPTION_UNACCOUNTED", at + ".evaluatedAt");
  }
  if (!isCount(accounting.subscriptionCalls)) {
    return deny("EVAL_CONSUMPTION_UNACCOUNTED", at + ".subscriptionCalls");
  }
  if (!Array.isArray(accounting.perProvider) || accounting.perProvider.length === 0) {
    return deny("EVAL_CONSUMPTION_UNACCOUNTED", at + ".perProvider");
  }

  let subscriptionCalls = 0;
  for (const [index, entry] of accounting.perProvider.entries()) {
    const row = at + ".perProvider[" + index + "]";
    if (!isRecord(entry)) return deny("EVAL_CONSUMPTION_UNACCOUNTED", row);
    const entryStray = strayKey(entry, CONSUMPTION_ENTRY_KEYS);
    if (entryStray !== null) return deny("EVAL_UNKNOWN_KEY", row + "." + entryStray);
    const entryMissing = missingKey(entry, CONSUMPTION_ENTRY_KEYS);
    if (entryMissing !== null) return deny("EVAL_CONSUMPTION_UNACCOUNTED", row + "." + entryMissing);

    if (!isNonEmptyString(entry.provider)) {
      return deny("EVAL_CONSUMPTION_UNACCOUNTED", row + ".provider");
    }
    if (!isNonEmptyString(entry.transport)) {
      return deny("EVAL_CONSUMPTION_UNACCOUNTED", row + ".transport");
    }
    if (!isCount(entry.calls)) return deny("EVAL_CONSUMPTION_UNACCOUNTED", row + ".calls");
    if (typeof entry.tokensUsed !== "number" || !Number.isFinite(entry.tokensUsed) || entry.tokensUsed < 0) {
      return deny("EVAL_CONSUMPTION_UNACCOUNTED", row + ".tokensUsed");
    }
    if (!isNonEmptyString(entry.observedAt)) {
      return deny("EVAL_CONSUMPTION_UNACCOUNTED", row + ".observedAt");
    }
    if (entry.transport === SUBSCRIPTION_TRANSPORT) subscriptionCalls += entry.calls;
  }

  // The declared total must be the total actually declared. Without this, a run
  // could reach a subscription and report zero of it, and the refusal below
  // would never fire on the very traffic it exists to catch.
  if (accounting.subscriptionCalls !== subscriptionCalls) {
    return deny("EVAL_CONSUMPTION_UNACCOUNTED", at + ".subscriptionCalls");
  }

  if (subscriptionCalls > 0) {
    const index = accounting.perProvider.findIndex(
      (entry) => entry.transport === SUBSCRIPTION_TRANSPORT,
    );
    return deny(
      "EVAL_SUBSCRIPTION_UNAUTHORIZED",
      at + ".perProvider[" + index + "].transport",
    );
  }

  return null;
}

/** One measured model, in the lane's own shape. */
function readMeasurement(raw, index) {
  const at = "evalOutput.models[" + index + "]";
  if (!isRecord(raw)) return deny("EVAL_OUTPUT_INVALID", at);

  const stray = strayKey(raw, EVAL_MODEL_KEYS);
  if (stray !== null) return deny("EVAL_UNKNOWN_KEY", at + "." + stray);
  const missing = missingKey(raw, EVAL_MODEL_KEYS);
  if (missing !== null) return deny("EVAL_OUTPUT_INVALID", at + "." + missing);

  if (!isNonEmptyString(raw.model)) return deny("EVAL_OUTPUT_INVALID", at + ".model");

  for (const [field, keys, measure] of [
    ["quality", EVAL_QUALITY_KEYS, "score"],
    ["latency", EVAL_LATENCY_KEYS, "p50Seconds"],
  ]) {
    const block = raw[field];
    const blockAt = at + "." + field;
    if (!isRecord(block)) return deny("EVAL_OUTPUT_INVALID", blockAt);
    const blockStray = strayKey(block, keys);
    if (blockStray !== null) return deny("EVAL_UNKNOWN_KEY", blockAt + "." + blockStray);
    const blockMissing = missingKey(block, keys);
    if (blockMissing !== null) return deny("EVAL_OUTPUT_INVALID", blockAt + "." + blockMissing);
    if (!isNullableNumber(block[measure])) {
      return deny("EVAL_OUTPUT_INVALID", blockAt + "." + measure);
    }
    if (!POLICY_CONFIDENCES.includes(block.confidence)) {
      return deny("EVAL_OUTPUT_INVALID", blockAt + ".confidence");
    }
    if (!EARNED_CONFIDENCES.includes(block.confidence)) {
      return deny("EVAL_CONFIDENCE_UNEARNED", blockAt + ".confidence");
    }
  }

  if (!isNullableNumber(raw.contextTokens)) {
    return deny("EVAL_OUTPUT_INVALID", at + ".contextTokens");
  }

  const supports = raw.supports;
  const supportsAt = at + ".supports";
  if (!isRecord(supports)) return deny("EVAL_OUTPUT_INVALID", supportsAt);
  const supportsStray = strayKey(supports, EVAL_SUPPORTS_KEYS);
  if (supportsStray !== null) return deny("EVAL_UNKNOWN_KEY", supportsAt + "." + supportsStray);
  const supportsMissing = missingKey(supports, EVAL_SUPPORTS_KEYS);
  if (supportsMissing !== null) return deny("EVAL_OUTPUT_INVALID", supportsAt + "." + supportsMissing);
  for (const key of EVAL_SUPPORTS_KEYS) {
    if (!POLICY_SUPPORTS.includes(supports[key])) {
      return deny("EVAL_OUTPUT_INVALID", supportsAt + "." + key);
    }
  }

  return null;
}

/**
 * Cut a version of the capability registry from an eval-output.
 *
 * Returns the document's bytes, their digest and the single pin row that
 * publishes them -- or a named refusal and the path it refused at. It never
 * touches a file, and `version` is always the caller's: deriving it from a clock
 * would let two cuts in one day collide under one version, which is the exact
 * lie the editorial law exists to prevent.
 */
function cutRegistryVersion({ current, evalOutput, version, evaluatedAt, consumption } = {}) {
  const registryRefusal = readCurrent(current);
  if (registryRefusal !== null) return registryRefusal;

  if (!isNonEmptyString(version)) return deny("EVAL_VERSION_INVALID", "version");
  if (!isNonEmptyString(evaluatedAt)) return deny("EVAL_OUTPUT_INVALID", "evaluatedAt");

  // The owner authorization seam, checked before anything is measured. There is
  // no lawful value in R15, so claiming one is the refusal: the seam cannot be
  // warmed up against the day a real run wants it.
  if (consumption !== undefined && consumption !== null) {
    if (!isRecord(consumption)) return deny("EVAL_OUTPUT_INVALID", "consumption");
    const stray = strayKey(consumption, CONSUMPTION_AUTHORIZATION_KEYS);
    if (stray !== null) return deny("EVAL_UNKNOWN_KEY", "consumption." + stray);
    if (Object.hasOwn(consumption, "subscriptionAuthorization")) {
      return deny("EVAL_SUBSCRIPTION_UNAUTHORIZED", "consumption.subscriptionAuthorization");
    }
  }

  if (!isRecord(evalOutput)) return deny("EVAL_OUTPUT_INVALID", "evalOutput");
  const outputStray = strayKey(evalOutput, EVAL_OUTPUT_KEYS);
  if (outputStray !== null) return deny("EVAL_UNKNOWN_KEY", "evalOutput." + outputStray);
  if (!Object.hasOwn(evalOutput, "accounting")) {
    return deny("EVAL_CONSUMPTION_UNACCOUNTED", "evalOutput.accounting");
  }
  if (!Object.hasOwn(evalOutput, "models")) {
    return deny("EVAL_OUTPUT_INVALID", "evalOutput.models");
  }

  const accountingRefusal = readAccounting(evalOutput.accounting);
  if (accountingRefusal !== null) return accountingRefusal;

  if (!Array.isArray(evalOutput.models)) return deny("EVAL_OUTPUT_INVALID", "evalOutput.models");

  const known = new Set(current.models.map((entry) => entry.model));
  const measured = new Map();
  for (const [index, raw] of evalOutput.models.entries()) {
    const refusal = readMeasurement(raw, index);
    if (refusal !== null) return refusal;
    const at = "evalOutput.models[" + index + "]";
    // A model the registry does not carry is a refusal, never an insertion:
    // adding a model is an editorial act, and this producer performs none.
    if (!known.has(raw.model)) return deny("EVAL_MODEL_UNKNOWN", at + ".model");
    if (measured.has(raw.model)) return deny("EVAL_MODEL_DUPLICATE", at + ".model");
    measured.set(raw.model, raw);
  }

  const models = current.models.map((entry) => {
    const measurement = measured.get(entry.model);
    const next = {};
    for (const key of Object.keys(entry)) {
      if (measurement === undefined || !MEASURED_ENTRY_KEYS.includes(key)) {
        next[key] = entry[key];
        continue;
      }
      if (key === "evaluatedAt") {
        next[key] = evaluatedAt;
        continue;
      }
      if (key === "quality") {
        next[key] = {
          score: measurement.quality.score,
          confidence: measurement.quality.confidence,
        };
        continue;
      }
      if (key === "latency") {
        next[key] = {
          p50Seconds: measurement.latency.p50Seconds,
          confidence: measurement.latency.confidence,
        };
        continue;
      }
      if (key === "supports") {
        next[key] = {
          tools: measurement.supports.tools,
          vision: measurement.supports.vision,
          streaming: measurement.supports.streaming,
        };
        continue;
      }
      next[key] = measurement.contextTokens;
    }
    return next;
  });

  const document = {};
  for (const key of Object.keys(current)) {
    if (key === "policyVersion") document[key] = version;
    else if (key === "evaluatedAt") document[key] = evaluatedAt;
    else if (key === "models") document[key] = models;
    else document[key] = current[key];
  }

  const bytes = serialize(document);

  // The editorial law, as far as one document can carry it: the version in force
  // may not be republished over content that moved. The fence holds the rest --
  // it is the only reader of the pin, and a producer that graded its own digest
  // against history it cannot see would be attesting itself.
  if (version === current.policyVersion && bytes !== serialize(current)) {
    return deny("EVAL_VERSION_REUSED", "version");
  }

  const digest = createHash("sha256").update(bytes, "utf8").digest("hex");
  return { ok: true, document: bytes, digest, pinRow: { [version]: digest } };
}

// ---------------------------------------------------------------------------
// The entry point, which is the only thing here that ever reads a file
// ---------------------------------------------------------------------------

function flag(name) {
  const found = process.argv.find((argument) => argument.startsWith("--" + name + "="));
  return found === undefined ? null : found.slice(name.length + 3);
}

function readOperatorPath(name) {
  const value = flag(name);
  if (value === null) {
    throw new Error("--" + name + "=<absolute path> is required; this producer has no default");
  }
  if (!isAbsolute(value)) {
    throw new Error("--" + name + " must be an absolute path, not " + value);
  }
  return JSON.parse(readFileSync(value, "utf8"));
}

function main() {
  const version = flag("version");
  const evaluatedAt = flag("evaluated-at");
  if (version === null || evaluatedAt === null) {
    throw new Error("--version=<version> and --evaluated-at=<instant> are both required");
  }

  const outcome = cutRegistryVersion({
    current: readOperatorPath("current"),
    evalOutput: readOperatorPath("eval-output"),
    version,
    evaluatedAt,
  });

  if (outcome.ok !== true) {
    console.error("refused: " + outcome.reason + " at " + outcome.at);
    process.exitCode = 1;
    return;
  }

  // Bytes to stdout, the pin row to stderr, and not one file written. Where
  // they land is the operator's decision and the operator's commit.
  process.stdout.write(outcome.document);
  console.error("digest " + outcome.digest);
  console.error("pin row " + JSON.stringify(outcome.pinRow));
}

const invoked = process.argv[1];
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "unknown failure");
    process.exitCode = 1;
  }
}

export {
  ADAPTER_DOCUMENT_KEYS,
  ADAPTER_ENTRY_KEYS,
  CONSUMPTION_AUTHORIZATION_KEYS,
  CONSUMPTION_ENTRY_KEYS,
  CONSUMPTION_KEYS,
  CONSUMPTION_OBSERVATION_KEYS,
  EARNED_CONFIDENCES,
  EVAL_REFUSALS,
  MEASURED_ENTRY_KEYS,
  POLICY_DOCUMENT_PATH,
  POLICY_PIN_PATH,
  SUBSCRIPTION_TRANSPORT,
  cutRegistryVersion,
};
