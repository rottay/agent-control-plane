import { readArtifact } from "@acp/ledger";
import { UNSCOPED_INITIATIVE, computeTokenRollups } from "@acp/observation";
import type { TaskTokenRollup, TokenRollups } from "@acp/observation";
import type {
  InitiativeEventRecord,
  InitiativeReadModel,
  Ledger,
  LedgerEventRecord,
  RoadmapVersionReadModel,
  TaskReadModel,
} from "@acp/ledger";

/**
 * The initiative read model the API serves.
 *
 * Three folds meet here and nowhere else: the ledger's initiative projection,
 * the roadmap-version history, and the observation plane's token rollups. The
 * route handlers stay thin because assembling them is a decision — which
 * events to page, which task belongs to which initiative, what to do with
 * spend that belongs to none — and a decision belongs in a module a test can
 * reach without an HTTP client.
 *
 * **Read-only, like everything else in this server.** Nothing here appends,
 * and nothing here is an authority: every number is derived from ledger events
 * and can be recomputed from them. If this module and its callers were
 * deleted, no fact would be lost.
 *
 * **The registration details are nullable on purpose.** `slug`, `title` and
 * `objective` are not columns of the initiative projection — they arrive in
 * the `INITIATIVE_REGISTERED` event's payload, which is a bounded free-form
 * record. An initiative registered without them has none, and this module
 * reports null rather than an empty string: null says the stream never carried
 * one, whereas `""` is a value that reads as a title nobody wrote.
 */

/** The registration facts a stream may or may not have carried. */
export interface InitiativeRegistrationDetail {
  readonly slug: string | null;
  readonly title: string | null;
  readonly objective: string | null;
}

export interface InitiativePortfolioRow {
  readonly initiative: InitiativeReadModel;
  readonly detail: InitiativeRegistrationDetail;
  readonly headRoadmapDigest: string | null;
  readonly roadmapVersionCount: number;
  readonly taskCount: number;
  readonly rollup: { readonly tokensUsed: number; readonly tokensReserved: number; readonly skippedMalformed: number };
}

export interface InitiativeDetailModel {
  readonly row: InitiativePortfolioRow;
  /** Newest first, with the head marked. */
  readonly roadmap: readonly { readonly version: RoadmapVersionReadModel; readonly head: boolean }[];
  readonly tasks: readonly { readonly task: TaskReadModel; readonly rollup: TaskTokenRollup | null }[];
  readonly quota: {
    readonly confidence: "HIGH" | "LOW";
    readonly skippedMalformed: number;
    readonly unscopedTokensUsed: number;
  };
}

/**
 * How many rows one page of the underlying paging reads.
 *
 * The ledger caps a single query at 1000, so a whole-stream fold has to page.
 * The **fold itself is not bounded**: it reads the stream to its end.
 *
 * That is a deliberate cost. A rollup taken over a prefix of the stream is not
 * a partial answer, it is a wrong one — it would report a total that looks
 * exact, drift as the ledger grew, and give two readers different numbers for
 * the same question depending on when they asked. A read model may be slow; it
 * may not be confidently wrong.
 */
export const INITIATIVE_PAGE_SIZE = 1_000;

const EMPTY_ROLLUP = Object.freeze({ tokensUsed: 0, tokensReserved: 0, skippedMalformed: 0 });

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The registration detail for one initiative, read from its own stream.
 *
 * The registering event is found by type rather than by position: a stream
 * whose first event is not the registration would still be found, and one with
 * no registration at all yields nulls instead of a guess.
 */
export function registrationDetail(ledger: Ledger, initiativeId: string): InitiativeRegistrationDetail {
  const page = ledger.listInitiativeEvents({ initiativeId, limit: 200 });
  for (const record of page.events) {
    if (record.event.type !== "INITIATIVE_REGISTERED") continue;
    const payload = record.event.payload;
    return Object.freeze({
      slug: stringOrNull(payload["slug"]),
      title: stringOrNull(payload["title"]),
      objective: stringOrNull(payload["objective"]),
    });
  }
  return Object.freeze({ slug: null, title: null, objective: null });
}

