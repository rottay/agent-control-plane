/**
 * The read-only observation CLI.
 *
 * `acp` answers questions about a ledger and changes nothing. That is a
 * structural property here, not a promise: the ledger is opened with
 * `readOnly: true`, which puts SQLite itself in query-only mode, and no code
 * path in this package calls `append()` or `rebuildReadModel()`. A CLI that
 * could repair a ledger would be a CLI that could rewrite recorded history.
 *
 * Four rules shape everything below.
 *
 * 1. Explicit ledger. `--database` is required and has no default and no
 *    environment fallback. A tool that guesses which ledger it is reading is a
 *    tool that eventually reads the wrong one and reports confidently about it.
 * 2. Validated output. Every document printed has been parsed by the schemas in
 *    `@acp/protocol`. The CLI and the future HTTP server therefore emit the
 *    same shapes, and a projection that drifted fails loudly here.
 * 3. Deterministic, leak-free errors. A failure is one closed error code and a
 *    fixed sentence. No absolute path, no SQLite message, no event payload and
 *    no exception text from a lower layer ever reaches the output, because those
 *    are the three places a path or a secret would escape.
 * 4. No dependency. Argument parsing is `node:util` `parseArgs`. The observation
 *    surface is a handful of read-only verbs; a parser library would be a supply
 *    chain risk bought for nothing.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  ApiError,
  API_CONTRACT_VERSION,
  EventsQuery,
  LEDGER_CONTRACT_VERSION,
  TasksQuery,
  WorkersQuery,
  taskPath,
  workerPath,
} from "@acp/protocol";
import type { ApiErrorCode, ToolCallPageResponse } from "@acp/protocol";
import { LEDGER_MIGRATIONS, LedgerError, openLedger } from "@acp/ledger";
import type { EventQuery, Ledger, TaskQuery, WorkerQuery } from "@acp/ledger";
import {
  DEFAULT_ROUTING_CONFIG,
  EVIDENCE_ABSENT,
  buildRegistry,
  estimateQuota,
  loadAccountsFile,
  loadPolicyRegistry,
} from "@acp/accounts";
import type { CandidateEvidence, PolicyRouteRequest, RoutingRequest } from "@acp/accounts";
import { composeSubmission } from "@acp/runtime";

import {
  renderError,
  renderEventPage,
  renderIntegrity,
  renderJson,
  renderOverview,
  renderStatus,
  renderTaskDetail,
  renderTaskPage,
  renderWorkerDetail,
  renderWorkerPage,
  isOutputFormat,
} from "../format/index.js";
import type { OutputFormat } from "../format/index.js";
import { ToolCallRefused, runToolCallVerb } from "../tool-call/index.js";
import {
  buildEventPage,
  buildIntegrity,
  buildOverview,
  buildStatus,
  buildTaskDetail,
  buildToolCallPage,
  buildTaskPage,
  buildUnavailableOverview,
  buildWorkerDetail,
  buildWorkerPage,
  databaseIdentity,
  systemClock,
} from "../observation/index.js";
import type { Clock } from "../observation/index.js";

/**
 * Exit codes, closed and meaningful.
 *
 * A script that calls this CLI needs to distinguish "I asked wrongly" from "the
 * ledger cannot be read" from "the ledger is not trustworthy". Collapsing those
 * into a single nonzero code is how an integrity failure gets retried as if it
 * were a typo.
 */
import { EXIT_OK, EXIT_USAGE } from "@acp/protocol";
export { EXIT_OK, EXIT_USAGE };
export const EXIT_INTERNAL = 1;
export const EXIT_NOT_FOUND = 4;
export const EXIT_UNAVAILABLE = 5;
export const EXIT_INTEGRITY = 6;

/** The ledger schema version this build is compiled against. */
export const LEDGER_SCHEMA_VERSION: number = LEDGER_MIGRATIONS.reduce(
  (highest, migration) => (migration.version > highest ? migration.version : highest),
  0,
);

/** Injection seam. Tests capture the streams and pin the clock. */
export interface CliIo {
  readonly stdout: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
  readonly now: Clock;
}

const defaultIo: CliIo = {
  stdout: (chunk) => void process.stdout.write(chunk),
  stderr: (chunk) => void process.stderr.write(chunk),
  now: systemClock,
};

// ---------------------------------------------------------------------------
// Option table
// ---------------------------------------------------------------------------

