import { parseWorkerIdentity } from "@acp/contracts";
import type { WorkerIdentityString } from "@acp/contracts";

import type {
  CapabilityOutcome,
  ParseCursor,
  ParseOutcome,
  ProviderAdapter,
  ProviderSignal,
  SessionDescriptor,
  SessionRequest,
} from "../../contract.js";
import { unknownCapabilities } from "../../contract.js";
import { buildEnv } from "../../config-root.js";
import { isReportableTokenCount } from "../../events.js";

/**
 * The Codex App Server descriptor and JSON-RPC envelope parser.
 *
 * Pure, like every provider module: it builds argv, reads frames and turns
 * them into signals. It imports neither the session controller nor any process
 * module nor `node:child_process`, so it cannot participate in the boundary it
 * is deliberately kept outside of.
 *
 * **What this is built against.** The offline schema the Codex CLI generates
 * for its own App Server protocol — `codex app-server generate-json-schema`,
 * run without `--experimental`, vendored as ignored evidence under
 * `.acp-local/p4d-codex-schema/` with the per-file manifest digest recorded in
 * `CODEX_PROTOCOL_RECORD` below. That schema is protocol evidence: it defines
 * the envelope shapes and the complete inbound method inventory, and the
 * co-located test proves this module's tables against those bytes rather than
 * against anyone's memory of them.
 *
 * **What it is not.** No live conformance is claimed. No App Server was
 * started, no `initialize` handshake sent, no account touched, no session
 * created. Wire framing is `UNKNOWN` — see the framing note below — and the
 * CLI version is an adjacent observation about a binary, never a warranty
 * about a protocol. Every Codex capability stays `UNKNOWN` with no evidence.
 *
 * **This is not the Agent Client Protocol.** Despite also being JSON-RPC over
 * stdio, the App Server protocol is Codex's own surface and shares no method
 * with the ACP the Kimi adapter reads. The two tables are unrelated and are
 * never reconciled against each other.
 */

/**
 * Our name for the envelope generation this parser reads.
 *
 * The App Server envelope is JSON-RPC 2.0 in shape — an id-bearing request, a
 * method-only notification, an id-bearing response carrying `result`, and an
 * id-bearing error. It is *named* here rather than read off the wire, because
 * the schema declares no version field for a peer to report.
 */
export const CODEX_APP_SERVER_PROTOCOL = "app-server/jsonrpc-2.0";

/**
 * What the vendored evidence does and does not establish, written down.
 *
 * `FRAMING` is the honest centre of this record. Neither the schema files nor
 * the App Server's own `--help` documents how a frame is delimited on the
 * wire: length-prefixed and newline-delimited are both consistent with every
 * byte anyone here is authorized to have seen. Proving it needs the handshake
 * this packet is expressly not authorized to perform, so it stays `UNKNOWN`
 * and this module claims nothing about it. The parser below splits on
 * newlines; that is the framing its *fixtures* declare, exercising the
 * frame-splitting seam, and it is not an assertion about a real server.
 *
 * `INITIALIZE_SHAPE` records that the v1 `initialize` request and response
 * shapes are in the vendored evidence. This module never sends one.
 *
 * `EXPERIMENTAL_API_TIER` is `UNKNOWN` because `experimentalApi` is a
 * client-declared capability negotiated during that same unperformed
 * handshake: whether a further tier of methods exists beyond this offline,
 * non-experimental generation cannot be established from these bytes.
 */
export const CODEX_PROTOCOL_RECORD: Readonly<Record<string, string>> = Object.freeze({
  FRAMING: "UNKNOWN",
  INITIALIZE_SHAPE: "v1",
  EXPERIMENTAL_API_TIER: "UNKNOWN",
  /** Adjacent observation about the binary that generated the schema. */
  CLI_VERSION_OBSERVED: "codex-cli 0.149.0",
  /** SHA-256 of the 291-line per-file manifest of the vendored schema tree. */
  SCHEMA_MANIFEST_DIGEST: "3c5da19ed58df2804ad92fc23051bc5ef55bdcc9c2fa06eec73dd33fb3422f08",
});

