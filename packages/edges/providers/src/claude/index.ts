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
  UsageSourceDescriptor,
} from "../contract/index.js";
import { unknownCapabilities } from "../contract/index.js";
import { buildEnv } from "../config-root/index.js";
import { AdapterError } from "../errors/index.js";
import { isReportableTokenCount } from "../events/index.js";
import { claudeSessionId } from "../session-name/index.js";

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
 * The MCP configuration every worker session is started with: no servers.
 *
 * With `--strict-mcp-config`, the CLI uses only this one, so an MCP server
 * configured on the account never reaches a worker. Both captures reported
 * `init.mcp_servers: []` under it.
 */
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

/**
 * Build the argv for one headless session (P-15 escalón A, ADR 0101).
 *
 * Array form throughout: no shell, and no value is ever interpolated into a
 * command string. Each flag and its evidence:
 *
 * - `--verbose`, always: the binary carries the string `requires --verbose` for
 *   `stream-json` under `-p`, and both captures passed it and produced a
 *   well-formed stream.
 * - `--session-id`, the attempt's version 5 name (`claudeSessionId`), never the task
 *   id, which every attempt shared. The CLI requires a UUID (stated in the recorded
 *   `--help` (2.1.280), behaviour not observed); passing one was not observed.
 * - `--no-session-persistence`: nothing is saved to resume ("only works with
 *   --print"; stated in the recorded `--help` (2.1.280), behaviour not observed),
 *   so no provider transcript is written under the account's configuration root.
 *   Both captures passed it.
 * - `--strict-mcp-config` with an empty `--mcp-config`: no MCP server of the
 *   account reaches a worker.
 * - a reviewer adds `--permission-mode plan --restricted` and `--tools` with the
 *   read-only allowlist, a CLI-side allowlist (stated in the recorded
 *   `--help` (2.1.280), behaviour not observed).
 *
 * `--resume` replaces `--session-id` only when the request carries the same name
 * this attempt would be given. Any other value — a different id, an empty string,
 * a value of another type — is refused with `PROTOCOL_UNSUPPORTED` before argv
 * exists, so no spawn happens. The port never sets `resumeSessionId` (a reattach is
 * an in-process rejoin, and a cross-process one is `REATTACH_UNAVAILABLE`), so this
 * branch is unreachable from it today, and with persistence off a resume would find
 * nothing: it is the typed, id-checked shape and nothing proven.
 */
function buildArgv(request: SessionRequest): readonly string[] {
  const sessionId = claudeSessionId(request.taskId, request.attempt);
  const argv: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    request.modelAlias,
  ];

  if (request.resumeSessionId === null) {
    argv.push("--session-id", sessionId);
  } else if (request.resumeSessionId === sessionId) {
    argv.push("--resume", sessionId);
  } else {
    throw new AdapterError("PROTOCOL_UNSUPPORTED", { provider: "claude", taskId: request.taskId });
  }

  argv.push("--no-session-persistence", "--strict-mcp-config", "--mcp-config", EMPTY_MCP_CONFIG);

  if (isReviewerIdentity(request.identity)) {
    // The provider-native layer, added because Claude has one. It is the
    // polite layer: the load-bearing guarantee is the structural scan before
    // spawn and the write-class kill during the stream, which hold whatever
    // these flags do. Both pair values are the safe ones the pair-aware scan
    // accepts, so this argv can never itself enable a write. How `--tools`
    // interacts with `--restricted` is unobserved.
    argv.push("--permission-mode", "plan", "--restricted", "--tools", READ_ONLY_TOOL_ALLOWLIST.join(","));
  }

  return Object.freeze(argv);
}

