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
  accountActionsPath,
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
  decideSwitch,
  estimateQuota,
  foldEffectiveState,
  foldPressureTrigger,
  loadAccountsFile,
  loadPolicyRegistry,
} from "@acp/accounts";
import type {
  CandidateEvidence,
  PolicyRegistry,
  PolicyRouteRequest,
  QuotaObservation,
  RoutingRequest,
} from "@acp/accounts";
import {
  composeSubmission,
  readAccountActions,
  readAccountPressure,
  readAccountUsage,
} from "@acp/runtime";

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
import { LifecycleRefused, runLifecycleVerb } from "../lifecycle/index.js";
import type { LifecycleDriverFactory, LifecycleOutcome } from "../lifecycle/index.js";
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
/**
 * Another caller holds this tool coordinate (V2 X1b).
 *
 * Its own code for the reason the docblock above gives, applied to the case the
 * table did not yet have. Without it a lost race falls to `EXIT_USAGE`, and the
 * one script most likely to meet this — a wrapper that retries `acp tool-call`
 * on a timeout — would read "you asked wrongly" and retry, which is the single
 * response that must not follow. A `2` says fix the arguments; a `7` says the
 * winner is recording the receipt, so read it.
 */
export const EXIT_CLAIM_HELD = 7;
/**
 * This engine does not serve the verb that was asked for (V2 L2).
 *
 * Its own code, and the distinction it draws is the one an operator's script
 * most needs. A cancellation refused because the SQLite supervisor declares
 * `CANCEL` unsupported and a cancellation that could not be delivered because
 * the engine is unreachable are opposite facts: the first will never succeed
 * however often it is retried, and the second is exactly what a retry is for.
 * Collapsing them into `EXIT_UNAVAILABLE` would make a wrapper retry the one
 * answer that cannot change, and collapsing them into `EXIT_USAGE` would tell
 * an operator to fix arguments that are already correct.
 *
 * It is defined here rather than in `@acp/protocol` by that package's own rule:
 * `EXIT_OK` and `EXIT_USAGE` are shared, and "codes beyond these two stay with
 * the entrypoint that defines them".
 */
export const EXIT_CAPABILITY_UNSUPPORTED = 8;

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
  account: { type: "string" },
  model: { type: "string" },
  "emit-authorization": { type: "boolean" },
  "estimated-tokens": { type: "string" },
  "reserve-tokens": { type: "string" },
  "duration-seconds": { type: "string" },
  request: { type: "string" },
  "tool-servers": { type: "string" },
  attempt: { type: "string" },
  mode: { type: "string" },
  scenario: { type: "string" },
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

/**
 * The two lifecycle verbs' names, as literals (V2 L2).
 *
 * Named for the reason the two above are: the table declares them and `run`
 * branches on them, and two spellings of one verb is how a branch and a table
 * come to disagree about which command was asked for.
 */
export const CANCEL_COMMAND = "cancel";
export const ATTACH_COMMAND = "attach";

/**
 * The decision verb's name, as one literal (V2-B1f/F4b).
 *
 * Named for the reason the four above are, and for one more: the usage errors
 * its own options raise name the command they belong to, so an operator who
 * mistypes an option on this verb is not told to consult a different one.
 */
export const SWITCH_DECISION_COMMAND = "switch-decision";

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
  // V2-B1f/F4b. The verb that reads the pressure the plane recorded and asks
  // the switch policy what it implies. It reaches `decideSwitch` -- which had
  // no production caller until this packet -- and prints what it observed and
  // what was decided. It plays no plan, moves no account and appends nothing.
  {
    name: SWITCH_DECISION_COMMAND,
    positional: null,
    options: [
      "accounts",
      "policy",
      "account",
      "model",
      "config",
      "emit-authorization",
      "estimated-tokens",
      "reserve-tokens",
      "duration-seconds",
    ],
    summary: "fold recorded provider pressure into a switch decision and print it",
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
  // V2 L2. The two lifecycle verbs. They append through the same writable open
  // the tool call owns, and they recover everything else they need from the
  // ledger: the only things an operator states are which attempt, which engine
  // and which scenario's evidence.
  {
    name: CANCEL_COMMAND,
    positional: null,
    options: ["task", "attempt", "mode", "scenario"],
    summary: "stop a durable invocation and settle the ledger once",
  },
  {
    name: ATTACH_COMMAND,
    positional: null,
    options: ["task", "attempt", "mode", "scenario"],
    summary: "rejoin a durable invocation already in flight",
  },
];

