/**
 * P6A: the writer-enforcement core — leases, write-set conformance, prestate.
 *
 * Three composed capabilities over one law: **one writer per worktree, an exact
 * write-set, and a violation that quarantines rather than cleans.**
 *
 * Everything here is a pure function over injected values. The module reads no
 * clock, opens nothing, and runs no process: the current instant is an
 * argument, and the state of a worktree arrives as an observation the caller
 * made. Decisions come back as frozen values, and the events they imply come
 * back as descriptors for the caller to append — this module appends nothing.
 *
 * **There is no production observer after P6A.** The read-only git port below
 * is a type: it names the four verbs an observer may ever speak and makes a
 * mutation verb unrepresentable. Nothing in this package implements it, and
 * nothing here imports a process module. Wiring a real observer is a separate
 * authorized packet with its own named spawn site.
 *
 * **One worktree, not the whole tree.** P6A admits at most one live holder
 * **per worktree**, and makes no cross-worktree claim: whether two worktrees
 * may be written in parallel is the conflict graph's decision, which is P6B's
 * gate applied before acquire. Nothing here computes a partial conflict check.
 *
 * **Revocation is the caller's fold, not this engine's memory.** Revoking a
 * lease means the caller stops including it in the injected set — derived from
 * `LEASE_ACQUIRED` and `LEASE_REVOKED` in the ledger, which is the authority.
 * The engine holds no revoked state and could not, because it holds no state
 * at all.
 *
 * **The No-Checkout Law is code here, not prose.** The recovery path this
 * module recommends is quarantine: it revokes the lease, recommends
 * SUSPECT_WORKTREE, and leaves the worktree exactly as it found it. There is no
 * verb in this module's vocabulary that could undo a writer's work, and a test
 * asserts the absent tokens.
 */

import { Lease } from "@acp/contracts";
import type { PathDigest } from "@acp/contracts";

// ---------------------------------------------------------------------------
// The read-only git port — a type, and an allow-list
// ---------------------------------------------------------------------------

/**
 * Every verb an observer of this plane may ever speak.
 *
 * A closed union, so a mutation verb is not merely forbidden by review — it is
 * unrepresentable. `GitReadPort` cannot be asked to do anything that changes a
 * worktree, because there is no value of this type that names such a thing.
 */
export type GitReadVerb = "status" | "diff" | "ls-files" | "rev-parse";

export const GIT_READ_VERBS: readonly GitReadVerb[] = Object.freeze([
  "diff",
  "ls-files",
  "rev-parse",
  "status",
]);

export interface GitReadRequest {
  readonly verb: GitReadVerb;
  readonly args: readonly string[];
}

export type GitReadOutcome =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The injected boundary. **No implementation of this exists in production
 * source**; the tests supply scripted fakes, and a production observer is a
 * later authorized packet.
 */
export type GitReadPort = (request: GitReadRequest) => GitReadOutcome;

// ---------------------------------------------------------------------------
// The observation
// ---------------------------------------------------------------------------

/**
 * What the caller saw in a worktree, in the receipt's own shape.
 *
 * This is a direct projection of `CommitAuthorizationReceipt`'s `baseHead`,
 * `observedTrackedChanges` and `observedUntrackedPaths`, so P6C's receipt is a
 * projection of this value rather than a re-shape of it.
 *
 * The enumeration rules are pinned, because each one is a way a violation could
 * otherwise hide:
 *
 * - untracked paths are enumerated **per file** (`--untracked-files=all`); an
 *   untracked directory would otherwise conceal every file beneath it;
 * - ignored files are **excluded** (`--exclude-standard`), which is the
 *   architecture fence's own model;
 * - a tracked deletion is an observed path, and a rename observes **both**
 *   sides — a writer who moves a file out of its write-set has still written
 *   outside it.
 */
export interface WorktreeObservation {
  /**
   * The commit the observation was taken against — a 40 character git object
   * id, or `null` only at a repository's initial commit, exactly as the
   * receipt's `baseHead` allows.
   */
  readonly head: string | null;
  readonly trackedChanges: readonly PathDigest[];
  readonly untrackedPaths: readonly string[];
}