/**
 * How this adapter normalizes usage, stated once (P-15/D2, ADR 0105; decision 138).
 *
 * Exactly one report per run, from the `result` record's `usage`, CUMULATIVE and
 * final: the CLI's own total for the session as far as the captures show, and they
 * show only single-run sessions. A `--resume` reuses the session id, so a resumed run
 * yields a second result with the same `sourceObservationId` whose usage scope (the
 * whole session or that run alone) is unobserved; D3 must refuse or distinguish it,
 * and this policy does not claim it. Assistant records report nothing
 * — one message arrives as several records, each repeating the message's usage, and
 * summing them was ADR 0099's double count. The four classes are read by name; a
 * class the record does not carry is `null` (UNKNOWN), never 0, and the total is the
 * sum only when all four are known. `stepIndex` is the number of distinct assistant
 * message ids the session produced (C-D5).
 */
const CLAUDE_USAGE_NORMALIZATION_POLICY = Object.freeze({
  policyVersion: 1,
  adapter: "claude",
  record: "result",
  field: "usage",
  classes: Object.freeze({
    inputTokens: "input_tokens",
    outputTokens: "output_tokens",
    cacheWriteTokens: "cache_creation_input_tokens",
    cacheReadTokens: "cache_read_input_tokens",
  }),
  absentClass: "UNKNOWN",
  totalTokens: "SUM_WHEN_ALL_KNOWN",
  reportKind: "CUMULATIVE",
  isFinal: true,
  sourceObservationId: "SESSION_ID/result",
  stepIndex: "DISTINCT_ASSISTANT_MESSAGE_IDS",
  assistantRecords: "NO_REPORT",
});

/**
 * The Claude CLI's usage source, declared once: the provider's own count of the
 * session (`PROVIDER_AUTHORITATIVE`), under the policy above. The digest is a pinned
 * literal over the policy's canonical JSON; the providers suite recomputes it, since
 * this package hashes nothing in `src/` outside the session name (L-P15A-1).
 */
export const CLAUDE_USAGE_SOURCE: UsageSourceDescriptor = Object.freeze({
  source: "claude-cli",
  sourceClass: "PROVIDER_AUTHORITATIVE",
  normalizationPolicy: CLAUDE_USAGE_NORMALIZATION_POLICY,
  normalizationPolicySha256: "14cbb2a397762bfc4cfec2d00073bc26402d7c81123a2a8683fc007fa808fb0d",
});

/** The result record's usage keys, by the port's class name. */
const CLAUDE_USAGE_CLASSES = CLAUDE_USAGE_NORMALIZATION_POLICY.classes;

/**
 * The one usage report of a `result` record, or `"MALFORMED"`, or null when the
 * record carries no `usage` at all (no report: settlement stays UNKNOWN, never 0).
 *
 * Present-invalid is refused, never read as absent (ADR 0079): a `usage` that is not
 * an object, a class present with anything but a reportable count, or a report with
 * no session id to name it by.
 */
function resultUsage(
  record: Record<string, unknown>,
  stepIndex: number,
): ProviderSignal | "MALFORMED" | null {
  const usage = record["usage"];
  if (usage === undefined) return null;
  if (!isRecord(usage)) return "MALFORMED";
  const classes: Record<string, number | null> = {};
  for (const [name, key] of Object.entries(CLAUDE_USAGE_CLASSES)) {
    const value = usage[key];
    if (value === undefined) {
      classes[name] = null;
    } else if (isReportableTokenCount(value)) {
      classes[name] = value;
    } else {
      return "MALFORMED";
    }
  }
  const sessionId = record["session_id"];
  if (typeof sessionId !== "string" || sessionId === "") return "MALFORMED";
  const known = Object.values(classes);
  const totalTokens = known.every((count) => count !== null)
    ? known.reduce<number>((sum, count) => sum + count, 0)
    : null;
  return {
    kind: "step",
    stepIndex,
    inputTokens: classes["inputTokens"] ?? null,
    outputTokens: classes["outputTokens"] ?? null,
    cacheWriteTokens: classes["cacheWriteTokens"] ?? null,
    cacheReadTokens: classes["cacheReadTokens"] ?? null,
    totalTokens,
    reportKind: "CUMULATIVE",
    isFinal: true,
    sourceObservationId: sessionId + "/result",
  };
}

