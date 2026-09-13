# ADR 0078 — A command intention commits with its quarantine, and the contract grows a version to say so

- Status: accepted (P-18/protocolo F, recorded 2026-09-12).
- Supersedes: none.
- Superseded-by: none.

## Context

Datos §11 `:523-585` fixes an eight-step saga across three files that share no
transaction, and escalón F owns its first three steps: the ledger's intention,
the arbiter's compare-and-set bound to a `command_id`, and the ledger's
acknowledgement with the fence obtained. Steps 4-8 are P-18/recuperación's,
which is blocked. Four rules derived there are F's to make true:

- `appendBatch` commits head, events, affected projection **and the outbox
  intention** in one transaction, and "the quarantine stops being three
  transactions" (`:546-547`);
- what is atomic inside the ledger is the quarantine with the **complete command
  event** that revokes the lease, never a row of the separate outbox
  (`:548-554`; contracts §13 `:559-561`);
- `saga_id` groups, and `command_id` is unique and deterministic over
  `(saga_id, phase, target_kind, target_id)` (`:563-565`);
- losing the cache never turns an uncertain delivery into `PENDING` (`:566-570`).

Coordination §6.2 `:301-312` fixes the three event names and what each payload
carries, and the V1 matrix of kinds and streams (`:287-299`). Coordination §3
`:90-99` fixes the fence rule for a revocation and its acknowledgement. Testing
§7 `:169-171` names the three crash boundaries F must drill, and `:178-179` the
oracle.

Escalón E2 (ADR 0074) built the outbox as an inert cache and left three things
to F by decision: `command_id` is the producer's (decision 44), and so is the
vocabulary of `last_failure_code` (decision 45); and E1 (ADR 0075) declared
`operation_id` and `revocation_acknowledged_at` on the lease with no verb that
writes them. The postaudits of E2 and C left four observations the DT adjudicated
to F.

What remained underdetermined, and was settled by the preaudit's corrections and
the DT's adjudications Q-F1..Q-F4:

- whether the **ACK** is a lease event or an outbox observation;
- the **encoding** of `command_id`, and where its grammar lives;
- **who builds** the quarantine batch, and what it contains;
- whether F builds the **reconciler** and the **dispatcher** the brief named;
- whether the second wing of the atomicity negative applies to the **daemon's
  live three-append quarantine**;
- whether the arbiter has a verb that actually **revokes**, so that there is
  something for `ACKNOWLEDGE_REVOCATION` to acknowledge;
- the **form** of the crash-boundary drills;
- whether the contract version **moves**.

## Decision

**1. Three types, with the specification's names and payloads.**
`OUTBOX_COMMAND_INTENDED`, `OUTBOX_DELIVERY_INTENDED` and
`OUTBOX_DELIVERY_OBSERVED` are same-state passthroughs on the `execution`
channel. This ADR declares their shape; it does not choose it (H-6):

- the intention carries `outboxContractVersion`, `sagaId`, `commandId`, `phase`,
  `commandKind`, `intentStream`, `targetKind`, `targetId`, `deadlineAt`, and the
  nullable pair `fence` / `targetStoreIncarnationId`;
- the attempt carries `outboxContractVersion`, `commandId`, `deliveryAttemptId`;
- the observation carries both ids, `outboxState`, a nullable `failureCode` and
  a nullable opaque `responseHandle`.

Every payload is closed: a key outside its list is refused by name.
`outboxContractVersion` is `1` and nothing else. The timestamps are the event's
own. `intentStream` is the one key §6.2's prose does not list: the matrix's
refusal of a combination (N-P18-13) needs a stream to refuse, and `outbox_message`
stores it as `intent_stream`. **Causality travels only in `CausationRef`** (H-11):
an attempt names its intention, an observation names its attempt, and no digest
enters a payload.

**2. The ACK is `OUTBOX_DELIVERY_OBSERVED` with `outboxState = DELIVERED`.** It is
the name §6.2 gives the acknowledgement, and it conserves the command's and the
attempt's identity, which a `LEASE_REVOKED` would not (§7 `:361-362`). The fence
obtained travels in the opaque `responseHandle`; the ledger does not parse it.

