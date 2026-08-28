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
 * The Claude headless descriptor and stream-json parser.
 *
 * Pure, like every provider module: it builds argv, reads a handshake and
 * turns bytes into signals. It cannot spawn, cannot open a file and cannot
 * reach a ledger, because it imports nothing that would let it — not
 * `node:child_process`, not `session.ts`, not `process/*`.
 *
 * **What the record shapes below rest on.** They are the documented headless
 * `stream-json` surface, written down here so a reader can see exactly what
 * this parser expects. They are *not* confirmed by any evidence P4B is
 * authorized to gather: `--help` output is adjacent observation and the
 * bounded `--version` probe proves only that a binary exists. Consequently
 * every Claude capability stays `UNKNOWN` through P4, and anything this table
 * does not recognize is a classified refusal rather than a guess.
 */

/**
 * Our name for the framing, not a version the provider reports.
 *
 * Claude's stream-json records carry no protocol version field, so inventing
 * one from the payload would be fabrication. This constant names the framing
 * *this parser* implements, which is the only thing we actually know.
 */
export const CLAUDE_STREAM_PROTOCOL = "stream-json/1";

/**
 * The tools a read-only session may use. **An allowlist, not a denylist.**
 *
 * A denylist of write tools fails open: it protects a reviewer only from the
 * names someone remembered to list, and `Bash` alone can do anything a write
 * tool can. The reviewer law has to fail closed, so anything outside this list
 * is treated as write-class — including a tool that does not exist yet.
 */
const READ_ONLY_TOOL_ALLOWLIST: readonly string[] = Object.freeze([
  "Glob",
  "Grep",
  "Read",
  "WebFetch",
  "WebSearch",
]);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build the argv for one headless session.
 *
 * Array form throughout: no shell, and no value is ever interpolated into a
 * command string. Session flags come only from the help-confirmed set.
 */
function buildArgv(request: SessionRequest): readonly string[] {
  const argv: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--model",
    request.modelAlias,
  ];

  if (request.resumeSessionId !== null) {
    argv.push("--resume", request.resumeSessionId);
  } else {
    argv.push("--session-id", request.taskId);
  }

  if (isReviewerIdentity(request.identity)) {
    // The provider-native layer, added because Claude has one. It is the
    // polite layer: the load-bearing guarantee is the structural scan before
    // spawn and the write-class kill during the stream, which hold whatever
    // these flags do. Both values are the safe ones the pair-aware scan
    // accepts, so this argv can never itself enable a write.
    argv.push("--permission-mode", "plan", "--restricted");
  }

  return Object.freeze(argv);
}

/** One assistant message's reported output tokens, if it reported any. */
function outputTokens(message: unknown): number | null {
  if (!isRecord(message)) return null;
  const usage = message["usage"];
  if (!isRecord(usage)) return null;
  const tokens = usage["output_tokens"];
  return isReportableTokenCount(tokens) ? tokens : null;
}

/**
 * Does this assistant message use a tool outside the read-only allowlist?
 *
 * The signal is emitted whatever the identity; only a reviewer session turns it
 * into a refusal. For any other role a write signal maps to no normalized
 * event, so this classification changes nothing an implementer observes.
 */
function writeToolTarget(message: unknown): string | null {
  if (!isRecord(message)) return null;
  const content = message["content"];
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block["type"] !== "tool_use") continue;
    const name = block["name"];
    if (typeof name !== "string") continue;
    if (!READ_ONLY_TOOL_ALLOWLIST.includes(name)) return name;
  }
  return null;
}

type RecordOutcome =
  | { readonly ok: true; readonly signals: readonly ProviderSignal[] }
  | { readonly ok: false; readonly code: "UNKNOWN_EVENT" | "MALFORMED_EVENT" };

/**
 * Read one stream-json record.
 *
 * Recognized types only. A record this function cannot classify fails the
 * session rather than being skipped: a stream we did not understand is not a
 * stream we may claim to have read.
 */
