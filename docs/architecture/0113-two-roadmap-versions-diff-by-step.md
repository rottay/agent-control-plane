# ADR 0113 — Two roadmap versions diff by step, read by number

- Status: accepted (P-26, cut C, recorded 2026-09-24).
- Supersedes: none.
- Superseded-by: none.

## Context

Requirement A10 asks for a semantic diff of changes, roles and dependencies between
roadmap versions, and for a restored version to be a new, traceable revision rather
than a rewrite. The second half already holds: cut A (ADR 0110) records a rollback as a
new version with `restoresVersionId`, and cut B (ADR 0111) makes a rollback re-declare
the restored steps. What was missing is the diff, and a way to read a version's steps
at all.

Four facts shaped the cut:

- Cut B keeps `stepId` stable across versions "for cut C", and records per step a
  title, three digests, a manifest position and a dependency rank. The step texts
  live in a private `PLAN_DOCUMENT`; the read model holds the title and the digests.
- The initiative family already reads a version by **number**: the content read takes
  `?version=` and resolves it inside the initiative's own history, never a global
  identifier (`gateway/src/initiatives` `roadmapContent`).
- Planning §6 resolves a step's roles `STEP` > `INITIATIVE` > `GLOBAL`. In this build
  the initiative stream folds no routing assignment
  (`nextRoutingAssignmentFromInitiative` returns `null`), the registry publishes
  GLOBAL assignments only, and every step row's `routingAssignmentVersion` is null.
  The STEP scope has no producer until P-28.
- Tests §8.1 guards reads of model output, prompts, tool arguments and tool results.
  A step's title is the one text the stream persists, of decision 76's class
  (decision 175), and the initiative's own title and objective already cross a public
  GET.

## Decision

### One — two reads, one selector class: the version number (decision 185; Fable C1, C2, C7)

- `GET /api/v1/initiatives/:initiativeId/roadmap/steps?version=`
  (`initiativeRoadmapSteps`) and `GET /api/v1/initiatives/:initiativeId/roadmap/diff?from=&to=`
  (`initiativeRoadmapDiff`). Both sit beside `content`, at the same depth and all
  static segments, so there is no parameter-versus-static sibling question.
- `RoadmapStepsQuery` is `RoadmapContentQuery`'s validator field for field, and
  `RoadmapDiffQuery` is two fields of it, both required, strict: a positive decimal
  integer up to 1 000 000. The three queries now share one declaration,
  `RoadmapVersionNumber`. A number is resolved inside the initiative, so a version of
  another initiative is unrepresentable.
- `initiativeRoadmapStepsPath(initiativeId)` and `initiativeRoadmapDiffPath(initiativeId)`
  return the **path only**, validated then encoded, exactly as
  `initiativeRoadmapContentPath` does. The query is the caller's, built with
  `URLSearchParams`.
- Both are reads through `registerGet`: `API_ALLOWED_METHODS`, `API_WRITE_ROUTES` (6)
  and `API_PRIVATE_READ_ROUTES` (1) do not move. Both are API_ONLY in `SURFACE_MAP`
  under the initiative plane's standing reason. Both have a parity binding row whose
  every field is `LEDGER` or `CONTRACT_VERSION`.
- `API_CONTRACT_VERSION` 0.20.0 → 0.21.0, minor: the route surface moves. No error
  word moves (`API_ERROR_CODES` stays 16). `CONTRACT_VERSION` and `MIGRATIONS` do not
  move: a read adds no recorded shape.

### Two — the diff, pure over rows (decision 186; Fable C4, C5)

`diffRoadmapVersions` is a new ledger concept, `roadmap-diff`, in the
`roadmap-steps` mould (`index.ts` and a `types/index.ts` leaf). It is pure: it
receives the two versions, their step and dependency rows and the version `to`
restores, and adds **no ledger read** — the caller composes `listRoadmapVersions`,
`listRoadmapSteps` and `listRoadmapStepDependencies`.

- `added` and `removed` are stepIds. `changed[]` is `{ stepId, fields[] }`, the names
  of the fields that differ among `stepIndex`, `title`, `objectiveSha256`,
  `acceptanceSha256`, `expectedWriteSetSha256` and `dependencyRank`, in that order.
  The digests are compared and never carried.
- `stepIndex` is **manifest position**, not topological order. A pure reorder reports
  a change, because the position is declared.
- `dependencyRank` is **derived** from the dependency pairs, so it reports twice with
  `dependencies`. It is kept because P-27's READY predicate consumes the rank.
- `dependencies.added` and `dependencies.removed` are `(stepId, dependsOnStepId)`
  pairs, order-free, so a forward reference needs no special case.
