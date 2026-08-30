import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CONTRACT_VERSION, ControlPlaneEvent, TaskEnvelope } from "@acp/contracts";
import type { CommitPolicy, Lease, PathDigest, TaskEnvelope as TaskEnvelopeShape } from "@acp/contracts";

import type { DurableInvocation } from "../../../src/contracts/index.js";
import { deriveEventCoordinate } from "../../../src/core/coordinates/index.js";
import { GIT_READ_VERBS } from "../../../src/enforcement/index.js";
import type {
  EnforcementEvent,
  GitReadOutcome,
  GitReadPort,
  GitReadRequest,
  WorktreeObservation,
} from "../../../src/enforcement/index.js";

/**
 * P7A pilot helpers: fixtures and pure wiring for the read-only packet drill.
 *
 * Everything here is either pure (no I/O) or confined to reading and writing
 * files with `node:fs`, which the architecture fence allows any runtime
 * source to do. Nothing here imports `node:child_process`: the one thing this
 * drill genuinely spawns is `git`, and that stays in `test/pilots/index.test.ts`
 * -- the only file in this pair whose name ends `.test.ts`, which is what the
 * fence's import-purity check treats as test-only. A helper module under
 * `test/` that is not itself `*.test.ts` is still scanned as production-shaped
 * source, so the spawn boundary is a real constraint here, not a style choice.
 */

// ---------------------------------------------------------------------------
// Identities -- C3: valid four-segment WorkerIdentityStrings, pairwise distinct
// ---------------------------------------------------------------------------

export const PILOT_WRITER = "claude/sonnet/implementer/01";
export const PILOT_VERIFIER = "claude/opus/verifier/01";
export const PILOT_AUTHORIZED_BY = "kimi/k3/coordinator/01";
export const PILOT_AUDITOR = "claude/fable/reviewer/01";

export const PILOT_IDENTITIES: readonly string[] = Object.freeze([
  PILOT_WRITER,
  PILOT_VERIFIER,
  PILOT_AUTHORIZED_BY,
  PILOT_AUDITOR,
]);

// ---------------------------------------------------------------------------
// Content digests, over real bytes
// ---------------------------------------------------------------------------

/** sha256 over a file's real bytes. Never a git plumbing digest. */
export function sha256File(absolutePath: string): string {
  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}

// ---------------------------------------------------------------------------
// The toy git repository's fixed content
// ---------------------------------------------------------------------------

export const TOY_README_PATH = "README.md";
export const TOY_SCRATCH_PATH = "scratch.txt";
export const TOY_NOTES_DIR = "notes";
export const TOY_NOTES_PATH = "notes/todo.txt";

const README_CONTENT = "toy repository for the P7A pilot drill\n";
const SCRATCH_CONTENT = "untracked scratch file\n";
const NOTES_CONTENT = "untracked directory with contents\n";

/**
 * Write the toy repository's fixed content to a directory the caller already
 * created. Does not touch git: `init`/`add`/`commit` are the fixture's own
 * mutating commands and stay in the `.test.ts` file that owns the spawn.
 */
export function writeToyContent(toyRoot: string): void {
  writeFileSync(join(toyRoot, TOY_README_PATH), README_CONTENT, "utf8");
  writeFileSync(join(toyRoot, TOY_SCRATCH_PATH), SCRATCH_CONTENT, "utf8");
  mkdirSync(join(toyRoot, TOY_NOTES_DIR), { recursive: true });
  writeFileSync(join(toyRoot, TOY_NOTES_PATH), NOTES_CONTENT, "utf8");
}

/** Plant an extra untracked file the declared set does not name. */
export function plantIntruder(toyRoot: string): string {
  const relative = "intruder.txt";
  writeFileSync(join(toyRoot, relative), "a file the write-set fence should catch\n", "utf8");
  return relative;
}

// ---------------------------------------------------------------------------
// The test-tree GitReadPort -- N1: only the four read verbs, ever
// ---------------------------------------------------------------------------