const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export type EnforcementRefusal =
  | "REQUEST_INVALID"
  | "LEASE_INVALID"
  | "LEASE_HELD_BY_ANOTHER"
  | "LEASE_EXPIRED"
  | "LEASE_NOT_HELD"
  | "LEASE_NOT_FOUND"
  | "INSTANT_INVALID"
  | "OBSERVATION_INVALID"
  | "OBSERVATION_FAILED"
  | "WRITE_SET_EMPTY"
  | "PRESTATE_MISMATCH"
  | "PRESTATE_MISSING";

export const ENFORCEMENT_REFUSALS: readonly EnforcementRefusal[] = Object.freeze([
  "INSTANT_INVALID",
  "LEASE_EXPIRED",
  "LEASE_HELD_BY_ANOTHER",
  "LEASE_INVALID",
  "LEASE_NOT_FOUND",
  "LEASE_NOT_HELD",
  "OBSERVATION_FAILED",
  "OBSERVATION_INVALID",
  "PRESTATE_MISMATCH",
  "PRESTATE_MISSING",
  "REQUEST_INVALID",
  "WRITE_SET_EMPTY",
]);

export interface EnforcementRefused {
  readonly ok: false;
  readonly reason: EnforcementRefusal;
  /** The input that decided it. A path, never a value. */
  readonly at: string;
}

function refuse(reason: EnforcementRefusal, at: string): EnforcementRefused {
  return Object.freeze({ ok: false as const, reason, at });
}

// ---------------------------------------------------------------------------
// Candidate events
// ---------------------------------------------------------------------------

/**
 * An event this decision implies, as a value.
 *
 * The `type` is drawn from the frozen control-plane vocabulary as-is. The
 * envelope — the id and the instants — belongs to the executor that appends,
 * exactly as the P5D switching policy allocates it: this module is forbidden a
 * clock and a random source, so it says which event should be recorded and
 * about what, and nothing more.
 */
export type EnforcementEventType =
  | "LEASE_ACQUIRED"
  | "LEASE_REVOKED"
  | "WRITE_SET_VIOLATION_DETECTED";

export interface EnforcementEvent {
  readonly type: EnforcementEventType;
  readonly payload: Readonly<Record<string, string>>;
}

function event(type: EnforcementEventType, payload: Record<string, string>): EnforcementEvent {
  return Object.freeze({ type, payload: Object.freeze({ ...payload }) });
}

// ---------------------------------------------------------------------------
// Instants, through the contract's own parser
// ---------------------------------------------------------------------------

/**
 * Validate an instant using the contract's own timestamp rule.
 *
 * Reached through `Lease.shape.expiresAt` deliberately: the contracts package
 * keeps its `Timestamp` schema module-private, and mirroring the grammar here
 * would be a fourth copy of a rule this repository has already had to
 * reconcile twice. Borrowing the field's parser borrows the rule itself.
 */
function isInstant(value: unknown): value is string {
  return Lease.shape.expiresAt.safeParse(value).success;
}

/** Ordering over admitted instants. Both sides are validated before comparison. */
function atOrAfter(left: string, right: string): boolean {
  return Date.parse(left) >= Date.parse(right);
}

// ---------------------------------------------------------------------------
// 1. The lease engine — stateless, over the caller's own live set
// ---------------------------------------------------------------------------

/**
 * The live leases, as the caller derived them.
 *
 * There is no registry in this module and no module-level state. The ledger is
 * the authority (ADR 0001): the caller folds `LEASE_ACQUIRED` and
 * `LEASE_REVOKED` into the set it passes here, and two callers reasoning over
 * the same ledger reach the same answer because this function is pure.
 */
export interface LeaseRequest {
  readonly leases: readonly Lease[];
  readonly now: string;
}

export interface LeaseGranted {
  readonly ok: true;
  readonly lease: Lease;
  readonly events: readonly EnforcementEvent[];
}

export type LeaseOutcome = LeaseGranted | EnforcementRefused;

