/**
 * Rendering of observation responses.
 *
 * This module turns validated DTOs into bytes. It holds no ledger handle, opens
 * nothing and reaches nothing: every function here is a pure mapping from a
 * value the contract already accepted to a string.
 *
 * Two properties matter more than looks:
 *
 * 1. Determinism. The same response renders to the same bytes, always. Objects
 *    are written in a fixed field order and every collection is rendered in the
 *    order the ledger returned it, so a diff between two runs is a difference in
 *    the ledger rather than in the formatter.
 * 2. No path, no payload. Nothing in this file can print an absolute path or an
 *    event payload value, because neither ever reaches it: the DTOs carry a
 *    redacted database identity and payload key names only.
 */

import type {
  ApiError,
  EventPageResponse,
  IntegrityResult,
  LedgerStatusResponse,
  OverviewResponse,
  TaskDetailResponse,
  TaskPageResponse,
  TimelineItem,
  WorkerDetailResponse,
  WorkerPageResponse,
} from "@acp/protocol";

/** The two output formats. `human` is for a terminal, `json` is for a pipe. */
export const OUTPUT_FORMATS = ["human", "json"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value);
}

/**
 * The JSON rendering, which is the machine contract of this CLI.
 *
 * Two decisions are deliberate. The document is the validated DTO and nothing
 * else, so a consumer parses exactly the shape `@acp/protocol` describes.
 * And it is pretty printed with a trailing newline, so a terminal reader and a
 * `jq` pipeline see the same bytes rather than one of them seeing a variant.
 */
export function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Human primitives
// ---------------------------------------------------------------------------

function padEnd(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** A two column label/value block. Labels are padded to a common width. */
function keyValues(rows: readonly (readonly [string, string])[]): string {
  const width = rows.reduce((widest, [label]) => Math.max(widest, label.length), 0);
  return rows.map(([label, value]) => padEnd(label, width) + "  " + value).join("\n");
}

/**
 * A column aligned table with a rule under the header.
 *
 * An empty body renders as an explicit "(none)" line rather than as a bare
 * header. A header with nothing under it reads as a failed query; a stated
 * absence reads as what it is.
 */
function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  if (rows.length === 0) {
    return headers.join("  ") + "\n(none)";
  }
  const widths = headers.map((header, column) =>
    rows.reduce((widest, row) => Math.max(widest, (row[column] ?? "").length), header.length),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => padEnd(cell, widths[column] ?? cell.length))
      .join("  ")
      .trimEnd();
  const rule = widths.map((width) => "─".repeat(width)).join("  ").trimEnd();
  return [line(headers), rule, ...rows.map(line)].join("\n");
}

function withNewline(body: string): string {
  return body.endsWith("\n") ? body : body + "\n";
}

function nullable(value: string | null): string {
  return value ?? "-";
}

function count(value: number): string {
  return String(value);
}

/** Short digest form. The full digest is always available in `--format json`. */
function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}

function pageFooter(page: {
  readonly returned: number;
  readonly limit: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}): string {
  const parts = [
    "returned " + count(page.returned) + " of at most " + count(page.limit),
    page.hasMore ? "more available" : "end of results",
  ];
  if (page.nextCursor !== null) {
    parts.push("next cursor: " + page.nextCursor);
  }
  return parts.join(" • ");
}

// ---------------------------------------------------------------------------
// Human renderings, one per command
// ---------------------------------------------------------------------------