export interface SpawnResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type SpawnGit = (args: readonly string[]) => SpawnResult;

/**
 * The production `GitReadPort` type, implemented here in the test tree.
 *
 * P6A-C1's law stands: no production observer exists, and this is not one --
 * it is a test implementation of a type the production module only declares.
 * The verb is checked against `GIT_READ_VERBS` before `spawnGit` is ever
 * called, so a denied verb (or a caller-constructed request naming one) never
 * reaches the process boundary at all.
 */
export function createGitReadPort(spawnGit: SpawnGit): GitReadPort {
  return (request: GitReadRequest): GitReadOutcome => {
    if (!GIT_READ_VERBS.includes(request.verb)) {
      return { ok: false, reason: "refused: '" + request.verb + "' is not a read verb" };
    }
    const result = spawnGit([request.verb, ...request.args]);
    if (result.status !== 0) {
      return {
        ok: false,
        reason: "git " + request.verb + " exited " + String(result.status) + ": " + result.stderr.trim(),
      };
    }
    return { ok: true, stdout: result.stdout };
  };
}

const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;

/**
 * Take one observation of the toy repository through the port, in exactly
 * the shape `checkWriteSetConformance` requires: untracked paths enumerated
 * per file, tracked changes as real content digests.
 *
 * This pilot never modifies the one committed file, so the tracked-change
 * branch below is exercised by construction only if a future extension adds
 * one; it is still real -- it reads the current bytes at `path`, never a git
 * plumbing hash -- rather than a placeholder for a shape this drill does not
 * itself plant.
 */
export function takeObservation(port: GitReadPort, toyRoot: string): WorktreeObservation {
  const headOutcome = port({ verb: "rev-parse", args: ["HEAD"] });
  if (!headOutcome.ok) throw new Error("rev-parse HEAD failed: " + headOutcome.reason);
  const head = headOutcome.stdout.trim();

  const statusOutcome = port({
    verb: "status",
    args: ["--porcelain=v1", "--untracked-files=all", "--ignored=no"],
  });
  if (!statusOutcome.ok) throw new Error("git status failed: " + statusOutcome.reason);

  const trackedChanges: PathDigest[] = [];
  const untrackedPaths: string[] = [];
  for (const line of statusOutcome.stdout.split("\n")) {
    if (line.length === 0) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3);
    if (code === "??") {
      untrackedPaths.push(path);
      continue;
    }
    trackedChanges.push({ path, sha256: sha256File(join(toyRoot, path)) });
  }

  return {
    head: GIT_OBJECT_ID.test(head) ? head : null,
    trackedChanges: Object.freeze(trackedChanges),
    untrackedPaths: Object.freeze(untrackedPaths),
  };
}

// ---------------------------------------------------------------------------
// The task envelope
// ---------------------------------------------------------------------------

export interface PilotEnvelopeInput {
  readonly taskId: string;
  readonly issuedAt: string;
  readonly authority: readonly PathDigest[];
  readonly readSet: readonly string[];
  readonly writeSet: readonly string[];
  readonly conflictKeys: readonly string[];
  readonly commitPolicy: CommitPolicy;
}

/** A minimal, real `TaskEnvelope`. Parsed, never assembled by cast. */
export function pilotEnvelope(input: PilotEnvelopeInput): TaskEnvelopeShape {
  return TaskEnvelope.parse({
    contractVersion: CONTRACT_VERSION,
    taskId: input.taskId,
    title: "P7A pilot: read-only packet",
    objective: "walk a NO_COMMIT packet over the real machinery and prove the fence",
    classification: "MECHANICAL",
    issuedBy: PILOT_AUTHORIZED_BY,
    issuedAt: input.issuedAt,
    authority: input.authority,
    readSet: input.readSet,
    writeSet: input.writeSet,
    conflictKeys: input.conflictKeys,
    allowedCommands: [],
    forbiddenActions: [],
    output: { kind: "NONE", description: "no artifact; this packet only reads" },
    validation: { commands: [], independentVerifierRequired: true },
    eligibility: { roles: ["implementer"], providers: null, requiredCapabilities: [] },
    budget: { maxTokens: 10_000, maxWallClockSeconds: 600, reserveTokensForCheckpoint: 1_000 },
    visualEvidenceRequired: false,
    commitPolicy: input.commitPolicy,
    checkpointPolicy: { onEveryAtomicStep: true, maxStepsWithoutCheckpoint: 5 },
  });
}

