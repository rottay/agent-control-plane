# acp-parity — audit report (snapshot 4569478)

Snapshot only, tree clean at HEAD. Re-ran `vitest run --project gateway .../test/parity/index.test.ts` → **34 passed**.

## Score + justification

**8 / 10.**

Convergence here is mostly *structural*, not disciplinary. The tool-call door is one operation (`runToolCall`, `domains/runtime/src/tool-call/index.ts:634`) composed by both doors from one request schema (`ToolCallExecuteRequest.safeParse` at `gateway/src/tool-calls/index.ts:219` and `cli/src/tool-call/index.ts:282`), and their answers are asserted **byte-identical with no field excluded** (`gateway/test/parity/index.test.ts:1008`), on refusals too (`:1019`), with a negative control proving non-vacuity (`:1027-1039`). Query parsing is not duplicated: the CLI hands raw argv strings to the *same* frozen DTOs the route uses (`cli/src/cli/index.ts:494-507, 549, 580, 619` vs `gateway/src/routes/index.ts:377, 411, 456`). The error vocabulary is one enum (`protocol/src/schemas/index.ts:205-257`) and the gateway's status map is **total** (`Record<ApiErrorCode, number>`, `gateway/src/errors/index.ts:44`), so a new code cannot ship without a status.

Two points go to what discipline still holds, both already drifted once: the CLI's exit-code switch (F2) and the missing verb↔route gate (F3). The UI leg of the four-way equality is a tautology (F1).

## Findings

### F1 — The "UI rows" leg of the parity equality is `f(x) == f(x)`, and `uiRowModel` has no caller in the console

**Class 2 (improvement).**

**Evidence.** `uiRowModel` is `return canonicalRows(route, response)` (`console/src/api/client/index.ts:250-252`). `canonicalRows` is `return canonicalize(response)` (`protocol/src/parity/index.ts:430-435`). The test computes `fromServer = canonicalRows(route, body)` and `fromUi = uiRowModel(route, body)` from the *same* `body`, then asserts `expect(fromUi).toEqual(fromServer)` (`gateway/test/parity/index.test.ts:322-329`) — one pure function applied twice to one value. It cannot fail. Grepping `console/src` for `uiRowModel` returns exactly one hit, its own definition: no view or component consumes it.

The file condemns this pattern in the neighbouring assertion — "Comparing `cliRowModel(detail)` to `canonicalRows(detail)` — as this test once did — only showed that one function called another with the same argument" (`:377-380`). The CLI leg was repaired by building independently from the ledger (`cliResponses`, `:246-274`). The UI leg was not.

**Impact.** The stated equality is `ledger == server == CLI == UI` (`protocol/src/parity/index.ts:13`). Three legs are proven; the fourth is decorative. Bounded, though: every console response is re-parsed against a frozen `z.strictObject` (68 of them, **zero** `z.object`) inside `fetchAndParse` (`console/src/api/client/index.ts:230-238`), which rejects a dropped *or* added field as `contract-mismatch`. The console is guarded — by schema validation, not by parity.

**Minimal fix / phase.** Now, one file: project `uiRowModel` from what a view actually renders, or drop the UI leg and record that the console's guarantee is strict-schema validation. Do not leave a test name claiming a comparison the assertion does not make.

### F2 — `WRITE_REFUSED` reaches the CLI through a `default:` arm and collapses onto `EXIT_USAGE`

**Class 2 (improvement).**

**Evidence.** The CLI door raises `WRITE_REFUSED` at three reachable sites — attempt not yet begun (`cli/src/tool-call/index.ts:312-317`), cause not in the ledger (`:328-332`), cause belongs to another task (`:335-339`). The exit-code mapper switches on `error.code` with cases for `NOT_FOUND`, `LEDGER_UNAVAILABLE`, `CONTRACT_VERSION_MISMATCH`, `INTERNAL` and `CLAIM_HELD`, then `default: return failure(EXIT_USAGE, …)` (`cli/src/cli/index.ts:384-400`). `WRITE_REFUSED` has no case. `EXIT_USAGE` is `2` (`contracts/src/schemas/exit-codes/index.ts:25`). The gateway answers the identical refusal with **409** (`gateway/src/errors/index.ts:49`).