const OPTIONS = {
  database: { type: "string" },
  format: { type: "string" },
  limit: { type: "string" },
  cursor: { type: "string" },
  state: { type: "string" },
  role: { type: "string" },
  provider: { type: "string" },
  task: { type: "string" },
  type: { type: "string" },
  "emitted-by": { type: "string" },
  "to-state": { type: "string" },
  "skip-integrity": { type: "boolean" },
  config: { type: "string" },
  accounts: { type: "string" },
  policy: { type: "string" },
  "estimated-tokens": { type: "string" },
  "reserve-tokens": { type: "string" },
  "duration-seconds": { type: "string" },
  request: { type: "string" },
  "tool-servers": { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
} as const;

/**
 * The planning verb's name, as one literal (V2-B7S).
 *
 * Named rather than spelled twice: the command table declares it and `run`
 * branches on it, and two spellings of one verb is how a branch and a table
 * come to disagree about which command was asked for.
 */
export const SUBMISSION_COMMAND = "submission";

/**
 * The one writing verb's name, as one literal (V2-B4b stage 3D).
 *
 * Named for the reason `SUBMISSION_COMMAND` is: the table declares it and `run`
 * branches on it, and two spellings of one verb is how a branch and a table
 * come to disagree. It is also the name the narrowed read-only law points at,
 * so it is worth having exactly one of.
 */
export const TOOL_CALL_COMMAND = "tool-call";

type OptionName = keyof typeof OPTIONS;
type ParsedValues = Partial<Record<OptionName, string | boolean>>;

/** Options every command accepts. */
const COMMON_OPTIONS: readonly OptionName[] = ["database", "format", "help"];

interface CommandSpec {
  readonly name: string;
  readonly positional: string | null;
  readonly options: readonly OptionName[];
  readonly summary: string;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: "overview",
    positional: null,
    options: ["skip-integrity"],
    summary: "one screen: state, counts, integrity verdict and capabilities",
  },
  {
    name: "tasks",
    positional: null,
    options: ["state", "cursor", "limit"],
    summary: "list task projections, filtered and cursor paginated",
  },
  {
    name: "task",
    positional: "<task-id>",
    options: [],
    summary: "one task with its most recent events",
  },
  {
    name: "workers",
    positional: null,
    options: ["role", "provider", "cursor", "limit"],
    summary: "list observed worker identities",
  },
  {
    name: "worker",
    positional: "<identity>",
    options: [],
    summary: "one worker with its most recent events",
  },
  {
    name: "events",
    positional: null,
    options: ["task", "type", "emitted-by", "to-state", "cursor", "limit"],
    summary: "list ledger events in sequence order",
  },
  {
    name: "status",
    positional: null,
    options: [],
    summary: "ledger pragmas, applied migrations and projection metadata",
  },
  {
    name: "integrity",
    positional: null,
    options: [],
    summary: "verify the hash chain, the schema and the projections",
  },
  // V2-B7S. The one verb that plans rather than observes, and the only one
  // that needs no ledger: it reads a daemon config document, re-elects its
  // route over the current policy and accounts, and prints the updated
  // document. It opens nothing, writes nothing and appends nothing.
  {
    name: SUBMISSION_COMMAND,
    positional: null,
    options: ["config", "accounts", "policy", "estimated-tokens", "reserve-tokens", "duration-seconds"],
    summary: "re-elect a daemon config's route by policy and print the updated document",
  },
  // V2-B4b stage 3D. A read over the tool-call receipts this plane records,
  // and the one verb that writes. The read is an ordinary handler; the write
  // branches on its own, below the `--database` law and above the read-only
  // open, and owns the only writable handle in this package.
  {
    name: "tool-calls",
    positional: null,
    options: ["task", "cursor", "limit"],
    summary: "list the tool calls recorded against one task",
  },
  {
    name: TOOL_CALL_COMMAND,
    positional: null,
    options: ["request", "tool-servers"],
    summary: "execute one explicit tool call and record what it did",
  },
];

const USAGE = ((): string => {
  const width = COMMANDS.reduce(
    (widest, command) =>
      Math.max(widest, (command.name + " " + (command.positional ?? "")).trim().length),
    0,
  );
  const commandLines = COMMANDS.map((command) => {
    const invocation = (command.name + " " + (command.positional ?? "")).trim();
    return "  " + invocation + " ".repeat(width - invocation.length + 2) + command.summary;
  });
  return [
    "acp - Agent Control Plane observation CLI",
    "  every read verb opens the ledger query-only; " + TOOL_CALL_COMMAND + " writes one receipt",
    "",
    "Usage:",
    "  acp <command> --database <path> [options]",
    "",
    "Commands:",
    ...commandLines,
    "",
    "Global options:",
    "  --database <path>   Path to the ledger. Required. No default is guessed.",
    "  --format <format>   human (default) or json.",
    "  -h, --help          Show this help.",
    "  -V, --version       Show the contract and schema versions.",
    "",
    "Filters and pagination:",
    "  --state <state>       tasks: filter by task state.",
    "  --role <role>         workers: filter by worker role.",
    "  --provider <name>     workers: filter by provider segment.",
    "  --task <task-id>      events: filter by task.",
    "  --type <event-type>   events: filter by event type.",
    "  --emitted-by <id>     events: filter by emitting worker identity.",
    "  --to-state <state>    events: filter by resulting task state.",
    "  --cursor <cursor>     Opaque cursor from the previous page. Hand it back unchanged.",
    "  --limit <n>           Page size, 1 to 200.",
    "  --skip-integrity      overview: report counts without verifying the chain.",
    "",
    "Submission planning (V2-B7S):",
    "  --config <path>            Daemon config document to re-elect. Absolute.",
    "  --accounts <path>          Owner accounts file. Absolute.",
    "  --policy <path>            Capability policy document. Absolute.",
    "  --estimated-tokens <n>     Tokens the next atomic step is expected to cost.",
    "  --reserve-tokens <n>       Tokens held back for checkpoint and verification.",
    "  --duration-seconds <n>     Wall-clock seconds the next atomic step may take.",
    "",
    "This CLI opens the ledger read-only and never writes. It prints no absolute",
    "path and no event payload value. `acp submission` opens no ledger at all: it",
    "reads three documents, elects a route and prints one document to stdout. It",
    "creates and modifies no file, so the CLI plans as well as observes and still",
    "never writes.",
    "",
  ].join("\n");
})();

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * A failure with the envelope already built.
 *
 * It is an `Error` so it can be thrown from anywhere in a command and caught
 * once at the top, and it carries the validated envelope rather than a string
 * so the two output formats render the same fact. Its `message` is the closed
 * code, never prose that a lower layer supplied.
 */
