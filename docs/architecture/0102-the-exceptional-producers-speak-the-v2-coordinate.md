# ADR 0102 — The exceptional producers speak the V2 coordinate

- Status: accepted (P-15 escalón B, recorded 2026-09-23).
- Supersedes: none.
- Superseded-by: none.
- Amends: ADR 0080's list of what stays V1, and the README sentence that restated
  it. ADR 0080 is not edited: this record supersedes that part of its
  Consequences by reference. `L-B7R-3` is amended in its own fence row.

## Context

P-18/protocolo G made the walk speak the V2 coordinate (ADR 0080). A
revision-bearing invocation keys every event by the revision's
`(revisionNumber, attemptNumber)`, `buildEvent` carries the two numbers in every
payload, and the contract refuses an event whose payload and key disagree.

G left six producers outside that, and one recovery path. Each builds its own
`ControlPlaneEvent` outside `buildEvent`:

- provider pressure (`QUOTA_WARNING`, `AUTH_REQUIRED_RAISED`);
- the switch player (every candidate of a switch plan);
- its landing (`ACCOUNT_SWITCH_COMPLETED`);
- the cancellation settlement (`TASK_CANCELLED`);
- the failure settlement (`TASK_FAILED`);
- the tool-call receipt (`TOOL_CALL_RECORDED`).

Their payloads carried no coordinate while `deriveEventCoordinate` keyed them V2,
so the contract refused every one of them for a V2 walk. `restateInvocation`
refused any task whose first event was an opening.

ADR 0080 declared all of this and left it failing closed. Adjudication v2 set the
bounds for this escalón:

- **C1.** No legacy `TOKEN_USAGE_RECORDED` under V2. Quota blindness is declared
  until P-19.
- **C2.** The intake → opening → discovery continuity belongs to P-15/D.

The DT's answers settled the two open questions:

- **Q-B1**, as corrected after the post-audit. The first answer filed an opening
  whose invocation id disagrees as `SUBMISSION_DIGEST_MISMATCH`. Its premise was
  false: the id is derived from the task and the flat attempt alone, with the
  revision kept out of it (ADR 0080), so it certifies nothing about the submission
  digest. Such an opening is present and invalid, and is refused as unreadable.
- **Q-B2.** No word-scan law is added.

## Decision

**One — one helper, one source.** `payloadCoordinate(invocation)` in
`core/coordinates` returns:

- nothing for a V1 invocation: no key at all, rather than `undefined` ones;
- `{ revisionNumber, attemptNumber }` for a V2 one, read from the invocation's
  **revision** and never from the flat `attempt` (ADR 0090 Three).

It builds the result field by field, so a wider revision cannot widen a payload.
Its return type is `PayloadCoordinate`, in a new type leaf.

`buildEvent` builds its base from the helper, byte-identically. Pinned vectors
of both plans' V2 walks, lifted from the pre-B source, hold that. Each of the six
producers spreads the helper's result into its payload after its own named
fields.

**Two — nothing of a coordinate before its opening, for every producer.**
`assertAttemptOpened` is narrowed to take one ledger read and the invocation. It
is exported to the producers, but not on the runtime barrel.

Each producer calls it for a V2 invocation, before it builds, probes or appends
anything:

- the settlements, before their precheck and their probe;
- the landing, before its probe and its gate;
- pressure, the switch player and the receipt, before their append.

The tool-call operation that calls the receipt, `runToolCall`, checks too, before
its replay read, its claim and its port. That check was added when a test found
that the receipt's refusal alone came too late for an unopened V2 attempt: the
port had already been called once, and no row followed. That violated the
operation's rule, "throw = the request never became an operation, return = there
is always a row". Now the refusal comes first: no call, no claim row, no receipt.
The receipt keeps its own check as the producer-level line.

An unopened attempt is refused by name ("has not been opened"). So is an opening
key that holds another event ("work this invocation did not do"). Either way the
ledger is not touched. Otherwise an exceptional producer would reopen O-2 from
outside the walk, which is what G closed inside it.

**Three — a plan may not name the coordinate.** Before any append, the switch
player refuses a candidate whose payload carries `revisionNumber` or
`attemptNumber`, with a value of any type, on a V1 walk as on a V2 one. The two
keys decide which idempotency key an event must carry, so a plan able to set them
could key an event into another coordinate. The appended payload's type widens
to a named `SwitchEventPayload`, in the executor's new type leaf.

