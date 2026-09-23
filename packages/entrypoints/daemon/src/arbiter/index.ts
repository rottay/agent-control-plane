import { join } from "node:path";

import type { Lease } from "@acp/contracts";
import { CONTRACT_VERSION } from "@acp/contracts";
import type { LeaseDecision, LeaseRow, LeaseStore } from "@acp/ledger";
import type { DurableInvocation, EnforcementEvent, LedgerPort } from "@acp/runtime";
import {
  ATTEMPT_OPENING_STEP,
  acquireLease,
  deriveEventCoordinate,
  deterministicUuid,
  payloadCoordinate,
  renewLease,
  revokeLease,
} from "@acp/runtime";

import { LEASE_STORE_NAME } from "../constants/index.js";
import { StartupError } from "../errors/index.js";
import type { ProcessInspector, RecordedIdentity } from "../identity-probe/index.js";
import type { DaemonRoot } from "../paths/index.js";

/**
 * The fenced worktree lease — V2 concurrency C2.
 *
 * C1 gave the plane a store that can arbitrate: one record per worktree, and
 * one decision at a time under `BEGIN IMMEDIATE`. `@acp/runtime` already had
 * the *rules* — `acquireLease`, `renewLease`, `revokeLease` are pure folds over
 * a caller-supplied live set. Neither could hold a lease on its own: the rules
 * have no lock, and the store has no policy.
 *
 * This module is the composition, and the daemon is the only place it can live.
 * It is the one component that imports both `@acp/runtime` and `@acp/ledger`,
 * and the only consumer. A port in `@acp/contracts` would be a third party to a
 * conversation with exactly two participants.
 *
 * **The rules are unchanged.** `decide` maps the store row to the live set the
 * pure function expects, calls it, and maps its outcome back to a
 * `LeaseDecision`. `runtime/src/enforcement/index.ts` is deliberately outside
 * this packet's write-set, so an edit there is a hard failure rather than a
 * permitted silence.
 *
 * ## The fence is what bounds overlap
 *
 * A TTL alone bounds nothing: a holder that stalls past its expiry and then
 * wakes up still believes it holds the worktree, and a successor has already
 * taken it. The fence closes that. Every grant bumps it; every renewal re-reads
 * the row and compares. If it moved, this walk lost the lease and says so —
 * {@link ArbiterRenewal.lost} — and the daemon aborts, reaping its provider
 * children through the harness. Overlap is bounded by one renewal interval and
 * ends in a classified abort rather than in two writers.
 *
 * ## Every instant handed to the store is canonical UTC
 *
 * See {@link canonicalInstant}. This is not tidiness: the store compares
 * `expires_at <= ?` as SQLite TEXT, and text ordering and instant ordering
 * disagree in both directions.
 *
 * ## Liveness is probed before the lock, and the verdict is bound to its subject
 *
 * `inspect` is asynchronous and C1's `decide` is synchronous, so the probe runs
 * **before** `transact` and its verdict is carried in as a value.
 *
 * A carried verdict is a statement about **one record**, and it stops being
 * true the moment that record is replaced. Between the probe and the lock a
 * successor can reclaim the worktree and become a live holder; applying a
 * `GONE` verdict to *that* record would fold a living lease out of the set and
 * grant a second holder — and record `HOLDER_DEAD` against a lease whose owner
 * is alive. It is not a conservative window in one direction; it is unsound in
 * the dangerous one.
 *
 * So the verdict is **bound to the identity of the row it judged**
 * ({@link sameRecord}: `leaseId`, `fence`, `holderPid`, `holderToken`) and is
 * applied inside the lock only if the current row is still that row. If it is
 * not, the current lease is folded in as **live** and the unmodified
 * `acquireLease` refuses — fail-closed, and the caller retries on its next
 * start. A verdict can then only ever be *ignored*, never misapplied.
 */

/** The canonical UTC form: `YYYY-MM-DDTHH:MM:SS.sssZ`, exactly 24 characters. */
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The one instant form this plane hands the lease store.
 *
 * The store compares `expires_at <= ?` as SQLite **TEXT** — lexical bytes, not
 * instants — while the runtime compares parsed instants and the contract's
 * `Timestamp` permits offsets. `requireText` in the store guards nothing but
 * emptiness, by design: it is a substrate and owns no semantics.
 *
 * Those three agree only while every string is canonical UTC. Two spellings of
 * one instant sort differently, and the divergence is silent **in both
 * directions**:
 *
 * - `2026-09-04T00:00:00.000-05:00` sorts *before* `2026-09-04T05:00:00.000Z`
 *   — the same instant — because `0` < `5` at index 11. A live lease is swept.
 * - `2026-09-04T05:00:00Z` sorts *after* `2026-09-04T05:00:00.000Z` because
 *   `Z` (0x5A) > `.` (0x2E). An expired lease survives its sweep.
 *
 * So the producer canonicalises, at every seam, and **refuses rather than
 * guessing** when the input is not an instant at all. The alternative — a
 * format guard inside the store — would amend a committed module, and the
 * caller that owns the semantics is this one.
 */
