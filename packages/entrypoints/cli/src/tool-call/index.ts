import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { LedgerError, openLedger, openToolClaimStore, toolClaimStorePath } from "@acp/ledger";
import type { ToolClaimDecision } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import {
  API_CONTRACT_VERSION,
  LEDGER_CONTRACT_VERSION,
  ToolCallExecuteRequest,
  ToolCallExecuteResponse,
} from "@acp/protocol";
import type { ApiErrorCode } from "@acp/protocol";
import {
  ToolClaimHeldError,
  deriveInvocation,
  runToolCall,
  toolOperationScopeId,
} from "@acp/runtime";
import type { ToolClaimPort } from "@acp/runtime";
import { admitToolServers, openToolOperation } from "@acp/tools";

/**
 * The CLI's tool-call write door (V2-B4b stage 3D).
 *
 * The plane's second door onto the same operation. It is deliberately **not** an
 * HTTP client of the gateway: two independent producers over one ledger is what
 * makes the parity proof evidence rather than a tautology, and a CLI that asked
 * the server would prove only that the server agrees with itself.
 *
 * **One behaviour authority.** Every rule about what a tool call may be lives in
 * `runToolCall` and the schemas this module parses; nothing about validation,
 * execution, redaction, idempotency or ledger semantics is restated here. This
 * module reads two operator files, opens a ledger, hands the operation what it
 * needs, and prints what came back.
 *
 * **The request is the API's request, byte for byte.** `ToolCallExecuteRequest`
 * is the schema the POST body is parsed by; the `--request` document is parsed
 * by the same one over the same bytes. That identity *is* the equivalence claim
 * — a CLI-local request type would make it untestable.
 *
 * ## Operator authority: the owning uid, and it is weaker than the bearer
 *
 * The API door is bearer-guarded because it is reachable by anything that can
 * reach the port. This door is not reachable at all except by a process already
 * running as the operator, so its authority is the **owning uid**, applied to
 * both documents it reads: supplied → absolute → canonical realpath → regular
 * file → owned by this uid → bounded size → parsed.
 *
 * Say plainly what that is worth: a uid check is an assertion about who is
 * running this process, and no more. It is exactly the authority the daemon's
 * own config door claims, and it is **weaker than the bearer** — it cannot tell
 * one program run by the operator from another. The `--tool-servers` document
 * names commands the plane will execute, so it takes the bearer file's `0600`
 * mode check as well; `--request` is not a secret and takes the ladder without
 * it.
 *
 * Refusals name a reason and a field path, never a path and never the bytes.
 *
 * ## The ledger is probed read-only before it is opened writable
 *
 * `openLedger(path)` without `readOnly` is not a neutral act: it opens with no
 * `fileMustExist`, so a typo **creates an empty database**, and it then applies
 * every pending migration inside a transaction. The DT granted this verb a
 * short-lived writable ledger to *execute* through the shared operation, which
 * is not the same as granting it authority to create one or to migrate one — an
 * observation CLI silently migrating an operator's ledger is precisely the
 * surprise this plane exists to avoid.
 *
 * So the sequence is: stat the path, open it **read-only** and close it, and
 * only then open it writable. The read-only probe is what makes this verb's
 * refusals byte-identical to every read verb's — an absent file and an
 * unapplied migration both fail closed there, with the same words — and it is
 * what removes both hazards.
 *
 * The cost is a named **TOCTOU window** between the two opens: a file that
 * passes the probe could in principle be replaced before the writable open. It
 * is one loopback-local file, opened twice by one process, and the window is
 * stated here rather than left for a reader to find.
 *
 * ## Replay is arbitrated by the claim store, and this door contends on it
 * ## exactly as the gateway does
 *
 * Stage 3C's version of this section said the opposite, and said it accurately
 * for the code it described: `runToolCall` spent a coordinate by appending
 * *after* the tool had answered, so two callers that reached it together both
 * found the key unspent and both ran a real effect. Two overlapping
 * `acp tool-call` invocations — exactly what a script that retries on a timeout
 * produces — spawned two children for one row. That section ended by naming
 * what would close it: "a lock the **ledger itself arbitrates**, so that both
 * doors and every process contend on one authority rather than on per-process
 * memory. That is a later packet's, it must name both doors."
 *
 * V2 X1b is that packet, and it names both doors. The authority is `tool_claim`,
 * a `BEGIN IMMEDIATE` compare-and-set in a SQLite database beside the ledger,
 * derived from the ledger path through `toolClaimStorePath` and through nothing
 * else. This door and the API door take it through the same operation; neither
 * carries a lock of its own, and this file still holds no registry, because it
 * no longer needs one.
 *
 * - **CLI against CLI.** Two overlapping invocations for one coordinate: one
 *   takes the claim and runs, and the other is refused `CLAIM_HELD` before a
 *   child exists — one child, one row, and the loser told to read the receipt
 *   rather than retry. Run sequentially, the same pair behaves as before: one
 *   child, one row, and the second answers `replayed: true`.
 * - **CLI against the gateway.** The same, and by the same mechanism: the
 *   contention is in a file both processes open, not in either one's memory.
 *
 * **What is guaranteed, exactly, and what is not.** Exactly-once receipt, and
 * exactly-once *effect* per coordinate across OS processes — **except** across a
 * claimant crash in the window between the tool answering and the receipt
 * landing. There, the plane cannot know whether the effect happened, so the
 * coordinate is not re-run and not reported as done: the next caller promotes it
 * to a `POSTCONDITION_UNKNOWN` receipt and it is spent. That exception is not a
 * rounding error to be dropped from the sentence; a reader who takes away an
 * unqualified "exactly-once" has taken away something this plane does not
 * provide.
 */