/**
 * The output text of one assistant message: its `text` blocks, in order, each
 * non-empty text once. `null` when a present value has the wrong shape — a
 * `content` that is not an array, a block that is not an object, or a `text`
 * block without a string — which is refused, never read as no text. An absent
 * `content` is no output, and a block of another type is skipped.
 */
function outputTexts(message: Record<string, unknown>): readonly string[] | null {
  const content = message["content"];
  if (content === undefined) return [];
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) return null;
    if (block["type"] !== "text") continue;
    const text = block["text"];
    if (typeof text !== "string") return null;
    if (text.length > 0) texts.push(text);
  }
  return texts;
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
  | {
      readonly ok: false;
      readonly code: Extract<ParseOutcome, { readonly ok: false }>["code"];
      /** What the refusal may name beyond its record index; absent when nothing may be echoed. */
      readonly detail?: string;
    };

/**
 * The Claude CLI versions whose streams this parser has evidence for (P-15/A2, ADR 0112).
 *
 * One authorized capture each: 2.1.280 (2026-09-22, P-07 escalón C) and 2.1.281
 * (2026-09-24). `init` names the version; a version outside this list is a stream
 * this adapter has no evidence for and is refused with the descriptor's word. The
 * refusal fires at the first record, after the CLI was spawned: it does not prevent
 * spend, and a pre-spawn gate is ND-A2-7's.
 */
const CLAUDE_OBSERVED_CLI_VERSIONS: readonly string[] = Object.freeze(["2.1.280", "2.1.281"]);

/** The one grammar a refused version may be echoed in (Fable C4); anything else is not echoed. */
const CLI_VERSION_GRAMMAR = /^\d+\.\d+\.\d+$/;

/**
 * How one field of a no-signal record is admitted.
 *
 * - `string`: a non-empty string; `count`: a reportable token count; `number`: a
 *   finite number, never negative; `boolean`; `array`: an array, its contents not
 *   read. A value of another type is `MALFORMED_EVENT`.
 * - `oneOf`: one of the words observed. Any other value, `null` included, is
 *   `UNKNOWN_EVENT`: a word never observed is a record this parser has no evidence
 *   for.
 * - `record`: an object whose keys are exactly the nested gate's.
 */
type AdmissionGate =
  | "string"
  | "count"
  | "number"
  | "boolean"
  | "array"
  | { readonly oneOf: readonly unknown[] }
  | { readonly record: Readonly<Record<string, AdmissionGate>> };

/**
 * One observed shape of a no-signal record in one version, and the capture that shows
 * it: the exact fields and their gates. `capture` names a digest by its first 8 hex
 * characters, a prefix of the full digest in the fixture table: a label, not a pointer.
 */
interface ObservedShape {
  readonly capture: string;
  readonly keys: Readonly<Record<string, AdmissionGate>>;
}

/**
 * One no-signal record kind: the versions it was observed in, and the shapes observed
 * in each. `beforeInitIn` names the versions whose capture shows it before `init`; a
 * row without it is never read before `init`.
 */
interface NoSignalRecordRow {
  readonly observedIn: readonly string[];
  readonly beforeInitIn?: readonly string[];
  readonly shapesByVersion: Readonly<Record<string, readonly ObservedShape[]>>;
}