export function canonicalInstant(value: string, field: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new StartupError(field + " is not an instant: the lease store orders text, not guesses");
  }
  const canonical = new Date(ms).toISOString();
  if (!CANONICAL_INSTANT.test(canonical)) {
    throw new StartupError(field + " has no canonical UTC form");
  }
  return canonical;
}

/**
 * Where the arbitration store lives, derived and never supplied.
 *
 * C1's `openLeaseStore` defaults nothing on purpose, so the path is composed
 * here from the daemon root — which is itself resolved, never an option. A
 * caller-supplied path would be a second store, which is two answers to *may I
 * write here*.
 */
export function leaseStorePath(root: DaemonRoot): string {
  return join(root, LEASE_STORE_NAME);
}

/** What the probe could prove about the recorded holder, before the lock. */
export type HolderLiveness = "GONE" | "PID_REUSED" | "LIVE" | "INDETERMINATE";

export interface ArbiterOptions {
  readonly store: LeaseStore;
  readonly ledger: LedgerPort;
  readonly invocation: DurableInvocation;
  readonly worktreePath: string;
  readonly holder: string;
  readonly identity: RecordedIdentity;
  readonly inspector: ProcessInspector;
  readonly ttlMs: number;
  /** Injected, and canonicalised at every point of use. */
  readonly now: () => string;
}

export interface ArbiterRenewal {
  readonly ok: boolean;
  /** The fence moved: another daemon holds this worktree now. */
  readonly lost: boolean;
  readonly reason: string | null;
}

export interface LeaseHold {
  readonly lease: Lease;
  readonly fence: number;
  readonly renew: () => ArbiterRenewal;
  readonly release: (cause: string) => readonly EnforcementEvent[];
}

export type AcquisitionOutcome =
  | { readonly ok: true; readonly hold: LeaseHold; readonly events: readonly EnforcementEvent[] }
  | { readonly ok: false; readonly reason: string; readonly at: string };

export interface Arbiter {
  readonly acquire: () => Promise<AcquisitionOutcome>;
  /**
   * Append every lease event the ledger can accept yet.
   *
   * See {@link createArbiter} for why this is separate from deciding.
   */
  readonly flush: () => number;
  readonly pending: () => number;
}

/**
 * Is this the same record the probe judged?
 *
 * The four fields are a complete identity for a liveness verdict: `fence` is
 * monotonic per worktree and never reset, so a grant, a release or a sweep all
 * move at least one of these. A mismatch is not an error — it means the verdict
 * in hand is about a record that no longer exists, and the only safe reading of
 * it is none at all.
 */
function sameRecord(current: LeaseRow | null, probed: LeaseRow | null): boolean {
  if (current === null || probed === null) return current === probed;
  return (
    current.leaseId === probed.leaseId &&
    current.fence === probed.fence &&
    current.holderPid === probed.holderPid &&
    current.holderToken === probed.holderToken
  );
}