/**
 * The names this CLI answers to, derived from the table that declares them.
 *
 * Derived rather than restated (old-V2 R1). A second list of the same names is
 * a list that goes stale in one direction only: the banner would keep printing
 * a verb the table had dropped, or a verb added to the table would never reach
 * whatever was checking the other copy. The suite compares this against the
 * banner's command column and against `SURFACE_MAP`, so a command added here
 * reaches both checks without either being edited.
 *
 * It is deliberately not re-exported from the package barrel: this is material
 * for the suite and the surface map, not part of `@acp/cli`'s public surface.
 */
export const CLI_COMMAND_NAMES: readonly string[] = Object.freeze(
  COMMANDS.map((command) => command.name),
);

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
    "  every read verb opens the ledger query-only; " +
      TOOL_CALL_COMMAND +
      " writes one receipt and " +
      CANCEL_COMMAND +
      " settles one cancellation",
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
    "Lifecycle (V2 L2):",
    "  --task <task-id>           The task whose attempt is being acted on.",
    "  --attempt <n>              The attempt. Must be the task's latest.",
    "  --mode <driver-mode>       SQLITE_SUPERVISOR or RESTATE. Required, never inferred.",
    "  --scenario <id>            The scenario whose execution evidence is probed.",
    "",
    "Submission planning (V2-B7S):",
    "  --config <path>            Daemon config document to re-elect. Absolute.",
    "  --accounts <path>          Owner accounts file. Absolute.",
    "  --policy <path>            Capability policy document. Absolute.",
    "  --estimated-tokens <n>     Tokens the next atomic step is expected to cost.",
    "  --reserve-tokens <n>       Tokens held back for checkpoint and verification.",
    "  --duration-seconds <n>     Wall-clock seconds the next atomic step may take.",
    "",
    "Every read verb opens the ledger query-only. Three verbs write, and they",
    "share one writable open: `" + TOOL_CALL_COMMAND + "` records one receipt, and `" + CANCEL_COMMAND + "` appends",
    "one cancellation (`" + ATTACH_COMMAND + "` takes the same handle and appends nothing). The CLI",
    "prints no absolute path and no event payload value. `acp submission` opens no",
    "ledger at all: it reads three documents, elects a route and prints one",
    "document to stdout, creating and modifying no file.",
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
 * The exit code a door's refusal earns, for every code the contract declares.
 *
 * Both write doors raise the same closed `ApiErrorCode`s for the same reasons —
 * three of the five `WRITE_REFUSED` sites are word-for-word the gateway's — and
 * until this table existed each door carried its own `switch` over that code.
 * Two tables over one closed set is the shape a shared convention takes right
 * before one of them drifts, and it had already drifted: `WRITE_REFUSED` left
 * the lifecycle door as `EXIT_INTEGRITY` and the tool-call door as `EXIT_USAGE`,
 * through a `default:` arm that never had a case. The API answers that refusal
 * with one status at both of its doors (`STATUS_BY_CODE`), so a CLI that answers
 * two numbers is not the same plane reached through a different transport.
 *
 * `WRITE_REFUSED` is `EXIT_INTEGRITY`, not `EXIT_USAGE`: the ledger disagrees
 * with the coordinates the caller named, and nothing about the invocation was
 * wrong. A `2` would tell a script to fix arguments that are already correct —
 * the reasoning ADR 0026 already recorded for `EXIT_CLAIM_HELD`.
 *
 * **A table rather than a switch, and total by type (old-V2 R1b).** The switch
 * named six of the fifteen codes and sent the other nine to `EXIT_USAGE`
 * through a `default:`, which is `Record<ApiErrorCode, number>`'s job done by a
 * catch-all: the numbers were the same, and nobody had chosen them. The failure
 * mode was never a misrouted code — it was the sixteenth. A new member of
 * `API_ERROR_CODES`, or a code an existing door starts raising, became a `2`
 * with no author, and a `2` tells an operator's script the arguments were
 * wrong. Written as a table the compiler settles it: a sixteenth member is a
 * type error here, at the same stage that already checks the gateway's
 * `STATUS_BY_CODE`, and the fence checks that these two name the same fifteen.
 *
 * Every number below is the number this package answered before it became a
 * table. Re-assigning any of them — the 503 family earning `EXIT_UNAVAILABLE`,
 * the two authentication codes earning their own — is a change to a published
 * CLI contract and is deliberately not this record's (ADR 0053).
 */