/**
 * The records this parser admits and reads nothing from (P-15/A2, ADR 0112; P-15/A3,
 * ADR 0114), measured key by key against the captures and no further.
 *
 * Keyed by `type` or `type/subtype`, then by CLI version, then by every field the
 * captures show the shape varying on; each shape cites its capture. Every record is
 * held three ways: its version must be one it was observed in; its keys must be
 * exactly one of that version's observed shapes, so a key set no capture showed in
 * that version refuses; and every value must pass its gate. `rate_limit_event` is
 * keyed by (version, status): its captures show the overage pair (`overageStatus`,
 * `overageDisabledReason`) travelling with `allowed` and the utilization pair
 * (`utilization`, `surpassedThreshold`) with `allowed_warning`, and one version
 * carrying both, so a status word admits only the key set it was captured with, and
 * a (version, status) pair no capture showed has no shape. `status` and
 * `rateLimitType` are confounded in the captures (`allowed` with `five_hour` twice,
 * `allowed_warning` with `seven_day` once); the window is pooled inside each shape,
 * which admits an unobserved window under an observed key set and nothing else.
 *
 * `admitUnder`'s fold of `MALFORMED_EVENT` over `UNKNOWN_EVENT` relies on two things
 * about a version's nested `rate_limit_info` shapes: `status` is the first key of
 * each, and no two shapes share a key set (today they share no status word either).
 * A later shape keeps both, so a record carrying an unobserved status word refuses
 * `UNKNOWN_EVENT` before any of its other values is read for type.
 *
 * No shape emits a signal, so none of these numbers can become a step, a usage
 * report, a pressure, a cost or a decision: `estimated_tokens` is an estimate, and
 * the rate-limit numbers are the provider's quota telemetry, whose mapping to a
 * pressure is P-19's. `isUsingOverage` admits only `false`: a `true` refuses as any
 * unobserved word does, so the parser does not tell the two apart and the S1 assert
 * is the owner's instrument for the no-overage criterion.
 */
const CLAUDE_NO_SIGNAL_RECORDS: Readonly<Record<string, NoSignalRecordRow>> = Object.freeze({
  "system/commands_changed": {
    observedIn: ["2.1.280"],
    beforeInitIn: ["2.1.280"],
    shapesByVersion: {
      "2.1.280": [
        {
          capture: "sample 2, sha256 01132951",
          keys: { type: "string", subtype: "string", commands: "array", uuid: "string", session_id: "string" },
        },
      ],
    },
  },
  "system/thinking_tokens": {
    observedIn: ["2.1.281"],
    shapesByVersion: {
      "2.1.281": [
        {
          capture: "sample 3, sha256 a1bd7d82; sample 4, sha256 21a6d56e",
          keys: {
            type: "string",
            subtype: "string",
            estimated_tokens: "count",
            estimated_tokens_delta: "count",
            session_id: "string",
            uuid: "string",
          },
        },
      ],
    },
  },
  rate_limit_event: {
    observedIn: ["2.1.280", "2.1.281"],
    shapesByVersion: {
      "2.1.280": [
        {
          capture: "sample 2, sha256 01132951: allowed, five_hour",
          keys: {
            type: "string",
            uuid: "string",
            session_id: "string",
            rate_limit_info: {
              record: {
                status: { oneOf: ["allowed"] },
                resetsAt: "number",
                rateLimitType: { oneOf: ["five_hour", "seven_day"] },
                overageStatus: { oneOf: ["rejected"] },
                overageDisabledReason: { oneOf: ["org_level_disabled"] },
                isUsingOverage: { oneOf: [false] },
                unifiedWindows: {
                  record: {
                    five_hour: { record: { utilization: "number", resetsAt: "number" } },
                    seven_day: { record: { utilization: "number", resetsAt: "number" } },
                  },
                },
              },
            },
          },
        },
      ],
      "2.1.281": [
        {
          capture: "sample 4, sha256 21a6d56e: allowed, five_hour",
          keys: {
            type: "string",
            uuid: "string",
            session_id: "string",
            rate_limit_info: {
              record: {
                status: { oneOf: ["allowed"] },
                resetsAt: "number",
                rateLimitType: { oneOf: ["five_hour", "seven_day"] },
                overageStatus: { oneOf: ["rejected"] },
                overageDisabledReason: { oneOf: ["org_level_disabled"] },
                isUsingOverage: { oneOf: [false] },
                unifiedWindows: {
                  record: {
                    five_hour: { record: { utilization: "number", resetsAt: "number" } },
                    seven_day: { record: { utilization: "number", resetsAt: "number" } },
                  },
                },
              },
            },
          },
        },
        {
          capture: "sample 3, sha256 a1bd7d82: allowed_warning, seven_day",
          keys: {
            type: "string",
            uuid: "string",
            session_id: "string",
            rate_limit_info: {
              record: {
                status: { oneOf: ["allowed_warning"] },
                resetsAt: "number",
                rateLimitType: { oneOf: ["five_hour", "seven_day"] },
                utilization: "number",
                isUsingOverage: { oneOf: [false] },
                surpassedThreshold: "number",
                unifiedWindows: {
                  record: {
                    five_hour: { record: { utilization: "number", resetsAt: "number" } },
                    seven_day: { record: { utilization: "number", resetsAt: "number" } },
                  },
                },
              },
            },
          },
        },
      ],
    },
  },
});