export function renderOverview(response: OverviewResponse): string {
  const rows: (readonly [string, string])[] = [
    ["state", response.state],
    ["observed at", response.observedAt],
    ["database", response.database === null ? "-" : response.database.label],
    ["api contract", response.apiContractVersion],
    ["ledger contract", response.ledgerContractVersion],
  ];

  if (response.ledger !== null) {
    rows.push(
      ["events", count(response.ledger.eventCount)],
      ["head sequence", count(response.ledger.headSequence)],
      ["head digest", shortDigest(response.ledger.headEventSha256)],
      ["last event at", nullable(response.ledger.lastEventAt)],
    );
  }

  rows.push(
    [
      "integrity",
      response.integrity.checked
        ? (response.integrity.ok === true ? "ok" : "FAILING") +
          " (" +
          count(response.integrity.problemCount ?? 0) +
          " problem(s))"
        : "not checked",
    ],
    [
      "tasks",
      count(response.tasks.total) +
        " total, " +
        count(response.tasks.active) +
        " active, " +
        count(response.tasks.terminal) +
        " terminal",
    ],
    ["workers", count(response.workers.total) + " total"],
  );

  const sections = [keyValues(rows)];

  if (response.tasks.byState.length > 0) {
    sections.push(
      "Tasks by state",
      table(
        ["STATE", "COUNT"],
        response.tasks.byState.map((entry) => [entry.state, count(entry.count)]),
      ),
    );
  }

  if (response.workers.byRole.length > 0) {
    sections.push(
      "Workers by role",
      table(
        ["ROLE", "COUNT"],
        response.workers.byRole.map((entry) => [entry.role, count(entry.count)]),
      ),
    );
  }

  sections.push(
    "Capabilities",
    keyValues([
      ["read only", String(response.capabilities.readOnly)],
      ["writes", String(response.capabilities.writes)],
      ["routing", String(response.capabilities.routing)],
      ["accounts", String(response.capabilities.accounts)],
      ["leases", String(response.capabilities.leases)],
    ]),
  );

  if (response.notice !== null) {
    sections.push("Notice: " + response.notice);
  }

  return withNewline(sections.join("\n\n"));
}

export function renderTaskPage(response: TaskPageResponse): string {
  const body = table(
    ["TASK", "STATE", "TERMINAL", "ATTEMPT", "EVENTS", "LAST TYPE", "UPDATED"],
    response.items.map((task) => [
      task.taskId,
      task.currentState,
      task.isTerminal ? "yes" : "no",
      count(task.latestAttempt),
      count(task.eventCount),
      task.lastEventType,
      task.updatedAt,
    ]),
  );
  return withNewline(body + "\n\n" + pageFooter(response.page));
}

function renderTimeline(items: readonly TimelineItem[]): string {
  return table(
    ["SEQ", "TYPE", "FROM", "TO", "EMITTED BY", "OCCURRED", "DIGEST", "PAYLOAD"],
    items.map((item) => [
      count(item.sequence),
      item.type,
      item.fromState ?? "-",
      item.toState,
      item.emittedBy,
      item.occurredAt,
      shortDigest(item.eventSha256),
      count(item.payloadByteSize) + "B " + (item.payloadKeys.join(",") || "-"),
    ]),
  );
}

export function renderTaskDetail(response: TaskDetailResponse): string {
  const task = response.task;
  const head = keyValues([
    ["task", task.taskId],
    ["state", task.currentState],
    ["terminal", task.isTerminal ? "yes" : "no"],
    ["latest attempt", count(task.latestAttempt)],
    ["events", count(task.eventCount)],
    ["sequences", count(task.firstSequence) + " to " + count(task.lastSequence)],
    ["last event", task.lastEventType + " (" + task.lastEventId + ")"],
    ["last transition", task.lastTransitionId],
    ["last emitted by", task.lastEmittedBy],
    ["created at", task.createdAt],
    ["updated at", task.updatedAt],
  ]);
  const timeline =
    "Recent events (most recent first, " +
    count(task.recentEvents.length) +
    " shown)\n" +
    renderTimeline(task.recentEvents);
  return withNewline(head + "\n\n" + timeline);
}

export function renderWorkerPage(response: WorkerPageResponse): string {
  const body = table(
    ["IDENTITY", "ROLE", "PROVIDER", "MODEL", "EVENTS", "TASKS", "LAST SEEN"],
    response.items.map((worker) => [
      worker.identity,
      worker.role,
      worker.provider,
      worker.model,
      count(worker.eventCount),
      count(worker.taskCount),
      worker.lastSeenAt,
    ]),
  );
  return withNewline(body + "\n\n" + pageFooter(response.page));
}

