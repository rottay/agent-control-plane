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
} from "../contract.js";
import { unknownCapabilities } from "../contract.js";
import { buildEnv } from "../config-root.js";
import { isReportableTokenCount } from "../events.js";

/**
 * The Kimi ACP descriptor and JSON-RPC parser.
 *
 * Pure, like every provider module: it builds argv, reads frames and turns
 * them into signals. It imports neither the session controller nor any process
 * module nor `node:child_process`, so it cannot participate in the boundary it
 * is deliberately kept outside of.
 *
 * **What this is built against.** Stable ACP v1, framed as newline-delimited
 * JSON-RPC over stdio, per the contract revision recorded in
 * `.acp-local/p4c-acp-contract-evidence.md` (schema `9f40e018…`, SDK
 * `5dac09aa…`). ACP v2 is experimental and out of scope, and `Content-Length`
 * framing is **not** implemented — the stable stream helper is NDJSON, and
 * inventing a second framing would be asserting a contract nobody recorded.
 *
 * **What it is not.** No live conformance is claimed. No ACP server was
 * started, no login performed, no session authenticated. If a real Kimi server
 * deviates from the recorded contract, the fail-closed law below refuses
 * rather than misunderstands — which is the whole reason the refusals are
 * classified instead of skipped. Every Kimi capability stays `UNKNOWN`.
 */

/** The stable protocol generation this parser implements. */
export const KIMI_ACP_PROTOCOL_VERSION = 1;

/** Our name for the framing, not a version the agent reports. */
export const KIMI_ACP_PROTOCOL = "acp/v1-ndjson";

/**
 * Tools a read-only session may use. **An allowlist, not a denylist.**
 *
 * Same law as the Claude adapter, and for the same reason: a denylist protects
 * a reviewer only from the names someone remembered, and one general-purpose
 * tool defeats it. Anything outside this list is write-class, including a tool
 * that does not exist yet.
 */
const READ_ONLY_TOOL_ALLOWLIST: readonly string[] = Object.freeze([
  "Glob",
  "Grep",
  "Read",
  "WebFetch",
  "WebSearch",
]);

/**
 * Agent-to-client methods, reconciled against the pinned schema bytes.
 *
 * Both tables were checked name by name against
 * `.acp-local/p4c-acp-v1-schema-9f40e018.json` (schema commit `9f40e018…`,
 * SHA-256 `caf62ff9…`) rather than derived from memory. That reconciliation
 * found one omission: `terminal/output` is defined there as "Request to get
 * the current output and status of a terminal" and returns `output`,
 * `truncated` and an exit status — a read, and it is listed as one below.
 *
 * `session/request_permission` is handled separately: it embeds the call it
 * is asking about, so it is classified rather than waved through.
 *
 * Every other method the schema defines is client-to-agent. One arriving
 * inbound would be unexpected, and unexpected is a classified refusal.
 */
const READ_METHODS: readonly string[] = Object.freeze([
  "fs/read_text_file",
  "terminal/output",
]);
const WRITE_METHODS: readonly string[] = Object.freeze([
  "fs/write_text_file",
  "terminal/create",
  "terminal/kill",
  "terminal/release",
  "terminal/wait_for_exit",
]);

/** The permission request carries the call it asks about; classify that. */
const PERMISSION_METHOD = "session/request_permission";

/**
 * Elicitation: the agent asking the client for input, and the answer landing.
 *
 * `elicitation/create` is an interaction request, not a write, so it is
 * tolerated under every identity including a reviewer's — refusing it would
 * confuse "asked a question" with "changed something". It maps to the frozen
 * interaction signal with a classified reason and nothing else: the request's
 * schema, prompt, URL and any response data never travel, because a payload is
 * exactly where they would travel if anyone let them.
 *
 * `elicitation/complete` is the notification that the exchange finished. It
 * maps to a bounded open state token, with no passthrough.
 *
 * P4 generates no client response to either and persists nothing.
 */
const ELICITATION_CREATE_METHOD = "elicitation/create";
const ELICITATION_COMPLETE_METHOD = "elicitation/complete";

/** `session/update` kinds the recorded contract defines. */
const UPDATE_KINDS_WITHOUT_EVENT: readonly string[] = Object.freeze([
  "agent_message_chunk",
  "agent_thought_chunk",
  "available_commands_update",
  "current_mode_update",
  "plan",
  "user_message_chunk",
]);
const UPDATE_KINDS_TOOL: readonly string[] = Object.freeze(["tool_call", "tool_call_update"]);

/**
 * The JSON-RPC error code the recorded contract uses for "authenticate first".
 *
 * Declared as a named constant so a later protocol-proof packet can compare it
 * against the same document rather than against a memory of it. Any other
 * error code is surfaced as an open provider-state token, never guessed at.
 */
const ACP_AUTH_REQUIRED_CODE = -32000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Derived here, not imported from the session controller. */
function isReviewerIdentity(identity: WorkerIdentityString): boolean {
  return parseWorkerIdentity(identity).role === "reviewer";
}