class CliFailure extends Error {
  readonly exitCode: number;
  readonly envelope: ApiError;

  constructor(exitCode: number, envelope: ApiError) {
    super(envelope.error.code);
    this.name = "CliFailure";
    this.exitCode = exitCode;
    this.envelope = envelope;
  }
}

function failure(
  exitCode: number,
  code: ApiErrorCode,
  message: string,
  detail: string | null = null,
): CliFailure {
  return new CliFailure(
    exitCode,
    ApiError.parse({
      apiContractVersion: API_CONTRACT_VERSION,
      error: { code, message, detail },
    }),
  );
}

/**
 * The failure a lower layer is allowed to produce.
 *
 * Only the typed error code crosses. The message never does: `LedgerOpenError`
 * embeds the ledger path, SQLite messages embed file locations, and a validation
 * message can quote the value it rejected. Mapping the closed code onto a fixed
 * sentence is what makes the output both deterministic and leak-free.
 */
/**
 * Map the tool-call verb's refusal onto this package's exit-code table.
 *
 * The verb module names a reason and a field; the exit code is decided here,
 * where the table lives, so there is one place a code is chosen rather than two
 * that could drift. A refused **call** never reaches this function: it is a
 * recorded outcome and exits `EXIT_OK`, the CLI's analogue of the API's 200.
 */
function fromToolCallError(error: unknown): CliFailure {
  // A ledger that cannot be opened or is not migrated refuses through the same
  // function every read verb refuses through, so this verb's ledger failures
  // are byte-identical to theirs rather than merely similar.
  if (error instanceof LedgerError) return fromLedgerError(error);
  if (!(error instanceof ToolCallRefused)) return fromUnknownError(error);
  switch (error.code) {
    case "NOT_FOUND":
      return failure(EXIT_NOT_FOUND, "NOT_FOUND", error.message, error.at);
    case "LEDGER_UNAVAILABLE":
    case "CONTRACT_VERSION_MISMATCH":
      return failure(EXIT_UNAVAILABLE, error.code, error.message, error.at);
    case "INTERNAL":
      return failure(EXIT_INTERNAL, "INTERNAL", error.message, error.at);
    default:
      // Everything else is a document that never became a request.
      return failure(EXIT_USAGE, error.code, error.message, error.at);
  }
}

function fromLedgerError(error: LedgerError): CliFailure {
  switch (error.code) {
    case "LEDGER_OPEN":
      return failure(
        EXIT_UNAVAILABLE,
        "LEDGER_UNAVAILABLE",
        "the ledger could not be opened",
        "LEDGER_OPEN",
      );
    case "LEDGER_MIGRATION":
      return failure(
        EXIT_UNAVAILABLE,
        "CONTRACT_VERSION_MISMATCH",
        "the ledger schema does not match this build",
        "LEDGER_MIGRATION",
      );
    case "LEDGER_INTEGRITY":
      return failure(
        EXIT_INTEGRITY,
        "LEDGER_INTEGRITY",
        "the ledger is not trustworthy; run acp integrity",
        "LEDGER_INTEGRITY",
      );
    case "LEDGER_QUERY":
      return failure(
        EXIT_USAGE,
        "BAD_REQUEST",
        "the query is outside the bounds the ledger accepts",
        "LEDGER_QUERY",
      );
    case "LEDGER_READ_ONLY":
    case "LEDGER_CLOSED":
      return failure(
        EXIT_UNAVAILABLE,
        "LEDGER_UNAVAILABLE",
        "the ledger handle is not usable",
        error.code,
      );
    default:
      return failure(EXIT_INTERNAL, "INTERNAL", "the ledger reported a failure", error.code);
  }
}

/** Zod issue paths, and nothing else. An issue message can quote the input. */
function issuePaths(error: unknown): string | null {
  const issues = (error as { readonly issues?: unknown }).issues;
  if (!Array.isArray(issues)) return null;
  const paths = issues
    .map((issue: unknown) => {
      const path = (issue as { readonly path?: unknown }).path;
      return Array.isArray(path) && path.length > 0 ? path.join(".") : "<root>";
    })
    .filter((path, index, all) => all.indexOf(path) === index);
  return paths.length === 0 ? null : "invalid at: " + paths.join(", ");
}