export function renderWorkerDetail(response: WorkerDetailResponse): string {
  const worker = response.worker;
  const head = keyValues([
    ["identity", worker.identity],
    ["provider", worker.provider],
    ["model", worker.model],
    ["role", worker.role],
    ["instance", worker.instance],
    ["events", count(worker.eventCount)],
    ["tasks", count(worker.taskCount)],
    ["sequences", count(worker.firstSequence) + " to " + count(worker.lastSequence)],
    ["first seen at", worker.firstSeenAt],
    ["last seen at", worker.lastSeenAt],
    ["last task", worker.lastTaskId],
    ["last event type", worker.lastEventType],
  ]);
  const timeline =
    "Recent events (most recent first, " +
    count(worker.recentEvents.length) +
    " shown)\n" +
    renderTimeline(worker.recentEvents);
  return withNewline(head + "\n\n" + timeline);
}

export function renderEventPage(response: EventPageResponse): string {
  return withNewline(renderTimeline(response.items) + "\n\n" + pageFooter(response.page));
}

export function renderStatus(response: LedgerStatusResponse): string {
  const head = keyValues([
    ["database", response.database.label],
    ["database id", shortDigest(response.database.id)],
    ["path", "redacted"],
    ["read only", String(response.readOnly)],
    ["events", count(response.eventCount)],
    ["head sequence", count(response.headSequence)],
    ["head digest", response.headEventSha256],
    ["journal mode", response.pragmas.journalMode],
    ["foreign keys", String(response.pragmas.foreignKeys)],
    ["synchronous", count(response.pragmas.synchronous)],
    ["busy timeout ms", count(response.pragmas.busyTimeoutMs)],
    ["query only", String(response.pragmas.queryOnly)],
    ["observed at", response.observedAt],
    ["api contract", response.apiContractVersion],
    ["ledger contract", response.ledgerContractVersion],
  ]);

  const migrations =
    "Applied migrations\n" +
    table(
      ["VERSION", "NAME", "DIGEST", "APPLIED AT"],
      response.migrations.map((migration) => [
        count(migration.version),
        migration.name,
        shortDigest(migration.sha256),
        migration.appliedAt,
      ]),
    );

  const projections =
    "Projections\n" +
    table(
      ["NAME", "THROUGH", "EVENTS", "ROWS", "SOURCE HEAD", "UPDATED AT"],
      response.projections.map((projection) => [
        projection.name,
        count(projection.appliedThroughSequence),
        count(projection.eventCount),
        count(projection.rowCount),
        shortDigest(projection.sourceHeadSha256),
        projection.updatedAt,
      ]),
    );

  return withNewline([head, migrations, projections].join("\n\n"));
}

export function renderIntegrity(response: IntegrityResult): string {
  const head = keyValues([
    ["verdict", response.ok ? "ok" : "FAILING"],
    ["checked events", count(response.checkedEvents)],
    ["head sequence", count(response.headSequence)],
    ["head digest", response.headEventSha256],
    ["problems", count(response.problems.length) + (response.truncated ? " (truncated)" : "")],
    ["checked at", response.checkedAt],
  ]);

  if (response.problems.length === 0) {
    return withNewline(head);
  }

  const problems =
    "Problems\n" +
    table(
      ["KIND", "SEQUENCE", "DETAIL"],
      response.problems.map((problem) => [
        problem.kind,
        problem.sequence === null ? "-" : count(problem.sequence),
        problem.detail,
      ]),
    );

  return withNewline(head + "\n\n" + problems);
}

/**
 * The human rendering of a failure.
 *
 * One line with the closed error code, so a reader can grep for the cause, then
 * the bounded detail if the envelope carried one. The envelope itself is what
 * `--format json` prints, unchanged.
 */
export function renderError(envelope: ApiError): string {
  const lines = ["acp: " + envelope.error.code + ": " + envelope.error.message];
  if (envelope.error.detail !== null) {
    lines.push("acp: " + envelope.error.detail);
  }
  return lines.join("\n") + "\n";
}