function validateLeaseSet(leases: unknown, now: unknown, at: string): EnforcementRefused | null {
  if (!Array.isArray(leases)) return refuse("REQUEST_INVALID", at + ".leases");
  for (let index = 0; index < leases.length; index += 1) {
    if (!Lease.safeParse(leases[index]).success) {
      return refuse("LEASE_INVALID", at + ".leases[" + String(index) + "]");
    }
  }
  if (!isInstant(now)) return refuse("INSTANT_INVALID", at + ".now");
  return null;
}

/**
 * Is this lease still live at `now`?
 *
 * The instant of expiry is **expired**: `now >= expiresAt` authorizes nothing.
 * A lease that expires at noon does not cover the packet that starts at noon,
 * because the two claims cannot both be checked against a clock that is only
 * accurate to the second.
 */
function isLive(lease: Lease, now: string): boolean {
  return !atOrAfter(now, lease.expiresAt);
}

/** Acquire a lease on a worktree. One live holder, always. */
export function acquireLease(
  request: LeaseRequest & { readonly candidate: Lease },
): LeaseOutcome {
  const raw: unknown = request;
  if (typeof raw !== "object" || raw === null) return refuse("REQUEST_INVALID", "request");
  const fields = raw as Record<string, unknown>;

  const candidateParse = Lease.safeParse(fields["candidate"]);
  if (!candidateParse.success) return refuse("LEASE_INVALID", "request.candidate");
  const candidate = candidateParse.data;

  const invalid = validateLeaseSet(fields["leases"], fields["now"], "request");
  if (invalid !== null) return invalid;
  const { leases, now } = request;

  // A lease has to make sense before it can be honoured. Each of these is a
  // shape a caller can hand over that would otherwise be treated as authority:
  // a duplicate id, a lease that starts in the future, or one whose window is
  // empty or inverted.
  const duplicate = leases.find((lease) => lease.leaseId === candidate.leaseId);
  if (
    duplicate !== undefined &&
    !(duplicate.worktreePath === candidate.worktreePath && duplicate.holder === candidate.holder)
  ) {
    // The idempotent re-offer of the same lease for the same worktree and
    // holder is tolerated; a reused id pointing anywhere else is not.
    return refuse("LEASE_INVALID", "request.candidate.leaseId");
  }
  if (atOrAfter(candidate.acquiredAt, now) && candidate.acquiredAt !== now) {
    return refuse("LEASE_INVALID", "request.candidate.acquiredAt");
  }
  if (atOrAfter(candidate.acquiredAt, candidate.expiresAt)) {
    return refuse("LEASE_INVALID", "request.candidate.expiresAt");
  }

  // A lease that has already expired authorizes nothing — including itself.
  if (!isLive(candidate, now)) return refuse("LEASE_EXPIRED", "request.candidate.expiresAt");

  // One writer per worktree. A live lease held by anyone else closes the door;
  // an expired one does not, which is what lets a worktree be re-leased after
  // its holder goes away without anyone reaching in to clean up first.
  const held = leases.find(
    (lease) => lease.worktreePath === candidate.worktreePath && isLive(lease, now),
  );
  if (held !== undefined && held.leaseId !== candidate.leaseId) {
    return refuse("LEASE_HELD_BY_ANOTHER", "request.candidate.worktreePath");
  }

  return Object.freeze({
    ok: true as const,
    lease: candidate,
    events: Object.freeze([
      event("LEASE_ACQUIRED", {
        leaseId: candidate.leaseId,
        worktreePath: candidate.worktreePath,
        holder: candidate.holder,
      }),
    ]),
  });
}