**3. `command_id` is a formula, and its grammar is the contract's.**

    preimage   = OUTBOX_COMMAND_ID_PREIMAGE_PREFIX_V1 + canonicalJson([
                   sagaId, phase, targetKind, targetId,
                 ])
    command_id = SHA256(preimage)

`OUTBOX_COMMAND_ID_PREIMAGE_PREFIX_V1 = "acp/outbox-command/v1\n"` lives in
`@acp/contracts`; `computeOutboxCommandId` lives in `@acp/ledger`. That is
`effect_id`'s split (ADR 0076) for its reasons, and it is the placement decision
44 foresaw "if it turns out to be grammar": the door recomputes the id and
refuses one that does not match, so it is. The kind of command is not in the
preimage — one target at one phase is one command — and neither is a clock,
because retrying must conserve the identity (§7 `:360-361`). `L-P18F-2` keeps
the prefix literal in one source file.

**4. The door.** Everything one event can be wrong about is `readOutboxEvent`'s,
and everything a link can be wrong about is `outboxLinkRefusal`'s; the append
door and the fold call the same two functions:

- **The V1 matrix, first.** A kind outside the four, a stream outside the four,
  a combination the matrix does not list, and a listed combination whose stream
  is not `control_plane_events` are all refused `CAPABILITY_UNSUPPORTED` before
  any command exists. `CAPABILITY_UNSUPPORTED` is the message prefix of a
  `LedgerValidationError` with a `path`, not a fourteenth error class. This door
  realises the `control_plane_events` column; the `initiative_events` and
  `account_events` rows belong to those streams' doors, which a later escalón
  opens.
- **One intention per command.** The same command again is refused as a reuse,
  and another under its id as a `CONFLICT`.
- **An attempt** serves a command that exists, on the command's own task, and
  names the intention as its cause. A new attempt needs the command `PENDING`;
  the same `deliveryAttemptId` again is admitted and counts once (§6.2 `:321`).
- **An observation** reports on the attempt in force, names it as its cause, and
  moves the state by coordination §2's table from the folded state. Nothing
  leaves a terminal state or amends one.
- **The pair.** `fence` and `targetStoreIncarnationId` are both present or both
  absent, each nullity tested on its own — the trap E2's `CHECK` met.

**5. A quarantine commits with its intention to revoke, or not at all.** A
quarantine event is `WRITE_SET_VIOLATION_DETECTED` or `TASK_STATE_CHANGED` to
`SUSPECT_WORKTREE`. The door holds two wings (N-F-1, Q-F3):

- a `REVOKE_LEASE` intention is admitted **only** immediately after a quarantine
  event of the same task **inserted by the same transaction** — so never by
  `append`, never alone in a batch, and never after a quarantine the batch merely
  replays;
- **inside `appendBatch`**, a batch that inserts a move to `SUSPECT_WORKTREE` with
  no `REVOKE_LEASE` intention of that task rolls back whole.

`LEASE_REVOKED` is not a quarantine event and not part of the batch: inside the
ledger's transaction nothing has happened at the arbiter yet, and recording a
revocation there would be the cross-file atomicity datos §11 `:558` forbids.

**6. The legacy window, declared.** A unitary `append` of the move to
`SUSPECT_WORKTREE` is still admitted. The daemon's conformance gate
(`packages/entrypoints/daemon/src/composition/ports/index.ts`) records a
violation today with three unitary appends — the finding, `LEASE_REVOKED`, the
move — which are exactly the three transactions §11 retires. Rewriting it to
emit a batch with a saga is operative adoption, blocked by P-18/recuperación.
So the window stays open at that one site, `L-P18F-1` names it and fails on a
second, and the adoption closes it (decision 51).

**7. `buildQuarantineBatch`, in `@acp/runtime`, pure.** It turns a
`QuarantineRecord` into the three candidates of one batch — finding, move,
intention — with phase `QUARANTINE`, target kind `WORKTREE_LEASE` and the
worktree path as target id. It mints nothing: the saga, the event ids, the
transitions and the instants are the caller's, a request without a saga is
refused `REQUEST_INVALID` at `request.sagaId` (N-F-11), and the command id is
`computeOutboxCommandId`'s. Every candidate is parsed by the contract before it
is returned.