function fromUnknownError(error: unknown): CliFailure {
  if (error instanceof LedgerError) return fromLedgerError(error);
  const paths = issuePaths(error);
  if (paths !== null) {
    return failure(
      EXIT_INTERNAL,
      "INTERNAL",
      "the observation response did not satisfy the API contract",
      paths,
    );
  }
  return failure(EXIT_INTERNAL, "INTERNAL", "the command failed", null);
}

function usageFailure(message: string, detail: string | null = null): CliFailure {
  return failure(EXIT_USAGE, "BAD_REQUEST", message, detail);
}

// ---------------------------------------------------------------------------
// Argument handling
// ---------------------------------------------------------------------------

function stringOption(values: ParsedValues, name: OptionName): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Parse the filters of a command through the contract's own query schema.
 *
 * The CLI does not restate what a state, a role, a cursor or a page ceiling may
 * be. It hands the raw strings to the schema the HTTP surface will use, so a
 * value the API would reject is rejected here identically rather than reaching
 * the ledger through a second, looser door.
 */
function parseQuery<TOut>(
  schema: { readonly parse: (value: unknown) => TOut },
  raw: Record<string, string | undefined>,
): TOut {
  const input: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) input[key] = value;
  }
  try {
    return schema.parse(input);
  } catch (error: unknown) {
    throw usageFailure("one or more filters are not valid", issuePaths(error));
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface CommandContext {
  readonly ledger: Ledger;
  readonly databasePath: string;
  readonly values: ParsedValues;
  readonly positionals: readonly string[];
  readonly io: CliIo;
  readonly format: OutputFormat;
}

interface CommandResult {
  readonly document: unknown;
  readonly human: string;
  readonly exitCode: number;
}

function ok(document: unknown, human: string): CommandResult {
  return { document, human, exitCode: EXIT_OK };
}

function runOverview(context: CommandContext): CommandResult {
  const skip = context.values["skip-integrity"] === true;
  const integrity = skip ? null : context.ledger.verifyIntegrity();
  const response = buildOverview({
    ledger: context.ledger,
    database: databaseIdentity(context.databasePath),
    integrity,
    now: context.io.now,
  });
  return {
    document: response,
    human: renderOverview(response),
    exitCode: response.state === "DEGRADED" ? EXIT_INTEGRITY : EXIT_OK,
  };
}

function runTasks(context: CommandContext): CommandResult {
  const parsed = parseQuery(TasksQuery, {
    state: stringOption(context.values, "state"),
    cursor: stringOption(context.values, "cursor"),
    limit: stringOption(context.values, "limit"),
  });
  const query: TaskQuery = {
    ...(parsed.state === undefined ? {} : { state: parsed.state }),
    ...(parsed.cursor === undefined ? {} : { afterTaskId: parsed.cursor }),
    limit: parsed.limit,
  };
  const response = buildTaskPage(context.ledger, query);
  return ok(response, renderTaskPage(response));
}

function runTask(context: CommandContext): CommandResult {
  const taskId = requirePositional(context, "<task-id>");
  // The route helper is the contract's own validator for this parameter. Using
  // it here keeps the CLI and the HTTP surface agreeing on what a task id is.
  try {
    taskPath(taskId);
  } catch (error: unknown) {
    throw usageFailure("the task id is not a uuid", issuePaths(error));
  }
  const response = buildTaskDetail(context.ledger, taskId);
  if (response === null) {
    throw failure(EXIT_NOT_FOUND, "NOT_FOUND", "no task with that id is recorded", null);
  }
  return ok(response, renderTaskDetail(response));
}

function runWorkers(context: CommandContext): CommandResult {
  const parsed = parseQuery(WorkersQuery, {
    role: stringOption(context.values, "role"),
    provider: stringOption(context.values, "provider"),
    cursor: stringOption(context.values, "cursor"),
    limit: stringOption(context.values, "limit"),
  });
  const query: WorkerQuery = {
    ...(parsed.role === undefined ? {} : { role: parsed.role }),
    ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
    ...(parsed.cursor === undefined ? {} : { afterIdentity: parsed.cursor }),
    limit: parsed.limit,
  };
  const response = buildWorkerPage(context.ledger, query);
  return ok(response, renderWorkerPage(response));
}

function runWorker(context: CommandContext): CommandResult {
  const identity = requirePositional(context, "<identity>");
  try {
    workerPath(identity);
  } catch (error: unknown) {
    throw usageFailure(
      "the identity is not <provider>/<model>/<role>/<instance>",
      issuePaths(error),
    );
  }
  const response = buildWorkerDetail(context.ledger, identity);
  if (response === null) {
    throw failure(
      EXIT_NOT_FOUND,
      "NOT_FOUND",
      "no worker with that identity has emitted an event",
      null,
    );
  }
  return ok(response, renderWorkerDetail(response));
}

function runEvents(context: CommandContext): CommandResult {
  const parsed = parseQuery(EventsQuery, {
    taskId: stringOption(context.values, "task"),
    type: stringOption(context.values, "type"),
    emittedBy: stringOption(context.values, "emitted-by"),
    toState: stringOption(context.values, "to-state"),
    cursor: stringOption(context.values, "cursor"),
    limit: stringOption(context.values, "limit"),
  });
  const query: EventQuery = {
    ...(parsed.taskId === undefined ? {} : { taskId: parsed.taskId }),
    ...(parsed.type === undefined ? {} : { type: parsed.type }),
    ...(parsed.emittedBy === undefined ? {} : { emittedBy: parsed.emittedBy }),
    ...(parsed.toState === undefined ? {} : { toState: parsed.toState }),
    ...(parsed.cursor === undefined ? {} : { afterSequence: parsed.cursor }),
    limit: parsed.limit,
  };
  const response = buildEventPage(context.ledger, query);
  return ok(response, renderEventPage(response));
}

/**
 * The human rendering of a tool-call page.
 *
 * Declared beside its handler rather than in `format/index.ts`, where every
 * other renderer lives, for one reason worth stating rather than hiding: that
 * file is outside this packet's exact write-set, and a convention is not worth
 * a write-set expansion. It uses no helper from there, so nothing is
 * duplicated; moving it is a one-line follow-up whenever `format/` is next
 * open.
 *
 * There is no content column, because a recorded row carries none.
 */
function renderToolCallPage(response: ToolCallPageResponse): string {
  if (response.items.length === 0) return "no tool calls recorded for this task\n";
  const lines = response.items.map(
    (row) =>
      String(row.sequence) +
      "  " +
      row.outcome +
      "  " +
      row.serverId +
      "/" +
      row.toolName +
      "  " +
      (row.refusal ?? "-") +
      "  " +
      String(row.argumentBytes) +
      "b in / " +
      String(row.resultBytes) +
      "b out",
  );
  const footer =
    String(response.count) +
    " shown" +
    (response.nextCursor === null ? "" : ", next cursor " + response.nextCursor);
  return lines.join("\n") + "\n\n" + footer + "\n";
}

/**
 * The tool-call receipts recorded against one task (V2-B4b stage 3D).
 *
 * An ordinary read: it opens nothing of its own, changes nothing, and is
 * subject to no new authority. The window is parsed by `EventsQuery`, which
 * already validates a task id, a decimal sequence cursor and a page limit —
 * reused rather than restated, because a second query schema in this package
 * would be a second place the same three filters could drift.
 */
function runToolCalls(context: CommandContext): CommandResult {
  const parsed = parseQuery(EventsQuery, {
    taskId: stringOption(context.values, "task"),
    cursor: stringOption(context.values, "cursor"),
    limit: stringOption(context.values, "limit"),
  });
  if (parsed.taskId === undefined) {
    throw usageFailure("--task is required", "acp tool-calls");
  }
  const response = buildToolCallPage(context.ledger, {
    taskId: parsed.taskId,
    ...(parsed.cursor === undefined ? {} : { afterSequence: parsed.cursor }),
    limit: parsed.limit,
  });
  return ok(response, renderToolCallPage(response));
}

function runStatus(context: CommandContext): CommandResult {
  const response = buildStatus(
    context.ledger.status(),
    databaseIdentity(context.databasePath),
    context.io.now,
  );
  return ok(response, renderStatus(response));
}

function runIntegrity(context: CommandContext): CommandResult {
  const response = buildIntegrity(context.ledger.verifyIntegrity(), context.io.now);
  return {
    document: response,
    human: renderIntegrity(response),
    exitCode: response.ok ? EXIT_OK : EXIT_INTEGRITY,
  };
}

function requirePositional(context: CommandContext, label: string): string {
  const value = context.positionals[1];
  if (value === undefined || value === "") {
    throw usageFailure("this command requires " + label, null);
  }
  if (context.positionals.length > 2) {
    throw usageFailure("this command takes exactly one " + label, null);
  }
  return value;
}

const HANDLERS: Readonly<Record<string, (context: CommandContext) => CommandResult>> = {
  overview: runOverview,
  tasks: runTasks,
  task: runTask,
  workers: runWorkers,
  worker: runWorker,
  events: runEvents,
  status: runStatus,
  integrity: runIntegrity,
  "tool-calls": runToolCalls,
};

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function versionDocument(): Record<string, string | number> {
  return {
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
  };
}

function emitFailure(failed: CliFailure, format: OutputFormat, io: CliIo): number {
  io.stderr(format === "json" ? renderJson(failed.envelope) : renderError(failed.envelope));
  return failed.exitCode;
}

// ---------------------------------------------------------------------------
// The submission verb (V2-B7S)
// ---------------------------------------------------------------------------

/**
 * The composition root, above the walk.
 *
 * D5 (`.acp-local/v2-b1b-brief.md:83-93`, carried into commit `0418cae`)
 * forbade **the walk** resolving and named the submission path as the elector's
 * home. This is that home's CLI leg. The daemon is behaviourally unchanged by
 * it: it still receives an admitted route it did not resolve, through the same
 * config door, compared against the same digest.
 *
 * **It writes nothing and opens no ledger.** Three documents are read, a route
 * is elected, one document is printed. That is why the branch below sits ahead
 * of the `--database` law and ahead of `openLedger`: this verb has no ledger to
 * name, and requiring one would be requiring a thing it never touches.
 *
 * **The config is carried, not re-validated.** Exactly two fields are replaced,
 * `execution.route` and `submissionDigest`; everything else passes through as
 * opaque JSON. The four coordinates the digest is taken over are read because
 * they are the digest's own inputs, not because this verb judges the document —
 * the daemon's door remains the only validator of the whole of it, and a second
 * validator here would be a second authority on what a config is.
 *
 * **No credential is read.** `credentialRef` and `authProfileRef` are fields of
 * the loaded `AccountRecord` and nothing in this file names either.
 */

/**
 * The transport vocabulary, exhaustive **by type**.
 *
 * A `Record` keyed by the union rather than a list of strings, which is the
 * idiom the observation plane's refusal map already uses and for the same
 * reason: a transport kind added to the contract breaks this file at compile
 * time instead of falling through to a default. There is deliberately no
 * default arm — the config names a transport and this verb admits it or
 * refuses, and a default would let an unknown transport be elected silently.
 *
 * Note what this does **not** do: it admits the transport the config already
 * asked for. It does not elect one. Every model in the shipped policy document
 * declares `CLI_SUBSCRIPTION` only, so no policy edit can move a route onto a
 * different transport — see ADR 0018.
 */
const TRANSPORT_KINDS: Readonly<
  Record<PolicyRouteRequest["transportKind"], PolicyRouteRequest["transportKind"]>
> = Object.freeze({
  CLI_SUBSCRIPTION: "CLI_SUBSCRIPTION",
  API_KEY: "API_KEY",
  LOCAL_OR_SELF_HOSTED: "LOCAL_OR_SELF_HOSTED",
});

function admitTransportKind(candidate: string): PolicyRouteRequest["transportKind"] {
  const admitted = Object.hasOwn(TRANSPORT_KINDS, candidate)
    ? TRANSPORT_KINDS[candidate as PolicyRouteRequest["transportKind"]]
    : undefined;
  if (admitted === undefined) {
    throw failure(
      EXIT_USAGE,
      "BAD_REQUEST",
      "the config's route names a transport this build does not know",
      "config.execution.route.transportKind",
    );
  }
  return admitted;
}

/** A required absolute path option, refused by name and never by value. */
function absolutePathOption(values: ParsedValues, name: OptionName): string {
  const supplied = stringOption(values, name);
  if (supplied === undefined || supplied === "") {
    throw failure(EXIT_USAGE, "BAD_REQUEST", "--" + name + " is required", "acp " + SUBMISSION_COMMAND);
  }
  if (!supplied.startsWith("/")) {
    throw failure(EXIT_USAGE, "BAD_REQUEST", "--" + name + " must be an absolute path", "acp " + SUBMISSION_COMMAND);
  }
  return supplied;
}

/** A required non-negative integer option. No default: a budget is never guessed. */
function integerOption(values: ParsedValues, name: OptionName): number {
  const supplied = stringOption(values, name);
  if (supplied === undefined || !/^[0-9]+$/.test(supplied)) {
    throw failure(
      EXIT_USAGE,
      "BAD_REQUEST",
      "--" + name + " is required and must be a non-negative integer",
      "acp " + SUBMISSION_COMMAND,
    );
  }
  return Number(supplied);
}

/** Read one JSON document, refusing by field name and never by content. */
function readJsonDocument(path: string, at: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw failure(EXIT_USAGE, "BAD_REQUEST", "the " + at + " could not be read", at);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw failure(EXIT_USAGE, "BAD_REQUEST", "the " + at + " is not valid JSON", at);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw failure(EXIT_USAGE, "BAD_REQUEST", "the " + at + " is not a JSON object", at);
  }
  return parsed as Record<string, unknown>;
}