/**
 * The listen form, as the App Server's own `--help` documents it.
 *
 * Recorded in `.acp-local/p4d-sonnet-protocol-evidence.md`: `--listen` selects
 * the transport, `stdio://` is the documented default, and `unix://` and
 * `ws://` are the alternatives this adapter never uses. Passing the default
 * explicitly is deliberate — a descriptor that relies on a default is a
 * descriptor whose behaviour changes when the default does.
 */
const CODEX_STDIO_LISTEN = "stdio://";

/** The envelope generation the schema's shapes describe, when a frame names one. */
const JSONRPC_VERSION = "2.0";

/**
 * Server-to-client requests that would authorize a write if anyone answered
 * them. **Nobody answers them here.**
 *
 * A real server asking for approval and receiving no reply will stall, and
 * that is the correct behaviour for a read-only phase: P4 sends no approval,
 * no token and no tool result, so no write can be authorized by silence.
 *
 * Each one becomes a write-class signal whatever the identity. The session
 * controller — not this module — turns that into `READ_ONLY_VIOLATION` and an
 * autonomous teardown under a reviewer identity, and tolerates it as a
 * classified signal under an implementer.
 */
const WRITE_AUTHORIZING_REQUESTS: readonly string[] = Object.freeze([
  "applyPatchApproval",
  "execCommandApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

/**
 * The remaining server-to-client requests, and the classified reason each
 * raises.
 *
 * Interaction is not a write, so refusing these under a reviewer identity
 * would confuse "asked a question" with "changed something". They are
 * tolerated under every identity and answered under none.
 *
 * The reason is the *only* thing that travels. Every one of these carries
 * material that must not: `item/tool/call` carries a tool name and its
 * arguments, `item/tool/requestUserInput` and `mcpServer/elicitation/request`
 * carry prompts and schemas, and `account/chatgptAuthTokens/refresh` carries
 * an account identifier. None of it reaches a signal, an error or a log,
 * because a payload is exactly where it would travel if anyone let it.
 */
const INTERACTION_REQUEST_REASON: Readonly<Record<string, string>> = Object.freeze({
  "account/chatgptAuthTokens/refresh": "AUTH_REQUIRED",
  "attestation/generate": "ATTESTATION_REQUESTED",
  "item/tool/call": "TOOL_CALL_REQUESTED",
  "item/tool/requestUserInput": "USER_INPUT_REQUESTED",
  "mcpServer/elicitation/request": "ELICITATION_REQUIRED",
});

/**
 * The exact notification subset this adapter claims.
 *
 * **An allowlist, never a denylist.** The schema defines seventy-five
 * server-to-client notifications; five are claimed and the other seventy are
 * refused, along with every client-to-agent method that could arrive inbound.
 * Absence from a table is refusal, so a notification added by a future Codex
 * release is refused rather than silently mishandled.
 *
 * Content deltas — agent message deltas, reasoning deltas, command output
 * deltas, plan and diff updates — are deliberately **not** claimed. They carry
 * content, the normalized union has no content event, and P4's adapter is a
 * control-plane observer rather than a transcript pipe. Claiming them would
 * mean either inventing an event the frozen vocabulary does not have or
 * dropping their payload on the floor while pretending to read them.
 */
const CLAIMED_NOTIFICATIONS: readonly string[] = Object.freeze([
  "error",
  "thread/started",
  "thread/tokenUsage/updated",
  "turn/completed",
  "turn/started",
]);

/**
 * `TurnStatus`, as the schema's closed enum defines it.
 *
 * Validated rather than passed through: a status outside this set is a peer
 * contradicting its own schema, and that is a malformed frame, not a state
 * token to forward.
 */
const TURN_STATUSES: readonly string[] = Object.freeze([
  "completed",
  "failed",
  "inProgress",
  "interrupted",
]);

/**
 * `CodexErrorInfo`, as the schema's discriminated union names its variants.
 *
 * Seventeen names: twelve plain enum members and five single-key object
 * variants, whose key is the discriminant. The variant name is a classified
 * code from a closed set and may travel; the accompanying `message` is free
 * text and may not. Validating against this list rather than forwarding
 * whatever a frame contains is what keeps a peer from writing its own token
 * into our state stream.
 */
const CODEX_ERROR_VARIANTS: readonly string[] = Object.freeze([
  "activeTurnNotSteerable",
  "badRequest",
  "contextWindowExceeded",
  "cyberPolicy",
  "httpConnectionFailed",
  "internalServerError",
  "misalignmentPolicyViolation",
  "other",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
  "sandboxError",
  "serverOverloaded",
  "sessionBudgetExceeded",
  "threadRollbackFailed",
  "unauthorized",
  "usageLimitExceeded",
]);

/** The token used when a frame's error variant is absent or off-schema. */
const UNCLASSIFIED_ERROR = "unclassified";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Is this identity a reviewer?
 *
 * Derived here from `@acp/contracts` rather than imported from the session
 * controller: a provider module is a pure descriptor and parser, and reaching
 * into `session.ts` would make it a participant in the process boundary it is
 * deliberately kept outside of.
 */
function isReviewerIdentity(identity: WorkerIdentityString): boolean {
  return parseWorkerIdentity(identity).role === "reviewer";
}

/**
 * Build the argv for one App Server session.
 *
 * `codex app-server --listen stdio://` and nothing else. Array form
 * throughout: no shell, and no value is ever interpolated into a command
 * string. No flag outside the documented listen form is forwarded, and in
 * particular nothing that would select a sandbox, an approval policy or an
 * account.
 */
function buildArgv(): readonly string[] {
  return Object.freeze(["app-server", "--listen", CODEX_STDIO_LISTEN]);
}

type FrameOutcome =
  | { readonly ok: true; readonly signals: readonly ProviderSignal[] }
  | { readonly ok: false; readonly code: "UNKNOWN_EVENT" | "MALFORMED_EVENT" };

const MALFORMED: FrameOutcome = Object.freeze({ ok: false, code: "MALFORMED_EVENT" });
const UNKNOWN: FrameOutcome = Object.freeze({ ok: false, code: "UNKNOWN_EVENT" });

/**
 * Read `thread/started`.
 *
 * The thread record is the single richest privacy hazard in the whole claimed
 * subset: it carries `cwd`, `preview` — usually the first user message —
 * `gitInfo` and an on-disk path. Exactly one bit of it is used, and it is used
 * only to decide whether the frame conforms; none of it is carried into the
 * signal.
 *
 * `resolvedModel` is `unreported` and not a guess. The record names a
 * `modelProvider`, which is a vendor and not a model, and reporting one as the
 * other would be a fabrication in a field whose whole purpose is to say which
 * model actually ran.
 */
function readThreadStarted(params: unknown): FrameOutcome {
  if (!isRecord(params)) return MALFORMED;
  const thread = params["thread"];
  if (!isRecord(thread)) return MALFORMED;
  const id = thread["id"];
  if (typeof id !== "string" || id === "") return MALFORMED;
  return {
    ok: true,
    signals: [
      {
        kind: "started",
        resolvedModel: "unreported",
        protocolVersion: CODEX_APP_SERVER_PROTOCOL,
      },
    ],
  };
}

/**
 * Read `turn/started` or `turn/completed` into a lifecycle token.
 *
 * The turn record carries its items, and items carry content. Only `status`
 * is read, and only after it is checked against the schema's closed enum.
 */
function readTurn(params: unknown, lifecycle: "started" | "completed"): FrameOutcome {
  if (!isRecord(params)) return MALFORMED;
  const threadId = params["threadId"];
  if (typeof threadId !== "string" || threadId === "") return MALFORMED;
  const turn = params["turn"];
  if (!isRecord(turn)) return MALFORMED;
  const status = turn["status"];
  if (typeof status !== "string" || !TURN_STATUSES.includes(status)) return MALFORMED;
  const toState = lifecycle === "started" ? "TURN_STARTED" : "TURN_" + status.toUpperCase();
  return { ok: true, signals: [{ kind: "state", toState }] };
}

/**
 * Read `thread/tokenUsage/updated` into a bounded measurement.
 *
 * `last` rather than `total`: a step measurement is what the most recent unit
 * of work cost, and `total` is the thread's running sum. Reporting the sum as
 * a step would inflate every step after the first.
 *
 * A count outside the reportable range yields no measurement at all rather
 * than a clamped one, because a clamped number is indistinguishable from a
 * real one and would quietly become a false observation.
 *
 * `stepIndex` is zero. The App Server numbers turns by id, not by ordinal, and
 * synthesizing an ordinal from a counter this parser happens to keep would be
 * inventing an index the protocol never reported.
 */
function readTokenUsage(params: unknown): FrameOutcome {
  if (!isRecord(params)) return MALFORMED;
  const threadId = params["threadId"];
  if (typeof threadId !== "string" || threadId === "") return MALFORMED;
  const usage = params["tokenUsage"];
  if (!isRecord(usage)) return MALFORMED;
  const last = usage["last"];
  if (!isRecord(last)) return MALFORMED;
  const tokens = last["totalTokens"];
  if (!isReportableTokenCount(tokens)) return { ok: true, signals: [] };
  return { ok: true, signals: [{ kind: "step", tokensUsed: tokens, stepIndex: 0 }] };
}

/**
 * Classify the error variant a frame reports, or refuse to.
 *
 * The schema's union has two branch shapes — a bare enum string, and an object
 * whose single key is the discriminant — and both are read. Anything else,
 * including a name the schema does not define, classifies as unclassified: a
 * peer does not get to put its own text into our state stream by putting it
 * where a discriminant belongs.
 */
function classifyErrorVariant(info: unknown): string {
  if (typeof info === "string") {
    return CODEX_ERROR_VARIANTS.includes(info) ? info : UNCLASSIFIED_ERROR;
  }
  if (isRecord(info)) {
    const keys = Object.keys(info);
    const only = keys.length === 1 ? keys[0] : undefined;
    if (only !== undefined && CODEX_ERROR_VARIANTS.includes(only)) return only;
  }
  return UNCLASSIFIED_ERROR;
}

/**
 * Read the `error` notification into a classified provider-state token.
 *
 * **Why a state token and not a terminal failure.** The notification carries
 * `willRetry`, so the schema itself says an error here is not necessarily the
 * end of anything: a server that is about to retry has not failed, and a
 * session torn down on its first retryable error would be reporting a failure
 * that did not happen. The retry disposition is therefore carried in the token
 * rather than discarded, and both forms are classified.
 *
 * The error's `message` is free text — it is checked for conformance and then
 * left exactly where it was found.
 */
function readErrorNotification(params: unknown): FrameOutcome {
  if (!isRecord(params)) return MALFORMED;
  const error = params["error"];
  if (!isRecord(error)) return MALFORMED;
  if (typeof error["message"] !== "string") return MALFORMED;
  const willRetry = params["willRetry"];
  if (typeof willRetry !== "boolean") return MALFORMED;
  const variant = classifyErrorVariant(error["codexErrorInfo"]);
  return {
    ok: true,
    signals: [{ kind: "state", toState: (willRetry ? "ERROR_RETRYING_" : "ERROR_") + variant }],
  };
}

/** Classify one method-bearing frame, or refuse it. */
function readMethodFrame(method: string, params: unknown): FrameOutcome {
  if (WRITE_AUTHORIZING_REQUESTS.includes(method)) {
    return { ok: true, signals: [{ kind: "write", target: method }] };
  }

  // `Object.hasOwn` rather than a bare lookup: a frame naming `toString` or
  // `constructor` would otherwise reach an inherited member and turn a
  // prototype function into a classified reason. An allowlist that can be
  // walked off the end of is not an allowlist.
  if (Object.hasOwn(INTERACTION_REQUEST_REASON, method)) {
    const reason = INTERACTION_REQUEST_REASON[method];
    if (typeof reason === "string") {
      return { ok: true, signals: [{ kind: "authRequired", reason }] };
    }
  }

  // The allowlist gate. A notification absent from the claimed table is
  // refused before the dispatcher below ever sees it, so a name added to the
  // switch without being added to the table cannot quietly become claimed.
  if (!CLAIMED_NOTIFICATIONS.includes(method)) return UNKNOWN;

  switch (method) {
    case "thread/started":
      return readThreadStarted(params);
    case "turn/started":
      return readTurn(params, "started");
    case "turn/completed":
      return readTurn(params, "completed");
    case "thread/tokenUsage/updated":
      return readTokenUsage(params);
    case "error":
      return readErrorNotification(params);
    default:
      // Unreachable while the table and the dispatcher agree, and a refusal
      // rather than a throw if they ever stop agreeing.
      return UNKNOWN;
  }
}

/**
 * Read one frame under the declared test framing.
 *
 * The `jsonrpc` member deserves a note, because this adapter treats it
 * differently from the Kimi one and the difference is evidence-driven rather
 * than stylistic. The vendored schema declares **no** `jsonrpc` property on
 * any of the four envelope shapes — across the whole generated tree the token
 * occurs only inside type names such as `JSONRPCRequest`, never once as a
 * property key — so requiring it would refuse frames the protocol's own
 * definition calls conforming. Requiring nothing at all would be no better:
 * a frame that does name a generation and names the wrong one is a peer
 * disagreeing with the envelope this parser reads. So it is optional, and
 * checked when present.
 */
function readFrame(raw: string): FrameOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return MALFORMED;
  }
  if (!isRecord(parsed)) return MALFORMED;
  if (Object.hasOwn(parsed, "jsonrpc") && parsed["jsonrpc"] !== JSONRPC_VERSION) return MALFORMED;

  const hasResult = Object.hasOwn(parsed, "result");
  const hasError = Object.hasOwn(parsed, "error");

  if (Object.hasOwn(parsed, "method")) {
    const method = parsed["method"];
    if (typeof method !== "string" || method === "") return MALFORMED;
    // A frame is a request or a notification, or it is a response. One that is
    // both is malformed, and checking it here means a method name can never be
    // used to smuggle a response past the exclusivity rule below.
    if (hasResult || hasError) return MALFORMED;
    return readMethodFrame(method, parsed["params"]);
  }

  // A response carries exactly one of `result` or `error` — never both, never
  // neither. Checking one first and falling through to the other would
  // silently prefer one and mask a peer that sent both, which is precisely the
  // malformed case worth catching.
  if (hasResult && hasError) return MALFORMED;
  if (hasResult || hasError) {
    if (!Object.hasOwn(parsed, "id")) return MALFORMED;
    // Well formed, and still refused: P4 issues no request, so no response to
    // one can legitimately arrive. Refusing it is the allowlist holding, not a
    // parser gap.
    return UNKNOWN;
  }

  return MALFORMED;
}

