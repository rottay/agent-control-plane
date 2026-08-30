import { AccountRecord, CONTRACT_VERSION, ControlPlaneEvent, buildIdempotencyKey } from "@acp/contracts";
import type { ControlPlaneEventType, Lease, TaskState } from "@acp/contracts";

import type { QuotaEstimate, QuotaOutcome } from "../../../src/quota/index.js";
import { DEFAULT_ROUTING_CONFIG } from "../../../src/routing/index.js";
import type { RoutingRequest } from "../../../src/routing/index.js";
import type { SwitchRequest } from "../../../src/switching/index.js";

/**
 * P7B leg 2 pilot helpers: fixture builders, the ledger-event assembler, and
 * the live-lease fold, for the account-switch drill.
 *
 * Pure fixture builders and pure folds only. This package's own fence forbids
 * a non-`.test.ts` source from opening a ledger, minting a sha256 digest, or
 * touching the filesystem at all (`ACCOUNTS_FORBIDDEN_TOKENS`, the token scan
 * that hits every source in this tree except `*.test.ts`), so every ledger
 * open, every append and every id minted live in
 * `test/pilots/index.test.ts` -- this file only builds values and validates
 * them.
 */

// ---------------------------------------------------------------------------
// Fixed instants -- no clock
// ---------------------------------------------------------------------------

export const PILOT_ESTIMATED_AT = "2026-08-30T09:00:00.000Z";
export const PILOT_RESET_AT = "2026-08-30T10:00:00.000Z";
const HOUR_MS = 3_600_000;

/** A second writer identity for this leg, distinct from leg 1's. */
export const SWITCH_PILOT_WRITER = "claude/sonnet/implementer/02";

// ---------------------------------------------------------------------------
// Fixture builders -- modelled on the switching suite's own record()/
// estimate()/routing()/request() shapes, declared fresh for this leg
// ---------------------------------------------------------------------------

type Overrides = Partial<Record<string, unknown>>;

export function pilotAccountRecord(accountId: string, overrides: Overrides = {}): AccountRecord {
  const parsed = AccountRecord.safeParse({
    contractVersion: CONTRACT_VERSION,
    accountId,
    provider: "anthropic",
    alias: accountId,
    authMode: "PREAUTHENTICATED_PROFILE",
    authProfileRef: "profile://acp-p7b-" + accountId,
    credentialRef: null,
    plan: "max",
    enabledModels: ["opus", "sonnet"],
    knownLimits: { weekly: 1_000_000 },
    resetSchedule: {
      kind: "DECLARED",
      nextResetAt: PILOT_RESET_AT,
      timezone: "UTC",
      confidence: "HIGH",
    },
    quotaEstimate: {
      remainingRatio: 0.5,
      estimatedTokensRemaining: 500_000,
      estimatedAt: PILOT_ESTIMATED_AT,
      confidence: "MEDIUM",
    },
    lastHealthProbe: null,
    lastClassifiedError: null,
    status: "AVAILABLE",
    isolatedConfigRoot: "/tmp/acp-p7b-" + accountId,
    contextSwitchCost: { estimatedTokens: 1_000, estimatedSeconds: 10 },
    ...overrides,
  });
  if (!parsed.success) throw new Error("pilot fixture is not a valid AccountRecord");
  return parsed.data;
}

/**
 * An `AUTH_REQUIRED` record. The contract refuses such a record a quota
 * estimate, so the fixture nulls it rather than working around the schema.
 */
export function pilotAuthRequiredRecord(accountId: string, overrides: Overrides = {}): AccountRecord {
  return pilotAccountRecord(accountId, {
    status: "AUTH_REQUIRED",
    quotaEstimate: {
      remainingRatio: null,
      estimatedTokensRemaining: null,
      estimatedAt: PILOT_ESTIMATED_AT,
      confidence: "MEDIUM",
    },
    ...overrides,
  });
}

export function pilotQuotaEstimate(
  accountId: string,
  overrides: Partial<QuotaEstimate> = {},
): QuotaEstimate {
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
    estimatedAt: PILOT_ESTIMATED_AT,
    reset: {
      kind: "DECLARED",
      nextResetAt: PILOT_RESET_AT,
      timezone: "UTC",
      millisUntilReset: HOUR_MS,
      confidence: "HIGH",
    },
    ...overrides,
  };
}

function pilotWrapEstimates(
  estimates: readonly QuotaEstimate[],
): readonly { readonly accountId: string; readonly outcome: QuotaOutcome }[] {
  return estimates.map((estimate) => ({
    accountId: estimate.accountId,
    outcome: { ok: true as const, estimate },
  }));
}

