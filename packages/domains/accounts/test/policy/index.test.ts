import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AccountRecord, CONTRACT_VERSION, TRANSPORT_KINDS } from "@acp/contracts";
import type { TransportKind } from "@acp/contracts";
import { afterAll, describe, expect, it } from "vitest";

import {
  POLICY_REFUSALS,
  POLICY_SELECTION_RULES,
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

/** The rule a document publishes. Document order unless a drill says otherwise. */
type Selection = Readonly<Record<string, unknown>>;

const ORDERED: Selection = { by: "DOCUMENT_ORDER" };

/** A measuring rule at a named floor. `LOW` admits every real confidence. */
function measuring(minimumConfidence = "LOW"): Selection {
  return { by: "QUALITY_SCORE", minimumConfidence };
}

/** A measured quality, for the entries a measuring rule is allowed to order. */
function scored(score: number, confidence = "HIGH"): Entry {
  return { quality: { score, confidence } };
}

function document(
  models: readonly Entry[],
  policyVersion = "test.1",
  selection: Selection = ORDERED,
): Readonly<Record<string, unknown>> {
  return { policyVersion, evaluatedAt: NOW, selection, models };
}

function registryOf(
  models: readonly Entry[],
  policyVersion = "test.1",
  selection: Selection = ORDERED,
): PolicyRegistry {
  const outcome = buildPolicyRegistry(document(models, policyVersion, selection));
  if (!outcome.ok) throw new Error("fixture is not a valid registry: " + outcome.reason);
  return outcome.registry;
}

// ---------------------------------------------------------------------------
// Routing fixtures — the shape `rankAccounts` already takes
// ---------------------------------------------------------------------------

function record(
  accountId: string,
  enabledModels: readonly string[],
  status = "AVAILABLE",
): AccountRecord {
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
    status,
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

/** Several accounts, each enabling exactly the models named. */
function routingOf(
  accounts: readonly { readonly accountId: string; readonly models: readonly string[]; readonly status?: string }[],
): RoutingRequest {
  return {
    records: accounts.map((account) => record(account.accountId, account.models, account.status)),
    estimates: accounts.map((account) => ({
      accountId: account.accountId,
      outcome: { ok: true, estimate: estimate(account.accountId) } as QuotaOutcome,
    })),
    evidence: accounts.map((account) => absent(account.accountId)),
    task: {
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

// ---------------------------------------------------------------------------
// V2-B5/R13 — the selection rule is a document fact (ADR 0047)
// ---------------------------------------------------------------------------

const SRC = resolve(HERE, "../../src");
const POLICY_MODULE = join(SRC, "policy", "index.ts");

/** Comment-stripped source, for the assertions about what a module names. */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

function sourcesUnder(root: string): string[] {
  const found: string[] = [];
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) found.push(...sourcesUnder(path));
    else if (item.name.endsWith(".ts")) found.push(path);
  }
  return found.sort();
}

describe("the document says how its own preference is read", () => {
  it("elects a different model when only a score changes, and stamps the new version", () => {
    // The law-4 criterion, run on the axis this packet opens: one request, one
    // account that can serve either model, and two documents whose only
    // differences are one `quality.score` and the version. No source
    // difference between the two runs, and none between the two documents
    // beyond the number the rule reads.
    const request = {
      role: "implementer" as const,
      routing: routing("acct-a", ["opus", "sonnet"]),
      transportKind: "CLI_SUBSCRIPTION" as const,
    };

    const first = registryOf(
      [entry("opus", scored(0.5)), entry("sonnet", scored(0.9))],
      "measured.1",
      measuring(),
    );
    const second = registryOf(
      [entry("opus", scored(0.95)), entry("sonnet", scored(0.9))],
      "measured.2",
      measuring(),
    );

    const before = routeWithPolicy(request, first);
    const after = routeWithPolicy(request, second);
    if (!("model" in before) || !("model" in after)) throw new Error("expected two choices");

    expect({ model: before.model, version: before.capabilityPolicyVersion }).toEqual({
      model: "sonnet",
      version: "measured.1",
    });
    expect({ model: after.model, version: after.capabilityPolicyVersion }).toEqual({
      model: "opus",
      version: "measured.2",
    });
    expect(before.model).not.toBe(after.model);

    // The choice explains itself in the registry's own terms: which rule, and
    // the elected entry's own measurement rather than the document's.
    expect(before.selectedBy).toEqual({ rule: "QUALITY_SCORE", measurement: 0.9, confidence: "HIGH" });
    expect(after.selectedBy).toEqual({ rule: "QUALITY_SCORE", measurement: 0.95, confidence: "HIGH" });
  });

  it("elects document-first under DOCUMENT_ORDER for the same pair, which is the non-vacuity leg", () => {
    // The same two documents under the other rule. If the drill above passed
    // because of the order the entries are written in rather than because of
    // the score, this leg would disagree with itself.
    const request = {
      role: "implementer" as const,
      routing: routing("acct-a", ["opus", "sonnet"]),
      transportKind: "CLI_SUBSCRIPTION" as const,
    };

    const first = routeWithPolicy(
      request,
      registryOf([entry("opus", scored(0.5)), entry("sonnet", scored(0.9))], "ordered.1"),
    );
    const second = routeWithPolicy(
      request,
      registryOf([entry("opus", scored(0.95)), entry("sonnet", scored(0.9))], "ordered.2"),
    );
    if (!("model" in first) || !("model" in second)) throw new Error("expected two choices");

    expect([first.model, second.model]).toEqual(["opus", "opus"]);
    expect(first.selectedBy).toEqual({ rule: "DOCUMENT_ORDER", measurement: 0.5, confidence: "HIGH" });
    expect(second.selectedBy).toEqual({ rule: "DOCUMENT_ORDER", measurement: 0.95, confidence: "HIGH" });
  });

  it("breaks ties on document position and never on the model's name", () => {
    const request = {
      role: "implementer" as const,
      routing: routing("acct-a", ["opus", "sonnet"]),
      transportKind: "CLI_SUBSCRIPTION" as const,
    };
    const forward = registryOf([entry("opus", scored(0.8)), entry("sonnet", scored(0.8))], "tie.1", measuring());
    const reversed = registryOf([entry("sonnet", scored(0.8)), entry("opus", scored(0.8))], "tie.2", measuring());

    const first = routeWithPolicy(request, forward);
    const second = routeWithPolicy(request, reversed);
    if (!("model" in first) || !("model" in second)) throw new Error("expected two choices");

    // Byte-identical scores, so the tie-break decides. Reversing the array
    // reverses the answer: an implementation that tied on the model name would
    // pass the first leg and fail this one.
    expect(first.model).toBe("opus");
    expect(second.model).toBe("sonnet");

    // And it is an answer, not a distribution.
    const answers = new Set<string>();
    for (let run = 0; run < 100; run += 1) {
      const outcome = routeWithPolicy(request, forward);
      if (!("model" in outcome)) throw new Error("expected a choice");
      answers.add(outcome.model);
    }
    expect([...answers]).toEqual(["opus"]);
  });

  it("never attempts an unmeasured entry under a measuring rule, even as a declared fallback", () => {
    // `opus` is measured and declares the unmeasured `sonnet` as its fallback.
    // The account cannot serve `opus`, so the router refuses it — and the
    // fallback is not reached, because a fallback is a permission the document
    // granted and not an exemption from the rule the document published.
    const registry = registryOf(
      [entry("opus", { ...scored(0.7), allowedFallbacks: ["sonnet"] }), entry("sonnet")],
      "measured.3",
      measuring(),
    );
    const refused = routeWithPolicy(
      { role: "implementer", routing: routing("acct-a", ["sonnet"]), transportKind: "CLI_SUBSCRIPTION" },
      registry,
    );
    expect("model" in refused).toBe(false);
    if ("model" in refused) throw new Error("expected a refusal");
    // The router's own refusal, about the account — not a policy refusal, and
    // certainly not an election of the model nobody measured.
    expect("rejected" in refused).toBe(true);

    // Non-vacuity: with an account that can serve it, the measured entry is
    // elected from the very same document.
    const elected = routeWithPolicy(
      { role: "implementer", routing: routing("acct-b", ["opus"]), transportKind: "CLI_SUBSCRIPTION" },
      registry,
    );
    if (!("model" in elected)) throw new Error("expected a choice");
    expect(elected.model).toBe("opus");
  });

  it("refuses by its own name when eligible entries exist and none is measured", () => {
    const request = {
      role: "implementer" as const,
      routing: routing("acct-a", ["opus", "sonnet"]),
      transportKind: "CLI_SUBSCRIPTION" as const,
    };

    // (b) every entry unmeasured. Asserted by equality: not
    // `POLICY_NO_ELIGIBLE_MODEL`, which would say the registry has nothing for
    // this role, and not a quiet relaxation to document order.
    expect(
      routeWithPolicy(request, registryOf([entry("opus"), entry("sonnet")], "measured.4", measuring())),
    ).toEqual({ ok: false, reason: "POLICY_NO_MEASURED_MODEL", at: "models" });

    // (c) a number without an evaluation behind it is not a measurement.
    expect(
      routeWithPolicy(
        request,
        registryOf([entry("opus", scored(0.9, "UNKNOWN"))], "measured.5", measuring()),
      ),
    ).toEqual({ ok: false, reason: "POLICY_NO_MEASURED_MODEL", at: "models" });

    // (d) measured, but below the floor the document declared.
    expect(
      routeWithPolicy(
        request,
        registryOf([entry("opus", scored(0.9, "LOW"))], "measured.6", measuring("HIGH")),
      ),
    ).toEqual({ ok: false, reason: "POLICY_NO_MEASURED_MODEL", at: "models" });

    // The floor is a floor and not an equality: `HIGH` clears a `MEDIUM` floor.
    const cleared = routeWithPolicy(
      request,
      registryOf([entry("opus", scored(0.9, "HIGH"))], "measured.7", measuring("MEDIUM")),
    );
    expect("model" in cleared).toBe(true);
  });

  it("tries a qualifying fallback immediately after the entry that declared it", () => {
    // Three measured entries; the account can serve neither the top-scored one
    // nor nothing else. The question the drill settles is precedence: does the
    // top entry's declared fallback come before the next entry in score order,
    // or does score order ignore fallbacks entirely?
    const request = {
      role: "implementer" as const,
      routing: routing("acct-a", ["sonnet", "haiku"]),
      transportKind: "CLI_SUBSCRIPTION" as const,
    };

    // Written deliberately against the score order, so document position and
    // measurement disagree and only one of them can be answering.
    const withFallback = routeWithPolicy(
      request,
      registryOf(
        [
          entry("sonnet", scored(0.8)),
          entry("haiku", scored(0.5)),
          entry("opus", { ...scored(0.9), allowedFallbacks: ["haiku"] }),
        ],
        "fallback.1",
        measuring(),
      ),
    );
    if (!("model" in withFallback)) throw new Error("expected a choice");
    // The declared fallback wins over the better-scored entry that was not
    // declared: the document said `opus` may fall back to `haiku`, and that
    // permission is read where it was written.
    expect({ model: withFallback.model, from: withFallback.viaFallbackFrom }).toEqual({
      model: "haiku",
      from: "opus",
    });
    expect(withFallback.selectedBy).toEqual({
      rule: "QUALITY_SCORE",
      measurement: 0.5,
      confidence: "HIGH",
    });

    // Remove the declaration and change nothing else: score order answers, and
    // the choice says it followed no fallback.
    const withoutFallback = routeWithPolicy(
      request,
      registryOf(
        [entry("sonnet", scored(0.8)), entry("haiku", scored(0.5)), entry("opus", scored(0.9))],
        "fallback.2",
        measuring(),
      ),
    );
    if (!("model" in withoutFallback)) throw new Error("expected a choice");
    expect({ model: withoutFallback.model, from: withoutFallback.viaFallbackFrom }).toEqual({
      model: "sonnet",
      from: null,
    });
  });
});

describe("the selection block is closed, and refuses by name", () => {
  it("refuses a document that carries no selection at all", () => {
    // The pre-packet three-key shape. No default is invented: a default would
    // be a rule no version records.
    expect(buildPolicyRegistry({ policyVersion: "test.1", evaluatedAt: NOW, models: [entry("opus")] })).toEqual({
      ok: false,
      reason: "POLICY_UNKNOWN_KEY",
      at: "<root>.selection",
    });
  });

  it("refuses a rule it does not know, and a block that is not a record", () => {
    expect(buildPolicyRegistry(document([entry("opus")], "test.1", { by: "COST" }))).toEqual({
      ok: false,
      reason: "POLICY_FILE_INVALID",
      at: "selection.by",
    });
    expect(
      buildPolicyRegistry(document([entry("opus")], "test.1", "DOCUMENT_ORDER" as unknown as Selection)),
    ).toEqual({ ok: false, reason: "POLICY_FILE_INVALID", at: "selection" });
  });

  it("puts the floor exactly where the rule reads it, in both directions", () => {
    // A floor under a rule that never reads confidence is a field the loader
    // would silently ignore; a missing floor under the rule that needs one is
    // a default the loader would silently invent. Both are refused, by name.
    expect(
      buildPolicyRegistry(
        document([entry("opus")], "test.1", { by: "DOCUMENT_ORDER", minimumConfidence: "HIGH" }),
      ),
    ).toEqual({ ok: false, reason: "POLICY_UNKNOWN_KEY", at: "selection.minimumConfidence" });

    expect(buildPolicyRegistry(document([entry("opus")], "test.1", { by: "QUALITY_SCORE" }))).toEqual({
      ok: false,
      reason: "POLICY_UNKNOWN_KEY",
      at: "selection.minimumConfidence",
    });
  });

  it("refuses UNKNOWN as a floor, which would admit what the rule excludes", () => {
    expect(buildPolicyRegistry(document([entry("opus")], "test.1", measuring("UNKNOWN")))).toEqual({
      ok: false,
      reason: "POLICY_FILE_INVALID",
      at: "selection.minimumConfidence",
    });
    expect(buildPolicyRegistry(document([entry("opus")], "test.1", measuring("SOMEWHAT")))).toEqual({
      ok: false,
      reason: "POLICY_FILE_INVALID",
      at: "selection.minimumConfidence",
    });
  });

  it("keeps the rule vocabulary closed, sorted and unique", () => {
    expect([...POLICY_SELECTION_RULES]).toEqual(["DOCUMENT_ORDER", "QUALITY_SCORE"]);
    expect([...POLICY_SELECTION_RULES]).toEqual([...POLICY_SELECTION_RULES].sort());
    expect(POLICY_REFUSALS).toContain("POLICY_NO_MEASURED_MODEL");
    expect([...POLICY_REFUSALS]).toEqual([...POLICY_REFUSALS].sort());
    expect(new Set(POLICY_REFUSALS).size).toBe(POLICY_REFUSALS.length);
  });
});

describe("eligibility is decided before measurement, and refuses in its own words", () => {
  it("does not elect a top-scored entry the role may not use", () => {
    const outcome = routeWithPolicy(
      { role: "implementer", routing: routing("acct-a", ["opus", "sonnet"]), transportKind: "CLI_SUBSCRIPTION" },
      registryOf(
        [
          entry("opus", { ...scored(0.99), eligibleRoles: ["verifier"] }),
          entry("sonnet", scored(0.2)),
        ],
        "eligible.1",
        measuring(),
      ),
    );
    if (!("model" in outcome)) throw new Error("expected a choice");
    expect(outcome.model).toBe("sonnet");
  });

  it("says NO_ELIGIBLE when the role admits nothing, not NO_MEASURED", () => {
    // Both entries are measured, and neither is for this role. The refusal has
    // to name the gate that actually fired, or the reader fixes the wrong line.
    expect(
      routeWithPolicy(
        { role: "coordinator", routing: routing("acct-a", ["opus"]), transportKind: "CLI_SUBSCRIPTION" },
        registryOf([entry("opus", scored(0.9)), entry("sonnet", scored(0.8))], "eligible.2", measuring()),
      ),
    ).toEqual({ ok: false, reason: "POLICY_NO_ELIGIBLE_MODEL", at: "models" });
  });

  it("refuses an unknown transport before it scans or scores anything", () => {
    expect(TRANSPORT_KINDS as readonly string[]).not.toContain("SMOKE_SIGNAL");
    const unknown = "SMOKE_SIGNAL" as unknown as TransportKind;
    // No records at all, so ranking would refuse if it ran, and every entry is
    // unmeasured, so the measuring rule would refuse if it ran. Neither does.
    const noRecords = { ...routing("acct-a", ["opus"]), records: [] };
    expect(
      routeWithPolicy(
        { role: "implementer", routing: noRecords, transportKind: unknown },
        registryOf([entry("opus", { transports: ["SMOKE_SIGNAL"] })], "eligible.3", measuring()),
      ),
    ).toEqual({ ok: false, reason: "POLICY_TRANSPORT_UNKNOWN", at: "request.transportKind" });
  });

  it("will not let a measured fallback widen a permission the policy withheld", () => {
    const outcome = routeWithPolicy(
      { role: "implementer", routing: routing("acct-a", ["sonnet"]), transportKind: "CLI_SUBSCRIPTION" },
      registryOf(
        [
          entry("opus", { ...scored(0.9), allowedFallbacks: ["sonnet"] }),
          entry("sonnet", { ...scored(0.95), eligibleRoles: ["verifier"] }),
        ],
        "eligible.4",
        measuring(),
      ),
    );
    expect("model" in outcome).toBe(false);
  });
});

describe("account pressure moves which account answers, never which model", () => {
  it("attempts the next model only after the router refuses every account of this one", () => {
    // Two accounts, neither able to serve the top-scored model. The model order
    // is the score's; the account axis is the router's; and when nothing is
    // left the router's own refusal travels rather than being reclassified.
    const registry = registryOf(
      [entry("haiku", scored(0.5)), entry("sonnet", scored(0.8)), entry("opus", scored(0.9))],
      "pressure.1",
      measuring(),
    );

    // Neither account can serve the top-scored `opus`; both can serve the two
    // written before it. Score order attempts `opus`, is refused on the account
    // axis, and lands on `sonnet` — document order would have stopped at
    // `haiku` without ever asking about `opus`.
    const served = routeWithPolicy(
      {
        role: "implementer",
        routing: routingOf([
          { accountId: "acct-a", models: ["sonnet", "haiku"] },
          { accountId: "acct-b", models: ["sonnet", "haiku"] },
        ]),
        transportKind: "CLI_SUBSCRIPTION",
      },
      registry,
    );
    if (!("model" in served)) throw new Error("expected a choice");
    expect({ model: served.model, from: served.viaFallbackFrom }).toEqual({ model: "sonnet", from: null });

    const exhausted = routeWithPolicy(
      {
        role: "implementer",
        routing: routingOf([{ accountId: "acct-a", models: ["enabled-nowhere-in-the-document"] }]),
        transportKind: "CLI_SUBSCRIPTION",
      },
      registry,
    );
    expect("model" in exhausted).toBe(false);
    if ("model" in exhausted) throw new Error("expected a refusal");
    expect(exhausted.reason).not.toBe("POLICY_NO_ELIGIBLE_MODEL");
    expect(exhausted.reason).not.toBe("POLICY_NO_MEASURED_MODEL");
    expect("rejected" in exhausted).toBe(true);
  });

  it("changes the account and not the model when one account is draining", () => {
    const registry = registryOf(
      [entry("sonnet", scored(0.8)), entry("opus", scored(0.9))],
      "pressure.2",
      measuring(),
    );
    const request = (drained: boolean) => ({
      role: "implementer" as const,
      routing: routingOf([
        { accountId: "acct-a", models: ["opus", "sonnet"], status: drained ? "DRAINING" : "AVAILABLE" },
        { accountId: "acct-b", models: ["opus", "sonnet"] },
      ]),
      transportKind: "CLI_SUBSCRIPTION" as const,
    });

    const before = routeWithPolicy(request(false), registry);
    const after = routeWithPolicy(request(true), registry);
    if (!("model" in before) || !("model" in after)) throw new Error("expected two choices");

    expect(before.recommendation.ranked.map((candidate) => candidate.accountId)).toEqual([
      "acct-a",
      "acct-b",
    ]);
    expect(after.recommendation.ranked.map((candidate) => candidate.accountId)).toEqual(["acct-b"]);
    expect(after.recommendation.rejected.map((candidate) => candidate.accountId)).toEqual(["acct-a"]);
    // Pressure is an account fact. The elected model does not move with it.
    expect(after.model).toBe(before.model);
    expect(after.model).toBe("opus");
  });
});

describe("versions are immutable, and there is exactly one registry", () => {
  it("elects differently per version, and identically across a re-cut", () => {
    const request = {
      role: "implementer" as const,
      routing: routing("acct-a", ["opus", "sonnet"]),
      transportKind: "CLI_SUBSCRIPTION" as const,
    };
    const models = [entry("opus", scored(0.4)), entry("sonnet", scored(0.6))];

    const cut1 = routeWithPolicy(request, registryOf(models, "measured.8", measuring()));
    const cut2 = routeWithPolicy(request, registryOf(models, "measured.9", measuring()));
    const moved = routeWithPolicy(
      request,
      registryOf([entry("opus", scored(0.7)), entry("sonnet", scored(0.6))], "measured.10", measuring()),
    );
    if (!("model" in cut1) || !("model" in cut2) || !("model" in moved)) {
      throw new Error("expected three choices");
    }

    // Same content, new version: the same election, each stamping its own.
    expect([cut1.model, cut2.model]).toEqual(["sonnet", "sonnet"]);
    expect([cut1.capabilityPolicyVersion, cut2.capabilityPolicyVersion]).toEqual([
      "measured.8",
      "measured.9",
    ]);
    // New content, new version: a different election, and the version says so.
    expect(moved.model).toBe("opus");
    expect(moved.capabilityPolicyVersion).toBe("measured.10");
  });

  it("keeps the loader and the seam in one module, so there is no second registry", () => {
    // Restriction 6 in one assertion: the evaluations produce immutable
    // versions of the one registry, never a second one. Nothing outside the
    // policy module and the barrel may load a registry, build one, or read a
    // version off a document.
    const owners = [POLICY_MODULE, join(SRC, "index.ts")];
    const offenders: string[] = [];
    for (const path of sourcesUnder(SRC)) {
      if (owners.includes(path)) continue;
      const code = codeOf(path);
      for (const token of ["loadPolicyRegistry", "buildPolicyRegistry", ".policyVersion"]) {
        if (code.includes(token)) offenders.push(path + " names " + token);
      }
    }
    expect(offenders).toEqual([]);
    // Non-vacuity: the scan walked real files, and the owner does name them.
    expect(sourcesUnder(SRC).length).toBeGreaterThan(5);
    expect(codeOf(POLICY_MODULE).includes("loadPolicyRegistry")).toBe(true);
  });

  it("reads no clock and rolls no dice, and reaches for no ledger", () => {
    // The filesystem is deliberately absent from this list: this module *is*
    // the loader, and `node:fs` is a lawful import here. What must stay absent
    // is anything that would make one document elect two different models.
    const code = codeOf(POLICY_MODULE);
    for (const token of [
      "Date.now",
      "new Date(",
      "Date.parse",
      "performance.now",
      "Math.random",
      "process.env",
      ["@acp", "ledger"].join("/"),
      ".append(",
    ]) {
      expect({ token, present: code.includes(token) }).toEqual({ token, present: false });
    }
  });

  it("publishes DOCUMENT_ORDER in the shipped document, loaded rather than built", () => {
    const outcome = loadPolicyRegistry(SHIPPED);
    if (!outcome.ok) throw new Error("the shipped registry did not load: " + outcome.reason);
    expect(outcome.registry.selection).toEqual({ by: "DOCUMENT_ORDER" });
    expect(outcome.registry.policyVersion).toBe("2026-09-06.1");
  });
});
