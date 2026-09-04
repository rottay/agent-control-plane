import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { API_CONTRACT_VERSION, LEDGER_CONTRACT_VERSION } from "@acp/protocol";
import {
  ToolCallExecuteRequest,
  ToolCallExecuteResponse,
  ToolCallPageResponse,
} from "@acp/protocol";
import {
  deriveInvocation,
  runToolCall,
  toolCallTransitionId,
  toolOperationScopeId,
} from "@acp/runtime";
import { admitToolServers, openToolOperation } from "@acp/tools";
import type { AdmittedToolServer } from "@acp/tools";

import { ApiRouteError } from "../errors/index.js";

/**
 * The tool-call door (V2-B4b stage 3C).
 *
 * The plane's third write route, and the first that makes this process start a
 * child and speak a protocol to it. Everything that authority needs in order to
 * be reviewable is here: the operator document is loaded once, the scope is
 * opened per request and closed in a `finally`, and the operation itself is the
 * runtime's — this module never calls a tool port directly.
 *
 * **The door composes through `runToolCall`, never through `callTool`.** That
 * is load-bearing rather than stylistic. The protocol port builds a refusal
 * receipt from the caller's **raw** names, so a refusal on an out-of-grammar
 * name would be unrecordable; the operation's prechecks are what close that,
 * and they close it only for callers that go through the operation.
 *
 * **Layered validation, so no `SupervisorError` ever escapes.** The operation
 * refuses by throwing, and a throw arriving here would answer 500 and blame the
 * wrong party. So each of its nine prechecks is closed before it is entered:
 *
 * | Precheck | Closed by |
 * |---|---|
 * | 1 bounded names, 2 identity, 3 indices, 4 the invocation's attempt and instant | the request schema — a 400 naming the field |
 * | 5 the causal link | this module's predecessor check below |
 * | 6 the scope id | constructed here from the same coordinates, so it cannot differ |
 * | 7 the task exists | `getTask` null ⇒ 404 |
 * | 8 the attempt bound | ⇒ 409 |
 * | 9 the replay read | internal to the operation |
 *
 * After that a `SupervisorError` reaching the classifier is a defect, and 500
 * with no detail is the right answer to a defect. No classifier case is added:
 * mapping supervisor throws to `BAD_REQUEST` would blame callers for our bugs
 * and risk an internal message reaching a body.
 *
 * **A refusal is not an error.** `TOOL_NOT_ALLOWED`, `IDENTITY_FORBIDS_WRITE`,
 * `ARGUMENTS_UNBOUNDED`, `RESULT_UNSAFE`, `PROTOCOL_VIOLATION`,
 * `SERVER_NOT_ADMITTED` and `SESSION_NOT_LIVE` all answer **200** with
 * `outcome: "REFUSED"`, because the request became an operation and a durable
 * row exists. 4xx is reserved for requests that never became one.
 *
 * **`content` reaches the caller's body and nowhere else.** Not a ledger row —
 * the recorder writes nine named scalars — not a stream frame, not a log line.
 * A replay returns none, and that is a fact about what was stored rather than a
 * filter applied here.
 *
 * **Two callers, one coordinate: serialized here, and only here.** The
 * operation's replay read and its append are not one atomic step — it reads the
 * idempotency key, finds nothing, calls the tool, and appends afterwards — so
 * two requests in flight together for one coordinate would both find nothing
 * and both run a real effect. Sequentially the coordinate is spent and the
 * second replays; concurrently it is not yet spent when the second looks. This
 * door is the first place in the plane where two callers can reach the
 * operation at once, so it is where the gap is closed: {@link IN_FLIGHT} holds
 * the running execution per durable coordinate, and a second request for a key
 * already in flight waits for it to settle and then takes the ordinary path,
 * which by then finds the row and replays. It is not told the first caller's
 * outcome — only that the coordinate is no longer in flight — because a waiter
 * that inherited a result would be reporting a call it did not make.
 *
 * **That guarantee is per gateway process, and no wider.** It is a `Map` in
 * this process's memory, so it serializes the callers this process serves and
 * nothing else. Two gateway processes over one ledger can still both find the
 * coordinate unspent and both run the tool; closing that needs a lock the
 * ledger itself arbitrates, which is a later packet's and is deliberately not
 * invented here. Stated rather than left for a reader to discover: this is a
 * bound on the claim, not an oversight in it.
 */