const EXIT_BY_CODE: Record<ApiErrorCode, number> = {
  // The door refused a request it could read. `2` is the answer this code was
  // always given, and it is the right one: something about the invocation was
  // wrong and fixing it is the remedy.
  BAD_REQUEST: EXIT_USAGE,
  NOT_FOUND: EXIT_NOT_FOUND,
  // Neither door can raise this one — the CLI dispatches on its own verb table
  // and never presents a method — so it earns the usage number it inherited
  // rather than a code of its own invented for an unreachable case.
  METHOD_NOT_ALLOWED: EXIT_USAGE,
  // Including every throw from a driver. An engine this attempt could not
  // reach is a failure of the channel, and it must stay distinguishable from
  // `EXIT_CAPABILITY_UNSUPPORTED`, which says the engine answered and the
  // answer was no.
  CONTRACT_VERSION_MISMATCH: EXIT_UNAVAILABLE,
  WRITE_REFUSED: EXIT_INTEGRITY,
  // The three the gateway answers 401, 403 and 503 for. No CLI door raises any
  // of them: a local invocation presents no bearer and configures no tool
  // server, so these are the API's states reached through the shared
  // vocabulary rather than this transport's. They keep the number the
  // `default:` gave them, and whether the CLI should answer them differently
  // is the successor question ADR 0053 records rather than answers.
  AUTH_REQUIRED: EXIT_USAGE,
  WRITE_BEARER_UNCONFIGURED: EXIT_USAGE,
  TOOL_SERVERS_UNCONFIGURED: EXIT_USAGE,
  // A gateway's connection ceiling. A CLI invocation is one process holding no
  // long-lived connection, so it cannot be the ninth caller.
  STREAM_CAPACITY: EXIT_USAGE,
  LEDGER_UNAVAILABLE: EXIT_UNAVAILABLE,
  // Reached through `fromLedgerError`, not through here: that function maps
  // each `LedgerError` subclass onto its own number, and an integrity failure
  // arrives as `EXIT_INTEGRITY` there. The entry exists because the code is in
  // the vocabulary, and it carries the number this arm answered.
  LEDGER_INTEGRITY: EXIT_USAGE,
  // Not a usage error, and the distinction is the whole reason this code
  // exists: nothing about the invocation was wrong, and repeating it is the
  // one action that is certainly not the remedy.
  CLAIM_HELD: EXIT_CLAIM_HELD,
  // Decided by `lifecycleExitCode`, which answers a driver's own refusal with
  // `EXIT_CAPABILITY_UNSUPPORTED`. A capability gap that arrived here instead
  // would be a door refusal rather than an engine's answer, and it keeps the
  // number it had.
  CAPABILITY_UNSUPPORTED: EXIT_USAGE,
  // The lifecycle door refuses a missing scenario as `BAD_REQUEST` before this
  // code could be raised, so this too is the API's state named in the shared
  // vocabulary, holding the number it inherited.
  SCENARIO_UNCONFIGURED: EXIT_USAGE,
  INTERNAL: EXIT_INTERNAL,
};

/**
 * A refusal this package has no number for.
 *
 * Thrown rather than answered, and that is the whole point of the type above.
 * `EXIT_BY_CODE` is total by type, so a build the compiler has checked cannot
 * produce a miss; what can is a cast at a door, a hand-built refusal, or a
 * code deserialized from a wire by a driver. The old `default:` answered all
 * three with `EXIT_USAGE`, which is a number this package would be inventing
 * on behalf of a caller it does not understand. Refusing is the honest answer:
 * a script sees a crash it can investigate rather than a `2` it will act on.
 *
 * The message is fixed and carries no code, on this package's own rule that a
 * failure is a closed code and a fixed sentence. The code rides on the error
 * for a debugger and is printed nowhere.
 */
class UnnamedRefusal extends Error {
  readonly code: string;

  constructor(code: string) {
    super("the CLI has no exit code for this refusal");
    this.name = "UnnamedRefusal";
    this.code = code;
  }
}