/**
 * Fold the task stream once, for every initiative at once.
 *
 * Once rather than per initiative: the portfolio would otherwise re-read the
 * same events for each row, and — worse — two rows could be folded from
 * different pages of a moving ledger and disagree about the same task.
 */
export function rollupsFor(ledger: Ledger): { readonly rollups: TokenRollups; readonly tasks: readonly TaskReadModel[] } {
  const tasks: TaskReadModel[] = [];
  let taskCursor: string | null = null;
  for (;;) {
    const page: ReturnType<Ledger["listTasks"]> = ledger.listTasks({
      afterTaskId: taskCursor ?? undefined,
      limit: INITIATIVE_PAGE_SIZE,
    });
    tasks.push(...page.tasks);
    if (!page.hasMore || page.nextCursor === null) break;
    taskCursor = page.nextCursor;
  }

  const initiativeByTask = new Map<string, string | null>(
    tasks.map((task) => [task.taskId, task.initiativeId]),
  );

  // The whole stream, in ledger order, paged because the ledger caps one query
  // and folded because the rollup is only true over all of it.
  const events: LedgerEventRecord["event"][] = [];
  let eventCursor: number | null = null;
  for (;;) {
    const page: ReturnType<Ledger["listEvents"]> = ledger.listEvents({
      afterSequence: eventCursor ?? undefined,
      limit: INITIATIVE_PAGE_SIZE,
    });
    for (const record of page.events) events.push(record.event);
    if (!page.hasMore || page.nextCursor === null) break;
    eventCursor = page.nextCursor;
  }

  return { rollups: computeTokenRollups({ events, initiativeByTask }), tasks };
}

function summaryRow(
  ledger: Ledger,
  initiative: InitiativeReadModel,
  rollups: TokenRollups,
  tasks: readonly TaskReadModel[],
): InitiativePortfolioRow {
  const versions = ledger.listRoadmapVersions(initiative.initiativeId);
  const head = versions.at(-1);
  const scoped = tasks.filter((task) => task.initiativeId === initiative.initiativeId);
  const folded = rollups.byInitiative.find(
    (entry) => entry.initiativeId === initiative.initiativeId,
  );

  return Object.freeze({
    initiative,
    detail: registrationDetail(ledger, initiative.initiativeId),
    headRoadmapDigest: head === undefined ? null : head.contentDigest,
    roadmapVersionCount: versions.length,
    // The task count comes from the projection, not from the rollup: a task
    // that has spent nothing is still one of the initiative's tasks, and the
    // fold only knows tasks that produced a usage or reservation event.
    taskCount: scoped.length,
    rollup:
      folded === undefined
        ? EMPTY_ROLLUP
        : Object.freeze({
            tokensUsed: folded.tokensUsed,
            tokensReserved: folded.tokensReserved,
            skippedMalformed: folded.skippedMalformed,
          }),
  });
}

/** Every initiative, with its rollup summary. */
export function portfolio(ledger: Ledger): readonly InitiativePortfolioRow[] {
  const { rollups, tasks } = rollupsFor(ledger);
  return ledger
    .listInitiatives()
    .map((initiative) => summaryRow(ledger, initiative, rollups, tasks));
}