/**
 * Executions in flight, keyed by the durable coordinate they will spend.
 *
 * `taskId/attempt/tool.<operationIndex>.<callIndex>` — the same triple the
 * idempotency key is built from, so the key this map is keyed by and the key
 * the ledger uniques on name the same call.
 *
 * Module scope on purpose: one registry per process, shared by every request
 * the process serves. Entries live only for the duration of one execution and
 * are removed in a `finally`, so the map cannot grow with traffic.
 */
const IN_FLIGHT = new Map<string, Promise<ToolCallExecuteResponse>>();

/** Why an operator's tool document was refused. Reasons, never paths or bytes. */
export type ToolServersLoadRefusal =
  | "PATH_NOT_SUPPLIED"
  | "PATH_NOT_ABSOLUTE"
  | "PATH_NOT_CANONICAL"
  | "DOCUMENT_ABSENT"
  | "DOCUMENT_NOT_REGULAR"
  | "DOCUMENT_NOT_OWNED"
  | "DOCUMENT_TOO_LARGE"
  | "DOCUMENT_NOT_JSON"
  | "DOCUMENT_NOT_ADMITTED";

export type ToolServersLoadOutcome =
  | { readonly ok: true; readonly servers: readonly AdmittedToolServer[] }
  | { readonly ok: false; readonly reason: ToolServersLoadRefusal };

/** A tool document is a short list of servers, not a data file. */
export const TOOL_SERVERS_MAX_BYTES = 64 * 1024;

function refuse(reason: ToolServersLoadRefusal): ToolServersLoadOutcome {
  return { ok: false, reason };
}

/**
 * Load and admit the operator's tool document, once.
 *
 * Mirrors `loadBearerGuard` deliberately, down to the refusal vocabulary's
 * shape: absolute path, canonical realpath, regular file, owned by the invoking
 * uid, bounded size. **A rotation is a restart** — a document re-read per
 * request would let a file edited mid-flight change the answer between two
 * calls of one batch, so the process serves the configuration it started with.
 *
 * The refusal words name a reason and never the path or the bytes. This module
 * reads the file and parses the JSON; `@acp/tools` decides. That split is the
 * law's — the tool edge may not read a filesystem outside its admission site —
 * and it is the right one anyway: reading is an entrypoint's job.
 */
export function loadToolServers(path?: unknown): ToolServersLoadOutcome {
  if (typeof path !== "string" || path === "") return refuse("PATH_NOT_SUPPLIED");
  if (!isAbsolute(path)) return refuse("PATH_NOT_ABSOLUTE");

  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return refuse("DOCUMENT_ABSENT");
  }
  if (real !== path) return refuse("PATH_NOT_CANONICAL");

  let stats;
  try {
    stats = statSync(real);
  } catch {
    return refuse("DOCUMENT_ABSENT");
  }
  if (!stats.isFile()) return refuse("DOCUMENT_NOT_REGULAR");
  if (stats.uid !== process.getuid?.()) return refuse("DOCUMENT_NOT_OWNED");
  if (stats.size > TOOL_SERVERS_MAX_BYTES) return refuse("DOCUMENT_TOO_LARGE");

  let text: string;
  try {
    text = readFileSync(real, "utf8");
  } catch {
    return refuse("DOCUMENT_ABSENT");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("DOCUMENT_NOT_JSON");
  }

  const admitted = admitToolServers(parsed);
  // The admission's own refusal and field path are deliberately not forwarded.
  // They describe the operator's file, and this outcome is on its way to an
  // HTTP body; "the document was not admitted" is the whole of what a caller
  // may learn about a file it cannot see.
  if (!admitted.ok) return refuse("DOCUMENT_NOT_ADMITTED");

  return { ok: true, servers: admitted.servers };
}

