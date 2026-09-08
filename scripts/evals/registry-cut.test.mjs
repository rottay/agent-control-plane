/**
 * The producer's own probes (old-V2 B5, R15).
 *
 * Three kinds of test live here, and the split is the same one the fence's
 * probes make.
 *
 * The adapter is a pure module, so it is exercised by direct import: no
 * subprocess, no tree, no network. It returns bytes and a digest and writes
 * nothing, which is what makes that possible.
 *
 * The registry it produces against is the **shipped** one, read from
 * `packages/domains/accounts/policy/capability-policy.json`. A fixture that
 * invented its own five models would prove the adapter merges into whatever it
 * is handed and nothing at all about the document this repository publishes.
 *
 * The immutability half is exercised **through the real fence as a subprocess**,
 * pointed at a synthetic tree in a temporary directory via `ACP_FENCE_ROOT` --
 * never against this repository. "Immutable" is the fence's word, enforced by
 * the fence's own pin law, and a producer that graded its own digest would be
 * attesting itself. Every child is run to completion inside the test that spawns
 * it and every temporary directory is removed in teardown.
 *
 * Every arm below was red before `registry-cut.mjs` existed, for a structural
 * reason rather than an assertion: the import at the top of this file could not
 * resolve.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  ADAPTER_DOCUMENT_KEYS,
  ADAPTER_ENTRY_KEYS,
  CONSUMPTION_OBSERVATION_KEYS,
  POLICY_DOCUMENT_PATH,
  POLICY_PIN_PATH,
  cutRegistryVersion,
} from "./registry-cut.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const FENCE = resolve(HERE, "..", "check-architecture.mjs");
const ADAPTER = resolve(HERE, "registry-cut.mjs");
const LOADER = resolve(REPO, "packages/domains/accounts/src/policy/index.ts");
const QUOTA = resolve(REPO, "packages/domains/accounts/src/quota/index.ts");

/** The registry as this repository publishes it, and the input every cut merges into. */
const CURRENT = JSON.parse(readFileSync(resolve(REPO, POLICY_DOCUMENT_PATH), "utf8"));

/** A version no published document ever carried, so nothing here can pass on history. */
const VERSION = "2099-01-01.1";
const NEXT_VERSION = "2099-01-02.1";
const AT = "2099-01-01T00:00:00.000Z";

/**
 * A well-formed accounting block for a run that consumed no subscription call.
 *
 * `tokensUsed` and `observedAt` are `QuotaObservation`'s names, not names this
 * lane chose: one consumption vocabulary, and L-R15-4 is what keeps the two
 * from drifting apart.
 */
function accounting(overrides = {}) {
  return {
    runId: "probe-run-1",
    evaluatedAt: AT,
    perProvider: [
      {
        provider: "claude",
        transport: "CLI_API",
        calls: 5,
        tokensUsed: 1200,
        observedAt: AT,
      },
    ],
    subscriptionCalls: 0,
    ...overrides,
  };
}

/** An eval-output in the lane's own form, measuring the named models at the given scores. */
function evalOutput(scores, overrides = {}) {
  return {
    models: Object.entries(scores).map(([model, score]) => ({
      model,
      quality: { score, confidence: "LOW" },
      latency: { p50Seconds: 2.5, confidence: "LOW" },
      contextTokens: 200000,
      supports: { tools: "YES", vision: "NO", streaming: "YES" },
    })),
    accounting: accounting(),
    ...overrides,
  };
}

/** Every model of the shipped document, scored in the order it is written in. */
const DESCENDING = { opus: 0.95, sonnet: 0.85, haiku: 0.75, k3: 0.65, "gpt-5-codex": 0.55 };

/**
 * The same five models, scored so the best is the one document order puts third.
 *
 * A fixture that scored them in document order could not tell a producer that
 * applies a measurement from one that copies its input: the two documents would
 * be indistinguishable. This one crosses the default order on purpose.
 */
const CROSSING = { opus: 0.41, sonnet: 0.62, haiku: 0.97, k3: 0.58, "gpt-5-codex": 0.55 };

function cut(overrides = {}) {
  return cutRegistryVersion({
    current: CURRENT,
    evalOutput: evalOutput(DESCENDING),
    version: VERSION,
    evaluatedAt: AT,
    ...overrides,
  });
}

