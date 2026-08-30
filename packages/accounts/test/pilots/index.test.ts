import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ControlPlaneEvent } from "@acp/contracts";
import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { rankAccounts } from "../../src/routing/index.js";
import { SWITCH_STEPS, decideSwitch } from "../../src/switching/index.js";
import type { SwitchOutcome } from "../../src/switching/index.js";
import {
  PILOT_RESET_AT,
  SWITCH_PILOT_WRITER,
  buildSwitchLedgerEvent,
  foldLiveLeases,
  pilotAuthRequiredRecord,
  pilotQuotaEstimate,
  pilotRoutingRequest,
  pilotSwitchRequest,
} from "./helpers/index.js";
import type { EventEnvelope } from "./helpers/index.js";

/**
 * P7B leg 2: the account switch, executed as values over a real ledger.
 *
 * `decideSwitch` is a pure decision core -- it returns the lawful plan as a
 * value and never acts. The executor that would append its events does not
 * exist yet, so this drill plays that role itself (the P7A
 * harness-as-executor pattern), round-tripping the SWITCH chain through a
 * real `@acp/ledger` instance: closed, reopened, folded, and continued.
 *
 * Everything that opens a ledger, appends to one, creates or removes a
 * directory, or mints a sha256 digest lives in this file. The helpers module
 * carries only pure fixture builders, a pure event assembler and a pure fold.
 */

const FIXED_INSTANT = "2026-08-30T09:05:00.000Z";
const EVENT_NAMESPACE = "9c142f6a-8b7d-5e13-9a44-2f6b8e0c7d21";

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

/**
 * A sha256-derived, version-5-shaped UUID, minted from durable inputs only.
 *
 * This package may not import `@acp/runtime`'s `deterministicUuid` (the P1B
 * dependency law: `packages/accounts` may not depend on `@acp/runtime`), so
 * this is a local, sha256-based construction of the same RFC 4122 shape --
 * the version and variant nibbles are forced explicitly, which is all
 * `z.uuid()` requires. No clock and no random source participate: `name` is
 * built from durable inputs only, so two runs of this drill mint
 * byte-identical ids.
 */
function mintEventId(name: string): string {
  const digest = createHash("sha256")
    .update(uuidToBytes(EVENT_NAMESPACE))
    .update(name, "utf8")
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20, 32)
  );
}

function envelopeFor(taskId: string, transitionId: string): EventEnvelope {
  return {
    eventId: mintEventId("switch-pilot/" + taskId + "/" + transitionId),
    occurredAt: FIXED_INSTANT,
    recordedAt: FIXED_INSTANT,
  };
}

const tempDirs: string[] = [];
const ledgers: Ledger[] = [];

function freshLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-p7b-accounts-"));
  tempDirs.push(dir);
  return join(dir, "ledger.sqlite");
}