interface ToolCallDependencies {
  readonly ledger: Ledger;
  readonly servers: ToolServersLoadOutcome;
  readonly taskId: string;
  readonly body: unknown;
}

/**
 * Execute one explicit tool call, and answer with what it recorded.
 *
 * The scope is opened only after every check above it has passed, and closed in
 * a `finally` so a throw on the way out still reaps the child. A dropped HTTP
 * connection does not cancel the operation (ADR 0010): the record still lands.
 */
export async function executeToolCall(
  dependencies: ToolCallDependencies,
): Promise<ToolCallExecuteResponse> {
  const { ledger, servers, taskId } = dependencies;

  // The body first, so a malformed request never learns whether this process
  // has a tool document. `safeParse` and a field path: the value is never
  // echoed, because a value in an error body is a value in a log.
  const parsed = ToolCallExecuteRequest.safeParse(dependencies.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue === undefined ? "body" : issue.path.join(".");
    throw new ApiRouteError("BAD_REQUEST", "the tool call request is not valid", at);
  }
  const request = parsed.data;

  // The path and the body must name the same task. Two ids in one request is a
  // request that does not know what it is asking for.
  if (request.taskId !== taskId) {
    throw new ApiRouteError(
      "BAD_REQUEST",
      "the task in the path and the task in the body must be the same",
      "taskId",
    );
  }

  if (!servers.ok) {
    throw new ApiRouteError(
      "TOOL_SERVERS_UNCONFIGURED",
      "this server was started without an admitted tool document, so no tool call can be made",
    );
  }

  const task = ledger.getTask(taskId);
  if (task === null) {
    throw new ApiRouteError("NOT_FOUND", "no task with that id was found");
  }
  if (request.attempt > task.latestAttempt) {
    throw new ApiRouteError(
      "WRITE_REFUSED",
      "that attempt has not begun; a tool call cannot belong to an attempt the task has not reached",
      "attempt",
    );
  }

  // Precheck 5, closed here because it is the only place that can be. The
  // operation validates the shape of `causedBy`; whether the event exists needs
  // a ledger, and the runtime's port exposes no lookup by event id — widening
  // it is a stop. This door holds the real ledger, so the check lives here.
  //
  // The event contract permits cross-task causation in general. This route
  // narrows it to the same task on purpose: a tool call caused by another
  // task's event is a claim no reader of this task's trail could resolve.
  if (request.causedBy !== undefined && request.causedBy !== null) {
    const predecessor = ledger.getEvent(request.causedBy);
    if (predecessor === null) {
      throw new ApiRouteError(
        "WRITE_REFUSED",
        "the event named as the cause is not in the ledger",
        "causedBy",
      );
    }
    if (predecessor.event.taskId !== taskId) {
      throw new ApiRouteError(
        "WRITE_REFUSED",
        "the event named as the cause belongs to another task",
        "causedBy",
      );
    }
  }

  // The durable coordinate this request will spend. Built from the same triple
  // the idempotency key is, so waiting on this key is waiting on that row.
  const coordinate =
    request.taskId +
    "/" +
    String(request.attempt) +
    "/" +
    toolCallTransitionId(request.operationIndex, request.callIndex);

  // Wait out any execution already holding this coordinate, then re-check:
  // another waiter may have taken it in the meantime, and a first attempt that
  // threw without appending leaves the coordinate unspent for the next one to
  // own. The running promise's outcome is deliberately discarded -- this
  // request reports the call it makes, not the one it waited for.
  for (;;) {
    const running = IN_FLIGHT.get(coordinate);
    if (running === undefined) break;
    await running.catch(() => undefined);
  }

  // No `await` between the loop's exit and the `set` below, which is what makes
  // this a claim rather than a hope: a concurrent request can only resume on a
  // later turn of the loop, by which time the entry is visible to it.
  const execution = runOneCall({ ledger, servers, request });
  IN_FLIGHT.set(coordinate, execution);
  try {
    return await execution;
  } finally {
    // Only if it is still ours. A later owner's entry must survive our exit.
    if (IN_FLIGHT.get(coordinate) === execution) IN_FLIGHT.delete(coordinate);
  }
}

