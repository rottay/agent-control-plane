import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AccountRecord,
  CLI_SUBSCRIPTION_PROVIDERS,
  CONTRACT_VERSION,
  ResolvedRoute,
  TRANSPORT_KINDS,
} from "@acp/contracts";
import type { TransportKind } from "@acp/contracts";
import { describe, expect, it } from "vitest";

import * as accounts from "../../src/index.js";
import { POLICY_REFUSALS, buildPolicyRegistry, loadPolicyRegistry } from "../../src/policy/index.js";
import type { PolicyRegistry, PolicyRouteRequest } from "../../src/policy/index.js";
import type { QuotaEstimate, QuotaOutcome } from "../../src/quota/index.js";
import { RESOLUTION_REFUSALS, resolveRoute } from "../../src/resolution/index.js";
import type { RouteResolutionOutcome } from "../../src/resolution/index.js";
import { DEFAULT_ROUTING_CONFIG, EVIDENCE_ABSENT, ROUTING_REFUSALS } from "../../src/routing/index.js";
import type { CandidateEvidence, RoutingRequest } from "../../src/routing/index.js";

/**
 * Evidence for the resolution entry point (V2-B1a).
 *
 * Three things are proved here, and the order is the order of the preaudit's
 * corrections. The value is deterministic and sourced: provider, model,
 * account, transport and policy version all come from the data the function
 * was handed — the shipped `capability-policy.json` read from disk, and a
 * registry of records — and the instant comes from the caller (C2). The
 * contract holds, not just the value: the output parses through contracts' own
 * `ResolvedRoute` schema, and the schema's negative refinement is proved both
 * directly and through the function, which refuses rather than emitting an
 * unlawful route (C1, C3). And an unknown model refuses closed: the seam names
 * a reason from a closed vocabulary and never improvises a route (ruling
 * punto 3).
 *
 * Nothing here reads a clock; every instant is a literal.
 */

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const SHIPPED = resolve(HERE, "../../policy/capability-policy.json");
const MODULE = resolve(HERE, "../../src/resolution/index.ts");
const BARREL = resolve(HERE, "../../src/index.ts");

/** Every instant is a literal; nothing here reads a clock. */
const NOW = "2026-08-30T12:00:00Z";
const RESET = "2026-08-30T13:00:00Z";
const RESOLVED_AT = "2026-08-30T12:00:05Z";
const HOUR_MS = 3_600_000;

/** Comment-stripped source, for the assertions about what a module names. */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
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

function registryOf(models: readonly Entry[], policyVersion = "test.1"): PolicyRegistry {
  const outcome = buildPolicyRegistry({ policyVersion, evaluatedAt: NOW, models });
  if (!outcome.ok) throw new Error("fixture is not a valid registry: " + outcome.reason);
  return outcome.registry;
}

/** The shipped document, loaded rather than built: real registry data. */
function shipped(): PolicyRegistry {
  const outcome = loadPolicyRegistry(SHIPPED);
  if (!outcome.ok) throw new Error("the shipped registry did not load: " + outcome.reason);
  return outcome.registry;
}

// ---------------------------------------------------------------------------
// Routing fixtures — the shape `rankAccounts` already takes
// ---------------------------------------------------------------------------