**8. No table: a fold.** A command's state is folded from its own events —
`foldOutboxCommands` over any sequence of stream entries, `listOutboxCommands`
and `getOutboxCommand` over the ledger's stream, and the door's own read of one
command's history through `control_plane_events_by_type`. The fold's reading of
§6.2 `:323-324`: an intention is `PENDING`; a recorded attempt without an
observation is **`RECONCILING`**, never `PENDING` and never `INFLIGHT`, because
the ledger records the attempt before anything is sent and cannot know whether
the send happened; an observation moves the state by §2. `lastFailureCode` and
`responseHandle` keep the last value any observation carried. `rebuildReadModel`
and `verifyIntegrity` drive the fold beside the projection snapshot, so a stored
history the door refuses fails the rebuild at the event that caused it.
`MIGRATIONS` stays 14, `DERIVED_TABLES` 15, `PROJECTION_NAMES` 10.

**9. The failure vocabulary is imposed when written.** `OUTBOX_FAILURE_CODES`,
declared in `@acp/contracts` beside the three types, closes six words:
`TARGET_REFUSED`, `TARGET_STALE_TOKEN`, `TARGET_INCARNATION_MISMATCH`,
`TARGET_UNAVAILABLE`, `DEADLINE_EXCEEDED`, `NOT_DISPATCHED_PROVEN`. A code is
required with `FAILED_RETRYABLE` and `FAILED_TERMINAL`, allowed with `ABANDONED`,
and refused with every other state — a failure recorded without its code would
rebuild a cache row that claims it never failed. These are the `code` of the
contracts §16 failure record for `origin ∈ {DURABILITY, EXECUTION}` in
`phase ∈ {DISPATCH, RECOVERY}`; the exhaustive §16 map is a later packet's, and
`outbox_message.last_failure_code` stays free `TEXT` (decision 45), because the
cache is only ever rebuilt from what this door admitted (decision 53).

**10. The lease arbiter gets the two verbs §3 describes** (Q-F4, decision 52).
`REVOKE { at, operationId }` requires a live lease, sets `fence = OLD.fence + 1`,
clears the six holder columns, stamps `released_at`, `operation_id` and the live
incarnation, and leaves `revocation_acknowledged_at` null.
`ACKNOWLEDGE_REVOCATION { at }` requires a record `REVOKE` left — cleared,
correlated, unacknowledged — sets `revocation_acknowledged_at`, and conserves the
fence. `LeaseGrant` gains an optional `operationId`, stamped by `GRANT`, which
also clears any earlier acknowledgement. One adjustment was needed to make
"a record `REVOKE` left" decidable: a `RELEASE` or `sweep` of a **live** grant
now clears `operation_id`, so a released record never passes for a revocation;
a release over an already cleared record conserves it, so it cannot erase an
unacknowledged revocation. No trigger and no token compare-and-set arrive: the
validators and the four-case fence rule stay decision 46's packet.

**11. The inherited observations that are code.** `readToken` in the outbox store
reads the row and the incarnation inside one deferred read transaction (E2, O-1).
And a new `DISPATCH_INTENDED` is refused while any earlier delivery of the same
effect is not `SETTLED` or `ABANDONED` (C, O-1), door-only on `operation_ordinal`'s
precedent.

**12. The crash boundaries are drilled in process.** For boundaries 1, 2 and 3 a
real ledger and a real lease store run the saga to the boundary, both handles
close, and both files are reopened and compared: the command's fold against the
arbiter's row. Boundary 2, which lives inside the acknowledgement's transaction,
is crossed with the ledger's own `beforeAppendCommit` fault. The oracle is
coordination §10 negative 8 and testing §7 `:178-179`: never "released in the
arbiter and alive in the ledger", no known effect duplicated — one command
advances the fence at most once — and the token conserved from the intention.
The reconciliation that finishes each drill is test code. The SIGKILL matrix and
`synchronous = FULL` are the certified profile's and P-18/recuperación's (testing
§10).