function parse(document) {
  return JSON.parse(document);
}

function entryOf(document, model) {
  return parse(document).models.find((entry) => entry.model === model);
}

/**
 * The two readings of a document, written here rather than imported.
 *
 * `routeWithPolicy` is TypeScript in a package this dependency-free lane may not
 * reach, and a probe that shared the loader's code could not tell a producer
 * whose measurement lands from one that agrees with the loader about nothing.
 * These are the two rules ADR 0047 published, applied to a document's own bytes:
 * eligibility by role and transport first, then position or measurement.
 */
function eligible(document, role, transport) {
  return parse(document).models.filter(
    (entry) => entry.eligibleRoles.includes(role) && entry.transports.includes(transport),
  );
}

function byDocumentOrder(document, role, transport) {
  return eligible(document, role, transport)[0]?.model ?? null;
}

const CONFIDENCE_ORDER = ["UNKNOWN", "LOW", "MEDIUM", "HIGH"];

function byQualityScore(document, role, transport, floor) {
  const measured = eligible(document, role, transport).filter(
    (entry) =>
      entry.quality.score !== null &&
      CONFIDENCE_ORDER.indexOf(entry.quality.confidence) >= CONFIDENCE_ORDER.indexOf(floor),
  );
  if (measured.length === 0) return null;
  return measured.reduce((best, entry) => (entry.quality.score > best.quality.score ? entry : best))
    .model;
}

// ---------------------------------------------------------------------------
// The synthetic tree the real fence is run against
// ---------------------------------------------------------------------------

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function syntheticTree() {
  const root = mkdtempSync(join(tmpdir(), "acp-evals-probe-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "probe@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "probe"], { cwd: root });
  return root;
}