/** One initiative in full, or null when the ledger has never seen it. */
export function initiativeDetail(ledger: Ledger, initiativeId: string): InitiativeDetailModel | null {
  const initiative = ledger.getInitiative(initiativeId);
  if (initiative === null) return null;

  const { rollups, tasks } = rollupsFor(ledger);
  const row = summaryRow(ledger, initiative, rollups, tasks);

  const versions = ledger.listRoadmapVersions(initiativeId);
  const headId = versions.at(-1)?.roadmapVersionId ?? null;
  // Newest first: a reader of a history wants the current state at the top,
  // and the ledger returns version order because a fold wants the oldest.
  const roadmap = [...versions]
    .reverse()
    .map((version) => Object.freeze({ version, head: version.roadmapVersionId === headId }));

  const scoped = tasks.filter((task) => task.initiativeId === initiativeId);
  const rollupByTask = new Map(rollups.byTask.map((entry) => [entry.taskId, entry]));
  const scopedTasks = scoped.map((task) =>
    Object.freeze({ task, rollup: rollupByTask.get(task.taskId) ?? null }),
  );

  const unscoped = rollups.byInitiative.find(
    (entry) => entry.initiativeId === UNSCOPED_INITIATIVE,
  );
  const unscopedTokensUsed = unscoped?.tokensUsed ?? 0;
  const skippedMalformed = row.rollup.skippedMalformed;

  return Object.freeze({
    row,
    roadmap: Object.freeze(roadmap),
    tasks: Object.freeze(scopedTasks),
    quota: Object.freeze({
      // The confidence is about the *fold*, not about a provider's quota API.
      // Anything skipped, or any spend the fold could not place, means the
      // totals below are a floor rather than a measurement — and saying so is
      // the whole point of publishing a confidence at all.
      confidence: skippedMalformed === 0 && unscopedTokensUsed === 0 ? ("HIGH" as const) : ("LOW" as const),
      skippedMalformed,
      unscopedTokensUsed,
    }),
  });
}

/**
 * One version's stored content, resolved through the initiative's own fold.
 *
 * The store is content-addressed, but the lookup starts from a **version**:
 * the fold turns it into the digest the ledger recorded, and only then does
 * the store see a digest. That order is what scopes the read — a caller cannot
 * name a digest belonging to another initiative, because it never names a
 * digest at all.
 *
 * Two absences that are not the same absence, and are not reported as one:
 * a version this initiative's history does not contain is `UNKNOWN_VERSION`,
 * and a version whose digest the store cannot produce is `CONTENT_MISSING`.
 * The first is a caller asking for something that was never recorded; the
 * second is the ledger and the store disagreeing about what exists, which is
 * an integrity problem and must never be answered with an empty body.
 */
export type RoadmapContentOutcome =
  | {
      readonly ok: true;
      readonly version: RoadmapVersionReadModel;
      readonly content: string;
    }
  | { readonly ok: false; readonly reason: "UNKNOWN_VERSION" | "CONTENT_MISSING" };

export function roadmapContent(
  ledger: Ledger,
  initiativeId: string,
  version: number,
  artifactRoot: string,
): RoadmapContentOutcome {
  const recorded = ledger
    .listRoadmapVersions(initiativeId)
    .find((entry) => entry.version === version);
  if (recorded === undefined) return Object.freeze({ ok: false as const, reason: "UNKNOWN_VERSION" as const });

  const stored = readArtifact(artifactRoot, recorded.contentDigest);
  // `readArtifact` re-digests on the way out, so a corrupt object is refused
  // there rather than returned. Either failure lands here as the same
  // classification: the ledger names bytes the store cannot honestly produce.
  if (!stored.ok) return Object.freeze({ ok: false as const, reason: "CONTENT_MISSING" as const });

  return Object.freeze({ ok: true as const, version: recorded, content: stored.content });
}

/** The roadmap history alone, newest first, with the head marked. */
export function roadmapHistory(
  ledger: Ledger,
  initiativeId: string,
): readonly { readonly version: RoadmapVersionReadModel; readonly head: boolean }[] {
  const versions = ledger.listRoadmapVersions(initiativeId);
  const headId = versions.at(-1)?.roadmapVersionId ?? null;
  return [...versions]
    .reverse()
    .map((version) => Object.freeze({ version, head: version.roadmapVersionId === headId }));
}

// ---------------------------------------------------------------------------
// The scoped reads (P8-8E-pre)
// ---------------------------------------------------------------------------