function record(accountId: string, enabledModels: readonly string[], provider = "claude"): AccountRecord {
  const parsed = AccountRecord.safeParse({
    contractVersion: CONTRACT_VERSION,
    accountId,
    provider,
    alias: accountId,
    authMode: "PREAUTHENTICATED_PROFILE",
    authProfileRef: "profile://acp-b1a-" + accountId,
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
    isolatedConfigRoot: "/tmp/acp-b1a-" + accountId,
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

/** One account, enabling exactly the models named, belonging to `provider`. */
function routing(accountId: string, enabledModels: readonly string[], provider = "claude"): RoutingRequest {
  const outcome: QuotaOutcome = { ok: true, estimate: estimate(accountId) };
  return {
    records: [record(accountId, enabledModels, provider)],
    estimates: [{ accountId, outcome }],
    evidence: [absent(accountId)],
    task: {
      // Ignored by the policy seam, which chooses the model. Set to something
      // no document names, so a resolution that honoured it would fail here.
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

function request(
  enabledModels: readonly string[],
  overrides: Partial<PolicyRouteRequest> = {},
  provider = "claude",
): PolicyRouteRequest {
  return {
    role: "implementer",
    routing: routing("acct-a", enabledModels, provider),
    transportKind: "CLI_SUBSCRIPTION",
    ...overrides,
  };
}

function resolved(outcome: RouteResolutionOutcome) {
  if (!outcome.ok) throw new Error("expected a resolution, got " + outcome.reason);
  return outcome;
}

// ---------------------------------------------------------------------------
// Determinism from the shipped registry
// ---------------------------------------------------------------------------

describe("the resolution is deterministic over the shipped registry", () => {
  it("composes provider, model, account, transport and version from the data it was handed, and the instant from the caller", () => {
    const registry = shipped();
    const outcome = resolved(resolveRoute(request(["opus", "sonnet"]), registry, RESOLVED_AT));

    // Every field is sourced, and the source is named: the first entry of the
    // shipped document (preference is document order), the ranked account, the
    // request's transport, the document's version, and the caller's instant.
    const first = registry.models[0];
    if (first === undefined) throw new Error("the shipped registry has no entries");
    expect(outcome.route).toEqual({
      provider: first.provider,
      model: first.model,
      accountId: "acct-a",
      transportKind: "CLI_SUBSCRIPTION",
      capabilityPolicyVersion: registry.policyVersion,
      resolvedAt: RESOLVED_AT,
    });
    expect(outcome.viaFallbackFrom).toBeNull();
    expect(outcome.recommendation.ranked.map((ranked) => ranked.accountId)).toEqual(["acct-a"]);

    // The same three values, read straight from the bytes on disk rather than
    // through the loader, so the proof does not rest on the loader agreeing
    // with itself.
    const raw = JSON.parse(readFileSync(SHIPPED, "utf8")) as {
      policyVersion: string;
      models: { model: string; provider: string }[];
    };
    expect({
      provider: outcome.route.provider,
      model: outcome.route.model,
      version: outcome.route.capabilityPolicyVersion,
    }).toEqual({
      provider: raw.models[0]?.provider,
      model: raw.models[0]?.model,
      version: raw.policyVersion,
    });
  });

  it("returns identical outcomes for identical inputs, and a second instant changes exactly one field", () => {
    const registry = shipped();
    const first = resolved(resolveRoute(request(["opus", "sonnet"]), registry, RESOLVED_AT));
    const second = resolved(resolveRoute(request(["opus", "sonnet"]), registry, RESOLVED_AT));
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    // C2: the instant is the caller's. It is the only thing that moves when
    // the caller moves it, which is what "not a clock read" means in a test.
    const later = resolved(resolveRoute(request(["opus", "sonnet"]), registry, "2026-08-30T12:00:06Z"));
    expect(later.route).toEqual({ ...first.route, resolvedAt: "2026-08-30T12:00:06Z" });
  });

  it("freezes what it returns, the route included", () => {
    const outcome = resolved(resolveRoute(request(["opus"]), shipped(), RESOLVED_AT));
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.route)).toBe(true);
  });

  it("follows a declared fallback and names it, taking the provider from the fallback's own entry", () => {
    // The shipped document declares `sonnet` as `opus`'s fallback. An account
    // that enables only `sonnet` is routed there, the choice records where it
    // came from, and the provider is the fallback entry's — not the origin's.
    const registry = shipped();
    const outcome = resolved(resolveRoute(request(["sonnet"]), registry, RESOLVED_AT));
    const fallback = registry.models.find((candidate) => candidate.model === "sonnet");
    if (fallback === undefined) throw new Error("the shipped registry no longer carries sonnet");
    expect({ model: outcome.route.model, from: outcome.viaFallbackFrom, provider: outcome.route.provider }).toEqual({
      model: "sonnet",
      from: "opus",
      provider: fallback.provider,
    });
  });
});

// ---------------------------------------------------------------------------
// The contract proof (C1, C3)
// ---------------------------------------------------------------------------

describe("the route is the contract's, not this package's", () => {
  it("parses through contracts' own ResolvedRoute schema, refinement included", () => {
    const outcome = resolved(resolveRoute(request(["opus"]), shipped(), RESOLVED_AT));
    const parsed = ResolvedRoute.safeParse(outcome.route);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("the route did not parse");
    expect(parsed.data).toEqual(outcome.route);
    // The six fields the owner ruling names, and no seventh.
    expect(Object.keys(outcome.route).sort()).toEqual([
      "accountId",
      "capabilityPolicyVersion",
      "model",
      "provider",
      "resolvedAt",
      "transportKind",
    ]);
  });

  it("the schema's negative: a CLI_SUBSCRIPTION route naming a non-CLI provider fails the refinement", () => {
    const outcome = resolved(resolveRoute(request(["opus"]), shipped(), RESOLVED_AT));
    expect(CLI_SUBSCRIPTION_PROVIDERS as readonly string[]).not.toContain("anthropic");
    const unlawful = ResolvedRoute.safeParse({ ...outcome.route, provider: "anthropic" });
    expect(unlawful.success).toBe(false);
    if (unlawful.success) throw new Error("the refinement did not fire");
    expect(unlawful.error.issues.map((issue) => issue.path)).toEqual([["provider"]]);
  });

  it("cannot emit an unlawful route: a registry entry naming a non-CLI provider over the CLI transport is refused, not emitted", () => {
    // The loader admits any provider string; the contract does not. The
    // resolution parses what it composed and refuses what the contract
    // refuses — the value never leaves, and the refusal names a path, never
    // the value. The account's record names the same provider as the entry,
    // so the F1 vocabulary check (below) agrees and it is the contract that
    // refuses here.
    const outcome = resolveRoute(
      request(["opus"], {}, "anthropic"),
      registryOf([entry("opus", { provider: "anthropic" })]),
      RESOLVED_AT,
    );
    expect(outcome).toEqual({ ok: false, reason: "RESOLUTION_ROUTE_INVALID", at: "route.provider" });
    expect(JSON.stringify(outcome)).not.toContain("anthropic");
  });

  it("holds the caller's instant and the transport kind to the contract rather than repairing them", () => {
    // An instant without an offset is exactly what the routing seam refuses
    // in `now`; the resolution refuses it in `resolvedAt` for the same reason,
    // and never resolves it in the runtime's zone.
    expect(resolveRoute(request(["opus"]), shipped(), "2026-08-30T12:00:05")).toEqual({
      ok: false,
      reason: "RESOLUTION_ROUTE_INVALID",
      at: "route.resolvedAt",
    });

    // A transport the registry and the request agree on but the kernel has
    // never heard of is refused before anything is ranked (F2, V2-B1b D8):
    // the policy seam validates the kind against the kernel's vocabulary and
    // names it by its own reason, which travels through this module
    // untranslated. The kernel's vocabulary governs.
    expect(TRANSPORT_KINDS as readonly string[]).not.toContain("SMOKE_SIGNAL");
    expect(
      resolveRoute(
        request(["opus"], { transportKind: "SMOKE_SIGNAL" as unknown as TransportKind }),
        registryOf([entry("opus", { transports: ["SMOKE_SIGNAL"] })]),
        RESOLVED_AT,
      ),
    ).toEqual({ ok: false, reason: "POLICY_TRANSPORT_UNKNOWN", at: "request.transportKind" });
  });

  it("the barrel exports the function and not the type's name (C1)", () => {
    expect(typeof accounts.resolveRoute).toBe("function");
    // The type stays contracts-owned: the barrel's code — comments stripped,
    // since the P8-5 note mentions the name in prose — never carries it, and
    // the module imports it from the kernel rather than declaring one.
    const barrel = codeOf(BARREL);
    expect(barrel).toContain('export { resolveRoute } from "./resolution/index.js";');
    expect(barrel).not.toContain("ResolvedRoute");
    const module = codeOf(MODULE);
    expect(module).toContain('from "@acp/contracts"');
    for (const redeclaration of ["const ResolvedRoute", "interface ResolvedRoute", "type ResolvedRoute", "export { ResolvedRoute", "export type { ResolvedRoute"]) {
      expect({ redeclaration, present: module.includes(redeclaration) }).toEqual({ redeclaration, present: false });
    }
  });
});

// ---------------------------------------------------------------------------
// F1: the two provider vocabularies agree, or nothing routes (V2-B1b D7)
// ---------------------------------------------------------------------------

describe("the provider the record names must be the provider the entry names", () => {
  it("refuses a mismatch closed at the route's provider, and never aliases", () => {
    // An `anthropic`-era record meets a `claude` entry. The ranking cannot see
    // it -- `rankAccounts` gates on enabled models -- so the resolution is the
    // seam that has to, and it refuses rather than translating one vocabulary
    // into the other. The refusal names a path, never either value.
    const outcome = resolveRoute(
      request(["opus"], {}, "anthropic"),
      registryOf([entry("opus", { provider: "claude" })]),
      RESOLVED_AT,
    );
    expect(outcome).toEqual({ ok: false, reason: "RESOLUTION_PROVIDER_MISMATCH", at: "route.provider" });
    expect(JSON.stringify(outcome)).not.toContain("anthropic");
  });

  it("resolves when the two agree, whichever vocabulary they share", () => {
    const agreed = resolved(
      resolveRoute(request(["opus"], {}, "claude"), registryOf([entry("opus", { provider: "claude" })]), RESOLVED_AT),
    );
    expect(agreed.route.provider).toBe("claude");
    // Agreement is checked, not the spelling: a non-CLI vocabulary that agrees
    // with itself passes this seam and is then judged by the contract alone.
    expect(
      resolveRoute(request(["opus"], {}, "anthropic"), registryOf([entry("opus", { provider: "anthropic" })]), RESOLVED_AT),
    ).toEqual({ ok: false, reason: "RESOLUTION_ROUTE_INVALID", at: "route.provider" });
  });

  it("passes the policy seam's classified refusal for a request that is not an object (F4)", () => {
    // The null guard lives at the policy seam (D9); this module hands the
    // refusal on untranslated instead of crashing on its own destructuring.
    expect(resolveRoute(null as unknown as PolicyRouteRequest, shipped(), RESOLVED_AT)).toEqual({
      ok: false,
      reason: "POLICY_REQUEST_INVALID",
      at: "request",
    });
  });

  it("pins the resolution vocabulary at exactly three sorted names", () => {
    expect([...RESOLUTION_REFUSALS]).toEqual([
      "RESOLUTION_CHOICE_INCOMPLETE",
      "RESOLUTION_PROVIDER_MISMATCH",
      "RESOLUTION_ROUTE_INVALID",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The failing fixture: an unknown model refuses closed (ruling punto 3)
// ---------------------------------------------------------------------------

describe("an unknown model refuses closed and never improvises", () => {
  it("a registry naming only a model no account enables is refused by the router's own reason", () => {
    // The policy knows one model and the account enables two others. The
    // router refuses the model by name, the policy passes that refusal
    // through, and the resolution has nothing truer to add: no route, no
    // substitution of a model the account does enable.
    const outcome = resolveRoute(request(["opus", "sonnet"]), registryOf([entry("ghost-model")]), RESOLVED_AT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("NO_ELIGIBLE_ACCOUNT");
    if (!("rejected" in outcome)) throw new Error("expected the router's refusal to travel");
    expect(outcome.rejected.map((rejected) => rejected.reason)).toEqual(["MODEL_NOT_ENABLED"]);
    expect("route" in outcome).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("opus");
  });

  it("a registry with no entry eligible for the role is refused by the policy's own reason", () => {
    const outcome = resolveRoute(
      request(["opus"], { role: "coordinator" }),
      registryOf([entry("ghost-model")]),
      RESOLVED_AT,
    );
    expect(outcome).toEqual({ ok: false, reason: "POLICY_NO_ELIGIBLE_MODEL", at: "models" });
  });

  it("every refusal it can return is a name from a closed, sorted vocabulary", () => {
    expect([...RESOLUTION_REFUSALS]).toEqual([...RESOLUTION_REFUSALS].sort());
    expect(new Set(RESOLUTION_REFUSALS).size).toBe(RESOLUTION_REFUSALS.length);

    const closed = new Set<string>([...ROUTING_REFUSALS, ...POLICY_REFUSALS, ...RESOLUTION_REFUSALS]);
    const outcomes = [
      resolveRoute(request(["opus", "sonnet"]), registryOf([entry("ghost-model")]), RESOLVED_AT),
      resolveRoute(request(["opus"], { role: "coordinator" }), registryOf([entry("ghost-model")]), RESOLVED_AT),
      resolveRoute(request(["opus"]), registryOf([entry("opus", { provider: "anthropic" })]), RESOLVED_AT),
    ];
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected a refusal");
      expect({ reason: outcome.reason, closed: closed.has(outcome.reason) }).toEqual({
        reason: outcome.reason,
        closed: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The module's own laws
// ---------------------------------------------------------------------------

describe("the module keeps its own laws", () => {
  const code = codeOf(MODULE);

  it("reads no clock and rolls no dice (C2)", () => {
    for (const token of ["Date.now", "new Date(", "Date.parse", "performance.now", "Math.random"]) {
      expect({ token, present: code.includes(token) }).toEqual({ token, present: false });
    }
  });

  it("reads no environment and touches no filesystem or ledger", () => {
    for (const token of ["process.env", "node:fs", "readFileSync", ["@acp", "ledger"].join("/"), ".append("]) {
      expect({ token, present: code.includes(token) }).toEqual({ token, present: false });
    }
  });

  it("takes the policy version from the choice and never reads the registry's own", () => {
    // `routeWithPolicy` is the only producer of `capabilityPolicyVersion`.
    // Reading `policyVersion` here as well would be two readers of one
    // document, and two answers the moment it is re-cut between them.
    expect(code.includes(".policyVersion")).toBe(false);
    expect(code.includes("routeWithPolicy(")).toBe(true);
  });
});