type AdmissionVerdict = "ADMITTED" | "UNKNOWN_EVENT" | "MALFORMED_EVENT";

function admitValue(value: unknown, gate: AdmissionGate): AdmissionVerdict {
  if (gate === "string") return typeof value === "string" && value !== "" ? "ADMITTED" : "MALFORMED_EVENT";
  if (gate === "count") return isReportableTokenCount(value) ? "ADMITTED" : "MALFORMED_EVENT";
  if (gate === "number") {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? "ADMITTED" : "MALFORMED_EVENT";
  }
  if (gate === "boolean") return typeof value === "boolean" ? "ADMITTED" : "MALFORMED_EVENT";
  if (gate === "array") return Array.isArray(value) ? "ADMITTED" : "MALFORMED_EVENT";
  if ("oneOf" in gate) return gate.oneOf.includes(value) ? "ADMITTED" : "UNKNOWN_EVENT";
  return isRecord(value) ? admitFields(value, gate.record) : "MALFORMED_EVENT";
}

/** Exactly the gated keys, each admitted: a missing or an extra key is a shape never observed. */
function admitFields(value: Record<string, unknown>, fields: Readonly<Record<string, AdmissionGate>>): AdmissionVerdict {
  const lawful = Object.keys(fields);
  const present = Object.keys(value);
  if (present.length !== lawful.length || present.some((key) => !lawful.includes(key))) return "UNKNOWN_EVENT";
  for (const key of lawful) {
    const gate = fields[key];
    if (gate === undefined) return "UNKNOWN_EVENT";
    const verdict = admitValue(value[key], gate);
    if (verdict !== "ADMITTED") return verdict;
  }
  return "ADMITTED";
}

/**
 * A record against one version's observed shapes: admitted if one admits it. Otherwise
 * `MALFORMED_EVENT` if a shape found a wrong value — the key set of every level read
 * up to that value, and every word read before it, matched, so the record is that
 * shape as far as it was read, with a value of the wrong type — and `UNKNOWN_EVENT` if
 * none did. A key set is checked one level at a time: a wrong-typed top-level field
 * such as `uuid` is `MALFORMED_EVENT` before the nested `rate_limit_info` key set is
 * read, as in ADR 0112's table.
 */
function admitUnder(record: Record<string, unknown>, row: NoSignalRecordRow, version: string): AdmissionVerdict {
  if (!row.observedIn.includes(version)) return "UNKNOWN_EVENT";
  const shapes = row.shapesByVersion[version] ?? [];
  const verdicts = shapes.map((shape) => admitFields(record, shape.keys));
  if (verdicts.includes("ADMITTED")) return "ADMITTED";
  return verdicts.includes("MALFORMED_EVENT") ? "MALFORMED_EVENT" : "UNKNOWN_EVENT";
}

/**
 * What one `parse` call carries from record to record: the cursor's state, unpacked
 * into a local the call owns. Never module state.
 */
interface StreamState {
  readonly stepMessageIds: string[];
  version: string | undefined;
  preInitRecords: { readonly kind: string; readonly admittedIn: readonly string[] }[];
}

/**
 * A no-signal record, judged against the table.
 *
 * After `init`, against that version's row. Before it, only a row a capture shows
 * before `init` is read (v1.1), and only against the versions whose capture shows it
 * there (ND-A2-10): admitted if any admits it, and the versions that did are kept in
 * the cursor, so `init` re-judges the record against the version it names (Fable C2).
 * A row never observed before `init` is `MALFORMED_EVENT` there. A record no version
 * admits is `MALFORMED_EVENT` when every version found its shape wrong, and
 * `UNKNOWN_EVENT` otherwise.
 */