interface OneCall {
  readonly ledger: Ledger;
  readonly servers: { readonly ok: true; readonly servers: readonly AdmittedToolServer[] };
  readonly request: ToolCallExecuteRequest;
}

/**
 * Open a scope, run the operation, project the row. One request's worth of work.
 *
 * Split out so the in-flight registry above holds a promise for exactly this —
 * the part that opens a child and spends a coordinate — and not for the
 * validation that precedes it, which is cheap, has no effect, and should never
 * queue behind another caller's tool call.
 */
async function runOneCall(input: OneCall): Promise<ToolCallExecuteResponse> {
  const { ledger, servers, request } = input;
  const invocation = deriveInvocation(
    request.taskId,
    request.attempt,
    request.submittedAt,
    request.submissionDigest,
  );
  // Built here from the same coordinates the operation will rebuild, so
  // precheck 6 cannot fail. One scope, one operation, one request.
  const scopeId = toolOperationScopeId(request.taskId, request.attempt, request.operationIndex);
  const scope = openToolOperation({ scopeId, servers: servers.servers });

  // The short-lived writable handle, in the register the roadmap write
  // established: the served ledger is opened read-only, so a route that appends
  // opens its own, uses it, and closes it. Never held between requests and
  // never reachable from the read path.
  const writable = openLedger(ledger.path);
  let result;
  let sequence;
  try {
    result = await runToolCall(writable, scope, {
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

    // `sequence` is the door's to project. The operation cannot answer one —
    // its ledger port exposes neither a sequence nor a record carrying it —
    // and the repair is a lookup here rather than a wider port. Read through
    // the handle that appended, and before it closes, so the row is certainly
    // visible. The replay path returns the recorded row's own `eventId`, so
    // this resolves identically for both.
    const record = writable.getEvent(result.eventId);
    if (record === null) {
      throw new ApiRouteError(
        "INTERNAL",
        "the recorded tool call could not be read back from the ledger",
      );
    }
    sequence = record.sequence;
  } finally {
    // Close drops liveness and then reaps by pid, so children are gone before
    // this handler returns whatever it is going to return.
    await scope.close();
    writable.close();
  }

  return ToolCallExecuteResponse.parse({
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
  });
}

/**
 * One task's recorded tool calls, oldest first.
 *
 * A fold of `TOOL_CALL_RECORDED` rows, paged by ledger sequence. Every field
 * comes from the row; there is no content member to omit, because the recorder
 * never wrote one.
 */
export function buildToolCallPage(
  ledger: Ledger,
  taskId: string,
  cursor: string | undefined,
  limit: number,
): ToolCallPageResponse {
  const afterSequence = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isInteger(afterSequence) || afterSequence < 0) {
    throw new ApiRouteError("BAD_REQUEST", "the cursor is not a ledger sequence", "cursor");
  }

  const page = ledger.listEvents({
    taskId,
    type: "TOOL_CALL_RECORDED",
    afterSequence,
    limit,
  });

  const items = page.events.map((row) => {
    const payload = row.event.payload;
    return {
      sequence: row.sequence,
      eventId: row.eventId,
      transitionId: row.event.transitionId,
      occurredAt: row.event.occurredAt,
      emittedBy: row.event.emittedBy,
      causedBy: row.event.causationId,
      accountId: payload["accountId"],
      serverId: payload["serverId"],
      toolName: payload["toolName"],
      transport: payload["transport"],
      outcome: payload["outcome"],
      refusal: payload["refusal"],
      argumentBytes: payload["argumentBytes"],
      resultBytes: payload["resultBytes"],
      contentBlocks: payload["contentBlocks"],
    };
  });

  return ToolCallPageResponse.parse({
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    taskId,
    items,
    count: items.length,
    // The ledger's own cursor, stringified. The page says whether more exist;
    // inventing a cursor when it says otherwise would offer a next page that
    // is not there.
    nextCursor: page.hasMore && page.nextCursor !== null ? String(page.nextCursor) : null,
  });
}