/** One row of an initiative's merged timeline, still in ledger terms. */
export type ScopedTimelineRow =
  | { readonly stream: "TASK"; readonly record: LedgerEventRecord }
  | { readonly stream: "INITIATIVE"; readonly record: InitiativeEventRecord };

export interface ScopedTimelineModel {
  readonly rows: readonly ScopedTimelineRow[];
  readonly truncated: boolean;
}

/**
 * Order two timeline rows, with the tie-break stated rather than implied.
 *
 * The two chains have two clocks, so equal `recordedAt` is expected rather than
 * exotic, and `sequence` cannot break the tie because the two chains count
 * independently — sequence 7 of the initiative stream and sequence 7 of the
 * task stream are unrelated numbers.
 *
 * The stated order: `recordedAt` ascending, then `INITIATIVE` before `TASK`,
 * then `sequence` ascending within the stream. The middle term is the one that
 * would otherwise be left to sort stability: when an initiative event and a
 * task event share a millisecond, the initiative row is the context for the
 * task row, so it reads first. Total and deterministic, which is what lets two
 * clients paging the same ledger produce the same page.
 */
function compareRows(left: ScopedTimelineRow, right: ScopedTimelineRow): number {
  const byTime = left.record.event.recordedAt.localeCompare(right.record.event.recordedAt);
  if (byTime !== 0) return byTime;
  if (left.stream !== right.stream) return left.stream === "INITIATIVE" ? -1 : 1;
  return left.record.sequence - right.record.sequence;
}

/**
 * An initiative's events and its tasks' events, merged and tagged.
 *
 * Scoped the only way the ledger supports: the task projection carries
 * `initiativeId`, so the initiative's tasks are known first, and only then are
 * their events read. Nothing here filters a global event page by guessing.
 *
 * Null when the ledger has never seen the initiative — the same absence the
 * detail route reports, reported the same way.
 */