function requiredString(document: Record<string, unknown>, key: string): string {
  const value = document[key];
  if (typeof value !== "string" || value === "") {
    throw failure(EXIT_USAGE, "BAD_REQUEST", "the config does not declare " + key, "config." + key);
  }
  return value;
}

/**
 * The worker role the run executes under, taken from the identity the config
 * already declares rather than from a flag of its own.
 *
 * A worker identity is `provider/model/role/instance`; the role is its third
 * segment. Reading it here means the elected route is eligible for the role the
 * config says will run it, instead of a role a caller could assert separately
 * from the identity the events will carry.
 */
function roleFromIdentity(emittedBy: string): string {
  const role = emittedBy.split("/")[2];
  if (role === undefined || role === "") {
    throw failure(EXIT_USAGE, "BAD_REQUEST", "the config's emittedBy names no role", "config.emittedBy");
  }
  return role;
}

interface SubmissionResult {
  readonly document: unknown;
  readonly exitCode: number;
}

function runSubmission(values: ParsedValues, io: CliIo): SubmissionResult {
  const configPath = absolutePathOption(values, "config");
  const accountsPath = absolutePathOption(values, "accounts");
  const policyPath = absolutePathOption(values, "policy");
  const estimatedTokens = integerOption(values, "estimated-tokens");
  const reserveTokens = integerOption(values, "reserve-tokens");
  const estimatedDurationSeconds = integerOption(values, "duration-seconds");

  const config = readJsonDocument(configPath, "config document");

  // Only what the digest is taken over, and the transport the config already
  // asked for. Everything else stays opaque.
  const taskId = requiredString(config, "taskId");
  const submittedAt = requiredString(config, "submittedAt");
  const initiativeId = requiredString(config, "initiativeId");
  const emittedBy = requiredString(config, "emittedBy");
  const attempt = config["attempt"];
  if (typeof attempt !== "number" || !Number.isInteger(attempt)) {
    throw failure(EXIT_USAGE, "BAD_REQUEST", "the config does not declare attempt", "config.attempt");
  }
  const execution = config["execution"];
  if (typeof execution !== "object" || execution === null || Array.isArray(execution)) {
    throw failure(EXIT_USAGE, "BAD_REQUEST", "the config declares no execution", "config.execution");
  }
  const executionRecord = execution as Record<string, unknown>;
  const currentRoute = executionRecord["route"];
  if (typeof currentRoute !== "object" || currentRoute === null || Array.isArray(currentRoute)) {
    throw failure(EXIT_USAGE, "BAD_REQUEST", "the config declares no execution route", "config.execution.route");
  }
  const transportKind = (currentRoute as Record<string, unknown>)["transportKind"];
  if (typeof transportKind !== "string" || transportKind === "") {
    throw failure(
      EXIT_USAGE,
      "BAD_REQUEST",
      "the config's route declares no transportKind",
      "config.execution.route.transportKind",
    );
  }

  const now = io.now();

  const accounts = loadAccountsFile(accountsPath);
  if (!accounts.ok) {
    throw failure(EXIT_USAGE, "BAD_REQUEST", "the accounts file was refused", accounts.reason);
  }
  const policy = loadPolicyRegistry(policyPath);
  if (!policy.ok) {
    throw failure(EXIT_USAGE, "BAD_REQUEST", "the policy document was refused", policy.reason);
  }

  const registry = buildRegistry(accounts.registry.accounts);
  const evidence: CandidateEvidence[] = registry.accounts.map((record) => ({
    accountId: record.accountId,
    acceptance: EVIDENCE_ABSENT,
    contextAffinity: EVIDENCE_ABSENT,
    capabilities: { known: false },
  }));
  const estimates = registry.accounts.map((record) => ({
    accountId: record.accountId,
    // The same fold the observation plane already performs in production: no
    // observations are supplied, so the estimate is the record's own published
    // position. A second way of estimating would be a second answer.
    outcome: estimateQuota({
      record,
      observations: [],
      limitKey: Object.keys(record.knownLimits)[0] ?? "",
      now,
    }),
  }));

  const routing: RoutingRequest = {
    records: registry.accounts,
    estimates,
    evidence,
    task: {
      // Ignored by the policy seam, which chooses the model; carried because
      // the request type is shared with `rankAccounts`.
      model: "",
      estimatedTokens,
      estimatedDurationSeconds,
      reserveTokens,
      requiredCapabilities: [],
    },
    config: DEFAULT_ROUTING_CONFIG,
    now,
  };

  const request: PolicyRouteRequest = {
    role: roleFromIdentity(emittedBy),
    routing,
    transportKind: admitTransportKind(transportKind),
  };

  const composed = composeSubmission(request, policy.registry, {
    taskId,
    attempt,
    submittedAt,
    initiativeId,
    resolvedAt: now,
  });
  if (!composed.ok) {
    throw failure(EXIT_USAGE, "BAD_REQUEST", "no route could be elected", composed.reason);
  }

  // Exactly two fields are replaced. Everything else is the caller's document,
  // byte for byte, for the daemon's door to judge.
  return {
    document: {
      ...config,
      submissionDigest: composed.submissionDigest,
      execution: { ...executionRecord, route: composed.submission.route },
    },
    exitCode: EXIT_OK,
  };
}

