/**
 * P6B: the conflict graph.
 *
 * Given a set of task envelopes, decide which pairs may run in parallel and
 * name exactly why the others may not. AGENTS.md law 1 is the rule being
 * enforced: write-sets, authorities and derived outputs do not intersect.
 *
 * **The graph decides envelope compatibility, and nothing else.** Worktree
 * isolation is a different question and remains P6A's lease check. The
 * composition order is: the graph first, then acquire, then write -- this
 * module is the gate applied *before* `acquireLease`, and it neither takes a
 * lease nor knows one exists.
 *
 * Pure and deterministic: envelopes are injected values, the output is frozen
 * at every level, and the verdict does not depend on the order the caller
 * happened to supply. No clock, no I/O, no git, no observation of anything.
 */

import { TaskEnvelope } from "@acp/contracts";

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/**
 * Why a pair conflicts.
 *
 * Read-read overlap is deliberately absent. Every packet is authorized by
 * `AGENTS.md`, so two packets sharing an authority path or a read path is the
 * normal case, not a collision -- the law reads as write-versus-{write,
 * authority, read}, in both directions. A graph that called read-read a
 * conflict would refuse every pair in the repository.
 *
 * There is no self-conflict kind either: `writeSet` uniqueness is a contract
 * refinement, and a packet that reads or is authorized by what it writes is
 * ordinary.
 */
export type ConflictKind =
  | "CONFLICT_KEY"
  | "WRITE_WRITE"
  | "WRITE_AUTHORITY"
  | "WRITE_READ";

export const CONFLICT_KINDS: readonly ConflictKind[] = Object.freeze([
  "CONFLICT_KEY",
  "WRITE_AUTHORITY",
  "WRITE_READ",
  "WRITE_WRITE",
]);

/** The duplicate-`taskId` finding is a property of the set, not of a pair. */
export const DUPLICATE_TASK_ID = "DUPLICATE_TASK_ID";

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export type GraphRefusal = "REQUEST_INVALID" | "ENVELOPE_INVALID";

export const GRAPH_REFUSALS: readonly GraphRefusal[] = Object.freeze([
  "ENVELOPE_INVALID",
  "REQUEST_INVALID",
]);

export interface GraphRefused {
  readonly ok: false;
  readonly reason: GraphRefusal;
  /** The input that decided it. A path, never a value. */
  readonly at: string;
}

function refuse(reason: GraphRefusal, at: string): GraphRefused {
  return Object.freeze({ ok: false as const, reason, at });
}

// ---------------------------------------------------------------------------
// Path intersection
// ---------------------------------------------------------------------------

/**
 * Normalize a path for comparison only.
 *
 * Exact string equality is unsafe here: `./src/a.ts`, `src//a.ts` and
 * `src/a.ts` name one file, and a graph that saw three different strings would
 * declare a write-write collision compatible. Normalization is internal -- the
 * verdict always reports the caller's own strings, because those are what the
 * caller has to go and fix.
 */