function refusalExitCode(code: ApiErrorCode): number {
  // Read through a lookup that is allowed to miss, so the guard below is a
  // real branch rather than dead code the compiler has already ruled out.
  const exitCode: number | undefined = (EXIT_BY_CODE as Record<string, number>)[code];
  if (exitCode === undefined) throw new UnnamedRefusal(code);
  return exitCode;
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
 * The verb module names a reason and a field; the number is `refusalExitCode`'s
 * to choose, so one code is chosen in one place rather than in two that could
 * drift. A refused **call** never reaches this function: it is a recorded
 * outcome and exits `EXIT_OK`, the CLI's analogue of the API's 200.
 */
function fromToolCallError(error: unknown): CliFailure {
  // A ledger that cannot be opened or is not migrated refuses through the same
  // function every read verb refuses through, so this verb's ledger failures
  // are byte-identical to theirs rather than merely similar.
  if (error instanceof LedgerError) return fromLedgerError(error);
  if (!(error instanceof ToolCallRefused)) return fromUnknownError(error);
  return failure(refusalExitCode(error.code), error.code, error.message, error.at);
}

/**
 * Map the lifecycle door's refusal onto this package's exit-code table.
 *
 * The same shape as `fromToolCallError`, and for the same reason: the verb
 * module names a reason and a field, and `refusalExitCode` names the number for
 * both doors. A refusal that never became an operation exits non-zero; a
 * driver's own answer does not reach this function at all, because it is a
 * document rather than a failure.
 */
function fromLifecycleError(error: unknown): CliFailure {
  if (error instanceof LedgerError) return fromLedgerError(error);
  if (!(error instanceof LifecycleRefused)) return fromUnknownError(error);
  return failure(refusalExitCode(error.code), error.code, error.message, error.at);
}

/**
 * The exit code a driver's own answer earns.
 *
 * Written as a table rather than as branches so the three refusals cannot drift
 * apart, and stated here rather than in the verb module because this is where
 * every other code in this package is chosen.
 *
 * - `CAPABILITY_UNSUPPORTED` — this engine does not serve the verb. Its own
 *   code, because no retry will change it.
 * - `POSTCONDITION_UNKNOWN` — the plane could not establish whether the effect
 *   happened, so it appended nothing and left the intent open. `UNAVAILABLE`:
 *   the answer is not available, and looking again is the right next move.
 * - `TASK_TERMINAL` — the task had already ended. The coordinates were the
 *   wrong ones to ask about, which is what `EXIT_USAGE` says.
 * - `INVOCATION_NOT_FOUND` (V2 L4) — the engine was reached and answered that
 *   it holds no invocation at this address. `EXIT_NOT_FOUND`, because to an
 *   operator that is the same thing the ledger pre-check means when it says a
 *   task or attempt is not recorded: there is nothing there to act on. The two
 *   share a code and differ in stream — the pre-check is an envelope on stderr
 *   about the request, this is a document on stdout about the work — and the
 *   ledger remains the authority on what the task did. It is deliberately not
 *   `EXIT_UNAVAILABLE`: the engine answered, so retrying in a loop is exactly
 *   the wrong move.
 */
function lifecycleExitCode(outcome: LifecycleOutcome): number {
  if (outcome.ok) return EXIT_OK;
  switch (outcome.refusal) {
    case "CAPABILITY_UNSUPPORTED":
      return EXIT_CAPABILITY_UNSUPPORTED;
    case "INVOCATION_NOT_FOUND":
      return EXIT_NOT_FOUND;
    case "POSTCONDITION_UNKNOWN":
      return EXIT_UNAVAILABLE;
    case "TASK_TERMINAL":
      return EXIT_USAGE;
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

/**
 * A required non-negative integer option. No default: a budget is never guessed.
 *
 * The command is a parameter, defaulting to the verb that first needed this,
 * so a second verb taking the same three options raises a usage error naming
 * **itself**. An operator told to consult a command they did not run would be
 * reading a diagnostic about somebody else's verb.
 */
function integerOption(
  values: ParsedValues,
  name: OptionName,
  command: string = SUBMISSION_COMMAND,
): number {
  const supplied = stringOption(values, name);
  if (supplied === undefined || !/^[0-9]+$/.test(supplied)) {
    throw failure(
      EXIT_USAGE,
      "BAD_REQUEST",
      "--" + name + " is required and must be a non-negative integer",
      "acp " + command,
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
 * The task profile a routing request is composed against.
 *
 * Three numbers the caller states and nothing else: the composition below
 * neither defaults them nor infers them from a config document, so both verbs
 * that use it state the same three or fail the same way.
 */
interface RoutingTaskProfile {
  readonly estimatedTokens: number;
  readonly estimatedDurationSeconds: number;
  readonly reserveTokens: number;
  /**
   * The routing alias the work is scheduled against.
   *
   * Empty on the submission path, and deliberately: there the **policy seam**
   * chooses the model, calling `rankAccounts` once per eligible entry with
   * that entry's own alias. A caller that ranks accounts directly has no such
   * seam above it, and `rankAccounts` admits an account only if its
   * `enabledModels` contains this value — so a direct caller that left it
   * empty would be told every account is ineligible, whatever their quota.
   */
  readonly model: string;
}

interface ComposedRouting {
  readonly registry: ReturnType<typeof buildRegistry>;
  readonly routing: RoutingRequest;
  readonly policy: PolicyRegistry;
  readonly now: string;
}

/**
 * Compose the routing request both deciding verbs need, exactly once.
 *
 * **Extracted rather than copied (V2-B1f/F4b).** The submission verb built this
 * and the decision verb needs the identical thing: the same accounts file, the
 * same policy document, the same operator-state overlay, the same exhaustive
 * usage read, the same estimator call and the same single clock read. A second
 * copy would be a second registry that could disagree with the first about
 * which accounts exist and what they have left — the failure this extraction
 * exists to make impossible.
 *
 * One `io.now()`, taken here and threaded, so nothing downstream reads a clock.
 */
function composeRoutingRequest(input: {
  readonly ledger: Ledger;
  readonly accountsPath: string;
  readonly policyPath: string;
  readonly io: CliIo;
  readonly task: RoutingTaskProfile;
}): ComposedRouting {
  const { ledger, accountsPath, policyPath, io, task } = input;

  const now = io.now();

  const accounts = loadAccountsFile(accountsPath);
  if (!accounts.ok) {
    throw failure(EXIT_USAGE, "BAD_REQUEST", "the accounts file was refused", accounts.reason);
  }
  const policy = loadPolicyRegistry(policyPath);
  if (!policy.ok) {
    throw failure(EXIT_USAGE, "BAD_REQUEST", "the policy document was refused", policy.reason);
  }

  /**
   * The state an operator's recorded actions put each account in (V2-B1e).
   *
   * The defect this closes: the election built its registry from the owner
   * file alone and never read `account_events`, so an account an operator had
   * explicitly drained was still elected by the very next submission. The
   * ledger held the decision and nothing on this path looked at it.
   *
   * **The overlay is deliberately not a new eligibility rule.** `DRAINING` is
   * already refused by `estimateQuota`'s `ACCOUNT_NOT_AVAILABLE` and,
   * independently, by the router; both read `record.status`. Folding the
   * effective state onto that field feeds the existing admissions rather than
   * adding a second rule beside them, which is what keeps the estimator and
   * the router refusing identically by construction (ADR 0035 s3.1a) instead
   * of by two rules that could drift.
   *
   * **The overlaid record is an in-memory view and is never persisted or
   * re-parsed.** `buildRegistry` freezes and indexes without re-validating, so
   * a `REAUTH_REQUIRED` overlay can sit beside a non-null published ratio in a
   * combination the contract's own refinement forbids. Harmless here because
   * both admissions refuse on status first -- and stated so that nobody later
   * writes such a record back to a file.
   *
   * **A read that fails refuses; it never falls back to the file.** "The
   * history could not be read" is not the same fact as "the ledger records no
   * action", and only the second one means the owner file stands.
   */
  const withOperatorState = accounts.registry.accounts.map((record) => {
    const read = readAccountActions(ledger, record.accountId);
    if (!read.ok) {
      throw failure(
        EXIT_UNAVAILABLE,
        "LEDGER_UNAVAILABLE",
        "the recorded operator actions could not be read",
        read.at,
      );
    }
    const folded = foldEffectiveState(record.status, read.history);
    return folded.stateSource === "OWNER_FILE" ? record : { ...record, status: folded.effectiveState };
  });

  const registry = buildRegistry(withOperatorState);

  /**
   * The spend this account has recorded since its own baseline was published.
   *
   * A refusal from the reader is a refusal here: it is never coerced to zero
   * observations, because zero observations now means "the published position
   * stands" and a failed scan is not that fact.
   */
  const observationsFor = (record: (typeof registry.accounts)[number]): readonly QuotaObservation[] => {
    const read = readAccountUsage(ledger, record.accountId, {
      since: record.quotaEstimate.estimatedAt,
    });
    if (!read.ok) {
      throw failure(EXIT_UNAVAILABLE, "LEDGER_UNAVAILABLE", "the recorded usage could not be read", read.at);
    }
    return read.observations;
  };
  const evidence: CandidateEvidence[] = registry.accounts.map((record) => ({
    accountId: record.accountId,
    acceptance: EVIDENCE_ABSENT,
    contextAffinity: EVIDENCE_ABSENT,
    capabilities: { known: false },
  }));
  const estimates = registry.accounts.map((record) => ({
    accountId: record.accountId,
    // V2-B1d. The observations are the spend the ledger recorded since this
    // record's own baseline was published, read exhaustively for this account.
    // The comment here used to say none were supplied "so the estimate is the
    // record's own published position" -- which was true, and was the defect:
    // a router that ranks on a figure nothing can move is weighing a constant.
    outcome: estimateQuota({
      record,
      observations: observationsFor(record),
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
      // the request type is shared with `rankAccounts`, and read directly by
      // it when a caller ranks without that seam above them.
      model: task.model,
      estimatedTokens: task.estimatedTokens,
      estimatedDurationSeconds: task.estimatedDurationSeconds,
      reserveTokens: task.reserveTokens,
      requiredCapabilities: [],
    },
    config: DEFAULT_ROUTING_CONFIG,
    now,
  };

  return { registry, routing, policy: policy.registry, now };
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

/** What the decision verb prints: one document, and the code it exits with. */
interface SwitchDecisionResult {
  readonly document: unknown;
  readonly exitCode: number;
}

function runSubmission(values: ParsedValues, io: CliIo, ledger: Ledger): SubmissionResult {
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

  const composed = composeRoutingRequest({
    ledger,
    accountsPath,
    policyPath,
    io,
    // The empty alias is what this verb has always passed: the policy seam
    // below chooses the model, and this request is its input rather than the
    // router's.
    task: { estimatedTokens, estimatedDurationSeconds, reserveTokens, model: "" },
  });
  const { routing, policy, now } = composed;

  const request: PolicyRouteRequest = {
    role: roleFromIdentity(emittedBy),
    routing,
    transportKind: admitTransportKind(transportKind),
  };

  const submission = composeSubmission(request, policy, {
    taskId,
    attempt,
    submittedAt,
    initiativeId,
    resolvedAt: now,
  });
  if (!submission.ok) {
    throw failure(EXIT_USAGE, "BAD_REQUEST", "no route could be elected", submission.reason);
  }

  // Exactly two fields are replaced. Everything else is the caller's document,
  // byte for byte, for the daemon's door to judge.
  return {
    document: {
      ...config,
      submissionDigest: submission.submissionDigest,
      execution: { ...executionRecord, route: submission.submission.route },
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
/**
 * Fold the recorded pressure and ask the switch policy what it implies.
 *
 * **The first production caller of `decideSwitch` in this plane's history.**
 * The pressure the walk records has had a writer since F4a and no reader at
 * all; the decision policy has had no caller since it was written. This verb
 * closes exactly that gap and nothing else.
 *
 * **It decides and prints. It does not act.** No plan is played: a switch plan
 * revokes a lease, and the executor refuses one without a real `Lease` that
 * only the daemon's arbiter can produce. No account state is written: the plan
 * asks for statuses no operator verb produces, and the one door that records an
 * operator action lives in an entrypoint this package may not import. Nothing
 * is appended at all — the handle this verb is given is query-only, so an
 * append is a database-level error rather than a policy one.
 *
 * **What it observed is printed whatever it decided.** The only pressure the
 * plane can currently observe through a daemon is an authentication
 * requirement, which is never a trigger; a verb that answered that with a bare
 * "nothing to do" would hide the one thing an operator needs to act on.
 */
function runSwitchDecision(values: ParsedValues, io: CliIo, ledger: Ledger): SwitchDecisionResult {
  const accountsPath = absolutePathOption(values, "accounts");
  const policyPath = absolutePathOption(values, "policy");
  const estimatedTokens = integerOption(values, "estimated-tokens", SWITCH_DECISION_COMMAND);
  const reserveTokens = integerOption(values, "reserve-tokens", SWITCH_DECISION_COMMAND);
  const estimatedDurationSeconds = integerOption(
    values,
    "duration-seconds",
    SWITCH_DECISION_COMMAND,
  );

  /**
   * The routing alias a switch would be for, and why this verb must be told.
   *
   * `decideSwitch` ranks the other accounts by calling `rankAccounts`
   * **directly**, and that admission reads `record.enabledModels.includes(
   * task.model)`. The submission verb never states an alias because the policy
   * seam above it chooses one and re-ranks per candidate model; this verb has
   * no such seam, so an unstated alias would make every account ineligible and
   * every exhaustion refuse `NO_ELIGIBLE_ACCOUNT` — a fail-closed answer that
   * looks exactly like "there is nowhere to go" when the truth is "nobody said
   * where from". Required, never defaulted, for the reason a budget is never
   * guessed: the switch is about a particular piece of work.
   */
  const emitAuthorization = values["emit-authorization"] === true;
  const model = stringOption(values, "model");
  if (model === undefined || model === "") {
    throw failure(
      EXIT_USAGE,
      "BAD_REQUEST",
      "--model is required and names the routing alias the switch would be for",
      "acp " + SWITCH_DECISION_COMMAND,
    );
  }

  // Validated through the protocol's own account-id grammar rather than a
  // regex restated here: `accountActionsPath` parses exactly that grammar and
  // throws on a violation, so the path it builds is discarded and only the
  // judgement is kept. A second spelling of a grammar is how two doors come to
  // disagree about what an account id is.
  const onlyAccount = stringOption(values, "account");
  if (onlyAccount !== undefined) {
    try {
      accountActionsPath(onlyAccount);
    } catch {
      throw failure(
        EXIT_USAGE,
        "BAD_REQUEST",
        "--account is not a valid account id",
        "acp " + SWITCH_DECISION_COMMAND,
      );
    }
  }

  const composed = composeRoutingRequest({
    ledger,
    accountsPath,
    policyPath,
    io,
    task: { estimatedTokens, estimatedDurationSeconds, reserveTokens, model },
  });
  const { registry, routing, now } = composed;

  const selected =
    onlyAccount === undefined
      ? registry.accounts
      : registry.accounts.filter((record) => record.accountId === onlyAccount);
  if (onlyAccount !== undefined && selected.length === 0) {
    throw failure(
      EXIT_USAGE,
      "BAD_REQUEST",
      "the accounts file declares no such account",
      "acp " + SWITCH_DECISION_COMMAND,
    );
  }

  const accounts = selected.map((record) => {
    const since = record.quotaEstimate.estimatedAt;
    const read = readAccountPressure(ledger, record.accountId, { since });
    if (!read.ok) {
      // A refusal is a refusal. It is never coerced into "no pressure": the
      // second is a fact about the account and the first is a fact about the
      // read, and folding one into the other is how a scan that failed comes
      // to read as an account that is fine.
      throw failure(
        EXIT_UNAVAILABLE,
        "LEDGER_UNAVAILABLE",
        "the recorded provider pressure could not be read",
        read.at,
      );
    }

    const folded = foldPressureTrigger(read.observations);
    if (!folded.ok) {
      return {
        accountId: record.accountId,
        since,
        decision: "NONE",
        reason: folded.reason,
        at: folded.at,
        observed: folded.observed,
      };
    }

    // The trigger is handed over and `decideSwitch` classifies it again
    // regardless. Two independent classifications is the correct redundancy:
    // the fold decides which rows are a trigger, the policy's own guard
    // decides whether the string it was handed is one.
    const outcome = decideSwitch({
      trigger: folded.trigger,
      currentAccountId: record.accountId,
      routing,
    });
    if (!outcome.ok) {
      return {
        accountId: record.accountId,
        since,
        decision: "REFUSED",
        // Carried verbatim, never re-worded: a refusal an operator can look up
        // is worth more than a sentence this verb invented for it.
        reason: outcome.reason,
        at: outcome.at,
        trigger: folded.trigger,
        causedBy: folded.causedBy,
        observed: folded.observed,
      };
    }

    return {
      accountId: record.accountId,
      since,
      decision: outcome.plan.kind,
      trigger: folded.trigger,
      causedBy: folded.causedBy,
      observed: folded.observed,
      plan: outcome.plan,
    };
  });

  // V2-B1f/F4d. The authorization the walk will play, emitted as the **whole**
  // configuration document.
  //
  // A fragment an operator merges by hand would be a second door: nothing
  // would stop them pairing one packet's plan with another packet's route, and
  // the daemon would admit the pair because each half parses. Printing the
  // entire document with `execution.switchAuthorization` inside it — exactly as
  // the re-election verb prints the whole re-elected document — means the door
  // never sees a half.
  //
  // `decidedBy` is the config's own `emittedBy`, so the identity recorded as
  // the decider is the identity the walk's events will carry. `decidedAt` is
  // this verb's single clock read, threaded like every other instant here.
  if (emitAuthorization) {
    const config = readJsonDocument(
      absolutePathOption(values, "config"),
      "config document",
    );
    const execution = config["execution"];
    if (typeof execution !== "object" || execution === null || Array.isArray(execution)) {
      throw failure(
        EXIT_USAGE,
        "BAD_REQUEST",
        "the config declares no execution",
        "config.execution",
      );
    }
    const executionRecord = execution as Record<string, unknown>;
    const configRoute = executionRecord["route"];
    if (typeof configRoute !== "object" || configRoute === null || Array.isArray(configRoute)) {
      throw failure(
        EXIT_USAGE,
        "BAD_REQUEST",
        "the config declares no execution route",
        "config.execution.route",
      );
    }
    const configAccountId = (configRoute as Record<string, unknown>)["accountId"];
    const decided = accounts.find((entry) => entry.accountId === configAccountId);
    if (decided === undefined) {
      throw failure(
        EXIT_USAGE,
        "BAD_REQUEST",
        "no decision was taken for the account the config's route names",
        "config.execution.route.accountId",
      );
    }
    // Nothing is emitted for an account the policy did not decide to move. A
    // document carrying an authorization the elector never issued would be the
    // forged decision this whole boundary exists to prevent.
    const undecided = decided.reason ?? decided.decision;
    const plan = decided.plan;
    const trigger = decided.trigger;
    const causedBy = decided.causedBy;
    if (plan === undefined || trigger === undefined || causedBy === undefined) {
      throw failure(
        EXIT_USAGE,
        "BAD_REQUEST",
        "no switch was decided for the account the config's route names",
        undecided,
      );
    }

    return {
      document: {
        ...config,
        execution: {
          ...executionRecord,
          switchAuthorization: {
            trigger,
            decidedForAccountId: decided.accountId,
            decidedBy: requiredString(config, "emittedBy"),
            decidedAt: now,
            decidedFromEventId: causedBy,
            observedSince: decided.since,
            plan,
          },
        },
      },
      exitCode: EXIT_OK,
    };
  }

  return { document: { now, accounts }, exitCode: EXIT_OK };
}

/**
 * Seams the command surface accepts, and production supplies none of.
 *
 * One member, and it exists because of the port topology rather than for
 * convenience: the `cli` vitest project runs in the default parallel group and
 * binds no ports, so a door that could only be exercised against a live engine
 * would have no suite in its own package. The real-engine proofs live in the
 * durability project over the same construction. Optional, defaulted, and never
 * passed by the process entry point.
 */
export interface CliSeams {
  readonly makeDriver?: LifecycleDriverFactory | undefined;
}

export async function run(
  argv: readonly string[],
  io: CliIo = defaultIo,
  seams: CliSeams = {},
): Promise<number> {
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

  // V2 L2. The two lifecycle verbs branch beside the tool call and for the same
  // reasons: below the `--database` law because they need a ledger, and above
  // the read-only open because they take the writable handle the tool-call
  // module owns. Every verb below this line still opens query-only.
  if (spec.name === CANCEL_COMMAND || spec.name === ATTACH_COMMAND) {
    try {
      const result = await runLifecycleVerb({
        verb: spec.name === CANCEL_COMMAND ? "CANCEL" : "ATTACH",
        databasePath,
        scenarioId: stringOption(values, "scenario") ?? "",
        taskId: stringOption(values, "task") ?? "",
        attempt: stringOption(values, "attempt") ?? "",
        mode: stringOption(values, "mode") ?? "",
        makeDriver: seams.makeDriver,
      });
      // JSON regardless of `--format`, on the tool call's precedent: a human
      // renderer for a lifecycle document would be a second place a driver's
      // answer gets formatted, and the only safe number of those is one.
      io.stdout(renderJson(result.document));
      return lifecycleExitCode(result.outcome);
    } catch (error: unknown) {
      return emitFailure(fromLifecycleError(error), format, io);
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

  // V2-B7S, moved below the `--database` law at V2-B1d. The planning verb used
  // to branch above it, under a comment saying it opened no ledger so requiring
  // one would require a thing it never touches. That is no longer true: the
  // election now weighs the usage the ledger recorded, so it needs the ledger
  // the law is about -- and it takes the one this function already opened
  // query-only rather than performing a bespoke open of its own. One law, one
  // open.
  if (spec.name === SUBMISSION_COMMAND) {
    try {
      const result = runSubmission(values, io, ledger);
      io.stdout(renderJson(result.document));
      return result.exitCode;
    } catch (error: unknown) {
      return emitFailure(error instanceof CliFailure ? error : fromUnknownError(error), format, io);
    } finally {
      ledger.close();
    }
  }

  // V2-B1f/F4b. The same shape and the same handle: the decision verb reads
  // the pressure this ledger recorded and prints what the policy makes of it.
  // It branches here rather than joining the handler table for the reason the
  // submission verb does -- it composes a routing request rather than
  // projecting a read model, and it needs the clock the seams inject.
  if (spec.name === SWITCH_DECISION_COMMAND) {
    try {
      const result = runSwitchDecision(values, io, ledger);
      io.stdout(renderJson(result.document));
      return result.exitCode;
    } catch (error: unknown) {
      return emitFailure(error instanceof CliFailure ? error : fromUnknownError(error), format, io);
    } finally {
      ledger.close();
    }
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