// ---------------------------------------------------------------------------
// Wrapping an enforcement candidate as a real ledger event
// ---------------------------------------------------------------------------

/**
 * Turn one `EnforcementEvent` candidate into a real, parsed `ControlPlaneEvent`
 * ready for `ledger.append`.
 *
 * The envelope -- id and instants -- is derived the same way `core/events`
 * derives it for a plan step: `deriveEventCoordinate` over durable invocation
 * inputs only, so two runs of this drill produce byte-identical events (N2a).
 * `fromState`/`toState` are the same state, which is legal for every event
 * type except `TASK_STATE_CHANGED` (the contract's own rule) -- a lease or
 * conformance decision does not itself move the task's lifecycle state.
 */
export function wrapEnforcementEvent(
  invocation: DurableInvocation,
  transitionId: string,
  atState: string,
  emittedBy: string,
  candidate: EnforcementEvent,
): ControlPlaneEvent {
  const coordinate = deriveEventCoordinate(invocation, transitionId, 0);
  return ControlPlaneEvent.parse({
    contractVersion: CONTRACT_VERSION,
    eventId: coordinate.eventId,
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    transitionId,
    idempotencyKey: coordinate.idempotencyKey,
    type: candidate.type,
    fromState: atState,
    toState: atState,
    emittedBy,
    occurredAt: coordinate.occurredAt,
    recordedAt: coordinate.recordedAt,
    correlationId: null,
    causationId: null,
    payload: candidate.payload,
  });
}

/** A synthesized `TASK_STATE_CHANGED` event, for the caller's own recommendation. */
export function wrapStateChange(
  invocation: DurableInvocation,
  transitionId: string,
  fromState: string,
  toState: string,
  emittedBy: string,
  payload: Readonly<Record<string, string>>,
): ControlPlaneEvent {
  const coordinate = deriveEventCoordinate(invocation, transitionId, 0);
  return ControlPlaneEvent.parse({
    contractVersion: CONTRACT_VERSION,
    eventId: coordinate.eventId,
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    transitionId,
    idempotencyKey: coordinate.idempotencyKey,
    type: "TASK_STATE_CHANGED",
    fromState,
    toState,
    emittedBy,
    occurredAt: coordinate.occurredAt,
    recordedAt: coordinate.recordedAt,
    correlationId: null,
    causationId: null,
    payload,
  });
}

// ---------------------------------------------------------------------------
// N3: the live-lease fold, over the real ledger -- the caller's own
// responsibility per P6A/P6F's documented law, exercised for the first time
// ---------------------------------------------------------------------------

interface FoldableEvent {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Ledger order: the sequence the row was appended at. */
  readonly sequence: number;
}

/**
 * Reconstruct the live-lease set from a ledger's own events.
 *
 * The fold rule, exactly as `enforcement/index.ts` documents it: per
 * `leaseId`, the last `LEASE_ACQUIRED` **in ledger order** wins; a
 * `LEASE_REVOKED` is terminal for that id, so a later `LEASE_ACQUIRED` for a
 * revoked id does not resurrect it. There is no fold utility inside the
 * enforcement module -- the module holds no state by design, and its own
 * documentation assigns this reconstruction to the caller. This is that
 * caller, for the first real ledger this repository has folded one over.
 */
export function foldLiveLeases(events: readonly FoldableEvent[]): ReadonlyMap<string, Lease> {
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
      if (revoked.has(leaseId)) continue; // terminal: not a resurrection
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