export const codexAdapter: ProviderAdapter = {
  provider: "codex",

  describe(request: SessionRequest): SessionDescriptor {
    // The reviewer role changes nothing in this argv, and that is the honest
    // position rather than an omission. Codex's read-only sandbox and approval
    // settings live on the `exec` surface and on per-thread start parameters;
    // the App Server's own listen surface takes no such flag, and P4 sends no
    // thread parameters at all. Spelling one anyway would be a false
    // native-flag claim, so the guarantee rests entirely on the structural
    // pre-spawn scan and the write-class refusal above.
    void isReviewerIdentity(request.identity);
    return {
      provider: "codex",
      argv: buildArgv(),
      env: buildEnv("codex", request.configRoot),
      cwd: request.workdir,
    };
  },

  parse(chunk: string, cursor: ParseCursor): ParseOutcome {
    const buffered = cursor.partial + chunk;
    const parts = buffered.split("\n");
    const partial = parts.pop() ?? "";
    const events: ProviderSignal[] = [];
    let index = cursor.recordIndex;

    for (const line of parts) {
      if (line.trim() === "") continue;
      const outcome = readFrame(line);
      if (!outcome.ok) {
        // The detail names a position, never a byte of what was read.
        return { ok: false, code: outcome.code, detail: "frame " + String(index) };
      }
      events.push(...outcome.signals);
      index += 1;
    }
    return { ok: true, events, cursor: { partial, recordIndex: index } };
  },

  negotiate(): CapabilityOutcome {
    // Nothing here confirms anything. No handshake was performed and none is
    // authorized in P4D; the vendored schema proves what the protocol defines,
    // never what a running server does.
    return {
      ok: true,
      capabilities: unknownCapabilities(),
      protocolVersion: CODEX_APP_SERVER_PROTOCOL,
    };
  },
};