/**
 * Run the CLI over an argument vector and return the process exit code.
 *
 * Separated from the entry point so the whole surface can be tested in process,
 * and so importing this module never runs anything and never opens a database.
 */
export async function run(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  let values: ParsedValues;
  let positionals: readonly string[];

  try {
    const parsed = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch {
    // The parser message names the offending flag, which is the caller's own
    // input, but it is not a contract. A fixed sentence plus the usage block is
    // both deterministic and more useful.
    return emitFailure(usageFailure("the arguments could not be parsed"), "human", io);
  }

  const requestedFormat = stringOption(values, "format");
  if (requestedFormat !== undefined && !isOutputFormat(requestedFormat)) {
    return emitFailure(usageFailure("--format must be human or json"), "human", io);
  }
  const format: OutputFormat = requestedFormat ?? "human";

  if (values.help === true) {
    io.stdout(USAGE);
    return EXIT_OK;
  }

  if (values.version === true) {
    const document = versionDocument();
    io.stdout(
      format === "json"
        ? renderJson(document)
        : Object.entries(document)
            .map(([key, value]) => key + "  " + String(value))
            .join("\n") + "\n",
    );
    return EXIT_OK;
  }

  if (positionals.length === 0) {
    io.stderr(USAGE);
    return emitFailure(usageFailure("a command is required"), format, io);
  }

  const commandName = positionals[0] ?? "";
  const spec = COMMANDS.find((candidate) => candidate.name === commandName);
  if (spec === undefined) {
    io.stderr(USAGE);
    return emitFailure(usageFailure("unknown command: " + sanitizeCommand(commandName)), format, io);
  }

  const allowed = new Set<string>([...COMMON_OPTIONS, ...spec.options, "version"]);
  const rejected = Object.keys(values).filter((name) => !allowed.has(name));
  if (rejected.length > 0) {
    return emitFailure(
      usageFailure(
        "these options are not accepted by acp " + spec.name,
        rejected.sort().map((name) => "--" + name).join(", "),
      ),
      format,
      io,
    );
  }

  if (spec.positional === null && positionals.length > 1) {
    return emitFailure(
      usageFailure("acp " + spec.name + " takes no positional argument"),
      format,
      io,
    );
  }

  // V2-B7S. The planning verb branches here, ahead of the `--database` law and
  // ahead of `openLedger`: it opens no ledger, so requiring one would require a
  // thing it never touches. Every verb below this line is untouched by it.
  if (spec.name === SUBMISSION_COMMAND) {
    try {
      const result = runSubmission(values, io);
      io.stdout(renderJson(result.document));
      return result.exitCode;
    } catch (error: unknown) {
      return emitFailure(error instanceof CliFailure ? error : fromUnknownError(error), format, io);
    }
  }

  const databasePath = stringOption(values, "database");
  if (databasePath === undefined || databasePath === "") {
    return emitFailure(
      usageFailure(
        "--database is required",
        "the ledger is never guessed from the environment or the working directory",
      ),
      format,
      io,
    );
  }

  // V2-B4b stage 3D. The one writing verb branches here: below the `--database`
  // law, because it needs a ledger, and above the read-only open, because it
  // needs a writable one and owns its own open/close pair. Every verb below
  // this line still opens query-only, which is what keeps the narrowed law
  // true rather than merely claimed.
  if (spec.name === TOOL_CALL_COMMAND) {
    try {
      const result = await runToolCallVerb({
        databasePath,
        requestPath: stringOption(values, "request") ?? "",
        toolServersPath: stringOption(values, "tool-servers") ?? "",
      });
      // JSON regardless of `--format`, exactly as the submission verb prints.
      // A human renderer for a tool call would be a second place tool content
      // gets formatted, and the only safe number of those is one.
      io.stdout(renderJson(result.document));
      return EXIT_OK;
    } catch (error: unknown) {
      return emitFailure(fromToolCallError(error), format, io);
    }
  }

  let ledger: Ledger;
  try {
    // Read-only is the whole posture of every other verb in this package. It
    // also means SQLite itself refuses a write, so a bug here cannot become a
    // mutation.
    ledger = openLedger(databasePath, { readOnly: true });
  } catch (error: unknown) {
    const failed =
      error instanceof LedgerError
        ? fromLedgerError(error)
        : failure(EXIT_UNAVAILABLE, "LEDGER_UNAVAILABLE", "the ledger could not be opened", null);

    // The overview is the one command that can answer honestly without a
    // ledger: UNAVAILABLE and EMPTY are different facts, and a reader that
    // cannot tell them apart cannot tell a quiet control plane from a broken
    // one. Every other command has nothing true to say and fails.
    if (commandName === "overview") {
      const response = buildUnavailableOverview(
        failed.envelope.error.message + " (" + failed.envelope.error.code + ")",
        io.now,
      );
      io.stdout(format === "json" ? renderJson(response) : renderOverview(response));
      return failed.exitCode;
    }
    return emitFailure(failed, format, io);
  }

  try {
    const handler = HANDLERS[spec.name];
    if (handler === undefined) {
      return emitFailure(
        failure(EXIT_INTERNAL, "INTERNAL", "the command has no handler", spec.name),
        format,
        io,
      );
    }
    const result = handler({
      ledger,
      databasePath,
      values,
      positionals,
      io,
      format,
    });
    io.stdout(format === "json" ? renderJson(result.document) : result.human);
    return result.exitCode;
  } catch (error: unknown) {
    return emitFailure(error instanceof CliFailure ? error : fromUnknownError(error), format, io);
  } finally {
    ledger.close();
  }
}

/**
 * Echo an unknown command back without echoing arbitrary bytes.
 *
 * The command name is caller input and lands in a diagnostic. Restricting it to
 * a short printable slug keeps a control sequence or a very long argument out of
 * a terminal line that an operator is about to read.
 */
function sanitizeCommand(value: string): string {
  const slug = value.slice(0, 40).replace(/[^A-Za-z0-9._:-]/g, "?");
  return slug === "" ? "<empty>" : slug;
}