/**
 * Why a tool call was refused before it became one.
 *
 * Plain data, and deliberately not the CLI's `CliFailure`: that type and its
 * envelope live in the command module, which imports this one, and a module
 * that imported it back would close a cycle. The caller maps the code to an
 * exit code, so the exit-code table stays in one place.
 */
export class ToolCallRefused extends Error {
  readonly code: ApiErrorCode;
  readonly at: string | null;

  constructor(code: ApiErrorCode, message: string, at: string | null = null) {
    super(message);
    this.name = "ToolCallRefused";
    this.code = code;
    this.at = at;
  }
}

/** A document a tool call needs, and how strictly its mode is judged. */
interface DocumentSpec {
  readonly path: string;
  /** The field path a refusal names. Never the path itself. */
  readonly at: string;
  /** True for a document that names commands the plane will execute. */
  readonly secret: boolean;
}

/** A tool document is a short list of servers; a request is one object. */
const DOCUMENT_MAX_BYTES = 64 * 1024;

function refuse(message: string, at: string): never {
  throw new ToolCallRefused("BAD_REQUEST", message, at);
}

/**
 * Read one operator document through the uid ladder.
 *
 * The same ladder the gateway's bearer loader and the daemon's config door
 * already use, spelled the same way. Every refusal names the field and never
 * the path, because a path in a diagnostic is a path in a terminal log.
 */
function readOperatorDocument(spec: DocumentSpec): unknown {
  if (spec.path === "") refuse("--" + spec.at + " is required", spec.at);
  if (!isAbsolute(spec.path)) refuse("--" + spec.at + " must be an absolute path", spec.at);

  let real: string;
  try {
    real = realpathSync(spec.path);
  } catch {
    refuse("the " + spec.at + " document could not be read", spec.at);
  }
  if (real !== spec.path) refuse("--" + spec.at + " must be a canonical path", spec.at);

  let stats;
  try {
    stats = statSync(real);
  } catch {
    refuse("the " + spec.at + " document could not be read", spec.at);
  }
  if (!stats.isFile()) refuse("the " + spec.at + " document is not a regular file", spec.at);
  if (stats.uid !== process.getuid?.()) {
    refuse("the " + spec.at + " document is not owned by this user", spec.at);
  }
  // A document that names commands the plane will execute is held to the
  // bearer file's mode: anything another user can rewrite is not the document
  // the operator reviewed.
  if (spec.secret && (stats.mode & 0o077) !== 0) {
    refuse("the " + spec.at + " document must not be readable by others", spec.at);
  }
  if (stats.size > DOCUMENT_MAX_BYTES) refuse("the " + spec.at + " document is too large", spec.at);

  let text: string;
  try {
    text = readFileSync(real, "utf8");
  } catch {
    refuse("the " + spec.at + " document could not be read", spec.at);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    refuse("the " + spec.at + " document is not valid JSON", spec.at);
  }
}