/**
 * Build the argv for one ACP session.
 *
 * `kimi acp` and nothing else. The help-confirmed flags on that surface are
 * `--login`, `--region` and `--help`; none is forwarded. `--login` in
 * particular is never passed: P4 performs no authentication.
 */
function buildArgv(): readonly string[] {
  return Object.freeze(["acp"]);
}

/**
 * Tool-call kinds a read-only session may perform.
 *
 * ACP classifies a tool call by `kind` as well as naming it by `title`, and
 * the two can disagree — a call titled `Read` whose kind is `execute` is an
 * execution however it is labelled. So **both** fields are checked and either
 * one being outside its allowlist makes the call write-class. Trusting the
 * title alone would be a reviewer-safety bypass a peer could spell out
 * deliberately.
 */
const READ_ONLY_TOOL_KINDS: readonly string[] = Object.freeze([
  "fetch",
  "read",
  "search",
  "think",
]);

/**
 * Why this tool call is write-class, or `null` if it is not.
 *
 * A **present** field that fails its allowlist is always write-class, whether
 * it arrives on the initial call or on a later update.
 *
 * Absence is where the two cases genuinely differ, and the difference is
 * structural rather than a matter of taste. An initial `tool_call` naming
 * neither field has told us nothing about itself, so it is unclassified and
 * fails closed. A `tool_call_update` naming neither is a conforming partial
 * update to a call that was already classified when it was created — treating
 * it as unclassified would refuse ordinary progress reports and make the
 * reviewer law unusable rather than strict. So the update kind is passed in
 * and the two are distinguished by the code, not by a comment.
 */
function writeClassReason(
  update: Record<string, unknown>,
  updateKind: "tool_call" | "tool_call_update",
): string | null {
  const title = update["title"];
  const kind = update["kind"];
  const hasTitle = typeof title === "string" && title !== "";
  const hasKind = typeof kind === "string" && kind !== "";

  if (hasKind && !READ_ONLY_TOOL_KINDS.includes(kind)) return kind;
  if (hasTitle && !READ_ONLY_TOOL_ALLOWLIST.includes(title)) return title;
  if (!hasTitle && !hasKind) {
    return updateKind === "tool_call" ? "unclassified" : null;
  }
  return null;
}

/**
 * Classify a tool call embedded in a permission request.
 *
 * Defense in depth: a permission request carries the call it is asking about,
 * so the same law applies to it. Absent fields are benign here for the same
 * reason they are on a partial update — the initial call is classified in its
 * own frame — while any present, disallowed field is write-class.
 */
function embeddedToolCallReason(params: unknown): string | null {
  if (!isRecord(params)) return null;
  const toolCall = params["toolCall"];
  if (!isRecord(toolCall)) return null;
  return writeClassReason(toolCall, "tool_call_update");
}

/** Tokens reported by an update, when it reports any within bounds. */
function updateTokens(update: Record<string, unknown>): number | null {
  const meta = update["_meta"];
  if (!isRecord(meta)) return null;
  const tokens = meta["tokensUsed"];
  return isReportableTokenCount(tokens) ? tokens : null;
}

type FrameOutcome =
  | { readonly ok: true; readonly signals: readonly ProviderSignal[] }
  | { readonly ok: false; readonly code: "UNKNOWN_EVENT" | "MALFORMED_EVENT" };

/** Read one agent-to-client `session/update` notification. */
function readUpdate(params: unknown): FrameOutcome {
  if (!isRecord(params)) return { ok: false, code: "MALFORMED_EVENT" };
  const update = params["update"];
  if (!isRecord(update)) return { ok: false, code: "MALFORMED_EVENT" };
  const kind = update["sessionUpdate"];
  if (typeof kind !== "string" || kind === "") return { ok: false, code: "MALFORMED_EVENT" };

  const signals: ProviderSignal[] = [];

  if (UPDATE_KINDS_TOOL.includes(kind)) {
    const reason = writeClassReason(update, kind === "tool_call" ? "tool_call" : "tool_call_update");
    if (reason !== null) signals.push({ kind: "write", target: reason });
  } else if (!UPDATE_KINDS_WITHOUT_EVENT.includes(kind)) {
    return { ok: false, code: "UNKNOWN_EVENT" };
  }

  const tokens = updateTokens(update);
  if (tokens !== null) signals.push({ kind: "step", tokensUsed: tokens, stepIndex: 0 });
  return { ok: true, signals };
}