/** Exactly the five contract fields. The store's own columns stay in the store. */
function rowToLease(row: LeaseRow): Lease | null {
  if (
    row.leaseId === null ||
    row.holder === null ||
    row.acquiredAt === null ||
    row.expiresAt === null
  ) {
    return null;
  }
  return {
    leaseId: row.leaseId,
    worktreePath: row.worktreePath,
    holder: row.holder,
    acquiredAt: row.acquiredAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * Create the arbiter for one worktree.
 *
 * ## Why recording is separate from deciding
 *
 * The acquisition happens **before the walk**, which is the entire point: a
 * refused acquisition must stop the walk from starting. But the walk is what
 * *opens the task* — `nextStep` picks its step from the task's state in the
 * ledger, and a fresh task has none. An event appended before the walk would
 * create the task row, and the walk would then resume at step 1 and never write
 * its own `TASK_DISCOVERED`.
 *
 * So the decision and its record are separated: lease events are held and
 * appended by {@link Arbiter.flush} at every moment the ledger can accept them
 * — after acquisition, on each renewal, and at release. The identifiers are
 * derived rather than minted, so **within this process** a flush that lands
 * twice is an exact replay and `append` refuses the duplicate.
 *
 * **Across a crash it is not idempotent, and saying otherwise would be false.**
 * `pending` is a local array. A process that dies between the grant and the
 * first moment the ledger could accept its event never flushes again: a
 * restarted daemon finds the dead holder, reclaims at the next fence, and
 * writes a `LEASE_REVOKED` for a lease the ledger never saw acquired. That
 * revocation, naming the lost lease id, is the surviving evidence — the record
 * is lopsided, not absent. The store row is the operational fact throughout,
 * which is why the worktree is never stranded.
 */
export function createArbiter(options: ArbiterOptions): Arbiter {
  const { store, ledger, invocation, worktreePath, holder, identity, inspector, ttlMs } = options;

  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new StartupError("the lease ttl must be a positive integer of milliseconds");
  }

  const pending: { readonly transitionId: string; readonly event: EnforcementEvent }[] = [];
  let held: { lease: Lease; fence: number } | null = null;
  let renewals = 0;

  const nowCanonical = (): string => canonicalInstant(options.now(), "now");

  const expiryFrom = (from: string): string =>
    canonicalInstant(new Date(Date.parse(from) + ttlMs).toISOString(), "expiresAt");

  /**
   * Derived, never minted (stop 8).
   *
   * The fence increments per grant, so the id is unique per grant and identical
   * across a retry of the same grant — which is what makes the append idempotent
   * rather than merely repeated.
   */
  const leaseIdFor = (fence: number): string =>
    deterministicUuid("lease/" + worktreePath + "/" + String(fence));

  const enqueue = (transitionId: string, event: EnforcementEvent): void => {
    pending.push({ transitionId, event });
  };

  /**
   * Append what the ledger can accept, and leave the rest queued.
   *
   * The task must already exist. This records against history; it never begins
   * one — the same rule `recordTokenObservation` holds, and for the same
   * reason: an event that opened a task would take the walk's own first step
   * away from it.
   */
  const flush = (): number => {
    const task = ledger.getTask(invocation.taskId);
    if (task === null) return 0;
    // P-15 escalón D3 (ADR 0105, decision 139). Under a revision nothing of the
    // coordinate may reach the ledger before its opening, and a recorded task
    // exists before its walk opens the attempt. So the events stay queued until the
    // opening is on record, found by its own derived key, and a later flush — the
    // release, or the violation path — appends them, once.
    if (invocation.revision !== undefined) {
      const opening = deriveEventCoordinate(invocation, ATTEMPT_OPENING_STEP.transitionId, ATTEMPT_OPENING_STEP.index);
      if (ledger.getEventByIdempotencyKey(opening.idempotencyKey) === null) return 0;
    }
    let appended = 0;
    while (pending.length > 0) {
      const next = pending[0];
      if (next === undefined) break;
      const coordinate = deriveEventCoordinate(invocation, next.transitionId, 0);
      const current = ledger.getTask(invocation.taskId);
      if (current === null) break;
      ledger.append({
        contractVersion: CONTRACT_VERSION,
        eventId: coordinate.eventId,
        taskId: invocation.taskId,
        attempt: invocation.attempt,
        transitionId: next.transitionId,
        idempotencyKey: coordinate.idempotencyKey,
        type: next.event.type,
        // A lease is not a lifecycle transition. It rides the task's thread and
        // says so by leaving the state exactly where it found it.
        fromState: current.currentState,
        toState: current.currentState,
        emittedBy: holder,
        occurredAt: coordinate.occurredAt,
        recordedAt: coordinate.recordedAt,
        correlationId: invocation.invocationId,
        causationId: null,
        // The coordinate a V2 key names; empty under V1, so V1 bytes are unchanged.
        payload: { ...next.event.payload, ...payloadCoordinate(invocation) },
      });
      pending.shift();
      appended += 1;
    }
    return appended;
  };

  /**
   * What the probe can prove about the recorded holder.
   *
   * Fail-closed, and it is `recoverStaleLock`'s own posture: only a proof of
   * absence permits a reclaim. `argvDigest` is deliberately **not** supplied to
   * `probeIdentity`: that field separates `INDETERMINATE` from
   * `SAME_LIVE_DAEMON`, and both of those refuse, so the two facts the store
   * actually carries — pid and start token — are sufficient and a placeholder
   * digest would be a fact this module does not have.
   */
  const probeHolder = async (row: LeaseRow | null): Promise<HolderLiveness> => {
    if (row?.leaseId == null || row.holderPid === null) return "INDETERMINATE";
    if (row.holderPid === identity.pid) return "LIVE";
    try {
      const facts = await inspector.inspect(row.holderPid);
      if (facts === null) return "GONE";
      if (row.holderToken !== null && facts.startToken !== row.holderToken) return "PID_REUSED";
      return "LIVE";
    } catch {
      // The operating system could not answer. That is not a proof of death.
      return "INDETERMINATE";
    }
  };

  /** The live set the pure rules fold over, as this arbiter derives it. */
  const liveSet = (row: LeaseRow | null, liveness: HolderLiveness): readonly Lease[] => {
    if (row === null) return [];
    const lease = rowToLease(row);
    if (lease === null) return [];
    // A holder this arbiter can prove is gone holds nothing. Expiry is the pure
    // function's own business and is deliberately not second-guessed here.
    if (liveness === "GONE" || liveness === "PID_REUSED") return [];
    return [lease];
  };

  const acquire = async (): Promise<AcquisitionOutcome> => {
    const before = store.read(worktreePath);
    const liveness = await probeHolder(before);

    // A holder object rather than three `let`s: the compiler cannot see that
    // `transact` calls `decide` synchronously, so it narrows plain locals to
    // `null` for the rest of the function and every read below becomes an
    // "always null" error. Properties survive the call.
    const seen: {
      refusal: { readonly reason: string; readonly at: string } | null;
      granted: { readonly lease: Lease; readonly fence: number } | null;
      reclaimed: { readonly lease: Lease; readonly fence: number; readonly cause: string } | null;
    } = { refusal: null, granted: null, reclaimed: null };

    store.transact(worktreePath, (current): LeaseDecision => {
      const now = nowCanonical();
      const fence = (current?.fence ?? 0) + 1;
      // The verdict is about `before`. If the row moved while the probe was
      // running, it says nothing about what is here now, and treating the
      // current holder as dead on the strength of it would grant a second live
      // writer. Unbound, the verdict is dropped and the lease folds in as live.
      const verdict: HolderLiveness = sameRecord(current, before) ? liveness : "INDETERMINATE";
      const leases = liveSet(current, verdict);
      const candidate: Lease = {
        leaseId: leaseIdFor(fence),
        worktreePath,
        holder,
        acquiredAt: now,
        expiresAt: expiryFrom(now),
      };
      const outcome = acquireLease({ leases, now, candidate });
      if (!outcome.ok) {
        seen.refusal = { reason: outcome.reason, at: outcome.at };
        return { verb: "REFUSE", reason: outcome.reason };
      }

      // Whatever was there is being taken over, and the reason is recorded
      // rather than inferred from the absence of a previous holder.
      const previous = current === null ? null : rowToLease(current);
      if (previous !== null) {
        seen.reclaimed = {
          lease: previous,
          fence: current?.fence ?? 0,
          // The bound verdict, never the carried one: a stale `GONE` must not
          // label an expiry reclaim as a death it did not observe.
          cause: verdict === "GONE" || verdict === "PID_REUSED" ? "HOLDER_DEAD" : "EXPIRED",
        };
      }

      seen.granted = { lease: outcome.lease, fence };
      return {
        verb: "GRANT",
        row: {
          leaseId: outcome.lease.leaseId,
          holder: outcome.lease.holder,
          acquiredAt: outcome.lease.acquiredAt,
          expiresAt: outcome.lease.expiresAt,
          holderPid: identity.pid,
          holderToken: identity.startToken,
        },
      };
    });

    const grant = seen.granted;
    if (grant === null) {
      const refused = seen.refusal ?? {
        reason: "LEASE_HELD_BY_ANOTHER",
        at: "request.candidate.worktreePath",
      };
      return { ok: false, reason: refused.reason, at: refused.at };
    }
    held = { lease: grant.lease, fence: grant.fence };
    renewals = 0;

    const events: EnforcementEvent[] = [];
    const taken = seen.reclaimed;
    if (taken !== null) {
      // Recorded by the successor, not by the holder. `revokeLease` answers
      // "may this holder revoke its live lease" — an expired record fails that
      // question by construction, and a reclaim is a different act: the
      // successor saying why the record was taken.
      const revoked: EnforcementEvent = {
        type: "LEASE_REVOKED",
        payload: {
          leaseId: taken.lease.leaseId,
          worktreePath: taken.lease.worktreePath,
          holder: taken.lease.holder,
          cause: taken.cause,
        },
      };
      enqueue("lease." + String(taken.fence) + ".revoked", revoked);
      events.push(revoked);
    }
    const acquired: EnforcementEvent = {
      type: "LEASE_ACQUIRED",
      payload: {
        leaseId: grant.lease.leaseId,
        worktreePath: grant.lease.worktreePath,
        holder: grant.lease.holder,
        acquiredAt: grant.lease.acquiredAt,
        expiresAt: grant.lease.expiresAt,
      },
    };
    enqueue("lease." + String(grant.fence) + ".acquired", acquired);
    events.push(acquired);
    flush();

    const hold: LeaseHold = {
      lease: grant.lease,
      fence: grant.fence,
      renew: (): ArbiterRenewal => renew(),
      release: (cause: string): readonly EnforcementEvent[] => release(cause),
    };
    return { ok: true, hold, events };
  };

  const renew = (): ArbiterRenewal => {
    const current = held;
    if (current === null) return { ok: false, lost: false, reason: "NOT_HELD" };

    const seen: { lost: boolean; refused: string | null; extended: Lease | null } = {
      lost: false,
      refused: null,
      extended: null,
    };

    store.transact(worktreePath, (row): LeaseDecision => {
      // The fence is the whole mechanism. A moved fence means a successor took
      // this worktree while this walk was still running, and no renewal can
      // undo that — it can only be noticed, promptly.
      if (row === null || row.fence !== current.fence || row.leaseId !== current.lease.leaseId) {
        seen.lost = true;
        return { verb: "REFUSE", reason: "LEASE_FENCE_LOST" };
      }
      const now = nowCanonical();
      const existing = rowToLease(row);
      if (existing === null) {
        seen.lost = true;
        return { verb: "REFUSE", reason: "LEASE_FENCE_LOST" };
      }
      const outcome = renewLease({
        leases: [existing],
        now,
        leaseId: current.lease.leaseId,
        holder,
        expiresAt: expiryFrom(now),
      });
      if (!outcome.ok) {
        seen.refused = outcome.reason;
        return { verb: "REFUSE", reason: outcome.reason };
      }
      seen.extended = outcome.lease;
      return {
        verb: "GRANT",
        row: {
          leaseId: outcome.lease.leaseId,
          holder: outcome.lease.holder,
          acquiredAt: outcome.lease.acquiredAt,
          expiresAt: outcome.lease.expiresAt,
          holderPid: identity.pid,
          holderToken: identity.startToken,
        },
      };
    });

    if (seen.lost) {
      held = null;
      return { ok: false, lost: true, reason: "LEASE_FENCE_LOST" };
    }
    const renewed = seen.extended;
    if (renewed === null) return { ok: false, lost: false, reason: seen.refused };

    // A GRANT bumps the store's fence, so the hold follows it rather than
    // holding a value the record no longer carries.
    const row = store.read(worktreePath);
    held = { lease: renewed, fence: row?.fence ?? current.fence + 1 };
    renewals += 1;
    // Indexed like `usageTransitionId`: one coordinate per renewal, so the
    // later expiry is recorded instead of colliding with the grant's own key.
    enqueue("lease." + String(current.fence) + ".renewed." + String(renewals), {
      type: "LEASE_ACQUIRED",
      payload: {
        leaseId: renewed.leaseId,
        worktreePath: renewed.worktreePath,
        holder: renewed.holder,
        acquiredAt: renewed.acquiredAt,
        expiresAt: renewed.expiresAt,
      },
    });
    flush();
    return { ok: true, lost: false, reason: null };
  };

  /**
   * Release the hold. Idempotent, and never a route for contention.
   *
   * C1 throws on a `RELEASE` of a never-granted record, and that is correct
   * substrate behaviour. So idempotency is by checking the hold, never by
   * catching that throw: a caught throw would turn a programming error into a
   * silent outcome.
   */
  const release = (cause: string): readonly EnforcementEvent[] => {
    const current = held;
    if (current === null) return [];
    held = null;

    const seen: { events: readonly EnforcementEvent[] } = { events: [] };
    store.transact(worktreePath, (row): LeaseDecision => {
      if (row === null || row.fence !== current.fence || row.leaseId === null) {
        // Somebody else holds it now. Releasing would free their lease.
        return { verb: "REFUSE", reason: "LEASE_FENCE_LOST" };
      }
      const now = nowCanonical();
      const existing = rowToLease(row);
      if (existing === null) return { verb: "REFUSE", reason: "LEASE_FENCE_LOST" };
      const outcome = revokeLease({ leases: [existing], now, leaseId: existing.leaseId, cause });
      if (outcome.ok) seen.events = outcome.events;
      // Even a refused revocation releases the record: the rules answer whether
      // the event is honest, and this arbiter is provably the holder here.
      return { verb: "RELEASE", at: now };
    });

    for (const event of seen.events) {
      enqueue("lease." + String(current.fence) + ".revoked", event);
    }
    flush();
    return seen.events;
  };

  return {
    acquire,
    flush,
    pending: (): number => pending.length,
  };
}