The hole is on record as having fired once already: `EXIT_CLAIM_HELD`'s docblock says "Without it a lost race falls to `EXIT_USAGE`… would read 'you asked wrongly' and retry, which is the single response that must not follow" (`cli/src/cli/index.ts:99-109`). That was fixed by hand, not by the type system, and the same shape is still open for `WRITE_REFUSED`.

**Impact.** A script branching on exit status cannot separate "your document is malformed" from "that attempt has not begun" — the exact distinction `WRITE_REFUSED` exists to preserve (`protocol/src/schemas/index.ts:210-215`). `--format json` callers are unaffected; the envelope still carries `error.code`.

**Minimal fix.** Add a `WRITE_REFUSED` case, then delete `default:` so the switch is exhaustive over `ApiErrorCode` and a future code fails typecheck at the CLI the way `STATUS_BY_CODE` already makes it fail at the gateway.

**Phase.** Now.

### F3 — Nothing relates CLI verbs to API routes; the hand-maintained copies have drifted

**Class 2 (improvement).**

**Evidence.** `COMMANDS` (`cli/src/cli/index.ts:191-266`) is consumed only by the usage renderer (`:269-276`) and the dispatcher (`:1075`). Grepping the whole CLI package for `API_ROUTES` returns **nothing** — it never imports the route table. `bindingCoversAllRoutes()` (`protocol/src/parity/index.ts:438-442`, asserted at `gateway/test/parity/index.test.ts:295-298`) proves route↔*binding*, never route↔*verb*. Drift is already visible wherever a human maintains the copy: the README's command table lists 8 verbs (`cli/README.md:31-40`), omitting `submission`, `tool-calls` and `tool-call`; the binding table's header still says "twelve frozen routes" (`protocol/src/parity/index.ts:84`) against an actual 19.

**Impact.** A 20th route can ship with a schema, a binding, a console fetcher and no CLI verb, every gate green. That is how the present nine-route gap arose. Answering the brief directly: **a new API route added without a CLI verb is caught by nothing.**

**Minimal fix.** A frozen `CLI_VERB_BY_ROUTE: Record<ApiRouteName, string | null>` where `null` carries a `because` string, asserted total over `API_ROUTES` — the shape `PARITY_BINDINGS` already proves works.

**Phase.** Next packet.

### F4 — Eight routes are bound but have exactly one door

**Class 3 (preference).**

**Evidence.** Computed over the snapshot: 19 routes, 19 bindings, and eight bound routes never reach an independent-implementation comparison — the six `initiative*` routes plus `accounts` and `accountActions`. There is no CLI implementation to compare, because there is no verb. Conversely `submission` (`cli/src/cli/index.ts:244-249`) is CLI-only with no route, and neither `health` nor `taskToolCalls` is consumed anywhere in the console.

**Impact.** Low today. Those eight are still covered field-by-field by the protocol-level check that binding fields equal schema fields for every route, with a positive control naming five bogus fields it once caught (`protocol/test/parity/index.test.ts:161-172`). What is absent is a second implementation that *could* disagree — an inventory asymmetry, not undetected mapper drift.

**Minimal fix / phase.** None required; record the asymmetry in F3's table.

### F5 — Cancellation, reattach, signals and timers are absent from all three doors

**Class 4 (planned and correctly absent).**

**Evidence.** `settleCancellation` is defined at `domains/runtime/src/cancellation/index.ts:169` and reached only from `edges/durability/src/drivers/restate-driver/index.ts:841`. `attachAdvance` lives in `edges/durability/src/submit/index.ts` and is reached from `entrypoints/daemon/src/mode-restate/index.ts:301` and `edges/durability/src/drivers/restate-child/index.ts:412`. Grepping the three door packages (`cli/src`, `gateway/src`, `console/src`) for `settleCancellation|attachAdvance|cancelAdvance` returns **zero hits**. No test-only or drill-only path leaks them into a door.

**Impact.** None at HEAD, and the absence is symmetric: no door can diverge on an operation neither exposes. The risk is future — whichever door gets cancellation first defines its refusal vocabulary, and F3's missing gate is what would let the second lag.