/** Renew a lease. Only its holder, and only while it is still live. */
export function renewLease(
  request: LeaseRequest & {
    readonly leaseId: string;
    readonly holder: string;
    readonly expiresAt: string;
  },
): LeaseOutcome {
  const raw: unknown = request;
  if (typeof raw !== "object" || raw === null) return refuse("REQUEST_INVALID", "request");
  const fields = raw as Record<string, unknown>;

  const invalid = validateLeaseSet(fields["leases"], fields["now"], "request");
  if (invalid !== null) return invalid;
  if (!isInstant(fields["expiresAt"])) return refuse("INSTANT_INVALID", "request.expiresAt");
  const { leases, now } = request;

  const existing = leases.find((lease) => lease.leaseId === request.leaseId);
  if (existing === undefined) return refuse("LEASE_NOT_FOUND", "request.leaseId");
  // Only the holder. A renewal by anyone else would be a second writer taking
  // the worktree by the back door.
  if (existing.holder !== request.holder) return refuse("LEASE_NOT_HELD", "request.holder");
  if (!isLive(existing, now)) return refuse("LEASE_EXPIRED", "request.leaseId");

  const renewed = Lease.safeParse({ ...existing, expiresAt: request.expiresAt });
  if (!renewed.success) return refuse("LEASE_INVALID", "request.expiresAt");

  return Object.freeze({
    ok: true as const,
    lease: renewed.data,
    events: Object.freeze([] as readonly EnforcementEvent[]),
  });
}

/** Revoke a live lease. */
export function revokeLease(
  request: LeaseRequest & { readonly leaseId: string; readonly cause: string },
): LeaseOutcome {
  const raw: unknown = request;
  if (typeof raw !== "object" || raw === null) return refuse("REQUEST_INVALID", "request");
  const fields = raw as Record<string, unknown>;

  const invalid = validateLeaseSet(fields["leases"], fields["now"], "request");
  if (invalid !== null) return invalid;
  const { leases, now } = request;

  const existing = leases.find((lease) => lease.leaseId === request.leaseId);
  if (existing === undefined) return refuse("LEASE_NOT_FOUND", "request.leaseId");
  if (!isLive(existing, now)) return refuse("LEASE_EXPIRED", "request.leaseId");

  return Object.freeze({
    ok: true as const,
    lease: existing,
    events: Object.freeze([
      event("LEASE_REVOKED", {
        leaseId: existing.leaseId,
        worktreePath: existing.worktreePath,
        holder: existing.holder,
        cause: request.cause,
      }),
    ]),
  });
}

// ---------------------------------------------------------------------------
// 2. Write-set conformance
// ---------------------------------------------------------------------------

export interface ConformanceRequest {
  readonly declaredWriteSet: readonly string[];
  readonly observation: WorktreeObservation;
  /** The lease the writer holds, so a violation can name what to revoke. */
  readonly leaseId: string;
}

export interface ConformanceVerdict {
  readonly ok: true;
  readonly conformant: boolean;
  /**
   * The `LEASE_REVOKED` candidate in `events` is the canonical instruction;
   * `revokeLeaseId` below merely names its subject. A caller applying this
   * verdict must not *also* call `revokeLease` for the same revocation — the
   * event is already there, and appending it twice would record a revocation
   * that happened once as if it had happened twice. (Unifying the two payload
   * shapes is deferred to P6C, the first real caller.)
   */
  /** Every observed path outside the declared set, sorted, deduplicated. */
  readonly violations: readonly string[];
  /** On a violation: revoke, quarantine, and change nothing else. */
  readonly revokeLeaseId: string | null;
  readonly recommendedTaskState: "SUSPECT_WORKTREE" | null;
  readonly events: readonly EnforcementEvent[];
}

export type ConformanceOutcome = ConformanceVerdict | EnforcementRefused;

/**
 * Compare an observation against the declared write-set.
 *
 * Tracked and untracked in one pass, exactly as the architecture fence does it:
 * a scan that only reads tracked files is a scan a new file walks straight
 * past. Any observed path outside the set is a violation.
 *
 * On a violation this recommends revoking the lease and moving the task to
 * `SUSPECT_WORKTREE`, **and recommends nothing else**. The worktree is left
 * exactly as it was found — the evidence of what happened is worth more than a
 * tidy directory, and no recovery this plane offers is allowed to destroy it.
 */