function readNoSignal(record: Record<string, unknown>, kind: string, state: StreamState): RecordOutcome {
  const row = Object.prototype.hasOwnProperty.call(CLAUDE_NO_SIGNAL_RECORDS, kind)
    ? CLAUDE_NO_SIGNAL_RECORDS[kind]
    : undefined;
  if (row === undefined) return { ok: false, code: "UNKNOWN_EVENT" };
  if (state.version !== undefined) {
    const verdict = admitUnder(record, row, state.version);
    return verdict === "ADMITTED" ? { ok: true, signals: [] } : { ok: false, code: verdict };
  }
  const preInit = row.beforeInitIn ?? [];
  if (preInit.length === 0) return { ok: false, code: "MALFORMED_EVENT" };
  const verdicts = preInit.map((version) => ({ version, verdict: admitUnder(record, row, version) }));
  const admittedIn = verdicts.filter((entry) => entry.verdict === "ADMITTED").map((entry) => entry.version);
  if (admittedIn.length === 0) {
    return {
      ok: false,
      code: verdicts.every((entry) => entry.verdict === "MALFORMED_EVENT") ? "MALFORMED_EVENT" : "UNKNOWN_EVENT",
    };
  }
  const seen = state.preInitRecords.some(
    (entry) => entry.kind === kind && entry.admittedIn.join("\n") === admittedIn.join("\n"),
  );
  if (!seen) state.preInitRecords.push({ kind, admittedIn });
  return { ok: true, signals: [] };
}

/**
 * The stream's `system/init`: the model it resolved and the CLI version it names.
 *
 * In order: a second `init` in one session is `MALFORMED_EVENT`, whatever it names
 * (Fable C3: one session, one `init`, the verdict-once rule applied whole); the model
 * must be a non-empty string; `claude_code_version` absent, empty or not a string is
 * `MALFORMED_EVENT`; a version outside the observed list is refused with the
 * descriptor's word, naming the version only in the grammar above (Fable C4); and
 * every no-signal record seen before it must have been admitted under that version
 * (Fable C2), or the `init` is `MALFORMED_EVENT`. The rest of the record is
 * environment inventory and is not read.
 */
function readInit(record: Record<string, unknown>, state: StreamState): RecordOutcome {
  if (state.version !== undefined) return { ok: false, code: "MALFORMED_EVENT" };
  const model = record["model"];
  if (typeof model !== "string" || model === "") return { ok: false, code: "MALFORMED_EVENT" };
  const version = record["claude_code_version"];
  if (typeof version !== "string" || version === "") return { ok: false, code: "MALFORMED_EVENT" };
  if (!CLAUDE_OBSERVED_CLI_VERSIONS.includes(version)) {
    return {
      ok: false,
      code: "PROTOCOL_UNSUPPORTED",
      ...(CLI_VERSION_GRAMMAR.test(version) ? { detail: "CLI version " + version } : {}),
    };
  }
  if (state.preInitRecords.some((entry) => !entry.admittedIn.includes(version))) {
    return { ok: false, code: "MALFORMED_EVENT" };
  }
  state.version = version;
  state.preInitRecords = [];
  return {
    ok: true,
    signals: [{ kind: "started", resolvedModel: model, protocolVersion: CLAUDE_STREAM_PROTOCOL }],
  };
}

/**
 * Read one stream-json record.
 *
 * Recognized types only. A record this function cannot classify fails the
 * session rather than being skipped: a stream we did not understand is not a
 * stream we may claim to have read.
 */
/**
 * `state` is the parse's running state, updated here in place: the distinct assistant
 * message ids (what the result's report counts as its steps), the CLI version once
 * `init` named it, and the no-signal records seen before `init`.
 */