function pilotAbsentEvidence(accountIds: readonly string[]): RoutingRequest["evidence"] {
  return accountIds.map((accountId) => ({
    accountId,
    acceptance: { known: false } as const,
    contextAffinity: { known: false } as const,
    capabilities: { known: false } as const,
  }));
}

export function pilotRoutingRequest(
  accountIds: readonly string[],
  overrides: Partial<RoutingRequest> = {},
): RoutingRequest {
  return {
    records: accountIds.map((id) => pilotAccountRecord(id)),
    estimates: pilotWrapEstimates(accountIds.map((id) => pilotQuotaEstimate(id))),
    evidence: pilotAbsentEvidence(accountIds),
    task: {
      estimatedTokens: 10_000,
      estimatedDurationSeconds: 60,
      reserveTokens: 5_000,
      model: "opus",
      requiredCapabilities: [],
    },
    config: DEFAULT_ROUTING_CONFIG,
    now: PILOT_ESTIMATED_AT,
    ...overrides,
  } satisfies RoutingRequest;
}

export function pilotSwitchRequest(overrides: Partial<SwitchRequest> = {}): SwitchRequest {
  return {
    trigger: "QUOTA_EXHAUSTED",
    currentAccountId: "current",
    routing: pilotRoutingRequest(["current", "spare"]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The ledger-event assembler -- pure; the envelope is minted by the caller
// ---------------------------------------------------------------------------

export interface EventEnvelope {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

export interface BuildSwitchLedgerEventInput {
  readonly envelope: EventEnvelope;
  readonly taskId: string;
  readonly attempt: number;
  readonly transitionId: string;
  readonly type: ControlPlaneEventType;
  readonly fromState: TaskState | null;
  readonly toState: TaskState;
  readonly emittedBy: string;
  readonly payload: Readonly<Record<string, string>>;
}

/**
 * Assemble one real, parsed `ControlPlaneEvent` for the switch chain.
 *
 * Pure: `envelope` is minted by the caller from durable inputs and a fixed
 * instant. This package's `.test.ts` files may import `node:crypto`; this
 * helper module may not, so the minting itself lives there and this function
 * only assembles and validates the result.
 */
export function buildSwitchLedgerEvent(input: BuildSwitchLedgerEventInput): ControlPlaneEvent {
  return ControlPlaneEvent.parse({
    contractVersion: CONTRACT_VERSION,
    eventId: input.envelope.eventId,
    taskId: input.taskId,
    attempt: input.attempt,
    transitionId: input.transitionId,
    idempotencyKey: buildIdempotencyKey({
      taskId: input.taskId,
      attempt: input.attempt,
      transitionId: input.transitionId,
    }),
    type: input.type,
    fromState: input.fromState,
    toState: input.toState,
    emittedBy: input.emittedBy,
    occurredAt: input.envelope.occurredAt,
    recordedAt: input.envelope.recordedAt,
    correlationId: null,
    causationId: null,
    payload: input.payload,
  });
}

// ---------------------------------------------------------------------------
// The live-lease fold -- reimplemented, never imported: this package may not
// depend on @acp/runtime (the P1B dependency law)
// ---------------------------------------------------------------------------

export interface FoldableSwitchEvent {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly sequence: number;
}

/**
 * The same live-lease fold P7A proved over the enforcement module's ledger
 * shape, reimplemented here rather than imported. It is what proves the
 * named observation: the switching module's `LEASE_REVOKED` payload carries
 * no `leaseId`, so this fold skips it by construction -- the same rule as
 * every other event with no string `leaseId`, never a special case written
 * for this one event type.
 */
export function foldLiveLeases(events: readonly FoldableSwitchEvent[]): ReadonlyMap<string, Lease> {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const revoked = new Set<string>();
  const live = new Map<string, Lease>();

  for (const event of ordered) {
    const leaseId = event.payload["leaseId"];
    if (typeof leaseId !== "string") continue;

    if (event.type === "LEASE_REVOKED") {
      revoked.add(leaseId);
      live.delete(leaseId);
      continue;
    }
    if (event.type === "LEASE_ACQUIRED") {
      if (revoked.has(leaseId)) continue;
      const worktreePath = event.payload["worktreePath"];
      const holder = event.payload["holder"];
      const acquiredAt = event.payload["acquiredAt"];
      const expiresAt = event.payload["expiresAt"];
      if (
        typeof worktreePath !== "string" ||
        typeof holder !== "string" ||
        typeof acquiredAt !== "string" ||
        typeof expiresAt !== "string"
      ) {
        continue;
      }
      live.set(leaseId, { leaseId, worktreePath, holder, acquiredAt, expiresAt });
    }
  }

  return live;
}