**Four — recovery reads an opening-first task.** When a task's first event is
this attempt's `TASK_ATTEMPT_OPENED`, `restateInvocation` does four things:

- It reads the revision record and the invocation id from the opening's payload.
  The result is `DISCOVERY_UNREADABLE` at `task.firstSequence`, and the opening is
  never read as "no opening", when:
  - any of them is absent, `null`, empty or of the wrong type;
  - the legacy attempt number disagrees;
  - the opening names an invocation that is not this coordinate's. The id is
    derived from the task and the flat attempt, so it says nothing about the
    submission (Q-B1 as corrected).
- It finds the discovery by its V2 key. A missing discovery is
  `DISCOVERY_UNREADABLE` at `attempt.discovery`.
- It runs the existing discovery read and digest check unchanged. The digest is
  what vouches for the submission. No refusal word is added.

`LifecycleRecoveryPort` gains `getEventByIdempotencyKey`, and `Ledger` satisfies
it structurally.

An intake-first task, whose first event is a discovery under the intake
transition, stays `DISCOVERY_UNREADABLE` until P-15/D (C2). So a task admitted
through the P-14/C intake **cannot be cancelled or attached through the lifecycle
door** until P-15/D delivers the intake → opening → discovery continuity.

**Five — V1 does not move.** For every producer, the V1 event built after B is
byte-identical to the one built before. Each producer's suite pins the sha-256 of
its V1 event, computed by running the pre-B source (HEAD `313512d`) over the same
fixture. The vectors were lifted, never re-derived. A presence matrix makes the
NULL rule mechanical:

- inputs: `revisionNumber` and `attemptNumber` each absent, `null`, `0`, `"1"`,
  `1.5` or valid, on a V1 and a V2 walk (72 cells);
- each cell goes through the contract and, when it parses, the ledger's door;
- exactly two cells land: no pair on a V1 walk, and the whole valid pair on a V2
  walk.

**Six — legacy usage is not adopted (C1).** `recordTokenObservation` is
untouched. Under V2 a legacy `TOKEN_USAGE_RECORDED` stays refused by the
contract, and a characterization test pins that refusal with zero delta.

V2 spend is recorded only as `USAGE_STREAM_DECLARED` /
`USAGE_OBSERVATION_RECORDED`, which P-15/D wires. Until P-19,
`readAccountUsage`, the accounts quota fold and the rollups see **no spend from a
V2 walk**. A smoke's bound is the owner's written limit plus provider pressure,
not the quota fold.

**Seven — the laws.** `L-B7R-3` is amended in its row. The failure settlement's
payload is built from the digest, the classified reason and
`payloadCoordinate(invocation)`, and there is exactly one `payload:` in the
module. The message ban is unchanged. `PATH_SCOPED_LAWS` stays 150: no structural
word-scan law is added (Q-B2), because the per-producer V2 tests are the guard.

## Why the coordinate was not carried in each producer's own words

Six producers each reading `invocation.revision` would be six places able to read
the flat attempt instead, or to half-carry the pair. The contract reads a `null`,
a string or a half pair as **no coordinate**, so a mistake there would not fail
loudly on a V1 key: it would be refused only at the key rule, and for a V1 walk
would look like a V1 event. One helper, spread last and tested once against the
key derivation, removes the second authority.

## Consequences

- There is no ledger change, no migration and no contract move. `CONTRACT_VERSION`
  (2.8.0), `MIGRATIONS` (22), `CONTRACTS_SCHEMA_EXPORTS` (161),
  `RUNTIME_PUBLIC_EXPORTS` (285) and `LIFECYCLE_RECOVERY_REFUSALS` are unchanged.
- The two ADR 0080 fail-closed drills are inverted. A V2 settlement appends one
  V2 `TASK_FAILED`. A V2 restate reads past the opening, and at `RESERVED` it is
  refused as `ROUTE_NOT_RECORDED`, the ordinary window before the INTENT.
- A V2 cancellation recovered by the restate settles end to end with a V2
  `TASK_CANCELLED`.
- The ADR corpus goes 101 → 102, and the decision register gains 119–121.

## Not in this record

- **P-15/D:** the intake-first continuity (C2, ADR 0080 §4 and §5), and the walk's
  wiring of V2 usage and pressure.
- **P-19:** quota and rollups over V2 spend.
- **Still V1:** the CLI, gateway and durability invocation constructions.