## Why F carries the bump

ADR 0076's criterion is whether an escalón's payloads carry an identity the fold
verifies and a contract version of their own. C carried the bump because its
fold recomputes `effect_id` and its payloads carry `request_contract_version`;
D did not, because its digests are conserved and it added no formula (decision
49).

F meets both arms. The door **and** the fold recompute `command_id` from a
preimage that did not exist before this escalón — a rebuild's acceptance of a
stored intention depends on it — and every outbox payload carries
`outboxContractVersion`. So `CONTRACT_VERSION` moves to `"2.4.0"`,
`SUPPORTED_CONTRACT_VERSIONS` becomes `["2.2.0", "2.3.0", "2.4.0"]`, and every
obligation ADR 0072 put on a bump carrier is paid again: the three admission
shapes and the append door pin the version in force through
`AdmittedContractVersion`, the exact replay of an older row stays exempt, a
`2.3.0` history reads, verifies, rebuilds and takes new work on top, and new
work stamped `2.3.0` is refused naming both numbers (decision 50).

What F does **not** do is put a causation digest into a payload (H-11). Had the
attempt carried its intention's digest, the fold would verify a digest too; it
carries a `CausationRef` instead, which the ledger already resolves.

**Consequence V3, again.** `TaskEnvelope.contractVersion` is the version in force
and the envelope preimage covers it, so the pinned `envelope_sha256` vectors move
with the fixture. They were computed twice before being written down.

## Binding rules for the reconciler and the dispatcher

F builds neither (H-3): they read `outbox.sqlite`, apply its compare-and-set and
dispatch, which is the blocked half. What F owes them is written down here, and a
packet that builds them follows these rules or amends this record:

- **O-2.** An `INFLIGHT` row past its deadline with **no attempt anchor** cannot
  move to `RECONCILING` — the store's `CHECK` refuses it. Its lawful exit is
  `FAILED_RETRYABLE`, which coordination §2 `:50-51` admits exactly when no
  dispatch happened, and without a durable attempt recorded before sending
  (§6.1 `:277`) none did. An `INFLIGHT` row **with** an anchor goes to
  `RECONCILING`; §6 `:245` reads unconditional and is not.
- **O-3.** A trigger's refusal in the outbox store is an exception —
  `LedgerQueryError` — and not one of the three verbs. A dispatcher catches it
  beside `APPLIED`, `UNCHANGED` and `CONFLICT`, and never reads it as a success
  or as a reason to resend.
- **From the fold.** A cache rebuilt from `listOutboxCommands` writes an attempt
  without an outcome as `RECONCILING`, and conserves the intention's anchor and
  target incarnation; it never substitutes the target's current incarnation.

## Consequences

- **The fold approximates the batch.** It sees the stream, not transactions, so
  a `REVOKE_LEASE` intention immediately after a quarantine appended by a
  separate transaction reads as lawful there. The door never writes that shape,
  so a stored history of it was not written through the door.
- **No lane for a late result on a terminal command.** §6.1 `:280-281` wants a
  stale relay's result recorded for reconciliation; the door refuses any
  observation of a terminal command and of a superseded attempt. That lane is
  the reconciler's to design.
- **A command never attempted cannot be abandoned** through these events: an
  observation names an attempt, and `PENDING → ABANDONED` has none to name.
  Also the reconciler's.
- **The door reads by JSON path.** One command's history is found through the
  type index and `json_extract` over the event body; the cost is proportional to
  the outbox events in the stream, and a table would be a migration this escalón
  does not carry.
- **The legacy window is real.** Until the adoption, the daemon's quarantine is
  three transactions, and the atomicity this record describes holds for batches
  only.
- **A released lease forgets its grant's command.** Nothing wrote `operation_id`
  before F, so no record in the field changes.

## Not in this record

Boundaries 4-8, the SIGKILL matrix, the reconciler, the dispatcher, the `account`
and `initiative` rows of the matrix, the exhaustive §16 map, the lease validators
and token compare-and-set of decision 46, the operative commit, B1-B3, O-Δ1/O-Δ2
and `API_CONTRACT_VERSION`.