function write(root, relativePath, content) {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function commitAll(root) {
  execFileSync("git", ["add", "-A", "-f"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.email=p@e.invalid", "-c", "user.name=p", "commit", "-qm", "probe"],
    { cwd: root },
  );
}

/**
 * Run the real fence against a synthetic tree, asynchronously.
 *
 * Asynchronous for the reason the fence's own probes record: a `spawnSync` here
 * blocks the vitest worker's event loop for the whole run, the worker stops
 * answering the runner's RPC, and the project can exit non-zero with every
 * assertion green. `status` is the child's exit code, `output` is stdout and
 * stderr concatenated -- the fence writes its refusals to stderr.
 */
function runFenceAgainst(root) {
  return new Promise((settle, reject) => {
    const child = spawn(process.execPath, [FENCE], {
      env: { ...process.env, ACP_FENCE_ROOT: root },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      settle({ status: code, output: stdout + stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// A. the cut is a merge into the registry that already exists
// ---------------------------------------------------------------------------

describe("A. an eval-output becomes a lawful version of the existing registry", () => {
  it("A1: emits the document's exact key sets, carries the rest through, and takes its version from the caller", () => {
    const result = cut();
    expect(result.ok).toBe(true);

    const produced = parse(result.document);
    expect(Object.keys(produced).sort()).toEqual([...ADAPTER_DOCUMENT_KEYS].sort());
    for (const entry of produced.models) {
      expect(Object.keys(entry).sort()).toEqual([...ADAPTER_ENTRY_KEYS].sort());
    }

    // The editorial fields are the editor's. A measurement may not appoint a
    // model, grant it a role, reach a transport or invent a fallback.
    expect(produced.models.map((entry) => entry.model)).toEqual(
      CURRENT.models.map((entry) => entry.model),
    );
    expect(produced.selection).toEqual(CURRENT.selection);
    for (const [index, entry] of produced.models.entries()) {
      const before = CURRENT.models[index];
      expect(entry.provider).toBe(before.provider);
      expect(entry.release).toEqual(before.release);
      expect(entry.eligibleRoles).toEqual(before.eligibleRoles);
      expect(entry.transports).toEqual(before.transports);
      expect(entry.allowedFallbacks).toEqual(before.allowedFallbacks);
      expect(entry.quotaConfidence).toBe(before.quotaConfidence);
      expect(entry.costPerMillionTokens).toEqual(before.costPerMillionTokens);
    }

    // `policyVersion` is an input. Deriving it -- from a clock, from a counter --
    // would let two cuts on one day collide under one version, which is the
    // exact lie the editorial law exists to prevent.
    expect(produced.policyVersion).toBe(VERSION);
    expect(produced.policyVersion).not.toBe(CURRENT.policyVersion);

    // `evaluatedAt` has two meanings and both move. A document whose header
    // disagreed with its rows would be attesting two different runs.
    expect(produced.evaluatedAt).toBe(AT);
    for (const entry of produced.models) {
      expect(entry.evaluatedAt).toBe(AT);
    }

    // The measured fields, and only those, carry the run's numbers.
    const opus = entryOf(result.document, "opus");
    expect(opus.quality).toEqual({ score: 0.95, confidence: "LOW" });
    expect(opus.latency).toEqual({ p50Seconds: 2.5, confidence: "LOW" });
    expect(opus.contextTokens).toBe(200000);
    expect(opus.supports).toEqual({ tools: "YES", vision: "NO", streaming: "YES" });

    // Bytes and a digest. Writing is the operator's act, never the producer's.
    expect(result.digest).toBe(createHash("sha256").update(result.document, "utf8").digest("hex"));
    expect(result.pinRow).toEqual({ [VERSION]: result.digest });
    expect(result.document.endsWith("\n")).toBe(true);
  });

  it("A2: the measurement lands, and the produced document reads differently from the one it merged into", () => {
    const result = cutRegistryVersion({
      current: CURRENT,
      evalOutput: evalOutput(CROSSING),
      version: VERSION,
      evaluatedAt: AT,
    });
    expect(result.ok).toBe(true);

    // Four of the five shipped entries are eligible verifiers on this
    // transport, and document order puts `opus` first among them. The fixture
    // scores `haiku` -- third in that order -- highest, so the two readings can
    // only agree if the measurement never landed.
    const role = "verifier";
    const transport = "CLI_SUBSCRIPTION";
    expect(eligible(result.document, role, transport).map((entry) => entry.model)).toEqual([
      "opus",
      "sonnet",
      "haiku",
      "gpt-5-codex",
    ]);

    expect(byDocumentOrder(result.document, role, transport)).toBe("opus");
    expect(byQualityScore(result.document, role, transport, "LOW")).toBe("haiku");
    expect(byQualityScore(result.document, role, transport, "LOW")).not.toBe(
      byDocumentOrder(result.document, role, transport),
    );

    // The input could not have produced that reading: the shipped registry has
    // measured nothing, so a measuring rule elects no one over it. This is what
    // makes the assertion above load-bearing rather than a restatement of the
    // fixture.
    const before = JSON.stringify(CURRENT, null, 2) + "\n";
    expect(byQualityScore(before, role, transport, "LOW")).toBe(null);
    expect(byDocumentOrder(before, role, transport)).toBe("opus");

    // And the array itself was not reordered: the difference is the measurement
    // applied, not a producer quietly rewriting the editor's preference.
    expect(parse(result.document).models.map((entry) => entry.model)).toEqual(
      CURRENT.models.map((entry) => entry.model),
    );
    expect(entryOf(result.document, "haiku").quality.score).toBe(0.97);
    expect(entryOf(result.document, "opus").quality.score).toBe(0.41);
  });

  it("A3: a model the registry does not carry is refused, never inserted", () => {
    const result = cutRegistryVersion({
      current: CURRENT,
      evalOutput: evalOutput({ opus: 0.9, "some-new-model": 0.99 }),
      version: VERSION,
      evaluatedAt: AT,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("EVAL_MODEL_UNKNOWN");
    expect(result.at).toBe("evalOutput.models[1].model");
  });

  it("A4: an unknown key at any level is refused by name, before the loader would refuse it", () => {
    const atDocument = cutRegistryVersion({
      current: CURRENT,
      evalOutput: { ...evalOutput(DESCENDING), evalRunId: "r-1" },
      version: VERSION,
      evaluatedAt: AT,
    });
    expect(atDocument.ok).toBe(false);
    expect(atDocument.reason).toBe("EVAL_UNKNOWN_KEY");
    expect(atDocument.at).toBe("evalOutput.evalRunId");

    const output = evalOutput(DESCENDING);
    output.models[0]._meta = { note: "from the runner" };
    const atModel = cutRegistryVersion({
      current: CURRENT,
      evalOutput: output,
      version: VERSION,
      evaluatedAt: AT,
    });
    expect(atModel.ok).toBe(false);
    expect(atModel.reason).toBe("EVAL_UNKNOWN_KEY");
    expect(atModel.at).toBe("evalOutput.models[0]._meta");

    const nested = evalOutput(DESCENDING);
    nested.models[0].quality.sampleSize = 40;
    const atQuality = cutRegistryVersion({
      current: CURRENT,
      evalOutput: nested,
      version: VERSION,
      evaluatedAt: AT,
    });
    expect(atQuality.ok).toBe(false);
    expect(atQuality.reason).toBe("EVAL_UNKNOWN_KEY");
    expect(atQuality.at).toBe("evalOutput.models[0].quality.sampleSize");

    const accounted = evalOutput(DESCENDING, {
      accounting: accounting({ promptfooVersion: "0.120.19" }),
    });
    const atAccounting = cutRegistryVersion({
      current: CURRENT,
      evalOutput: accounted,
      version: VERSION,
      evaluatedAt: AT,
    });
    expect(atAccounting.ok).toBe(false);
    expect(atAccounting.reason).toBe("EVAL_UNKNOWN_KEY");
    expect(atAccounting.at).toBe("evalOutput.accounting.promptfooVersion");
  });

  it("A5: a confidence the run did not earn is refused", () => {
    const claimHigh = evalOutput(DESCENDING);
    claimHigh.models[0].quality.confidence = "HIGH";
    const high = cutRegistryVersion({
      current: CURRENT,
      evalOutput: claimHigh,
      version: VERSION,
      evaluatedAt: AT,
    });
    expect(high.ok).toBe(false);
    expect(high.reason).toBe("EVAL_CONFIDENCE_UNEARNED");
    expect(high.at).toBe("evalOutput.models[0].quality.confidence");

    // The ceiling is `LOW`, not `HIGH`: this lane knows no runner that ever ran
    // against a real subject, so `MEDIUM` is unearned here too.
    const claimMedium = evalOutput(DESCENDING);
    claimMedium.models[1].latency.confidence = "MEDIUM";
    const medium = cutRegistryVersion({
      current: CURRENT,
      evalOutput: claimMedium,
      version: VERSION,
      evaluatedAt: AT,
    });
    expect(medium.ok).toBe(false);
    expect(medium.reason).toBe("EVAL_CONFIDENCE_UNEARNED");
    expect(medium.at).toBe("evalOutput.models[1].latency.confidence");
  });
});

// ---------------------------------------------------------------------------
// B. immutability, as the authority that enforces it defines it
// ---------------------------------------------------------------------------

describe("B. a version is immutable, and the fence is what says so", () => {
  it("B1: two cuts from identical inputs are byte-identical and share one digest", () => {
    const first = cut();
    const second = cut();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.document).toBe(first.document);
    expect(second.digest).toBe(first.digest);
    expect(second.pinRow).toEqual(first.pinRow);
  });

  it("B2: the published version cannot be re-cut over different content", () => {
    const result = cutRegistryVersion({
      current: CURRENT,
      evalOutput: evalOutput(DESCENDING),
      version: CURRENT.policyVersion,
      evaluatedAt: AT,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("EVAL_VERSION_REUSED");
    expect(result.at).toBe("version");
  });

  it("B2: the fence itself attests the pair the producer emitted", async () => {
    const result = cut();
    expect(result.ok).toBe(true);

    const root = syntheticTree();
    write(root, POLICY_DOCUMENT_PATH, result.document);
    write(
      root,
      POLICY_PIN_PATH,
      JSON.stringify({ document: POLICY_DOCUMENT_PATH, versions: result.pinRow }, null, 2) + "\n",
    );
    commitAll(root);

    // The exit stays nonzero -- a synthetic tree trips laws this packet is not
    // about -- so what is asserted is the pin law's own verdict about this
    // document, computed by the authority rather than by the producer.
    const { output } = await runFenceAgainst(root);
    expect(output).toContain("the capability policy " + VERSION + " matches its pinned digest");
    expect(output).not.toContain("changed content under an unchanged policyVersion");
  });

  it("B2: the fence refuses the same version once the bytes move under it", async () => {
    const result = cut();
    expect(result.ok).toBe(true);

    const root = syntheticTree();
    // The pin row is the producer's; the document is a byte the operator
    // changed afterwards. This is the failure the editorial law exists for.
    write(root, POLICY_DOCUMENT_PATH, result.document.replace('"score": 0.95', '"score": 0.94'));
    write(
      root,
      POLICY_PIN_PATH,
      JSON.stringify({ document: POLICY_DOCUMENT_PATH, versions: result.pinRow }, null, 2) + "\n",
    );
    commitAll(root);

    const { status, output } = await runFenceAgainst(root);
    expect(status).not.toBe(0);
    expect(output).toContain("changed content under an unchanged policyVersion " + VERSION);
  });

  it("B3: a new version over unchanged content is lawful, and the pin gains a row", () => {
    const first = cut();
    const second = cut({ version: NEXT_VERSION });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    // A re-cut: the evaluation was repeated and nothing moved. The only byte
    // that differs is the version, which is why the digests differ and why the
    // pin gains a row instead of replacing one.
    const strip = (document) =>
      document
        .split("\n")
        .filter((line) => !line.includes('"policyVersion"'))
        .join("\n");
    expect(strip(second.document)).toBe(strip(first.document));
    expect(second.digest).not.toBe(first.digest);
    expect(Object.keys({ ...first.pinRow, ...second.pinRow })).toEqual([VERSION, NEXT_VERSION]);
  });
});

// ---------------------------------------------------------------------------
// C. it is THE registry, not a second one
// ---------------------------------------------------------------------------

describe("C. the producer writes the one registry that already exists", () => {
  it("C1: the adapter's key tables and the loader's are a bijection, both directions", () => {
    const loader = readFileSync(LOADER, "utf8");
    const table = (name) => {
      const declaration = new RegExp(
        "const " + name + ": readonly string\\[\\] = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)",
      ).exec(loader);
      expect(declaration).not.toBe(null);
      return [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
    };

    const entryKeys = table("ENTRY_KEYS");
    const documentKeys = table("DOCUMENT_KEYS");
    // The scan has to have found something, or a bijection with an empty set
    // would pass over a loader this test never read.
    expect(entryKeys.length).toBe(13);
    expect(documentKeys.length).toBe(4);

    expect([...ADAPTER_ENTRY_KEYS].sort()).toEqual(entryKeys);
    expect([...ADAPTER_DOCUMENT_KEYS].sort()).toEqual(documentKeys);
    for (const key of entryKeys) expect(ADAPTER_ENTRY_KEYS).toContain(key);
    for (const key of ADAPTER_ENTRY_KEYS) expect(entryKeys).toContain(key);
    for (const key of documentKeys) expect(ADAPTER_DOCUMENT_KEYS).toContain(key);
    for (const key of ADAPTER_DOCUMENT_KEYS) expect(documentKeys).toContain(key);
  });

  it("C1: the consumption vocabulary is QuotaObservation's, both directions", () => {
    const quota = readFileSync(QUOTA, "utf8");
    const body = /export interface QuotaObservation \{([\s\S]*?)\n\}/.exec(quota);
    expect(body).not.toBe(null);
    const members = [...body[1].matchAll(/^\s*readonly ([A-Za-z0-9_]+)\s*:/gm)]
      .map((match) => match[1])
      .sort();
    expect(members).toEqual(["observedAt", "tokensUsed"]);
    expect([...CONSUMPTION_OBSERVATION_KEYS].sort()).toEqual(members);
  });

  it("C2: the adapter names the published document and its pin, and no third registry-shaped path", () => {
    const source = readFileSync(ADAPTER, "utf8");
    const jsonLiterals = new Set(
      [...source.matchAll(/"([^"\n]*\.json)"/g)].map((match) => match[1]),
    );
    expect([...jsonLiterals].sort()).toEqual(
      [POLICY_DOCUMENT_PATH, POLICY_PIN_PATH].sort(),
    );
    expect(POLICY_DOCUMENT_PATH).toBe("packages/domains/accounts/policy/capability-policy.json");
    expect(POLICY_PIN_PATH).toBe("scripts/policy-version-digests.json");
  });

  it("C2: the adapter reaches no package and no network", () => {
    const source = readFileSync(ADAPTER, "utf8");
    const specifiers = [...source.matchAll(/^\s*import[^;]*?from\s+"([^"]+)"/gm)].map(
      (match) => match[1],
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier.startsWith("node:")).toBe(true);
    }
    expect(source).not.toContain("@acp/");
    expect(source).not.toContain("http://");
    expect(source).not.toContain("https://");
  });
});

// ---------------------------------------------------------------------------
// E. no benchmark without accounting for what it consumed
// ---------------------------------------------------------------------------

describe("E. a cut accounts for what the run consumed", () => {
  it("E1: an eval-output with no accounting block is refused", () => {
    const withoutBlock = { models: evalOutput(DESCENDING).models };
    const absent = cutRegistryVersion({
      current: CURRENT,
      evalOutput: withoutBlock,
      version: VERSION,
      evaluatedAt: AT,
    });
    expect(absent.ok).toBe(false);
    expect(absent.reason).toBe("EVAL_CONSUMPTION_UNACCOUNTED");
    expect(absent.at).toBe("evalOutput.accounting");

    const malformed = cutRegistryVersion({
      current: CURRENT,
      evalOutput: evalOutput(DESCENDING, { accounting: { runId: "r-1" } }),
      version: VERSION,
      evaluatedAt: AT,
    });
    expect(malformed.ok).toBe(false);
    expect(malformed.reason).toBe("EVAL_CONSUMPTION_UNACCOUNTED");

    const notCounted = evalOutput(DESCENDING);
    notCounted.accounting.perProvider[0].tokensUsed = null;
    const uncounted = cutRegistryVersion({
      current: CURRENT,
      evalOutput: notCounted,
      version: VERSION,
      evaluatedAt: AT,
    });
    expect(uncounted.ok).toBe(false);
    expect(uncounted.reason).toBe("EVAL_CONSUMPTION_UNACCOUNTED");
    expect(uncounted.at).toBe("evalOutput.accounting.perProvider[0].tokensUsed");
  });

  it("E2: a subscription run is refused unconditionally, because R15 has no lawful authorization", () => {
    const subscription = evalOutput(DESCENDING, {
      accounting: accounting({
        perProvider: [
          {
            provider: "claude",
            transport: "CLI_SUBSCRIPTION",
            calls: 3,
            tokensUsed: 900,
            observedAt: AT,
          },
        ],
        subscriptionCalls: 3,
      }),
    });

    const unauthorized = cutRegistryVersion({
      current: CURRENT,
      evalOutput: subscription,
      version: VERSION,
      evaluatedAt: AT,
    });
    expect(unauthorized.ok).toBe(false);
    expect(unauthorized.reason).toBe("EVAL_SUBSCRIPTION_UNAUTHORIZED");
    expect(unauthorized.at).toBe("evalOutput.accounting.perProvider[0].transport");

    // And no value of the authorization seam changes that. There is no lawful
    // token in R15: the owner gate is a refusal in code, not a prose promise.
    for (const claim of ["owner", "", true, { signature: "x" }]) {
      const claimed = cutRegistryVersion({
        current: CURRENT,
        evalOutput: subscription,
        version: VERSION,
        evaluatedAt: AT,
        consumption: { subscriptionAuthorization: claim },
      });
      expect(claimed.ok).toBe(false);
      expect(claimed.reason).toBe("EVAL_SUBSCRIPTION_UNAUTHORIZED");
    }

    // Even over a run that consumed no subscription call at all: claiming the
    // authorization is itself the refusal, so the seam cannot be warmed up.
    const idle = cutRegistryVersion({
      current: CURRENT,
      evalOutput: evalOutput(DESCENDING),
      version: VERSION,
      evaluatedAt: AT,
      consumption: { subscriptionAuthorization: "owner" },
    });
    expect(idle.ok).toBe(false);
    expect(idle.reason).toBe("EVAL_SUBSCRIPTION_UNAUTHORIZED");
    expect(idle.at).toBe("consumption.subscriptionAuthorization");
  });

  it("E3: a well-formed block with no subscription call lets the cut proceed", () => {
    const result = cutRegistryVersion({
      current: CURRENT,
      evalOutput: evalOutput(DESCENDING),
      version: VERSION,
      evaluatedAt: AT,
      consumption: {},
    });
    expect(result.ok).toBe(true);
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
