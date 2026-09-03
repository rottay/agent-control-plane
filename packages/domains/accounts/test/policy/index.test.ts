import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AccountRecord, CONTRACT_VERSION, TRANSPORT_KINDS } from "@acp/contracts";
import type { TransportKind } from "@acp/contracts";
import { afterAll, describe, expect, it } from "vitest";

import {
  POLICY_REFUSALS,
  buildPolicyRegistry,
  loadPolicyRegistry,
  routeWithPolicy,
} from "../../src/policy/index.js";
import type { PolicyRegistry, PolicyRouteRequest } from "../../src/policy/index.js";
import type { QuotaEstimate, QuotaOutcome } from "../../src/quota/index.js";
import { DEFAULT_ROUTING_CONFIG, EVIDENCE_ABSENT } from "../../src/routing/index.js";
import type { CandidateEvidence, RoutingRequest } from "../../src/routing/index.js";

/**
 * Evidence for the versioned capability/policy registry.
 *
 * The acceptance criterion law 4 is judged by is blunt: a policy update changes
 * the eligible model chosen **with no source change**, and the outcome records
 * which version of the policy chose it. The drill at the foot of this file is
 * that criterion, run rather than described — two documents, distinct versions,
 * one preference order reversed, and the diff between the two runs is the data.
 */

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const SHIPPED = resolve(HERE, "../../policy/capability-policy.json");

/** Every instant is a literal; nothing here reads a clock. */
const NOW = "2026-08-30T12:00:00Z";
const RESET = "2026-08-30T13:00:00Z";
const HOUR_MS = 3_600_000;

const TMP_ROOT = realpathSync(tmpdir());
const created: string[] = [];