function readRecord(raw: string, state: StreamState): RecordOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, code: "MALFORMED_EVENT" };
  }
  if (!isRecord(parsed)) return { ok: false, code: "MALFORMED_EVENT" };

  const type = parsed["type"];
  if (typeof type !== "string") return { ok: false, code: "MALFORMED_EVENT" };

  // Before `init` names a version, only a table row a capture shows before `init` is
  // read (P-15/A2 v1.1, ADR 0112). A message, a tool echo, a result or an
  // `auth_required` with no version is a stream no capture shows, so an `init` the CLI
  // stopped sending cannot turn into a success read against no version at all.
  if (state.version === undefined && (type === "assistant" || type === "user" || type === "result")) {
    return { ok: false, code: "MALFORMED_EVENT" };
  }

  switch (type) {
    case "system": {
      const subtype = parsed["subtype"];
      if (typeof subtype !== "string") return { ok: false, code: "MALFORMED_EVENT" };
      if (subtype === "init") return readInit(parsed, state);
      if (subtype === "auth_required") {
        // Documented (ADR 0041), never captured, and its position unobserved: read only
        // after `init`.
        if (state.version === undefined) return { ok: false, code: "MALFORMED_EVENT" };
        // A classified reason only. Never the prompt, the URL or the code.
        return { ok: true, signals: [{ kind: "authRequired", reason: "LOGIN_REQUIRED" }] };
      }
      // `commands_changed` (2.1.280) and `thinking_tokens` (2.1.281) say nothing
      // about the session: the table admits them, and anything else is refused.
      return readNoSignal(parsed, "system/" + subtype, state);
    }

    case "assistant": {
      const message = parsed["message"];
      if (!isRecord(message)) return { ok: false, code: "MALFORMED_EVENT" };

      const signals: ProviderSignal[] = [];
      const target = writeToolTarget(message);
      if (target !== null) signals.push({ kind: "write", target });

      // No usage from an assistant record (P-15/D2, ADR 0105): one message arrives as
      // several records, each repeating its usage, and the session's one report is
      // the result's. The record's message id is counted once, as a step.
      const messageId = message["id"];
      if (messageId !== undefined) {
        if (typeof messageId !== "string" || messageId === "") return { ok: false, code: "MALFORMED_EVENT" };
        if (!state.stepMessageIds.includes(messageId)) state.stepMessageIds.push(messageId);
      }

      // Output text (P-07 escalón C, ADR 0099): the `text` blocks of the message,
      // in stream order, for the caller's private sink. Not a `thinking` block —
      // the captured success sample carries one with an opaque signature, and it
      // is not output. Not a record the CLI flags as an API error message — the
      // captured failure sample carries its error text there, and it is not the
      // operation's output. `is_api_error_message` is read present-invalid: absent
      // or false is an ordinary message, true is excluded, anything else refuses.
      const apiError = parsed["is_api_error_message"];
      if (apiError !== undefined && typeof apiError !== "boolean") return { ok: false, code: "MALFORMED_EVENT" };
      if (apiError !== true) {
        const texts = outputTexts(message);
        if (texts === null) return { ok: false, code: "MALFORMED_EVENT" };
        for (const text of texts) signals.push({ kind: "output", text });
      }
      return { ok: true, signals };
    }

    case "user":
      // Tool results echoed back into the stream. Recognized, and carries no
      // measurement of its own.
      return { ok: true, signals: [] };

    case "rate_limit_event":
      // Admitted by the table under the words and keys the captures show, and NEVER
      // mapped to quota pressure: a mapping would be a capability claim (ADR 0099),
      // and `allowed_warning` is P-19's to map.
      return readNoSignal(parsed, "rate_limit_event", state);

    case "result": {
      const subtype = parsed["subtype"];
      if (typeof subtype !== "string" || subtype === "") {
        return { ok: false, code: "MALFORMED_EVENT" };
      }
      // `subtype` stays an open provider-state token, deliberately, and it is
      // NOT a verdict: the captured failure sample (CLI 2.1.280, 2026-09-22)
      // carries `subtype: "success"` on an operation that failed. What the
      // operation said is `is_error`, read on the evidence of the two captured
      // samples and nothing else (P-07 escalón C, ADR 0099):
      //   - `true`  → FAILED    (sample 1: "Not logged in", exit 1);
      //   - `false` → SUCCEEDED (sample 2: result "ok", exit 0);
      //   - absent  → no operation signal (every earlier synthetic stream);
      //   - anything else → MALFORMED_EVENT, never read as absent (ADR 0079).
      // The crossed pairs — `true` with exit 0, `false` with exit 1 — were not
      // observed; the exit is a separate fact the session reports.
      // The session's one usage report, from the CLI's own total (P-15/D2), ahead of
      // the state the record reports, in the transports' shared order.
      const report = resultUsage(parsed, state.stepMessageIds.length);
      if (report === "MALFORMED") return { ok: false, code: "MALFORMED_EVENT" };
      const signals: ProviderSignal[] = report === null ? [] : [report];
      signals.push({ kind: "state", toState: subtype.toUpperCase() });
      const isError = parsed["is_error"];
      if (isError !== undefined && typeof isError !== "boolean") return { ok: false, code: "MALFORMED_EVENT" };
      if (isError === true) signals.push({ kind: "operation", status: "FAILED" });
      if (isError === false) signals.push({ kind: "operation", status: "SUCCEEDED" });
      return { ok: true, signals };
    }

    default:
      return { ok: false, code: "UNKNOWN_EVENT" };
  }
}