export function checkWriteSetConformance(request: ConformanceRequest): ConformanceOutcome {
  const raw: unknown = request;
  if (typeof raw !== "object" || raw === null) return refuse("REQUEST_INVALID", "request");
  const fields = raw as Record<string, unknown>;

  // The lease this verdict would revoke has to be a lease. A malformed id here
  // would produce a revocation instruction naming nothing.
  if (!Lease.shape.leaseId.safeParse(fields["leaseId"]).success) {
    return refuse("REQUEST_INVALID", "request.leaseId");
  }

  const declared: unknown = fields["declaredWriteSet"];
  if (!Array.isArray(declared)) return refuse("REQUEST_INVALID", "request.declaredWriteSet");
  if (declared.length === 0) return refuse("WRITE_SET_EMPTY", "request.declaredWriteSet");
  for (let index = 0; index < declared.length; index += 1) {
    const entry: unknown = declared[index];
    const at = "request.declaredWriteSet[" + String(index) + "]";
    if (typeof entry !== "string" || entry === "") return refuse("REQUEST_INVALID", at);
    // Repo-relative, or the comparison is meaningless: an absolute path or one
    // that climbs out of the tree describes a file this write-set has no
    // standing to authorize, and matching an observation against it would let
    // a declared escape hatch look like conformance.
    if (entry.startsWith("/")) return refuse("REQUEST_INVALID", at);
    if (entry.split("/").includes("..")) return refuse("REQUEST_INVALID", at);
  }

  const observation: unknown = fields["observation"];
  if (typeof observation !== "object" || observation === null) {
    return refuse("OBSERVATION_INVALID", "request.observation");
  }
  const observed = observation as Record<string, unknown>;
  const head: unknown = observed["head"];
  if (head !== null && (typeof head !== "string" || !GIT_OBJECT_ID.test(head))) {
    return refuse("OBSERVATION_INVALID", "request.observation.head");
  }
  const trackedChanges: unknown = observed["trackedChanges"];
  const untrackedPaths: unknown = observed["untrackedPaths"];
  if (!Array.isArray(trackedChanges)) {
    return refuse("OBSERVATION_INVALID", "request.observation.trackedChanges");
  }
  if (!Array.isArray(untrackedPaths)) {
    return refuse("OBSERVATION_INVALID", "request.observation.untrackedPaths");
  }

  const seen = new Set<string>(declared);
  const outside: string[] = [];
  for (let index = 0; index < trackedChanges.length; index += 1) {
    const change: unknown = trackedChanges[index];
    if (typeof change !== "object" || change === null) {
      return refuse("OBSERVATION_INVALID", "request.observation.trackedChanges[" + String(index) + "]");
    }
    const path: unknown = (change as Record<string, unknown>)["path"];
    if (typeof path !== "string" || path === "") {
      return refuse("OBSERVATION_INVALID", "request.observation.trackedChanges[" + String(index) + "].path");
    }
    if (!seen.has(path)) outside.push(path);
  }
  for (let index = 0; index < untrackedPaths.length; index += 1) {
    const path: unknown = untrackedPaths[index];
    if (typeof path !== "string" || path === "") {
      return refuse("OBSERVATION_INVALID", "request.observation.untrackedPaths[" + String(index) + "]");
    }
    if (!seen.has(path)) outside.push(path);
  }

  const violations = Object.freeze([...new Set(outside)].sort());
  if (violations.length === 0) {
    return Object.freeze({
      ok: true as const,
      conformant: true,
      violations: Object.freeze([] as readonly string[]),
      revokeLeaseId: null,
      recommendedTaskState: null,
      events: Object.freeze([] as readonly EnforcementEvent[]),
    });
  }

  return Object.freeze({
    ok: true as const,
    conformant: false,
    violations,
    revokeLeaseId: request.leaseId,
    recommendedTaskState: "SUSPECT_WORKTREE" as const,
    events: Object.freeze([
      event("WRITE_SET_VIOLATION_DETECTED", {
        leaseId: request.leaseId,
        firstPathOutsideSet: violations[0] ?? "",
        pathsOutsideSet: String(violations.length),
      }),
      event("LEASE_REVOKED", { leaseId: request.leaseId, cause: "WRITE_SET_VIOLATION_DETECTED" }),
    ]),
  });
}

