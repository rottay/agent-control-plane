# `@acp/protocol`

The browser-safe contract for the Agent Control Plane observation surface.

## Scope

This package describes what a reader of the control plane is allowed to see. It
describes nothing about how that surface is served and implements none of it.

**P1B is not P1 completion**, and this package shipped before the server, the
CLI and the UI existed. All three now consume it and P1 has closed. Completion
is still **no product adoption**: nothing here is connected to, observed from or
used by any real operation, and adoption still happens once, after P8
certification and a separate P9 authorisation.

## The boundary this package exists to hold

| Consumer | May depend on |
| --- | --- |
| `@acp/console` | `@acp/protocol` only |
| `@acp/gateway` | `@acp/protocol`, `@acp/ledger`, `@acp/accounts` and `@acp/observation` |
| `@acp/cli` | `@acp/protocol` and `@acp/ledger` |

The UI never links a database driver, never sees an absolute path and never
holds an event payload. The architecture fence asserts each of those rather
than trusting this table.

## What the contract guarantees

- **Two version lines.** `API_CONTRACT_VERSION` is the shape a reader receives.
  `LEDGER_CONTRACT_VERSION` is the durable meaning of a recorded event. They are
  deliberately different numbers and every response carries both.
- **Strict objects.** Unknown keys are rejected. A projection that grew a field
  server side fails at the boundary instead of leaking it.
- **Redacted database identity.** The absolute ledger path never crosses. A
  digest of the path and the bare file label do.
- **No payload values.** A timeline item carries the event's key names and
  serialized size, never its payload. Payload contents are the one part of an
  event the contract does not fix, so they are the one part a browser must not
  hold.
- **Reads are GET; every write is named.** Every route was a read through
  P8-8C, and `API_ALLOWED_METHODS` still says `["GET"]` because that describes
  the read plane, which did not change. The writes are recorded in a separate
  frozen table, `API_WRITE_ROUTES`, rather than by softening the first one.
  There are **six**, and the table grows visibly rather than a method quietly
  appearing on a route:

  | Write route | Method and path | Added by |
  | --- | --- | --- |
  | `initiativeRoadmap` | `POST /api/v1/initiatives/:initiativeId/roadmap` | P8-8D-pre |
  | `accountActions` | `POST /api/v1/accounts/:accountId/actions` | P8-8G packet 2 |
  | `taskToolCalls` | `POST /api/v1/tasks/:taskId/tool-calls` | V2-B4b stage 3C |
  | `taskLifecycle` | `POST /api/v1/tasks/:taskId/lifecycle` | V2 L3 |
  | `initiatives` | `POST /api/v1/initiatives` | P-14/B |
  | `tasks` | `POST /api/v1/tasks` | P-14/C |

  This table said **two** while there were three: `taskToolCalls` landed at
  V2-B4b stage 3C and the count was not moved with it. Corrected at V2 L3,
  where the fourth arrived — recorded as pre-existing drift rather than as that
  packet's doing, because a table whose whole purpose is to be short is only
  useful while it is also right.

  The fifth moved `API_CONTRACT_VERSION` to `0.16.0`. Its request and response
  are `InitiativeRegistrationRequest` and `InitiativeRegistrationResponse`,
  exported because both doors parse the one and print the other: the POST body
  and `acp initiative --request` are the same bytes. The request names the
  caller's own `initiativeId` and carries the objective inward once; the
  response carries the objective's digest and never the objective.

  The sixth (P-14/C) moved it to `0.17.0`. Its pair is `TaskIntakeRequest` and
  `TaskIntakeResponse`, exported on the same terms: the POST body and
  `acp intake --request` are the same bytes. The request embeds the contract's
  `TaskEnvelope` by import and carries everything that is not the work beside it
  — the client key, the roadmap link, the role, slot and transport the role
  resolves for, and the producer — so nothing outside the envelope enters its
  preimage. The response carries the envelope's digest and reference, the
  revision and the resolution with its vector, and never the envelope.

  A reader asking "what can mutate?" gets one short answer; a reader asking
  "is this route a read?" gets the unchanged one.