export function scopedTimeline(
  ledger: Ledger,
  initiativeId: string,
  limit: number,
): ScopedTimelineModel | null {
  if (ledger.getInitiative(initiativeId) === null) return null;

  const taskIds = new Set<string>();
  let taskCursor: string | null = null;
  for (;;) {
    const page: ReturnType<Ledger["listTasks"]> = ledger.listTasks({
      afterTaskId: taskCursor ?? undefined,
      limit: INITIATIVE_PAGE_SIZE,
    });
    for (const task of page.tasks) {
      if (task.initiativeId === initiativeId) taskIds.add(task.taskId);
    }
    if (!page.hasMore || page.nextCursor === null) break;
    taskCursor = page.nextCursor;
  }

  const rows: ScopedTimelineRow[] = [];

  for (const taskId of taskIds) {
    let cursor: number | null = null;
    for (;;) {
      const page: ReturnType<Ledger["listEvents"]> = ledger.listEvents({
        taskId,
        afterSequence: cursor ?? undefined,
        limit: INITIATIVE_PAGE_SIZE,
      });
      for (const record of page.events) rows.push({ stream: "TASK", record });
      if (!page.hasMore || page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
  }

  let initiativeCursor: number | null = null;
  for (;;) {
    const page: ReturnType<Ledger["listInitiativeEvents"]> = ledger.listInitiativeEvents({
      initiativeId,
      afterSequence: initiativeCursor ?? undefined,
      limit: INITIATIVE_PAGE_SIZE,
    });
    for (const record of page.events) rows.push({ stream: "INITIATIVE", record });
    if (!page.hasMore || page.nextCursor === null) break;
    initiativeCursor = page.nextCursor;
  }

  rows.sort(compareRows);

  // Truncation is reported, never silent: a graph drawn from a prefix and a
  // graph drawn from the whole timeline are different graphs.
  const truncated = rows.length > limit;
  return Object.freeze({
    rows: Object.freeze(truncated ? rows.slice(0, limit) : rows),
    truncated,
  });
}

/**
 * The event type, derived from the record the server already reads rather than
 * imported from `@acp/contracts`.
 *
 * The server's manifest does not declare that package and the dependency law
 * pins it by equality, so importing the enum would have meant a new dependency
 * edge — five synchronized declaration sites — to name a type that is already
 * reachable structurally. Derived, it also cannot drift: it is by construction
 * whatever the ledger record says it is.
 */
type ControlPlaneEventType = LedgerEventRecord["event"]["type"];

/** One worker as this initiative saw it, folded from the scoped events. */
export interface ScopedAgentRow {
  readonly identity: string;
  readonly eventCount: number;
  readonly taskCount: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly currentTaskId: string;
  readonly lastEventType: ControlPlaneEventType;
}

/**
 * The workers that have acted on one initiative.
 *
 * Folded from this initiative's own task events rather than read off
 * `listWorkers()`. The global projection would answer faster and wrongly: its
 * `lastTaskId` and `lastSeenAt` describe the worker's last action *anywhere*,
 * so an agent that touched this initiative once last week and another
 * initiative this morning would be reported as currently working here.
 *
 * The ordering is by scoped `lastSeenAt` descending, then identity ascending —
 * most recently active first, with a deterministic tie-break so two clients
 * agree. Only the task stream feeds this: initiative events are emitted by
 * whoever registered the initiative, which is a fact about the roadmap rather
 * than about an agent working on tasks.
 */
export function scopedAgents(
  ledger: Ledger,
  initiativeId: string,
  limit: number,
): readonly ScopedAgentRow[] | null {
  const timeline = scopedTimeline(ledger, initiativeId, Number.MAX_SAFE_INTEGER);
  if (timeline === null) return null;

  interface Accumulator {
    identity: string;
    eventCount: number;
    tasks: Set<string>;
    firstSeenAt: string;
    lastSeenAt: string;
    lastSequence: number;
    currentTaskId: string;
    lastEventType: ControlPlaneEventType;
  }
  const byIdentity = new Map<string, Accumulator>();

  for (const row of timeline.rows) {
    if (row.stream !== "TASK") continue;
    const event = row.record.event;
    const existing = byIdentity.get(event.emittedBy);
    if (existing === undefined) {
      byIdentity.set(event.emittedBy, {
        identity: event.emittedBy,
        eventCount: 1,
        tasks: new Set([event.taskId]),
        firstSeenAt: event.recordedAt,
        lastSeenAt: event.recordedAt,
        lastSequence: row.record.sequence,
        currentTaskId: event.taskId,
        lastEventType: event.type,
      });
      continue;
    }
    existing.eventCount += 1;
    existing.tasks.add(event.taskId);
    if (event.recordedAt < existing.firstSeenAt) existing.firstSeenAt = event.recordedAt;
    // Ties on the instant fall to the higher sequence: within one chain the
    // sequence is the authority on which event came last.
    const newer =
      event.recordedAt > existing.lastSeenAt ||
      (event.recordedAt === existing.lastSeenAt && row.record.sequence > existing.lastSequence);
    if (newer) {
      existing.lastSeenAt = event.recordedAt;
      existing.lastSequence = row.record.sequence;
      existing.currentTaskId = event.taskId;
      existing.lastEventType = event.type;
    }
  }

  const rows = [...byIdentity.values()]
    .sort((left, right) => {
      const byTime = right.lastSeenAt.localeCompare(left.lastSeenAt);
      return byTime !== 0 ? byTime : left.identity.localeCompare(right.identity);
    })
    .slice(0, limit)
    .map((entry) =>
      Object.freeze({
        identity: entry.identity,
        eventCount: entry.eventCount,
        taskCount: entry.tasks.size,
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt,
        currentTaskId: entry.currentTaskId,
        lastEventType: entry.lastEventType,
      }),
    );

  return Object.freeze(rows);
}