export interface ToolCallVerbInput {
  readonly databasePath: string;
  readonly requestPath: string;
  readonly toolServersPath: string;
}

export interface ToolCallVerbResult {
  readonly document: ToolCallExecuteResponse;
}

/**
 * Open the ledger for a write, having first proved it can be read.
 *
 * Both hazards of a bare writable open are closed here: the `stat` refuses a
 * path that is not already a regular file, and the read-only open refuses an
 * unapplied migration with the identical words every read verb produces. Only
 * then is a writable handle taken.
 */
function openForWrite(databasePath: string): Ledger {
  let stats;
  try {
    stats = statSync(databasePath);
  } catch {
    throw new ToolCallRefused("LEDGER_UNAVAILABLE", "the ledger could not be opened", "LEDGER_ABSENT");
  }
  if (!stats.isFile()) {
    throw new ToolCallRefused("LEDGER_UNAVAILABLE", "the ledger could not be opened", "LEDGER_ABSENT");
  }

  // The probe. It fails closed on anything a read verb would fail on, and it
  // never creates and never migrates, because `readOnly` sets `fileMustExist`
  // and takes the non-migrating branch.
  //
  // A `LedgerError` is re-thrown untouched so the command module maps it
  // through the same function every read verb uses — an unapplied migration
  // must answer what a read verb answers, not something adjacent. Anything
  // else the open can raise is a raw driver error (a file that is not a
  // database raises `SQLITE_NOTADB`), and the read path's rule is that
  // whatever opening the ledger throws is `LEDGER_UNAVAILABLE`. Stated the
  // same way here so the two are identical rather than similar.
  try {
    openLedger(databasePath, { readOnly: true }).close();
  } catch (error: unknown) {
    if (error instanceof LedgerError) throw error;
    throw new ToolCallRefused("LEDGER_UNAVAILABLE", "the ledger could not be opened", null);
  }

  try {
    return openLedger(databasePath);
  } catch (error: unknown) {
    if (error instanceof LedgerError) throw error;
    throw new ToolCallRefused("LEDGER_UNAVAILABLE", "the ledger could not be opened", null);
  }
}

/**
 * Run one explicit tool call and return the document to print.
 *
 * A refused call is a **success of this verb**: it became an operation and a
 * durable row exists, which is the CLI's exact analogue of the API answering
 * 200 with `outcome: "REFUSED"`. Only a request that never became an operation
 * exits non-zero.
 */