- **A roadmap version declares its steps.** P-26 cut B moved `API_CONTRACT_VERSION`
  to `0.20.0`: `RoadmapVersionWriteRequest` gains an optional `steps` — the
  contract's private step manifest, parsed whole on the way in — and
  `RoadmapVersionDto` gains `stepCount` (null for a version recorded before steps
  existed) and `stepManifestSha256`, never the manifest's reference and never a
  step's text. The timeline's type enum widens by derivation to
  `ROADMAP_STEP_DECLARED`, and the write route's transport limit grows by
  `ROADMAP_STEP_MANIFEST_MAX_BYTES`, re-exported beside `ROADMAP_CONTENT_MAX_BYTES`.
  No route, method or error word moves.
- **A version's steps, and the diff between two versions.** P-26 cut C moved
  `API_CONTRACT_VERSION` to `0.21.0` with two reads beside the content read, on
  its selector class — a version number resolved inside the initiative:
  `initiativeRoadmapSteps` (`?version=`, `RoadmapStepsQuery`,
  `RoadmapStepsResponse`) lists one version's steps with their titles, positions,
  ranks, states and dependencies, never a digest or a reference; and
  `initiativeRoadmapDiff` (`?from=&to=`, `RoadmapDiffQuery`, `RoadmapDiffResponse`)
  answers requirement A10's semantic diff by `stepId` — added, removed, changed
  (the fields by name), the dependency pairs, whether the content changed, the
  version a rollback restores, and `roles` as `STEP_ASSIGNMENTS_UNPRODUCED`, a
  named absence derived from the rows until P-28 produces STEP assignments. The
  builders `initiativeRoadmapStepsPath` and `initiativeRoadmapDiffPath` return the
  path only. Both are API_ONLY in `SURFACE_MAP` under the initiative plane's
  standing reason. `API_WRITE_ROUTES` and `API_PRIVATE_READ_ROUTES` do not move,
  and no error word moves.
- **Every read is free but one, and that one is named.** P-15/F added two reads
  and moved `API_CONTRACT_VERSION` to `0.19.0`: `taskEffects`, a plain read of a
  task's effect ids, coordinates and outcome words, and `taskEffectResult`, one
  effect's result read back by reference. The second answers model output, so it
  is the one GET a caller must be authorized for, and it is named in a third
  frozen table, `API_PRIVATE_READ_ROUTES`, rather than by a guard remembered in
  one handler:

  | Private read route | Method and path | Added by |
  | --- | --- | --- |
  | `taskEffectResult` | `GET /api/v1/tasks/:taskId/effects/:effectId/result` | P-15/F |

  Its response, `TaskEffectResultResponse`, carries the document as the result
  contract's own `ResultContractSchema`, imported from `@acp/contracts` rather
  than mirrored (decision 151). `PRIVATE_READ_UNCONFIGURED` joined
  `API_ERROR_CODES` with it, sixteen words, for a server started without a
  bearer. `EFFECT_RESULT_STATES` names the five answers. The outcome words are
  `@acp/contracts`' `EFFECT_OUTCOME_STATUSES`, imported: the ledger re-exports the
  same set, and nothing here restates it.
- **The CLI/API relation is declared, not assumed.** `SURFACE_MAP` names every
  pairing between a CLI command and an arm of the route table, and every arm or
  command that has no counterpart — each of those with the reason recorded
  rather than left as a silence. It is a compile, test and documentation
  contract with **no runtime role**: no dispatch, no help output and no request
  handling reads it. `surfaceDefects` takes the tables it measures as arguments,
  so a test can hand it a route table the map has never seen and demand the new
  arm be named. ADR 0049 records the decision; `docs/api-reference.md` carries
  the same relation as a `CLI` column the architecture fence checks both ways.
- **Explicit emptiness.** The overview distinguishes `EMPTY` from `UNAVAILABLE`
  and `ACTIVE` from `DEGRADED`, and states in data that routing, accounts and
  leases do not exist in this phase.

## Usage

```ts
import { API_ROUTES, OverviewResponse, taskPath } from "@acp/protocol";

const response = OverviewResponse.parse(await readSomething(API_ROUTES.overview));
const detail = taskPath("0f2a1a34-0f6f-4d55-9d0a-2a4b1d3e5f60");
```

Route helpers validate before they encode. A caller that passes a traversal
segment gets a thrown validation error rather than a request to somewhere else.

## Tests

`pnpm test` runs the `protocol` project. The suite is adversarial by
design: it asserts that unknown keys, credential shaped field names, transcript
shaped field names, absolute paths, unsafe route parameters, invalid cursors and
limits, and a mismatched contract version are all rejected, and that every
accepted shape survives a JSON round trip unchanged.