**Phase.** Whenever lifecycle is exposed; land F3 first.

## Door inventory table

| Route (method) | CLI verb | Console consumer | Independently compared |
| --- | --- | --- | --- |
| `health` GET | — | — | UI leg only, tautological |
| `overview` GET | `overview` | `overview-view` | yes |
| `tasks` GET | `tasks` | `tasks-list-view` | yes |
| `taskById` GET | `task <id>` | `task-detail-view` | yes |
| `workers` GET | `workers` | `workers-list-view` | yes |
| `workerByIdentity` GET | `worker <id>` | `worker-detail-view` | yes |
| `events` GET | `events` | `events-view` | yes |
| `status` GET | `status` | `status-view` | yes |
| `integrity` GET | `integrity` | `integrity-view` | yes |
| `initiatives` GET | — | `portfolio-view` | no |
| `initiativeById` GET | — | `workspace-view` | no |
| `initiativeRoadmap` GET/**POST** | — | `roadmap-document-view`, `edit-roadmap-dialog` | no |
| `initiativeRoadmapContent` GET | — | `roadmap-document-view` | no |
| `initiativeEvents` GET | — | `timeline-`, `graph-`, `logs-view` | no |
| `initiativeAgents` GET | — | `agents-view` | no |
| `accounts` GET | — | `accounts-view` | no |
| `accountActions` GET/**POST** | — | `accounts-view` | no |
| `eventStream` GET (SSE) | — | `api/stream` | yes, frame vs CLI page (`:526-568`) |
| `taskToolCalls` GET/**POST** | `tool-calls`, `tool-call` | — | yes (`:731-762`, `:998-1039`) |
| — | `submission` | — | CLI-only, no route |

The three POSTs are the write table (`protocol/src/routes/index.ts:121-125`). Answering the brief: **DRAIN an account** and **WRITE a roadmap version** are API/console only. **Execute a tool call** is the one operation with two doors, and the only one where "same operation, two doors" is proven rather than intended.

## Verified claims that hold

- **One operation, not two implementations.** Both doors call `runToolCall(ledger, scope, claims, execution)` (`gateway/src/tool-calls/index.ts:370`, `cli/src/tool-call/index.ts:364`) after parsing one schema.
- **Refusals agree, with field paths.** Same code *and* same `at` at both doors across a parameterised set (`:1119-1132`), including `RESULT_UNSAFE` (`:1135-1147`) and malformed tool documents, where the API answers 503 and the CLI refuses without spawning (`:1150-1198`).
- **One execution, one receipt, across doors.** A coordinate spent at the API replays at the CLI with `replayed: true`, identical `eventId`/`transitionId`/`sequence`, one row, no second child — and the mirror image (`:1043-1086`).
- **Cross-process arbitration is real.** `tool_claim` is a `BEGIN IMMEDIATE` compare-and-set in a sibling SQLite file (`persistence/ledger/src/tool-claim-store/index.ts:186-191`, WAL + `busy_timeout` at `:422-423`); both doors lose it identically with `CLAIM_HELD` and leak neither holder nor path (`:1340-1381`).
- **The CLI does not migrate your ledger.** It probes read-only and closes before opening writable (`cli/src/tool-call/index.ts:60-79`), the TOCTOU window named rather than hidden.
- **The binding table is checked against the schemas**, with a positive control (`protocol/test/parity/index.test.ts:161-172`).

## Open questions

1. **Is the machine-local door model meant to survive a remote UI?** `toolClaimStorePath` is `dirname(ledgerPath)/tool-claims.sqlite`, a local path, and every CLI verb takes `--database <path>`. Two doors on two machines share no arbiter, and SQLite locking over a network mount would not supply one. ADR 0026 says expiry-based detection keeps arbitration "from becoming machine-local" (`docs/architecture/0026-…:36`), but the store's *location* still is.
2. **Should the console reach `taskToolCalls`?** It is the plane's only two-door operation and the only route the console ignores entirely. If the console gains it, the three-way equality becomes non-trivial there and F1 stops being cosmetic.
3. **Does `submission` belong behind a route?** It reads operator documents rather than the ledger, so its absence from the API is plausibly deliberate — but undeclared either way.