function readRecord(raw: string, stepIndex: number): RecordOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, code: "MALFORMED_EVENT" };
  }
  if (!isRecord(parsed)) return { ok: false, code: "MALFORMED_EVENT" };

  const type = parsed["type"];
  if (typeof type !== "string") return { ok: false, code: "MALFORMED_EVENT" };

  switch (type) {
    case "system": {
      const subtype = parsed["subtype"];
      if (typeof subtype !== "string") return { ok: false, code: "MALFORMED_EVENT" };
      if (subtype === "init") {
        const model = parsed["model"];
        if (typeof model !== "string" || model === "") {
          return { ok: false, code: "MALFORMED_EVENT" };
        }
        return {
          ok: true,
          signals: [
            { kind: "started", resolvedModel: model, protocolVersion: CLAUDE_STREAM_PROTOCOL },
          ],
        };
      }
      if (subtype === "auth_required") {
        // A classified reason only. Never the prompt, the URL or the code.
        return { ok: true, signals: [{ kind: "authRequired", reason: "LOGIN_REQUIRED" }] };
      }
      return { ok: false, code: "UNKNOWN_EVENT" };
    }

    case "assistant": {
      const message = parsed["message"];
      if (!isRecord(message)) return { ok: false, code: "MALFORMED_EVENT" };

      const signals: ProviderSignal[] = [];
      const target = writeToolTarget(message);
      if (target !== null) signals.push({ kind: "write", target });

      const tokens = outputTokens(message);
      if (tokens !== null) signals.push({ kind: "step", tokensUsed: tokens, stepIndex });
      // An assistant message that reports no usage is not an error and not a
      // step; it simply carries no measurement.
      return { ok: true, signals };
    }

    case "user":
      // Tool results echoed back into the stream. Recognized, and carries no
      // measurement of its own.
      return { ok: true, signals: [] };

    case "result": {
      const subtype = parsed["subtype"];
      if (typeof subtype !== "string" || subtype === "") {
        return { ok: false, code: "MALFORMED_EVENT" };
      }
      // `subtype` stays an open provider-state token, deliberately. Inventing a
      // closed enum here would assert knowledge of the provider's state space
      // that no evidence P4 may gather could support — the capability-overclaim
      // shape this phase exists to prevent.
      return { ok: true, signals: [{ kind: "state", toState: subtype.toUpperCase() }] };
    }

    default:
      return { ok: false, code: "UNKNOWN_EVENT" };
  }
}

export const claudeAdapter: ProviderAdapter = {
  provider: "claude",

  describe(request: SessionRequest): SessionDescriptor {
    return {
      provider: "claude",
      argv: buildArgv(request),
      // Key by key from the P4A allowlist: CLAUDE_CONFIG_DIR plus PATH, HOME
      // and LC_ALL. `process.env` is never spread, here or anywhere.
      env: buildEnv("claude", request.configRoot),
      cwd: request.workdir,
    };
  },

  /**
   * Newline-framed records, with a carry-over partial.
   *
   * A chunk boundary lands wherever the operating system put it, not where a
   * record ends, so the partial is what keeps the framing honest under load.
   */
  parse(chunk: string, cursor: ParseCursor): ParseOutcome {
    const buffered = cursor.partial + chunk;
    const parts = buffered.split("\n");
    const partial = parts.pop() ?? "";
    const events: ProviderSignal[] = [];
    let index = cursor.recordIndex;

    for (const line of parts) {
      if (line.trim() === "") continue;
      const outcome = readRecord(line, index);
      if (!outcome.ok) {
        return { ok: false, code: outcome.code, detail: "record " + String(index) };
      }
      events.push(...outcome.signals);
      index += 1;
    }
    return { ok: true, events, cursor: { partial, recordIndex: index } };
  },

  /**
   * Nothing here confirms anything.
   *
   * Claude's headless stream carries no capability handshake, and no evidence
   * P4 is authorized to gather could confirm one: help text is adjacent
   * observation, the `--version` probe proves only the binary, and a fake
   * proves only us. Every capability therefore leaves P4B `UNKNOWN` with no
   * evidence, which is the honest answer rather than a gap.
   */
  negotiate(): CapabilityOutcome {
    return {
      ok: true,
      capabilities: unknownCapabilities(),
      protocolVersion: CLAUDE_STREAM_PROTOCOL,
    };
  },
};