function normalize(path: string): string {
  let value = path;
  while (value.includes("//")) value = value.replace("//", "/");
  // Interior `.` segments too, not just a leading one: `src/./a.ts` names the
  // same file as `src/a.ts`, and a normalizer that only stripped the prefix
  // would call that pair compatible -- the precise fail-open hole this
  // function exists to close.
  while (value.includes("/./")) value = value.replace("/./", "/");
  while (value.startsWith("./")) value = value.slice(2);
  while (value.length > 1 && value.endsWith("/.")) value = value.slice(0, -2);
  while (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  // A bare "." is the repository root, and the root contains everything.
  return value === "." ? "" : value;
}

/**
 * Do two paths intersect?
 *
 * Equality, **or ancestor containment**: `packages/x` and `packages/x/a.ts`
 * intersect, because a packet that may write the directory may write the file
 * inside it. Fail-closed by construction -- the containment case is the one a
 * naive equality check misses, and missing it authorizes exactly the parallel
 * write the law forbids.
 */
function pathsIntersect(left: string, right: string): boolean {
  const a = normalize(left);
  const b = normalize(right);
  if (a === b) return true;
  // The root normalizes to the empty string and contains every path.
  if (a === "" || b === "") return true;
  return b.startsWith(a + "/") || a.startsWith(b + "/");
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** One intersecting pair of the callers' own strings, with the kind it caused. */
export interface ConflictIntersection {
  readonly kind: ConflictKind;
  /** The entry from the lexicographically first task of the pair. */
  readonly left: string;
  /** The entry from the second. */
  readonly right: string;
}

export interface ConflictPair {
  /** Lexicographically first of the two task ids. */
  readonly taskIdA: string;
  readonly taskIdB: string;
  /** Every kind this pair conflicts on, sorted. */
  readonly kinds: readonly ConflictKind[];
  /** Every intersecting entry, sorted, never a bare `false`. */
  readonly intersections: readonly ConflictIntersection[];
}

export interface DuplicateTaskId {
  readonly taskId: string;
  /** How many envelopes in the set carry it. Always at least 2. */
  readonly count: number;
}

export interface ConflictVerdict {
  readonly ok: true;
  /**
   * True iff every unordered pair is conflict-free and no id repeats.
   *
   * Zero or one envelope is compatible -- vacuously, and the verdict says so
   * rather than leaving the caller to infer it from an empty list.
   */
  readonly compatible: boolean;
  /** Only the conflicting pairs, ordered by `(taskIdA, taskIdB)`. */
  readonly pairs: readonly ConflictPair[];
  /** One entry per repeated id, with its multiplicity, ordered by id. */
  readonly duplicateTaskIds: readonly DuplicateTaskId[];
}

export type ConflictOutcome = ConflictVerdict | GraphRefused;

// ---------------------------------------------------------------------------
// The pairwise decision
// ---------------------------------------------------------------------------

interface Sides {
  readonly taskId: string;
  readonly conflictKeys: readonly string[];
  readonly writeSet: readonly string[];
  readonly readSet: readonly string[];
  readonly authority: readonly string[];
}

function sidesOf(envelope: TaskEnvelope): Sides {
  return {
    taskId: envelope.taskId,
    conflictKeys: envelope.conflictKeys,
    writeSet: envelope.writeSet,
    readSet: envelope.readSet,
    authority: envelope.authority.map((entry) => entry.path),
  };
}

function compareIntersection(left: ConflictIntersection, right: ConflictIntersection): number {
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  if (left.left !== right.left) return left.left < right.left ? -1 : 1;
  if (left.right === right.right) return 0;
  return left.right < right.right ? -1 : 1;
}

/**
 * Every way these two envelopes collide.
 *
 * Kind (c) is checked in **both** directions: A writing what B is authorized
 * by is the same violation as B writing what A is authorized by, and a graph
 * that only looked one way would let the second past.
 */
function intersectionsFor(a: Sides, b: Sides): readonly ConflictIntersection[] {
  const found: ConflictIntersection[] = [];

  // Opaque keys compare by exact equality only -- they are the caller's own
  // vocabulary, and this module has no standing to interpret their shape.
  for (const left of a.conflictKeys) {
    for (const right of b.conflictKeys) {
      if (left === right) found.push({ kind: "CONFLICT_KEY", left, right });
    }
  }
  for (const left of a.writeSet) {
    for (const right of b.writeSet) {
      if (pathsIntersect(left, right)) found.push({ kind: "WRITE_WRITE", left, right });
    }
  }
  for (const left of a.writeSet) {
    for (const right of b.authority) {
      if (pathsIntersect(left, right)) found.push({ kind: "WRITE_AUTHORITY", left, right });
    }
  }
  for (const left of a.authority) {
    for (const right of b.writeSet) {
      if (pathsIntersect(left, right)) found.push({ kind: "WRITE_AUTHORITY", left, right });
    }
  }
  for (const left of a.writeSet) {
    for (const right of b.readSet) {
      if (pathsIntersect(left, right)) found.push({ kind: "WRITE_READ", left, right });
    }
  }
  for (const left of a.readSet) {
    for (const right of b.writeSet) {
      if (pathsIntersect(left, right)) found.push({ kind: "WRITE_READ", left, right });
    }
  }

  // A separator no `RepoRelativePath` and no conflict key can contain: a space
  // is a legal character in both, so keying on one could fuse two distinct
  // intersections into a single entry and lose a real collision from the
  // report.
  const SEP = "\u0000";
  const unique = new Map<string, ConflictIntersection>();
  for (const entry of found) {
    unique.set(entry.kind + SEP + entry.left + SEP + entry.right, entry);
  }
  return [...unique.values()].sort(compareIntersection);
}

function pairFor(a: Sides, b: Sides): ConflictPair | null {
  const ordered = a.taskId <= b.taskId ? [a, b] : [b, a];
  const first = ordered[0];
  const second = ordered[1];
  if (first === undefined || second === undefined) return null;
  const intersections = intersectionsFor(first, second);
  if (intersections.length === 0) return null;
  const kinds = [...new Set(intersections.map((entry) => entry.kind))].sort();
  return Object.freeze({
    taskIdA: first.taskId,
    taskIdB: second.taskId,
    kinds: Object.freeze(kinds),
    intersections: Object.freeze(intersections.map((entry) => Object.freeze({ ...entry }))),
  });
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function parseEnvelopes(value: unknown, at: string): readonly TaskEnvelope[] | GraphRefused {
  if (!Array.isArray(value)) return refuse("REQUEST_INVALID", at);
  const parsed: TaskEnvelope[] = [];
  for (let index = 0; index < value.length; index += 1) {
    // The contracts' own parser, never a local re-statement of the shape.
    const result = TaskEnvelope.safeParse(value[index]);
    if (!result.success) return refuse("ENVELOPE_INVALID", at + "[" + String(index) + "]");
    parsed.push(result.data);
  }
  return parsed;
}

function isRefused(value: readonly TaskEnvelope[] | GraphRefused): value is GraphRefused {
  return !Array.isArray(value);
}

function verdictOver(
  envelopes: readonly TaskEnvelope[],
  keep: (pair: ConflictPair) => boolean,
): ConflictVerdict {
  const counts = new Map<string, number>();
  for (const envelope of envelopes) {
    counts.set(envelope.taskId, (counts.get(envelope.taskId) ?? 0) + 1);
  }
  const duplicateTaskIds = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([taskId, count]) => Object.freeze({ taskId, count }))
    .sort((left, right) => (left.taskId < right.taskId ? -1 : 1));

  const sides = envelopes.map(sidesOf);
  // Keyed by the pair, not by the position: when an id repeats, the same
  // unordered pair is reachable from more than one index, and reporting it
  // twice would say two collisions happened where one did. The set is still
  // incompatible -- `duplicateTaskIds` carries that -- but the pair list must
  // name each pair once.
  const byPair = new Map<string, ConflictPair>();
  for (let i = 0; i < sides.length; i += 1) {
    for (let j = i + 1; j < sides.length; j += 1) {
      const left = sides[i];
      const right = sides[j];
      if (left === undefined || right === undefined) continue;
      // Two envelopes carrying the same id are the duplicate finding, not a
      // pair verdict: there is no "other" packet to be incompatible with.
      if (left.taskId === right.taskId) continue;
      const pair = pairFor(left, right);
      if (pair !== null && keep(pair)) {
        byPair.set(pair.taskIdA + "\u0000" + pair.taskIdB, pair);
      }
    }
  }
  const pairs = [...byPair.values()];
  pairs.sort((left, right) => {
    if (left.taskIdA !== right.taskIdA) return left.taskIdA < right.taskIdA ? -1 : 1;
    if (left.taskIdB === right.taskIdB) return 0;
    return left.taskIdB < right.taskIdB ? -1 : 1;
  });

  return Object.freeze({
    ok: true as const,
    compatible: pairs.length === 0 && duplicateTaskIds.length === 0,
    pairs: Object.freeze(pairs),
    duplicateTaskIds: Object.freeze(duplicateTaskIds),
  });
}

// ---------------------------------------------------------------------------
// The two forms
// ---------------------------------------------------------------------------

export interface ConflictGraphRequest {
  readonly envelopes: readonly TaskEnvelope[];
}

/** The complete pairwise verdict over a candidate set. */
export function buildConflictGraph(request: ConflictGraphRequest): ConflictOutcome {
  const raw: unknown = request;
  if (typeof raw !== "object" || raw === null) return refuse("REQUEST_INVALID", "request");
  const parsed = parseEnvelopes((raw as Record<string, unknown>)["envelopes"], "request.envelopes");
  if (isRefused(parsed)) return parsed;
  return verdictOver(parsed, () => true);
}

export interface AdmissionRequest {
  readonly admitted: readonly TaskEnvelope[];
  readonly candidate: TaskEnvelope;
}

/**
 * May this candidate join the admitted set?
 *
 * Defined **as** the graph over the admitted set plus the candidate,
 * restricted to the pairs involving the candidate. Defining it this way rather
 * than writing a second comparison means the two forms cannot disagree: there
 * is only one implementation of what a conflict is, and this one calls it.
 *
 * If the **admitted set itself** carries a duplicate id, no candidate is
 * admitted: `duplicateTaskIds` is non-empty, so `compatible` is false whatever
 * the candidate looks like. That is deliberate and fail-closed -- a corrupt
 * admitted set is not a state this module can reason from, and admitting into
 * it would be building on a contradiction.
 */
export function checkAdmission(request: AdmissionRequest): ConflictOutcome {
  const raw: unknown = request;
  if (typeof raw !== "object" || raw === null) return refuse("REQUEST_INVALID", "request");
  const fields = raw as Record<string, unknown>;

  const admitted = parseEnvelopes(fields["admitted"], "request.admitted");
  if (isRefused(admitted)) return admitted;
  const candidateResult = TaskEnvelope.safeParse(fields["candidate"]);
  if (!candidateResult.success) return refuse("ENVELOPE_INVALID", "request.candidate");
  const candidate = candidateResult.data;

  return verdictOver(
    [...admitted, candidate],
    (pair) => pair.taskIdA === candidate.taskId || pair.taskIdB === candidate.taskId,
  );
}