/** Read one JSON-RPC result object. */
function readResult(result: Record<string, unknown>): FrameOutcome {
  // initialize → the agent states the protocol generation it speaks.
  if (Object.hasOwn(result, "protocolVersion")) {
    const version = result["protocolVersion"];
    if (typeof version !== "number" || !Number.isInteger(version)) {
      return { ok: false, code: "MALFORMED_EVENT" };
    }
    if (version !== KIMI_ACP_PROTOCOL_VERSION) {
      // Out of range is refused, not adapted to. A parser that stretched to
      // meet an unrecorded generation would be claiming a contract it has not
      // read.
      return { ok: false, code: "UNKNOWN_EVENT" };
    }
    const model = result["agentName"];
    return {
      ok: true,
      signals: [
        {
          kind: "started",
          resolvedModel: typeof model === "string" && model !== "" ? model : "unreported",
          protocolVersion: KIMI_ACP_PROTOCOL,
        },
      ],
    };
  }

  // session/new and session/load both answer with a session id.
  if (Object.hasOwn(result, "sessionId")) {
    const sessionId = result["sessionId"];
    if (typeof sessionId !== "string" || sessionId === "") {
      return { ok: false, code: "MALFORMED_EVENT" };
    }
    return { ok: true, signals: [{ kind: "state", toState: "SESSION_READY" }] };
  }

  // session/prompt terminates with a stop reason — an open provider-state
  // token, deliberately: inventing a closed enum would assert knowledge of the
  // agent's state space that no evidence here could support.
  if (Object.hasOwn(result, "stopReason")) {
    const stopReason = result["stopReason"];
    if (typeof stopReason !== "string" || stopReason === "") {
      return { ok: false, code: "MALFORMED_EVENT" };
    }
    return { ok: true, signals: [{ kind: "state", toState: stopReason.toUpperCase() }] };
  }

  return { ok: false, code: "UNKNOWN_EVENT" };
}

/** Read one JSON-RPC error object. */
function readError(error: Record<string, unknown>): FrameOutcome {
  const code = error["code"];
  if (typeof code !== "number" || !Number.isInteger(code)) {
    return { ok: false, code: "MALFORMED_EVENT" };
  }
  if (code === ACP_AUTH_REQUIRED_CODE) {
    // A classified reason only. The error's own message may carry a prompt, a
    // URL or a code, and none of it travels.
    return { ok: true, signals: [{ kind: "authRequired", reason: "AUTH_REQUIRED" }] };
  }
  return { ok: true, signals: [{ kind: "state", toState: "ERROR_" + String(code) }] };
}

/** Read one NDJSON frame. */
function readFrame(raw: string): FrameOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, code: "MALFORMED_EVENT" };
  }
  if (!isRecord(parsed)) return { ok: false, code: "MALFORMED_EVENT" };
  if (parsed["jsonrpc"] !== "2.0") return { ok: false, code: "MALFORMED_EVENT" };

  const method = parsed["method"];
  if (typeof method === "string") {
    if (method === "session/update") return readUpdate(parsed["params"]);
    if (method === ELICITATION_CREATE_METHOD) {
      return { ok: true, signals: [{ kind: "authRequired", reason: "ELICITATION_REQUIRED" }] };
    }
    if (method === ELICITATION_COMPLETE_METHOD) {
      return { ok: true, signals: [{ kind: "state", toState: "ELICITATION_COMPLETE" }] };
    }
    if (method === PERMISSION_METHOD) {
      const reason = embeddedToolCallReason(parsed["params"]);
      return { ok: true, signals: reason === null ? [] : [{ kind: "write", target: reason }] };
    }
    if (WRITE_METHODS.includes(method)) {
      return { ok: true, signals: [{ kind: "write", target: method }] };
    }
    if (READ_METHODS.includes(method)) return { ok: true, signals: [] };
    return { ok: false, code: "UNKNOWN_EVENT" };
  }

  const result = parsed["result"];
  const error = parsed["error"];
  const hasResult = Object.hasOwn(parsed, "result");
  const hasError = Object.hasOwn(parsed, "error");

  // A JSON-RPC response carries exactly one of `result` or `error` — never
  // both, never neither. Checking `result` first and falling through to
  // `error` would silently prefer one and mask a peer that sent both, which is
  // precisely the malformed case worth catching.
  if (hasResult && hasError) return { ok: false, code: "MALFORMED_EVENT" };
  if (hasResult) return isRecord(result) ? readResult(result) : { ok: false, code: "MALFORMED_EVENT" };
  if (hasError) return isRecord(error) ? readError(error) : { ok: false, code: "MALFORMED_EVENT" };

  return { ok: false, code: "MALFORMED_EVENT" };
}

export const kimiAdapter: ProviderAdapter = {
  provider: "kimi",

  describe(request: SessionRequest): SessionDescriptor {
    // The reviewer role changes nothing in this argv, and that is the honest
    // position: Kimi's `acp` surface exposes no read-only mode, so asserting
    // one would be a false native-flag claim. The guarantee rests entirely on
    // the structural pre-spawn scan and the write-class refusal below.
    void isReviewerIdentity(request.identity);
    return {
      provider: "kimi",
      argv: buildArgv(),
      env: buildEnv("kimi", request.configRoot),
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
        return { ok: false, code: outcome.code, detail: "frame " + String(index) };
      }
      events.push(...outcome.signals);
      index += 1;
    }
    return { ok: true, events, cursor: { partial, recordIndex: index } };
  },

  negotiate(): CapabilityOutcome {
    // Nothing here confirms anything. No live handshake was performed and none
    // is authorized in P4C; a fake proves only our machinery.
    return {
      ok: true,
      capabilities: unknownCapabilities(),
      protocolVersion: KIMI_ACP_PROTOCOL,
    };
  },
};