- `contentChanged` is `from.contentDigest !== to.contentDigest`. **A text diff of the
  roadmap document is not in this cut.** It is the client's, from two
  `…/roadmap/content?version=` reads, and G-UI's. "Cambios" is not overclaimed.
- `from` and `to` are echoed as `{ version, roadmapVersionId, kind, stepCount }`,
  `stepCount` with `RoadmapVersionDto`'s meaning: **null is pre-cohort, "declared
  nothing"; 0 is "declared none".** Both diff as no steps, and the body tells them
  apart. The echo bounds it by `ROADMAP_STEPS_MAX` where the Dto is unbounded; the
  door refuses a version of more steps, so no recorded row exceeds the bound.
- `restores` is `{ version, roadmapVersionId }` of the version a rollback `to`
  restores, or null; `from == to` is the empty diff with `contentChanged` false and
  `restores` null.
- Everything is sorted by stepId, then by pair, in code-unit order, never by locale.

**Refusal placement.** The gateway checks the initiative first (404 `NOT_FOUND`), then
resolves `version`, `from`, `to` and the restored version inside one
`listRoadmapVersions(initiativeId)` (an unknown number is 404 `NOT_FOUND` with the
content read's message); a malformed selector is 400 at the field through
`parseQuery`. The pure function refuses only rows that resolution cannot produce —
`VERSIONS_OF_TWO_INITIATIVES`, `ROWS_OF_ANOTHER_VERSION` (including a `restored`
that is not the version `to` names) and `STEP_ASSIGNMENT_PRESENT` — and the route
answers any of them as 500 `INTERNAL` with the closed word in `detail` and no byte of
the rows.

### Three — the steps read is not a §8.1 read, and "no digests" is a choice (decision 187; Fable C5, C6, C8)

- The steps body echoes the version and lists `{ stepId, stepIndex, title,
  dependencyRank, state, dependsOn }` in index order. `title` is stream text of the
  decision-76 class (decision 175); the initiative's own title and objective already
  cross public GETs (`InitiativeSummary`, §8.1's out-of-scope precedent). The route
  reads the read model, never the plane. So it is **not** a §8.1 read: no inventory
  row, no bearer, `registerGet` like every initiative read.
- **"No digests" is a choice, not a law of §8.1.** `RoadmapVersionDto` carries
  `stepManifestSha256`; this listing carries no digest and no reference. The precedent
  is §8.1's `taskEffects` row, "ni digest, ni referencia, ni bytes" on a listing.
- Every array is bounded: steps and stepId lists by `ROADMAP_STEPS_MAX`, `dependsOn` by
  `ROADMAP_STEP_DEPENDS_ON_MAX`, and the diff's pair lists by their product, the most
  pairs a version can declare.
- **L-P26C-1** (fence): the declarations of `RoadmapStepsResponse` and
  `RoadmapDiffResponse`, and every top-level `const`, `let` or `var` of the schemas
  file they name, followed transitively, comments stripped and identifier escapes
  (`\u0053`, `\u{53}`) decoded, contain no `Sha256Hex` and no other hex-digest
  grammar (zod's `z.hash(` or `z.hex(`; a quantifier starting at 64 — `{64}`,
  `{64,}`, `{64,64}`; a `.length(64)`; a `.min(64)` and a `.max(64)` in one
  declaration; 64 spelled decimal, hex, octal or binary), no key whose name ends, in
  any case, in `sha256`, `reference`, `referenceId`, `digest` or `hash`, and no key
  named `objective`, `acceptance`, `expectedWriteSet` or `content` — keys read bare,
  quoted or shorthand (`{ objectiveSha256, … }`) — so no digest, no manifest
  reference and no text but the title. A declaration's span runs from its head to
  the `;` that closes it at bracket depth zero, strings, templates and regex
  literals skipped, so a column-0 keyword inside it does not cut it short; a read
  span that does not close is refused, not read short. The diff carries the digest
  field names as values of `changed[].fields`, never as keys. Limit, stated:
  text-level over one file; an imported schema, a function-built one, one bound
  other than to a single name at the top level (a destructuring, a `class`, a
  namespace), a computed or assembled key, a text field under another name, and a
  digest under a name the suffixes miss whose value is checked by other means (a
  `.refine`, an imported validator, a hex class without a quantifier starting at 64,
  a 64 held in a named constant or an expression) are not seen. The strict parse (a
  planted `objectiveSha256` or `contentDigest` key fails it) is the behaviour, with
  the gateway's sentinel sweeps over the bodies its suite builds: no 64-hex value in
  those fixtures. That is a property of the fixtures, not of every body — a legal
  64-hex `stepId` is an identifier, not a digest, and crosses both reads with 200.
  Decision 184's class — a digest under another name, zod's own hash grammar — is
  matched rather than left as a limit, and so is the shorthand key (v1.1, after
  Fable C-C1 and the verifier's unstated probe); so are a `let` or `var` sub-schema,
  a span cut by a column-0 keyword, an escaped key and the other spellings of a 64
  bound (v2.1, after the verifier's six unstated evasions and Fable C-V2-3).
  `PATH_SCOPED_LAWS` 166 → 167.

### Four — `roles` is a named absence, derived from the rows (decision 188; Fable C3)

- **Definition:** `STEP_ASSIGNMENTS_UNPRODUCED` says *the STEP scope has no producer in
  this build.* Planning §6's precedence makes every step's effective roles the GLOBAL
  assignment, which is a property of the plane rather than of a version, so a version
  diff has nothing to attribute. The word does **not** say the steps have no roles.
- **Derived, not hardcoded.** The word is answered only when every step row of both
  sides has `routingAssignmentVersion === null`; any non-null value is refused as
  `STEP_ASSIGNMENT_PRESENT`, since no producer can have written it. The parity binding
  for `roles` is `LEDGER`: two clients folding the same rows agree, and a producer
  changes the answer by changing the rows. The DTO fixes the one literal, so a producer
  of STEP assignments is also an API change, which is where P-28 belongs.
- **The owner's row.** The P-28 row of the packet inventory records that A10's `roles`
  is answered by this named absence until P-28 produces STEP-scope assignments, and
  that P-28 replaces it with the per-step diff of assignments.

## Evidence

The ledger suite drives the pure function over hand-built rows; the gateway suite
drives both routes through `buildServer` and the real write route, over a real ledger
and a real private plane:

| Row | Scenario | Assertion |
| --- | --- | --- |
| D1 | v1 = A, B(A), C(A); v2 = A, B(A) re-objectived, D(B) | added D, removed C, changed B `["objectiveSha256"]`, dependencies +(D,B) −(C,A), `roles` the named absence, `contentChanged` true, both sides echoed; the sentinel sweep finds no private text, no 64-hex value and no digest or reference key |
| D1b | v4 lists v2's steps with D before B (a forward reference) | changed B and D `["stepIndex"]` only; no pair moves |
| D2 | v3 = ROLLBACK to v1 | v2→v3 is D1's inverse with `restores` v1 by number and id; v1→v3 is empty with `contentChanged` false |
| D3 | `from == to`, an edit and a rollback | empty, 200, `contentChanged` false, `restores` null |
| D4 | unknown `from`, `to`, initiative; malformed selectors | 404 `NOT_FOUND` with the existing messages; `from=abc…`, `to=0`, missing `to` and an extra key are 400 with the field path, the value never echoed |
| D5 | the steps of v1 | three steps in index order, ranks 0/1/1, `dependsOn`, `DECLARED`; titles present, the sentinel sweep clean, no routing column |
| D6a | a stepless 2.10.0 version | echo `stepCount` 0, `steps: []`; the diff lists every step of the next version as added |
| D6b | a pre-cohort version (a history restamped to 2.9.0 and rebuilt, B's mould) | echo `stepCount` null, `steps: []`; the diff tells it from D6a |
| D7 | a planted `routing_assignment_version` on a scratch ledger | every diff that reads the row is 500 `INTERNAL`, `detail` `STEP_ASSIGNMENT_PRESENT`, no row content; a diff that reads neither side still answers |
| D8 | a version at `ROADMAP_STEPS_MAX` steps, chained | one bounded steps body, ranks up to 199 |
| — | census | `API_ROUTES` 24, parity by name and by schema keys, `SURFACE_MAP` total with both rows API_ONLY, the api-reference bijection green; a planted `objectiveSha256` key fails the strict parse |

The pure function's own suite adds the three refusals, the boundary of a single
assignment on one row of either side, code-unit ordering, field order, frozen output
and the pre-cohort echo.

**Bites**, on a disposable copy, each planted and withdrawn alone; the untouched copy
is green (positive control, 8 declarations read):

| Bite | Fence |
| --- | --- |
| `objectiveSha256: Sha256Hex` on a step | red (both clauses) |
| `stepManifestSha256` on the shared echo, reached transitively | red |
| a quoted `"manifestReference"` key on the diff | red |
| `artifactReferenceId` inside `restores` | red |
| a sub-schema declared at the end of the file with a `digestSha256` key, named by the diff | red |
| an `objective` key on a step; a single-quoted `'content'` key on the diff | red |
| `RoadmapDiffResponse` renamed away | red (the root is named missing) |
| the register row removed | red (166 rows, 167 call sites) |
| the key inside a comment; a `Sha256` key on a schema neither read names | green |
| a computed key `["objective" + "Sha256"]`; a `summary` text field | green (limit confirmed) |
| v1.1: `contentDigest: Sha256Hex` on the echo | red (both clauses) |
| v1.1: `contentDigest` with an inline `{64}` hex regex on the echo; a `summary` with the same regex | red (key and grammar; grammar) |
| v1.1: `digest: z.hash("sha256")` on the echo; `checksum: z.hex().length(64)` and `fingerprint: z.string().length(64)` on a step | red |
| v1.1: `ContentHash: z.string()` and `contentDigest: z.string()` on a step | red (the suffix in any case) |
| v1.1: shorthand `objectiveSha256,` bound to a local non-`Sha256Hex` regex const; shorthand `objective,` | red |
| v1.1: `checksum` checked by a `.refine`; a `summary` text field | green (limit confirmed) |
| v1.1 mutants of the fence: shorthand matcher removed, grammar clause disabled, `digest` suffix dropped | each turns its own red bite green |
| v2.1: a top-level `let` sub-schema with `objectiveSha256`, named by the diff; an exported `var` one with `contentDigest` | red |
| v2.1: the keys `objective\u0053ha256` and `content\u{44}igest` | red (decoded) |
| v2.1: a column-0 `function` or `async` inside the diff's object, a digest key after it | red (the span is not cut) |
| v2.1: a regex literal and a string holding `;`, `}`, `)` before a digest key | red (skipped by the span scan) |
| v2.1: `{64,}`, `{64,64}`, `.length(0x40)`, `.length(0o100)`, `.min(64).max(64)`, `.max(0x40)….min(64)` under a neutral key | red (grammar) |
| v2.1: a stray closer in the diff's object | red (the span does not close) |
| v2.1: `.max(64)` alone; `{63}`; a 64 held in a named constant; a `.refine` checksum; an escape that decodes to `:` | green (not a digest grammar; limit confirmed) |
| v2.1 mutants of the fence: heads `const` only, escapes not decoded, span cut at the next column-0 keyword, `{64}` only, 64 decimal only, the `.min`/`.max` pair dropped, an unclosed span read as empty | each turns its own red bite green |

And the behaviour, mutated in the same copy against the two suites: the assignment
check removed (the word written, not measured) fails D7 and the ledger's refusal row;
`restores` never reported fails D2 in both suites; the echo flattening null to 0 fails
D6b; the changed fields carried by value fails D1, D1b, D2, D7 and the ledger's
no-digest row. Restored, both suites are green again.

## Why the alternatives were not chosen

- **A version's uuid in the path** (`/roadmap/:roadmapVersionId/steps`, map v2). Two
  selector classes in one family, a foreign version to refuse by name, and a
  parameter segment that would swallow `/roadmap/content/steps` as a 400.
- **A literal `roles` word written into the function.** True the day it is written and
  silent the day a producer arrives. Derived from the rows, the same test that admits
  it today refuses it then.
- **The digests on the steps listing.** `RoadmapVersionDto` already names the
  manifest's digest; per-step digests on a listing add nothing a reader can use
  without the private manifest, and the effects listing set the precedent.
- **Refusing an unknown version inside the pure function.** It receives rows and
  cannot tell an unknown number from a foreign one; resolution is the route's.

## Consequences

| Pin | Change |
| --- | --- |
| `API_CONTRACT_VERSION` | 0.20.0 → 0.21.0 (eleven literal sites restamped) |
| `API_ROUTES` | 22 → 24 |
| `SURFACE_MAP` | 32 → 34 |
| `PARITY_ROUTES` | +2 |
| ledger barrel | +1 function (+ types) |
| `PATH_SCOPED_LAWS` | 166 → 167 |

Not moving: `CONTRACT_VERSION` 2.10.0, `MIGRATIONS` 25, `CONTRACTS_SCHEMA_EXPORTS` 178,
`API_WRITE_ROUTES` 6, `API_PRIVATE_READ_ROUTES` 1, `API_ERROR_CODES` 16. There is no
migration, so no per-migration restamp. History prose naming 0.20.0 is not restamped.

The protocol spells the step lifecycle for the wire; the gateway mapper's typing holds
the ledger's states inside it. A producer of STEP assignments turns every diff that
reads its rows into a 500 until P-28 replaces `roles`, which is the point: the absence
cannot outlive its cause silently.

## Not in this record

- **Client and G-UI:** a text diff of the document, and a diff view.
- **P-28:** `roles` beyond the named absence, the per-step diff of assignments.
- **CLI:** no verb (ND-C4); both reads are API_ONLY.
- **P-27:** step state transitions, which the steps read will show when they exist.