/**
 * The delivery of a transport that carries text and nothing else (P-06/C, ADR 0095).
 *
 * `STDIN` when every class the instruction was composed from is text, and
 * `MODALITY_UNSUPPORTED` otherwise. A pure decision over the classes the request
 * declares: no bytes are read, and the refusal happens before the spawn.
 */
function textOnlyDelivery(request: SessionRequest): SessionDescriptor["delivery"] {
  const foreign = request.modalities.filter((kind) => kind !== "text");
  if (foreign.length > 0) return { kind: "UNSUPPORTED", reason: "MODALITY_UNSUPPORTED" };
  return { kind: "STDIN" };
}

export const claudeAdapter: ProviderAdapter = {
  provider: "claude",

  describe(request: SessionRequest): SessionDescriptor {
    return {
      provider: "claude",
      argv: buildArgv(request),
      // Key by key from the allowlist: CLAUDE_CONFIG_DIR plus PATH, HOME, LC_ALL
      // and, for Claude alone, USER (ADR 0101). `process.env` is never spread,
      // here or anywhere.
      env: buildEnv("claude", request.configRoot),
      cwd: request.workdir,
      // V2-B1c. The argv above is `-p` with **no positional prompt**, which is
      // exactly the shape a real `claude` reads stdin for -- so the pipe the
      // spawn already opens is the transport, and it was never written to. The
      // declaration is all this pure method does; `startSession` performs it.
      //
      // P-06/C: stdin carries text and only text. A content list naming any other
      // class is refused here, before a process exists, rather than delivered
      // without the part the caller asked for -- silently dropping a block would
      // send the model a different instruction than the one that was authorized.
      delivery: textOnlyDelivery(request),
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
    const state: StreamState = {
      stepMessageIds: [...(cursor.stepMessageIds ?? [])],
      version: cursor.cliVersion,
      preInitRecords: [...(cursor.preInitRecords ?? [])],
    };

    for (const line of parts) {
      if (line.trim() === "") continue;
      const outcome = readRecord(line, state);
      if (!outcome.ok) {
        const named = outcome.detail === undefined ? "" : ", " + outcome.detail;
        return { ok: false, code: outcome.code, detail: "record " + String(index) + named };
      }
      events.push(...outcome.signals);
      index += 1;
    }
    return {
      ok: true,
      events,
      cursor: {
        partial,
        recordIndex: index,
        stepMessageIds: state.stepMessageIds,
        ...(state.version === undefined ? {} : { cliVersion: state.version }),
        ...(state.preInitRecords.length === 0 ? {} : { preInitRecords: state.preInitRecords }),
      },
    };
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
