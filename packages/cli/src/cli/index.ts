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
 *    `@acp/api-contracts`. The CLI and the future HTTP server therefore emit the
 *    same shapes, and a projection that drifted fails loudly here.
 * 3. Deterministic, leak-free errors. A failure is one closed error code and a
 *    fixed sentence. No absolute path, no SQLite message, no event payload and
 *    no exception text from a lower layer ever reaches the output, because those
 *    are the three places a path or a secret would escape.
 * 4. No dependency. Argument parsing is `node:util` `parseArgs`. The observation
 *    surface is a handful of read-only verbs; a parser library would be a supply
 *    chain risk bought for nothing.
 */

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
} from "@acp/api-contracts";
import type { ApiErrorCode } from "@acp/api-contracts";
import { LEDGER_MIGRATIONS, LedgerError, openLedger } from "@acp/ledger";
import type { EventQuery, Ledger, TaskQuery, WorkerQuery } from "@acp/ledger";

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
import {
  buildEventPage,
  buildIntegrity,
  buildOverview,
  buildStatus,
  buildTaskDetail,
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
export const EXIT_OK = 0;
export const EXIT_INTERNAL = 1;
export const EXIT_USAGE = 2;
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
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
} as const;

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
    "acp - Agent Control Plane observation CLI (read-only)",
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
    "This CLI opens the ledger read-only and never writes. It prints no absolute",
    "path and no event payload value.",
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

/**
 * Run the CLI over an argument vector and return the process exit code.
 *
 * Separated from the entry point so the whole surface can be tested in process,
 * and so importing this module never runs anything and never opens a database.
 */
export function run(argv: readonly string[], io: CliIo = defaultIo): number {
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

  let ledger: Ledger;
  try {
    // Read-only is the whole posture of this package. It also means SQLite
    // itself refuses a write, so a bug here cannot become a mutation.
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