afterAll(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

function drillRoot(): string {
  const path = join(TMP_ROOT, "acp-p85-policy-" + String(created.length) + "-" + String(process.pid));
  mkdirSync(path, { recursive: true, mode: 0o700 });
  created.push(path);
  return path;
}

/** Write a document to a real file, since the loader takes a path and only a path. */
function writeDocument(document: unknown): string {
  const path = join(drillRoot(), "capability-policy.json");
  writeFileSync(path, JSON.stringify(document, null, 2), { encoding: "utf8", mode: 0o600 });
  return path;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

type Entry = Readonly<Record<string, unknown>>;

function entry(model: string, overrides: Entry = {}): Entry {
  return {
    model,
    provider: "claude",
    release: null,
    eligibleRoles: ["implementer"],
    quality: { score: null, confidence: "UNKNOWN" },
    latency: { p50Seconds: null, confidence: "UNKNOWN" },
    contextTokens: null,
    supports: { tools: "UNKNOWN", vision: "UNKNOWN", streaming: "UNKNOWN" },
    transports: ["CLI_SUBSCRIPTION"],
    quotaConfidence: "LOW",
    costPerMillionTokens: null,
    evaluatedAt: NOW,
    allowedFallbacks: [],
    ...overrides,
  };
}

function document(models: readonly Entry[], policyVersion = "test.1"): Readonly<Record<string, unknown>> {
  return { policyVersion, evaluatedAt: NOW, models };
}

function registryOf(models: readonly Entry[], policyVersion = "test.1"): PolicyRegistry {
  const outcome = buildPolicyRegistry(document(models, policyVersion));
  if (!outcome.ok) throw new Error("fixture is not a valid registry: " + outcome.reason);
  return outcome.registry;
}

// ---------------------------------------------------------------------------
// Routing fixtures — the shape `rankAccounts` already takes
// ---------------------------------------------------------------------------

function record(accountId: string, enabledModels: readonly string[]): AccountRecord {
  const parsed = AccountRecord.safeParse({
    contractVersion: CONTRACT_VERSION,
    accountId,
    provider: "anthropic",
    alias: accountId,
    authMode: "PREAUTHENTICATED_PROFILE",
    authProfileRef: "profile://acp-p85-" + accountId,
    credentialRef: null,
    plan: "max",
    enabledModels: [...enabledModels],
    knownLimits: { weekly: 1_000_000 },
    resetSchedule: { kind: "DECLARED", nextResetAt: RESET, timezone: "UTC", confidence: "HIGH" },
    quotaEstimate: {
      remainingRatio: 0.5,
      estimatedTokensRemaining: 500_000,
      estimatedAt: NOW,
      confidence: "MEDIUM",
    },
    lastHealthProbe: null,
    lastClassifiedError: null,
    status: "AVAILABLE",
    isolatedConfigRoot: "/tmp/acp-p85-" + accountId,
    contextSwitchCost: { estimatedTokens: 1_000, estimatedSeconds: 10 },
  });
  if (!parsed.success) throw new Error("fixture is not a valid AccountRecord");
  return parsed.data;
}

function estimate(accountId: string): QuotaEstimate {
  return {
    accountId,
    limitKey: "weekly",
    limitTokens: 1_000_000,
    observedTokensUsed: 500_000,
    observationCount: 3,
    remainingRatio: 0.5,
    estimatedTokensRemaining: 500_000,
    overBudget: false,
    confidence: "MEDIUM",
    estimatedAt: NOW,
    reset: {
      kind: "DECLARED",
      nextResetAt: RESET,
      timezone: "UTC",
      millisUntilReset: HOUR_MS,
      confidence: "HIGH",
    },
  };
}

function absent(accountId: string): CandidateEvidence {
  return {
    accountId,
    acceptance: EVIDENCE_ABSENT,
    contextAffinity: EVIDENCE_ABSENT,
    capabilities: { known: false },
  };
}

/** One account, enabling exactly the models named. */
function routing(accountId: string, enabledModels: readonly string[]): RoutingRequest {
  const outcome: QuotaOutcome = { ok: true, estimate: estimate(accountId) };
  return {
    records: [record(accountId, enabledModels)],
    estimates: [{ accountId, outcome }],
    evidence: [absent(accountId)],
    task: {
      // Ignored by the seam: the policy chooses the model. It is set to
      // something no document below names, so a test that passed by honouring
      // it rather than the policy would fail here instead of silently agreeing.
      model: "never-chosen-by-policy",
      estimatedTokens: 10_000,
      estimatedDurationSeconds: 60,
      reserveTokens: 5_000,
      requiredCapabilities: [],
    },
    config: DEFAULT_ROUTING_CONFIG,
    now: NOW,
  };
}

// ---------------------------------------------------------------------------
// The shipped document
// ---------------------------------------------------------------------------

describe("the shipped registry is data this package can read", () => {
  it("loads, freezes, and carries every field law 4 names", () => {
    const outcome = loadPolicyRegistry(SHIPPED);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("the shipped registry did not load: " + outcome.reason);

    const { registry } = outcome;
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.models)).toBe(true);
    expect(registry.models.length).toBeGreaterThan(0);

    const first = registry.models[0];
    if (first === undefined) throw new Error("no entries");
    // The eleven fields, by name rather than by count, so a rename is a failure
    // and not a silent pass.
    expect(Object.keys(first).sort()).toEqual([
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
  });

  it("seeds the three landed CLI providers, and claims no measurement it does not have", () => {
    const outcome = loadPolicyRegistry(SHIPPED);
    if (!outcome.ok) throw new Error("the shipped registry did not load");

    expect([...new Set(outcome.registry.models.map((entry) => entry.provider))].sort()).toEqual([
      "claude",
      "codex",
      "kimi",
    ]);

    // Conservative seed, and honestly so: nothing here has been measured, and a
    // registry that defaulted an unmeasured quality to a number would be
    // inventing the evidence law 4 exists to record. `UNKNOWN` is the P4
    // capability discipline, applied to policy.
    for (const entry of outcome.registry.models) {
      expect({ model: entry.model, quality: entry.quality.score, confidence: entry.quality.confidence }).toEqual(
        { model: entry.model, quality: null, confidence: "UNKNOWN" },
      );
      expect(entry.transports).toEqual(["CLI_SUBSCRIPTION"]);
    }
  });
});

// ---------------------------------------------------------------------------
// The loader's laws
// ---------------------------------------------------------------------------

describe("the loader finds nothing on its own", () => {
  it("refuses to be called with no path, and with a relative one", () => {
    expect(loadPolicyRegistry()).toEqual({ ok: false, reason: "PATH_NOT_SUPPLIED", at: "<root>" });
    expect(loadPolicyRegistry("")).toEqual({ ok: false, reason: "PATH_NOT_SUPPLIED", at: "<root>" });
    // Calling it with nothing is a refusal at runtime, not a compiler opinion a
    // caller can cast away — the same law the owner file's loader holds.
    expect(loadPolicyRegistry("policy/capability-policy.json")).toEqual({
      ok: false,
      reason: "PATH_NOT_ABSOLUTE",
      at: "<root>",
    });
  });

  it("refuses an absent file, a directory, and bytes that are not JSON", () => {
    const root = drillRoot();
    expect(loadPolicyRegistry(join(root, "nothing.json")).ok).toBe(false);
    expect(loadPolicyRegistry(root)).toEqual({
      ok: false,
      reason: "POLICY_FILE_NOT_REGULAR",
      at: "<root>",
    });

    const bad = join(root, "bad.json");
    writeFileSync(bad, "{ not json", "utf8");
    expect(loadPolicyRegistry(bad)).toEqual({ ok: false, reason: "POLICY_FILE_NOT_JSON", at: "<root>" });
  });

  it("names the path it refused at, never a value from the document", () => {
    const path = writeDocument(document([entry("opus", { quotaConfidence: "SOMEWHAT" })]));
    const outcome = loadPolicyRegistry(path);
    expect(outcome).toEqual({
      ok: false,
      reason: "POLICY_FILE_INVALID",
      at: "models[0].quotaConfidence",
    });
    // The refused value does not travel. A registry is not credential material,
    // but the discipline is the package's and does not get relaxed per file.
    expect(JSON.stringify(outcome)).not.toContain("SOMEWHAT");
  });
});

describe("the document's shape is closed in both directions", () => {
  it("refuses an unexpected key and a missing one, naming which", () => {
    const extra = buildPolicyRegistry({ ...document([entry("opus")]), notes: "hello" });
    expect(extra).toEqual({ ok: false, reason: "POLICY_UNKNOWN_KEY", at: "<root>.notes" });

    const withoutRelease = { ...entry("opus") } as Record<string, unknown>;
    delete withoutRelease["release"];
    expect(buildPolicyRegistry(document([withoutRelease]))).toEqual({
      ok: false,
      reason: "POLICY_UNKNOWN_KEY",
      at: "models[0].release",
    });
  });

  it("refuses a duplicate model and a fallback naming nothing", () => {
    expect(buildPolicyRegistry(document([entry("opus"), entry("opus")]))).toEqual({
      ok: false,
      reason: "POLICY_DUPLICATE_MODEL",
      at: "models[1].model",
    });

    expect(
      buildPolicyRegistry(document([entry("opus", { allowedFallbacks: ["ghost"] })])),
    ).toEqual({ ok: false, reason: "POLICY_FALLBACK_UNKNOWN", at: "models[0].allowedFallbacks" });
  });

  it("keeps its refusal vocabulary closed and sorted", () => {
    expect([...POLICY_REFUSALS]).toEqual([...POLICY_REFUSALS].sort());
    expect(new Set(POLICY_REFUSALS).size).toBe(POLICY_REFUSALS.length);
  });
});

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

describe("routeWithPolicy is the only place a policy version is stamped", () => {
  it("chooses the model from the policy and ignores the one on the request", () => {
    const outcome = routeWithPolicy(
      { role: "implementer", routing: routing("acct-a", ["opus"]), transportKind: "CLI_SUBSCRIPTION" },
      registryOf([entry("opus")]),
    );
    expect(outcome.ok).toBe(true);
    if (!("model" in outcome)) throw new Error("expected a choice");
    expect({ model: outcome.model, version: outcome.capabilityPolicyVersion }).toEqual({
      model: "opus",
      version: "test.1",
    });
  });

  it("refuses when the role or the transport makes every entry ineligible", () => {
    const wrongRole = routeWithPolicy(
      { role: "coordinator", routing: routing("acct-a", ["opus"]), transportKind: "CLI_SUBSCRIPTION" },
      registryOf([entry("opus")]),
    );
    expect(wrongRole).toEqual({ ok: false, reason: "POLICY_NO_ELIGIBLE_MODEL", at: "models" });

    const wrongTransport = routeWithPolicy(
      { role: "implementer", routing: routing("acct-a", ["opus"]), transportKind: "API_KEY" },
      registryOf([entry("opus")]),
    );
    expect(wrongTransport).toEqual({ ok: false, reason: "POLICY_NO_ELIGIBLE_MODEL", at: "models" });
  });

  it("refuses a transport the kernel does not know BEFORE ranking, by its own name (F2, D8)", () => {
    // The entry declares the unknown kind, so the policy alone would find it
    // eligible; the request's records would rank if ranking ran. Neither
    // happens: the kind is validated against the kernel's vocabulary first,
    // and the refusal is its own -- never `POLICY_NO_ELIGIBLE_MODEL`, which
    // keeps meaning "the registry could not serve a lawful request".
    expect(TRANSPORT_KINDS as readonly string[]).not.toContain("SMOKE_SIGNAL");
    const unknown = "SMOKE_SIGNAL" as unknown as TransportKind;
    expect(
      routeWithPolicy(
        { role: "implementer", routing: routing("acct-a", ["opus"]), transportKind: unknown },
        registryOf([entry("opus", { transports: ["SMOKE_SIGNAL"] })]),
      ),
    ).toEqual({ ok: false, reason: "POLICY_TRANSPORT_UNKNOWN", at: "request.transportKind" });

    // Ordering, proved rather than asserted: with no records at all the
    // router refuses in its own vocabulary when the transport is lawful, and
    // says nothing at all when it is not -- the transport refusal came first.
    const noRecords = { ...routing("acct-a", ["opus"]), records: [] };
    const ranked = routeWithPolicy(
      { role: "implementer", routing: noRecords, transportKind: "CLI_SUBSCRIPTION" },
      registryOf([entry("opus")]),
    );
    expect(ranked.ok).toBe(false);
    if (ranked.ok) throw new Error("expected a refusal");
    expect(ranked.reason).not.toBe("POLICY_TRANSPORT_UNKNOWN");
    expect(
      routeWithPolicy(
        { role: "implementer", routing: noRecords, transportKind: unknown },
        registryOf([entry("opus", { transports: ["SMOKE_SIGNAL"] })]),
      ),
    ).toEqual({ ok: false, reason: "POLICY_TRANSPORT_UNKNOWN", at: "request.transportKind" });
  });

  it("refuses a request that is not an object, classified and never a TypeError (F4, D9)", () => {
    // The exact shape `rankAccounts` carries: the request is proved to be an
    // object before anything is read out of it.
    for (const broken of [null, undefined, 42, "request", true]) {
      expect(routeWithPolicy(broken as unknown as PolicyRouteRequest, registryOf([entry("opus")]))).toEqual({
        ok: false,
        reason: "POLICY_REQUEST_INVALID",
        at: "request",
      });
    }
    expect(POLICY_REFUSALS).toContain("POLICY_REQUEST_INVALID");
    expect(POLICY_REFUSALS).toContain("POLICY_TRANSPORT_UNKNOWN");
    expect([...POLICY_REFUSALS]).toEqual([...POLICY_REFUSALS].sort());
    expect(new Set(POLICY_REFUSALS).size).toBe(POLICY_REFUSALS.length);
  });

  it("follows a declared fallback and says so, rather than falling back silently", () => {
    // The account cannot serve `opus`, so the router refuses it; the policy's
    // declared fallback is tried next and the choice records where it came from.
    const outcome = routeWithPolicy(
      { role: "implementer", routing: routing("acct-a", ["sonnet"]), transportKind: "CLI_SUBSCRIPTION" },
      registryOf([entry("opus", { allowedFallbacks: ["sonnet"] }), entry("sonnet")]),
    );
    if (!("model" in outcome)) throw new Error("expected a choice");
    expect({ model: outcome.model, from: outcome.viaFallbackFrom }).toEqual({
      model: "sonnet",
      from: "opus",
    });
  });

  it("will not let a fallback widen a permission the policy withheld", () => {
    // `sonnet` is a declared fallback of `opus`, but this role may not use it.
    // A fallback that ignored eligibility would quietly grant what the policy
    // refused to state.
    const outcome = routeWithPolicy(
      { role: "implementer", routing: routing("acct-a", ["sonnet"]), transportKind: "CLI_SUBSCRIPTION" },
      registryOf([
        entry("opus", { allowedFallbacks: ["sonnet"] }),
        entry("sonnet", { eligibleRoles: ["verifier"] }),
      ]),
    );
    expect("model" in outcome).toBe(false);
  });

  it("passes the router's own refusal through rather than reclassifying it", () => {
    // No account enables the only eligible model and no fallback is declared.
    // The router's refusal names the account and the reason; the seam has
    // nothing truer to say than that, so it says nothing of its own.
    const outcome = routeWithPolicy(
      { role: "implementer", routing: routing("acct-a", ["haiku"]), transportKind: "CLI_SUBSCRIPTION" },
      registryOf([entry("opus")]),
    );
    expect("model" in outcome).toBe(false);
    if ("model" in outcome) throw new Error("expected a refusal");
    expect(outcome.reason).not.toBe("POLICY_NO_ELIGIBLE_MODEL");
    expect("rejected" in outcome).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The acceptance drill (C1)
// ---------------------------------------------------------------------------

describe("a policy update changes the chosen model with no source change", () => {
  it("reverses the preference order in data alone, and records each version", () => {
    // One account that can serve either model, so the choice is the policy's
    // and nothing else's.
    const request = {
      role: "implementer" as const,
      routing: routing("acct-a", ["opus", "sonnet"]),
      transportKind: "CLI_SUBSCRIPTION" as const,
    };

    // Two documents. The only differences are the order of `models` and the
    // version each is published under — C1: distinct versions, each recorded.
    const first = registryOf([entry("opus"), entry("sonnet")], "2026-08-30.1");
    const second = registryOf([entry("sonnet"), entry("opus")], "2026-08-30.2");

    const before = routeWithPolicy(request, first);
    const after = routeWithPolicy(request, second);
    if (!("model" in before) || !("model" in after)) throw new Error("expected two choices");

    expect({ model: before.model, version: before.capabilityPolicyVersion }).toEqual({
      model: "opus",
      version: "2026-08-30.1",
    });
    expect({ model: after.model, version: after.capabilityPolicyVersion }).toEqual({
      model: "sonnet",
      version: "2026-08-30.2",
    });

    // The criterion, stated as an assertion rather than as prose: the chosen
    // model moved, the recorded version moved with it, and the *same request*
    // object produced both. Nothing about the call site changed — the only
    // difference between the two runs is the document.
    expect(before.model).not.toBe(after.model);
    expect(before.capabilityPolicyVersion).not.toBe(after.capabilityPolicyVersion);
  });

  it("runs the same drill through documents on disk, loaded rather than built", () => {
    // The same criterion end to end: two real files, read by the loader, with
    // no source difference between the two runs.
    const firstPath = writeDocument(document([entry("opus"), entry("sonnet")], "2026-08-30.1"));
    const secondPath = writeDocument(document([entry("sonnet"), entry("opus")], "2026-08-30.2"));

    const first = loadPolicyRegistry(firstPath);
    const second = loadPolicyRegistry(secondPath);
    if (!first.ok || !second.ok) throw new Error("a drill document did not load");

    const request = {
      role: "implementer" as const,
      routing: routing("acct-a", ["opus", "sonnet"]),
      transportKind: "CLI_SUBSCRIPTION" as const,
    };
    const before = routeWithPolicy(request, first.registry);
    const after = routeWithPolicy(request, second.registry);
    if (!("model" in before) || !("model" in after)) throw new Error("expected two choices");

    expect([before.model, before.capabilityPolicyVersion]).toEqual(["opus", "2026-08-30.1"]);
    expect([after.model, after.capabilityPolicyVersion]).toEqual(["sonnet", "2026-08-30.2"]);
  });

  it("re-cuts a version without changing content, which the editorial law allows", () => {
    // Same content, new version: lawful, and the outcome records the new one.
    // The reverse — same version, new content — is what the fence refuses, and
    // it refuses it there because a loader sees one document and cannot know
    // what that version meant yesterday.
    const models = [entry("opus"), entry("sonnet")];
    const request = {
      role: "implementer" as const,
      routing: routing("acct-a", ["opus", "sonnet"]),
      transportKind: "CLI_SUBSCRIPTION" as const,
    };

    const cut1 = routeWithPolicy(request, registryOf(models, "2026-08-30.1"));
    const cut2 = routeWithPolicy(request, registryOf(models, "2026-08-31.1"));
    if (!("model" in cut1) || !("model" in cut2)) throw new Error("expected two choices");

    expect(cut1.model).toBe(cut2.model);
    expect(cut1.capabilityPolicyVersion).toBe("2026-08-30.1");
    expect(cut2.capabilityPolicyVersion).toBe("2026-08-31.1");
  });
});