/**
 * Turn a port failure into a refusal.
 *
 * An observation that could not be taken is never a pass. The alternative —
 * treating "we could not look" as "nothing was wrong" — is how an enforcement
 * plane becomes decorative.
 */
export function observationFailure(outcome: GitReadOutcome, at: string): EnforcementRefused | null {
  return outcome.ok ? null : refuse("OBSERVATION_FAILED", at);
}

// ---------------------------------------------------------------------------
// 3. Prestate verification
// ---------------------------------------------------------------------------

export interface PrestateRequest {
  /** `TaskEnvelope.authority`: the paths and digests the packet was authorized against. */
  readonly authority: readonly PathDigest[];
  /** The same paths, digested from the worktree the packet is about to run in. */
  readonly observed: readonly PathDigest[];
}

/**
 * The only prestate verdict there is.
 *
 * A mismatch is a refusal, not a verdict with a flag on it: the law is "refuse
 * the start on any mismatch, naming the path", and a caller that had to read a
 * boolean to discover that could forget to. `matches` is typed `true` because
 * that is the only value this shape can ever carry.
 */
export interface PrestateVerdict {
  readonly ok: true;
  readonly matches: true;
}

export type PrestateOutcome = PrestateVerdict | EnforcementRefused;

/**
 * Verify a worktree still matches the authority the packet was issued against.
 *
 * Digests are content digests — sha256 over file bytes — and never a git
 * plumbing call: the question is what the file says now, which is not the same
 * question as what git last recorded about it.
 *
 * A mismatch refuses the start and names the path. Recovery revalidates
 * authority and prestate; it never forces an old snapshot over a worktree.
 */
export function verifyPrestate(request: PrestateRequest): PrestateOutcome {
  const raw: unknown = request;
  if (typeof raw !== "object" || raw === null) return refuse("REQUEST_INVALID", "request");
  const fields = raw as Record<string, unknown>;
  const authority: unknown = fields["authority"];
  const observed: unknown = fields["observed"];
  if (!Array.isArray(authority)) return refuse("REQUEST_INVALID", "request.authority");
  // A packet with no authority has none. Treating an empty list as "everything
  // matched" would let a packet start against any worktree at all.
  if (authority.length === 0) return refuse("PRESTATE_MISSING", "request.authority");
  if (!Array.isArray(observed)) return refuse("REQUEST_INVALID", "request.observed");

  const byPath = new Map<string, string>();
  for (let index = 0; index < observed.length; index += 1) {
    const entry: unknown = observed[index];
    if (typeof entry !== "object" || entry === null) {
      return refuse("REQUEST_INVALID", "request.observed[" + String(index) + "]");
    }
    const fieldsOf = entry as Record<string, unknown>;
    const path: unknown = fieldsOf["path"];
    const digest: unknown = fieldsOf["sha256"];
    if (typeof path !== "string" || typeof digest !== "string") {
      return refuse("REQUEST_INVALID", "request.observed[" + String(index) + "]");
    }
    byPath.set(path, digest);
  }

  const mismatched: string[] = [];
  for (let index = 0; index < authority.length; index += 1) {
    const entry: unknown = authority[index];
    if (typeof entry !== "object" || entry === null) {
      return refuse("REQUEST_INVALID", "request.authority[" + String(index) + "]");
    }
    const fieldsOf = entry as Record<string, unknown>;
    const path: unknown = fieldsOf["path"];
    const digest: unknown = fieldsOf["sha256"];
    if (typeof path !== "string" || typeof digest !== "string") {
      return refuse("REQUEST_INVALID", "request.authority[" + String(index) + "]");
    }
    const seen = byPath.get(path);
    // Absent counts as mismatched: a file the authority names and the worktree
    // does not have is not a match, and calling it one would let a packet start
    // against a tree it was never authorized for.
    if (seen === undefined || seen !== digest) mismatched.push(path);
  }

  const mismatches = [...new Set(mismatched)].sort();
  const first = mismatches[0];
  if (first !== undefined) {
    return refuse("PRESTATE_MISMATCH", "request.authority." + first);
  }
  return Object.freeze({ ok: true as const, matches: true as const });
}