function track(ledger: Ledger): Ledger {
  ledgers.push(ledger);
  return ledger;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The decision: SWITCH, cross-checked against the router, for both
// accountStatus branches
// ---------------------------------------------------------------------------

describe("the switch decision, cross-checked against the router", () => {
  it("recommends the full plan, and selects exactly what rankAccounts ranked first", () => {
    const routing = pilotRoutingRequest(["current", "spare"]);
    const outcome = decideSwitch(pilotSwitchRequest({ routing }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected a switch outcome");

    expect(outcome.plan.kind).toBe("SWITCH");
    expect([...outcome.plan.steps]).toEqual([...SWITCH_STEPS]);
    expect(outcome.plan.taskState).toBe("QUOTA_BLOCKED");
    // Reset ahead of now: COOLDOWN.
    expect(outcome.plan.accountStatus).toBe("COOLDOWN");

    // One selection authority: the drill calls the router itself over the
    // current-account-filtered request, rather than re-deriving the pick.
    const crossCheck = rankAccounts({
      ...routing,
      records: routing.records.filter((record) => record.accountId !== "current"),
      estimates: routing.estimates.filter((estimate) => estimate.accountId !== "current"),
      evidence: routing.evidence.filter((evidence) => evidence.accountId !== "current"),
    });
    expect(crossCheck.ok).toBe(true);
    if (crossCheck.ok) {
      expect(outcome.plan.selectedAccountId).toBe(crossCheck.recommendation.ranked[0]?.accountId ?? null);
    }
  });

  it("reads EXHAUSTED from the estimator when no reset is ahead", () => {
    const routing = pilotRoutingRequest(["current", "spare"], {
      estimates: [
        {
          accountId: "current",
          outcome: {
            ok: true,
            estimate: pilotQuotaEstimate("current", {
              reset: {
                kind: "DECLARED",
                nextResetAt: PILOT_RESET_AT,
                timezone: "UTC",
                millisUntilReset: 0,
                confidence: "HIGH",
              },
            }),
          },
        },
        { accountId: "spare", outcome: { ok: true, estimate: pilotQuotaEstimate("spare") } },
      ],
    });
    const outcome = decideSwitch(pilotSwitchRequest({ routing }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected a switch outcome");
    expect(outcome.plan.accountStatus).toBe("EXHAUSTED");
  });
});

// ---------------------------------------------------------------------------
// The executor: the SWITCH chain played over a real ledger, closed, reopened,
// folded, and continued
// ---------------------------------------------------------------------------

describe("the switch chain, played as the executor over a real ledger", () => {
  it("appends the plan's five events verbatim, in order, then survives a close and reopen", () => {
    const taskId = "8c8c8c8c-8c8c-4c8c-8c8c-8c8c8c8c8c01";
    const attempt = 1;
    const ledgerPath = freshLedgerPath();

    const routing = pilotRoutingRequest(["current", "spare"]);
    const outcome: SwitchOutcome = decideSwitch(pilotSwitchRequest({ routing }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected a switch outcome");
    const plan = outcome.plan;
    expect(plan.events.map((candidate) => candidate.type)).toEqual([
      "QUOTA_WARNING",
      "TASK_STATE_CHANGED",
      "LEASE_REVOKED",
      "ACCOUNT_SWITCH_STARTED",
      "ACCOUNT_SWITCH_COMPLETED",
    ]);
    const [quotaWarning, quotaBlocked, leaseRevoked, switchStarted, switchCompleted] = plan.events;
    if (
      quotaWarning === undefined ||
      quotaBlocked === undefined ||
      leaseRevoked === undefined ||
      switchStarted === undefined ||
      switchCompleted === undefined
    ) {
      throw new Error("expected exactly five switch events");
    }

    const ledger = track(openLedger(ledgerPath));

    // The harness's own envelope: the task is opened and moved to RUNNING
    // before any quota pressure exists. The module's own documentation
    // assigns the envelope to the caller, never to decideSwitch.
    const discovered = ledger.append(
      buildSwitchLedgerEvent({
        envelope: envelopeFor(taskId, "task.discovered"),
        taskId,
        attempt,
        transitionId: "task.discovered",
        type: "TASK_DISCOVERED",
        fromState: null,
        toState: "DISCOVERED",
        emittedBy: SWITCH_PILOT_WRITER,
        payload: {},
      }),
    );
    expect(discovered.inserted).toBe(true);

    const running = ledger.append(
      buildSwitchLedgerEvent({
        envelope: envelopeFor(taskId, "task.running"),
        taskId,
        attempt,
        transitionId: "task.running",
        type: "TASK_STATE_CHANGED",
        fromState: "DISCOVERED",
        toState: "RUNNING",
        emittedBy: SWITCH_PILOT_WRITER,
        payload: {},
      }),
    );
    expect(running.inserted).toBe(true);

    // The plan's own five events, in the order decideSwitch returned them,
    // payloads verbatim -- never re-derived.
    const quotaWarningAppend = ledger.append(
      buildSwitchLedgerEvent({
        envelope: envelopeFor(taskId, "quota.warning"),
        taskId,
        attempt,
        transitionId: "quota.warning",
        type: quotaWarning.type,
        fromState: "RUNNING",
        toState: "RUNNING",
        emittedBy: SWITCH_PILOT_WRITER,
        payload: quotaWarning.payload,
      }),
    );
    expect(quotaWarningAppend.inserted).toBe(true);
    expect(quotaWarningAppend.record.event.payload).toEqual(quotaWarning.payload);

    const quotaBlockedAppend = ledger.append(
      buildSwitchLedgerEvent({
        envelope: envelopeFor(taskId, "task.quota-blocked"),
        taskId,
        attempt,
        transitionId: "task.quota-blocked",
        type: quotaBlocked.type,
        fromState: "RUNNING",
        toState: "QUOTA_BLOCKED",
        emittedBy: SWITCH_PILOT_WRITER,
        payload: quotaBlocked.payload,
      }),
    );
    expect(quotaBlockedAppend.inserted).toBe(true);
    expect(quotaBlockedAppend.record.event.payload).toEqual(quotaBlocked.payload);

    // N4 (the named observation): the switching module's LEASE_REVOKED
    // carries {accountId}, not the enforcement module's
    // {leaseId, worktreePath, holder, cause}. Asserted verbatim, exactly as
    // the module emitted it -- never patched around.
    expect(leaseRevoked.payload).toEqual({ accountId: "current" });
    const leaseRevokedAppend = ledger.append(
      buildSwitchLedgerEvent({
        envelope: envelopeFor(taskId, "lease.revoked"),
        taskId,
        attempt,
        transitionId: "lease.revoked",
        type: leaseRevoked.type,
        fromState: "QUOTA_BLOCKED",
        toState: "QUOTA_BLOCKED",
        emittedBy: SWITCH_PILOT_WRITER,
        payload: leaseRevoked.payload,
      }),
    );
    expect(leaseRevokedAppend.inserted).toBe(true);
    expect(leaseRevokedAppend.record.event.payload).toEqual({ accountId: "current" });

    const switchStartedAppend = ledger.append(
      buildSwitchLedgerEvent({
        envelope: envelopeFor(taskId, "account-switch.started"),
        taskId,
        attempt,
        transitionId: "account-switch.started",
        type: switchStarted.type,
        fromState: "QUOTA_BLOCKED",
        toState: "QUOTA_BLOCKED",
        emittedBy: SWITCH_PILOT_WRITER,
        payload: switchStarted.payload,
      }),
    );
    expect(switchStartedAppend.inserted).toBe(true);
    expect(switchStartedAppend.record.event.payload).toEqual(switchStarted.payload);

    const switchCompletedAppend = ledger.append(
      buildSwitchLedgerEvent({
        envelope: envelopeFor(taskId, "account-switch.completed"),
        taskId,
        attempt,
        transitionId: "account-switch.completed",
        type: switchCompleted.type,
        fromState: "QUOTA_BLOCKED",
        toState: "QUOTA_BLOCKED",
        emittedBy: SWITCH_PILOT_WRITER,
        payload: switchCompleted.payload,
      }),
    );
    expect(switchCompletedAppend.inserted).toBe(true);
    expect(switchCompletedAppend.record.event.payload).toEqual(switchCompleted.payload);

    // Seven events total: the harness's two, then the plan's five, in
    // append order.
    const appendOrder = ledger.listEvents({ limit: 200 }).events.map((record) => record.event.type);
    expect(appendOrder).toEqual([
      "TASK_DISCOVERED",
      "TASK_STATE_CHANGED",
      "QUOTA_WARNING",
      "TASK_STATE_CHANGED",
      "LEASE_REVOKED",
      "ACCOUNT_SWITCH_STARTED",
      "ACCOUNT_SWITCH_COMPLETED",
    ]);
    expect(ledger.getTask(taskId)?.currentState).toBe("QUOTA_BLOCKED");

    // N4 continued: a leaseId-keyed fold correctly skips the switching
    // module's accountId-shaped revocation -- the same rule as any event
    // with no string leaseId, not a special case.
    const preReopenFolded = foldLiveLeases(
      ledger.listEvents({ limit: 200 }).events.map((record) => ({
        type: record.event.type,
        payload: record.event.payload,
        sequence: record.sequence,
      })),
    );
    expect(preReopenFolded.size).toBe(0);

    ledger.close();
    ledgers.splice(ledgers.indexOf(ledger), 1);

    // The restart analogue: reopen the same path and prove the rehydration.
    const reopened = track(openLedger(ledgerPath));
    const rehydrated = reopened.listEvents({ limit: 200 });
    expect(rehydrated.events.map((record) => record.event.type)).toEqual(appendOrder);
    expect(rehydrated.events.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(reopened.getTask(taskId)?.currentState).toBe("QUOTA_BLOCKED");
    const reopenedIntegrity = reopened.verifyIntegrity();
    expect(reopenedIntegrity.ok).toBe(true);
    expect(reopenedIntegrity.problems).toEqual([]);

    // CONTINUE: the harness's own TASK_STATE_CHANGED back to RUNNING,
    // appended after the reopen. Recovery revalidates and continues; it
    // never forces an old snapshot.
    const continued = reopened.append(
      buildSwitchLedgerEvent({
        envelope: envelopeFor(taskId, "task.continue"),
        taskId,
        attempt,
        transitionId: "task.continue",
        type: "TASK_STATE_CHANGED",
        fromState: "QUOTA_BLOCKED",
        toState: "RUNNING",
        emittedBy: SWITCH_PILOT_WRITER,
        payload: {},
      }),
    );
    expect(continued.inserted).toBe(true);
    expect(continued.record.sequence).toBe(rehydrated.events.length + 1);
    expect(reopened.status().eventCount).toBe(8);
    expect(reopened.status().headSequence).toBe(8);
    expect(reopened.getTask(taskId)?.currentState).toBe("RUNNING");
    const continuedIntegrity = reopened.verifyIntegrity();
    expect(continuedIntegrity.ok).toBe(true);
    expect(continuedIntegrity.problems).toEqual([]);
  });

  it("mints byte-identical events across two runs of the same coordinates", () => {
    const taskId = "8c8c8c8c-8c8c-4c8c-8c8c-8c8c8c8c8c02";
    const first: ControlPlaneEvent = buildSwitchLedgerEvent({
      envelope: envelopeFor(taskId, "quota.warning"),
      taskId,
      attempt: 1,
      transitionId: "quota.warning",
      type: "QUOTA_WARNING",
      fromState: "RUNNING",
      toState: "RUNNING",
      emittedBy: SWITCH_PILOT_WRITER,
      payload: { accountId: "current" },
    });
    const second: ControlPlaneEvent = buildSwitchLedgerEvent({
      envelope: envelopeFor(taskId, "quota.warning"),
      taskId,
      attempt: 1,
      transitionId: "quota.warning",
      type: "QUOTA_WARNING",
      fromState: "RUNNING",
      toState: "RUNNING",
      emittedBy: SWITCH_PILOT_WRITER,
      payload: { accountId: "current" },
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

// ---------------------------------------------------------------------------
// Boundary sub-scenarios: nothing is appended on the non-switch paths
// ---------------------------------------------------------------------------

describe("the non-switch paths leave the ledger untouched", () => {
  it("DRAIN, an unclassified refusal, and an AUTH_REQUIRED escalation append nothing", () => {
    const ledgerPath = freshLedgerPath();
    const ledger = track(openLedger(ledgerPath));
    expect(ledger.status().eventCount).toBe(0);

    // QUOTA_WARNING -> DRAIN: the plan is asserted as a value; the ledger
    // stays untouched because this packet plays executor for SWITCH only.
    const drain = decideSwitch(pilotSwitchRequest({ trigger: "QUOTA_WARNING" }));
    expect(drain.ok).toBe(true);
    if (!drain.ok) throw new Error("expected a drain outcome");
    expect(drain.plan.kind).toBe("DRAIN");
    expect([...drain.plan.steps]).toEqual([
      "MARK_ACCOUNT_DRAINING",
      "FINISH_CURRENT_ATOMIC_STEP",
      "WRITE_CHECKPOINT",
    ]);
    expect(drain.plan.taskState).toBeNull();
    expect(drain.plan.events.map((candidate) => candidate.type)).toEqual(["QUOTA_WARNING"]);
    expect(ledger.status().eventCount).toBe(0);

    // An unclassified trigger: fail-closed, no event of any kind.
    const unclassified: SwitchOutcome = decideSwitch(
      pilotSwitchRequest({ trigger: "provider returned 503" }),
    );
    expect(unclassified.ok).toBe(false);
    if (unclassified.ok) throw new Error("expected a refusal");
    expect(unclassified.reason).toBe("TRIGGER_UNCLASSIFIED");
    expect(ledger.status().eventCount).toBe(0);

    // A current account AUTH_REQUIRED: ESCALATE, no steps, no selection, no
    // ledger write. The credential path stays the owner's.
    const escalate = decideSwitch(
      pilotSwitchRequest({
        routing: pilotRoutingRequest(["current", "spare"], {
          // Only `current`'s status decides ESCALATE; `spare` carries the
          // same status here purely for fixture simplicity.
          records: [pilotAuthRequiredRecord("current"), pilotAuthRequiredRecord("spare")],
        }),
      }),
    );
    expect(escalate.ok).toBe(true);
    if (!escalate.ok) throw new Error("expected an escalate outcome");
    expect(escalate.plan.kind).toBe("ESCALATE");
    expect(escalate.plan.steps).toEqual([]);
    expect(escalate.plan.selectedAccountId).toBeNull();
    expect(escalate.plan.events.map((candidate) => candidate.type)).toEqual(["AUTH_REQUIRED_RAISED"]);
    expect(ledger.status().eventCount).toBe(0);
  });
});