export async function runToolCallVerb(input: ToolCallVerbInput): Promise<ToolCallVerbResult> {
  const rawRequest = readOperatorDocument({
    path: input.requestPath,
    at: "request",
    secret: false,
  });
  const rawServers = readOperatorDocument({
    path: input.toolServersPath,
    at: "tool-servers",
    secret: true,
  });

  const parsed = ToolCallExecuteRequest.safeParse(rawRequest);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // The field path only. The value is the operator's own, but a value echoed
    // into a diagnostic is a value in a terminal log.
    const at = issue === undefined ? "request" : "request." + issue.path.join(".");
    throw new ToolCallRefused("BAD_REQUEST", "the request document is not a valid tool call", at);
  }
  const request = parsed.data;

  const admitted = admitToolServers(rawServers);
  if (!admitted.ok) {
    throw new ToolCallRefused(
      "BAD_REQUEST",
      "the tool-servers document was not admitted",
      "tool-servers",
    );
  }

  const ledger = openForWrite(input.databasePath);
  // V2 X1b. Derived from the resolved database through the one producer, never
  // composed here (L-X1-7): the gateway derives the same path from the same
  // ledger, which is what makes the two doors arbitrate over one file rather
  // than over two that look alike.
  const claimStore = openToolClaimStore(toolClaimStorePath(input.databasePath));
  try {
    const task = ledger.getTask(request.taskId);
    if (task === null) {
      throw new ToolCallRefused("NOT_FOUND", "no task with that id was found", "request.taskId");
    }
    if (request.attempt > task.latestAttempt) {
      throw new ToolCallRefused(
        "WRITE_REFUSED",
        "that attempt has not begun; a tool call cannot belong to an attempt the task has not reached",
        "request.attempt",
      );
    }

    // The causal link, resolved against this ledger. The operation validates
    // the shape; whether the event exists needs a ledger, and the runtime's
    // port offers no lookup by event id. Narrowed to the same task on purpose,
    // exactly as the API door narrows it: a tool call caused by another task's
    // event is a claim no reader of this task's trail could resolve.
    if (request.causedBy !== undefined && request.causedBy !== null) {
      const predecessor = ledger.getEvent(request.causedBy);
      if (predecessor === null) {
        throw new ToolCallRefused(
          "WRITE_REFUSED",
          "the event named as the cause is not in the ledger",
          "request.causedBy",
        );
      }
      if (predecessor.event.taskId !== request.taskId) {
        throw new ToolCallRefused(
          "WRITE_REFUSED",
          "the event named as the cause belongs to another task",
          "request.causedBy",
        );
      }
    }

    const invocation = deriveInvocation(
      request.taskId,
      request.attempt,
      request.submittedAt,
      request.submissionDigest,
    );
    const scopeId = toolOperationScopeId(request.taskId, request.attempt, request.operationIndex);
    const scope = openToolOperation({ scopeId, servers: admitted.servers });

    let result;
    let sequence;
    try {
      // Adapted at the door, as the gateway's is: the runtime's port is
      // structural and names no ledger type, so the concrete store meets it
      // here, with the one cast in view.
      const claims: ToolClaimPort = {
        transact: (coordinateKey, decide) =>
          claimStore.transact(coordinateKey, (current) => decide(current) as ToolClaimDecision),
        now: (): string => new Date().toISOString(),
      };
      try {
        result = await runToolCall(ledger, scope, claims, {
          invocation,
          operationIndex: request.operationIndex,
          callIndex: request.callIndex,
          accountId: request.accountId,
          identity: request.identity,
          serverId: request.serverId,
          toolName: request.toolName,
          arguments: request.arguments,
          ...(request.causedBy === undefined ? {} : { causedBy: request.causedBy }),
        });
      } catch (error) {
        // Caught by class, exactly as the API door catches it, so both doors
        // answer a lost race from the same fact rather than from two
        // independently maintained readings of a message. The verb names the
        // reason; `fromToolCallError` decides the exit code, so the table stays
        // in one place.
        if (error instanceof ToolClaimHeldError) {
          throw new ToolCallRefused(
            "CLAIM_HELD",
            "another caller holds this tool coordinate; read the recorded call rather than retrying",
            null,
          );
        }
        throw error;
      }

      // Projected the way the API door projects it, and for the same reason:
      // the operation's ledger port exposes no sequence, so the door that holds
      // the real ledger looks it up by the `eventId` the operation returned.
      // Identical on the replay path, which returns the recorded row's own id.
      const record = ledger.getEvent(result.eventId);
      if (record === null) {
        throw new ToolCallRefused(
          "INTERNAL",
          "the recorded tool call could not be read back from the ledger",
          null,
        );
      }
      sequence = record.sequence;
    } finally {
      // Close drops liveness and then reaps by pid, so the child is gone before
      // this verb returns anything.
      await scope.close();
    }

    return {
      document: ToolCallExecuteResponse.parse({
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        replayed: result.replayed,
        outcome: result.outcome,
        refusal: result.refusal,
        at: result.at,
        serverId: result.serverId,
        toolName: result.toolName,
        transport: result.transport,
        accountId: result.accountId,
        argumentBytes: result.argumentBytes,
        resultBytes: result.resultBytes,
        contentBlocks: result.contentBlocks,
        content: result.content,
        sequence,
        eventId: result.eventId,
        transitionId: result.transitionId,
      }),
    };
  } finally {
    ledger.close();
    claimStore.close();
  }
}
