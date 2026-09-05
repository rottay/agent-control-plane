# acp-product — audit report (snapshot 4569478)

Paths are snapshot-relative to `packages/`.

## Scores + justification

**Preparación como producto (vs the owner's model): 3/10.** A strong execution
substrate and a weak product. Everything downstream of "here is one authorized
packet" is real: hash-chained append-only ledger, durable walk on two drivers, exact
write-set enforcement, conflict graph, routing over a versioned policy registry,
account records, commit receipts, loopback gateway with a bearer-guarded write door,
console. Everything upstream is absent. A roadmap is an opaque 1 MiB text blob, not
a plan. No contract can say who works on a step. Nothing turns a roadmap into tasks.
No code produces a `TaskEnvelope` or registers an initiative. And the boundary that
spawns a model carries no instructions at all.

**Observabilidad: 3/10.** The "super Lego" property is earned: no observability
vendor in the dependency graph, `TelemetryEvent` branded so the one translator
cannot receive an ungated value, the projection pure and deterministic. As design
that is 8/10. As a working instrument it is near zero: no production caller, six of
nine payload attributes read keys the emitter does not write at the level read,
every span is `AGENT`, and `correlationId`/`causationId` are dropped, so the output
is a flat list that cannot form a trace.

## Findings

**P1 — Nothing tells the model what to do. Class 1.**
Evidence: `kernel/contracts/src/schemas/execution-boundary/index.ts:202-217` —
`ExecutionRequest` is `{taskId, attempt, identity, reattach}`.
`edges/providers/src/contract/index.ts:193-203` — `SessionRequest` carries binary,
config root, workdir, limits, no instructions.
`edges/providers/src/claude/index.ts:81-107` — argv is `-p --output-format
stream-json --model <alias>` plus `--session-id`/`--resume` and, for a reviewer,
`--permission-mode plan --restricted`. No prompt positional.
`edges/providers/src/process/spawn/index.ts:73-79` pipes stdin, and no module under
`edges/providers/src` ever writes or ends it. `edges/providers/src/codex/index.ts:473-487`
states it outright: "P4 sends no thread parameters at all".
`TaskEnvelope.objective` (`task-envelope/index.ts:42`) is read by nothing outside
contract validation. Impact: the assembled path spawns a real CLI that receives an
empty instruction channel; the expected observable is a wall-clock timeout under
`limits.timeoutMs`, not work. Every downstream guarantee is currently proven over a
session that was never asked anything. Minimal fix:
`ExecutionRequest.instructionsDigest` plus `SessionRequest.instructions`, resolved
before spawn; the claude adapter writes it to stdin and ends it, codex sends
`thread/start` params. Phase: this is B1's missing half, not a new packet.

**P2 — A roadmap is a document, not a plan; no contract can express a step or a
team. Class 1.**
Evidence: `kernel/contracts/src/schemas/initiatives/index.ts:102-149` — `RoadmapVersion`
carries `contentDigest`, `parentVersionId`, `expectedHeadDigest`, `kind`,
`restoresVersionId`. Digest only, by law. `kernel/protocol/src/schemas/index.ts:1582-1587`
— the request body is `content: z.string()` bounded to 1 MiB of UTF-8. The console
edits it in a dialog and renders it as a document
(`entrypoints/console/src/views/roadmap-document-view/`, `components/edit-roadmap-dialog/`).
There is no `RoadmapStep`, no `TeamComposition`, no per-step model assignment
anywhere in `kernel/contracts`. The closest thing is `TaskEnvelope.eligibility`
(`task-envelope/index.ts:67-72`): roles, an optional provider list, capability
strings — no counts, no named model per role, and it is per task, not per step.
Impact: the owner's core unit ("this step uses model X as DT, three implementers,
one auditor") cannot be written down, so it cannot be versioned, diffed or enforced.
Minimal fix: a `schemas/roadmap-plan/` band declaring `RoadmapStep` and
`TeamComposition`, referenced by digest from the roadmap version. Phase: new, before B5.

**P3 — Nothing produces a task, and nothing produces an initiative. Class 1.**
Evidence: `TaskEnvelope` is only ever `.safeParse`d —
`entrypoints/daemon/src/daemon-child/index.ts:255,468` and
`domains/runtime/src/conflict-graph/index.ts:277,380`. It arrives as a hand-written
JSON config; `acp submission` (`entrypoints/cli/src/cli/index.ts:245-249`) re-elects
its route and prints the document back. No `INITIATIVE_REGISTERED` is appended
anywhere in `src`; the only production `appendInitiativeEvent` caller is
`gateway/src/roadmap-write/index.ts:192`, and the roadmap POST refuses unless the
initiative already exists (`gateway/src/routes/index.ts:850`), so the plane's one
write door is unreachable without out-of-band ledger seeding. `API_ROUTES`
(`kernel/protocol/src/routes/index.ts:25-69`) has no initiative or task POST. Minimal
fix: a guarded `POST /api/v1/initiatives` through the existing write registrar, then a
decomposer. Phase: new, alongside P2.

**P4 — Prompt/response lineage is unrepresentable, and the one digest of it is thrown
away. Class 1 against the owner's model.**
Evidence: the transcript guard denies `promptlog`, `messages`, `completion`,
`rawoutput` as keys (`credential-guards/index.ts:94-110`); the payload budget is
8 KB (`control-plane-event/index.ts:18`); the artifact store's only production caller
is roadmap content (`roadmap-write/index.ts:139`). `ExecutionEvent.text.delta` (≤16
KB, `execution-boundary/index.ts:140-144`) is consumed by nothing: the whole trail is
folded into `trailSha256` on a marker file
(`domains/runtime/src/execution-effects/index.ts:429`) and dropped — only
`kind === "usage"` is read (`:409`). One can prove *that* a run happened on a route,
never what was asked or answered. Reconciliation: the laws ban prompts **in the
ledger, in SSE and in the DOM**; they do not ban a content-addressed vault referenced
by digest. See the design below. Phase: with P1.

**P5 — The telemetry projection reads keys production does not write. Class 2.**
Evidence: `domains/observation/src/telemetry/index.ts:189-199` promotes flat payload
keys `provider`, `model`, `transportKind`, `capabilityPolicyVersion`, `verdict`,
`resolvedModel`. Production nests the first four under `payload.route`
(`domains/runtime/src/core/events/index.ts:130-141`), never emits `verdict` on
`AUDIT_COMPLETED` (`:152` returns `{submissionDigest, beat, planIndex}`), and never
puts `resolvedModel` in any payload. Only `initiativeId`, `accountId` and `tokens`
survive on a real chain (`domains/runtime/src/usage/index.ts:182`). `tokens` is total
spend but is mapped to `gen_ai.usage.output_tokens` (`:197`). `ERROR_TYPES` (`:164-170`)
names `TASK_QUARANTINED` and `COMMIT_REFUSED`, neither of which is in
`CONTROL_PLANE_EVENT_TYPES`, while `TASK_CANCELLED` and `WRITE_SET_VIOLATION_DETECTED`
are treated as `OK`. Every span kind is `AGENT` (`:161`); there is no trace, span or
parent id. The 16 green tests use flat synthetic payloads, so they certify the mapper
against fixtures, not against the emitter. Sibling defect: `computeBaseline` requires
`payload.tokensUsed` on `ATOMIC_STEP_COMPLETED` and throws `MISSING_TOKENS_USED`
otherwise (`domains/observation/src/baseline/index.ts:263-266`) — a key the producer
never writes, so the baseline cannot run over a production chain. Phase: before B5,
or B5 exports empty spans.

**P6 — No OTel/OpenInference/Phoenix code or dependency. Class 4 (planned, correctly
absent).** No `@opentelemetry/*`, `openinference` or `phoenix` package appears in any
`package.json` under `packages/`; the only occurrences are doc comments and the
attribute key at `telemetry/index.ts:157`. The V2 draft assigns this to packet B5 and
C1 marks the exporter packages as an owner dependency ask. The absence is the roadmap
holding, not a gap.

## Gap table

| Owner-model item | State | Evidence |
| --- | --- | --- |
| Initiative entity + lifecycle | PARTIAL | contract, ledger, projection, console exist; no production writer (P3) |
| Versioned roadmap, immutable, rollback, OCC | EXISTS | `initiatives/index.ts:102-149`; `ledger/src/roadmap-version`; `roadmap-write/index.ts` |
| Roadmap as a structured plan (steps) | ABSENT | roadmap is `content: string` (P2) |
| Per-step team composition (DT / N implementers / researcher / auditor) | ABSENT | no such contract (P2) |
| Tasks with dependencies | ABSENT | `conflict-graph` is pairwise write-set compatibility only (`conflict-graph/index.ts:38-47`) |
| Per-task write-set / read-set / authority | EXISTS | `task-envelope/index.ts:47-53`; `runtime/src/enforcement` |
| Roadmap → task decomposition | ABSENT | no producer (P3) |
| Prompt sent to each model | ABSENT | no channel (P1) |
| Prompt/response audit trail | ABSENT | unrepresentable (P4) |
| Which model/account served a run | PARTIAL | route on the INTENT event (`core/events/index.ts:130-141`); `resolvedModel` never reaches the ledger |
| Coordinator/DT execution | ABSENT | `coordinator` appears only as a vocabulary word (`worker-identity/index.ts:19`) |
| Operator approval gate | PARTIAL | `WAITING_OWNER` exists as a settlement state (`lifecycle/index.ts:29`); no transition into it, no durable signal, no route |
| Cost / spend ledger | PARTIAL | `TOKEN_USAGE_RECORDED` + rollups; no money, no subscription-vs-API split |
| Neutral OTel/OpenInference contract | PARTIAL | shape exists, unwired and mis-keyed (P5) |
| Phoenix optional, non-blocking | ABSENT | planned B5 (P6) |
| Observability replaceable ("super Lego") | EXISTS | no vendor in the graph; branded gate; one pure translator (`telemetry/langfuse/index.ts:14-25`) |

## Prompt-traceability design proposal

1. New band `kernel/contracts/src/schemas/prompt-record/`: `PromptRecord` =
   `{contractVersion, promptRecordId, taskId, attempt, stepIndex, identity, route,
   promptDigest, promptBytes, responseDigest|null, responseBytes, redactionVerdict:
   "CLEAN"|"REDACTED", createdAt}`, with `attachGuards(…, {transcript: true})`.
2. The names work as-is: `promptdigest` and `responsedigest` normalize outside both
   `DENIED_TRANSCRIPT_KEYS` and every credential stem, so the vault needs no guard
   widening. That is the whole reason this is representable.
3. Bytes go to the existing content-addressed store under a new `prompts/` root
   sibling to `artifacts/` (`ledger/src/artifact-store`: 0700/0600, atomic rename,
   verify-never-trust, no delete). Add a `maxBytes` argument rather than a second
   store — today the bound is hardwired to `ROADMAP_CONTENT_MAX_BYTES` (`:144`).
4. Secret-scan with `findCredentialViolations` before publish. A hit publishes
   redacted bytes and records `redactionVerdict: "REDACTED"` with paths-only
   diagnostics. Never a silent refusal, never a quoted match.
5. Two `ControlPlaneEventType`s: `PROMPT_RECORDED`, `RESPONSE_RECORDED` — same-state
   passthroughs exactly like `TOOL_CALL_RECORDED`. Payload is scalars only:
   `{promptDigest, promptBytes, responseDigest, responseBytes, stepIndex, accountId,
   model, transportKind, redactionVerdict}`.
6. Producer `domains/runtime/src/prompt-record/`, built field by field, mirroring
   `runtime/src/tool-receipt`'s producer-owned grammar; called on the INTENT beat and
   at stream end under the same durable key, so a replay appends once.
7. Presupposes P1's instruction channel; the record is that channel's receipt.
8. SSE and DOM are unchanged: `timelineItem` projects digests and counts, so
   restriction 2 ("ningún payload, transcript, path absoluto o argumento de tool al
   browser/SSE/DOM") holds by construction.
9. Read path: `GET /api/v1/tasks/:taskId/prompts/:digest` registered through a new
   `registerGuardedGet`, sibling of `registerGetAndPost`
   (`gateway/src/routes/index.ts:292-320`), reusing `loadBearerGuard`. Reads stay free
   everywhere else; the vault is the one read that is not, because bytes are the one
   thing a credential scan can only probably clean.
10. Retention is an operator act against the filesystem, as artifact removal already
    is — the store exposes no delete, by law.

## Observability minimal design

1. One port in the domain: `TelemetryExporterPort` in
   `domains/observation/src/telemetry/port/` — `export(batch: TelemetryBatch): void`,
   `flush(timeoutMs): Promise<void>`. The domain declares it and imports no adapter.
2. Adapters live in a new edge `packages/edges/telemetry/`: one OTLP/HTTP exporter
   over `fetch`. Phoenix is that same adapter pointed at a different endpoint, so
   "Phoenix" is a config value, not a package. `noopExporter` is the default and stays
   in the domain.
3. The daemon statically imports nothing. One composition-root branch reads an
   optional `telemetry: {endpoint, headersRef}` and only then `await import`s the
   edge. Absent config means the import never evaluates — the same removal proof the
   Langfuse translator already models.
4. Non-blocking: bounded ring buffer with drop-oldest, one request in flight, per
   request timeout, backoff, and a `droppedCount`. An export failure logs at `warn`
   through the daemon logger and never touches a walk's outcome.
5. Health stays independent: `/api/v1/health` must not consult the exporter. Report
   `{configured, dropped}` on `/api/v1/status` instead.
6. `daemon/src/log` is already a fit OTel log source — structured JSON lines, path
   scrubbing (`log/index.ts:53-57`), three caps, rotation. It needs `traceId`/`spanId`
   so logs and spans join. Note in passing that `renderLine` (`:75`) truncates by
   UTF-16 code units against a constant named `LOG_MAX_LINE_BYTES`.
7. Fix P5 first. Then: `traceId = correlationId`, `spanId = eventId`,
   `parentSpanId = causationId`; `TOOL_CALL_RECORDED` → span kind `TOOL` with
   `tool.name`; `RUN_STARTED`/`PROMPT_RECORDED` → `LLM` with `gen_ai.request.model`;
   lifecycle beats stay `AGENT`; `tokens` → `gen_ai.usage.total_tokens`.
8. OpenInference's `input.value`/`output.value` are deliberately **not** emitted.
   Emit `acp.prompt.digest` and `acp.response.digest` instead and let the operator
   resolve them through the guarded vault route. The digest is the join key; the
   vendor never holds the text. That is the honest reconciliation of the convention
   with the no-transcript law.

## New features

1. `RoadmapStep` / `TeamComposition` — `@acp/contracts` `schemas/roadmap-plan/`; event `ROADMAP_STEP_DECLARED`.
2. Instruction channel — `@acp/contracts` `ExecutionRequest.instructionsDigest`; `@acp/providers` `SessionRequest.instructions`.
3. `PromptRecord` lineage — `@acp/contracts` + `@acp/runtime/prompt-record`; events `PROMPT_RECORDED`, `RESPONSE_RECORDED`.
4. Initiative write door — `@acp/gateway` `initiative-write`; `POST /api/v1/initiatives`, `InitiativeRegisterRequest`.
5. Task-graph decomposer — `@acp/runtime/decompose`; `TaskGraph`, `TaskDependency`; event `TASK_GRAPH_PLANNED`.
6. Coordinator as a durable workflow — `@acp/runtime/coordination`; events `DT_PLAN_REQUESTED`, `DT_PLAN_RECORDED`.
7. Owner approval gate — `@acp/runtime/approval`; events `OWNER_APPROVAL_REQUESTED`, `OWNER_APPROVAL_GRANTED`, resumed by the durable signal `@acp/durability` already exposes.
8. `TelemetryExporterPort` + `packages/edges/telemetry` — OTLP adapter; Phoenix as an endpoint.
9. Cost ledger — `@acp/observation/cost`; `CostRollup`; event `COST_RECORDED` with `{accountId, transportKind, tokens, currencyMinorUnits|null}`.
10. Account pool and cross-walk reservations — `@acp/accounts/pool`; events `ACCOUNT_RESERVED`, `ACCOUNT_RELEASED`.
11. Policy-as-data per step — `@acp/runtime/policy`; `StepRoutingPolicy` keyed by `roadmapStepId`, so the model per role per step is a document version, not code.
12. Replay / what-if — `@acp/observation/replay`; `ReplayVerdict` re-elects routes over a past chain under a new policy version and reports the diff.

## Verified claims that hold

Every claim in the brief holds: `ExecutionRequest` is `{taskId, attempt, identity,
reattach}` with no prompt field; `SessionRequest` carries no instructions; the claude
argv is exactly as stated; `emitTelemetry` and `toLangfuseTrace` have only tests and
the barrel as callers; no OTel, OpenInference or Phoenix code or dependency exists at
HEAD; digest continuity and the no-prompt rule hold structurally, via the guards plus
the 8 KB payload budget, not by convention; and `conflict-graph` is pairwise write-set
compatibility, never dependency ordering.

One correction to an open question in the brief: `publishArtifact` **does** have
exactly one production caller, `recordRoadmapVersion`
(`gateway/src/roadmap-write/index.ts:139`), and one production reader, `roadmapContent`
(`gateway/src/initiatives/index.ts:266`). The vault design above reuses that store
rather than inventing a second one.
