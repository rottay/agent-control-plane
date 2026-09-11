# ADR 0066 — The revision digest covers the whole envelope, or it identifies nothing

- Status: accepted (P-05/A, recorded 2026-09-11).
- Supersedes: none.
- Superseded-by: none.
- Extends: none.

## Context

`docs/audit/findings/index.md` records N01: the identity of a submission does
not incorporate the objective or the authority. The probe is two envelopes that
differ in what the work *is* and in what it was allowed to touch, accepted under
one digest.

The reason is structural rather than an oversight. The only digest on the
submission path is `canonicalSubmissionDigest`
(`runtime/src/submission/index.ts`), and its preimage is `(taskId, attempt,
submittedAt, initiativeId, route{provider, model, accountId, transportKind,
capabilityPolicyVersion, resolvedAt})`. That is a good digest of a good
question — *which delivery, with which route elected* — and it contains three of
the four things `docs/audit/architecture/database/index.md` §6.2 explicitly
excludes from the envelope's identity, and not one envelope field. The daemon's
child parses the whole `TaskEnvelope` and checks that its `taskId` and
`initiativeId` agree with the config; then it compares a digest that never
looked at the envelope.

§6.2's correction is not "hash more". It is: **declare the preimage.** And it
refuses to enumerate the fields, saying so out loud — "esta página **no**
reproduce una preimagen parcial que se desactualizaría" — while naming
`kernel/contracts` as the master contract.

## Decision

**The preimage is the whole parsed envelope, and there is no list of fields
anywhere.**

```
preimage = ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1 + canonicalJsonStringify(TaskEnvelope.parse(value))
digest   = sha256(preimage)
```

Five things this record decides.

**1. Coverage is a property of the schema, not of a list.** `TaskEnvelope` is a
`z.strictObject`, so hashing the parse output covers every field by
construction: a field added to the schema enters the digest the day it is added,
and nobody has to remember a second list. The same strictness enforces §6.2's
exclusions from the other side — the default clock, `attempt_number`,
`account_id`, the resolved `model_version_id` and any process identifier are not
fields, and an object carrying one is **refused** rather than ignored. That is
stronger than filtering it out.

The test that makes this unviolatable derives its keys from
`Object.keys(TaskEnvelope.shape)` at test time and asserts they match the parsed
value's. A hand-written list of names there would be the very enumeration §6.2
rejects, and it would go stale on the day it most needs to fail.

**2. The rule lives in `contracts`; the function lives in `@acp/ledger`.** The
split is forced, not chosen. `@acp/contracts` may import `zod` and no `node:`
builtin at all, because every package imports it *including the browser client*
and one `node:crypto` there would make the whole contract surface unloadable in
a page. So contracts declares `ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1` and states
the rule; `@acp/ledger`, which already owns `canonicalJsonStringify` and
`sha256Hex`, computes it. A second canonicalizer or a second sha-256 declared in
contracts — including one reached through `crypto.subtle`, which is not an
import and would evade the letter of that law while breaking its intent — would
be a second authority on a question already answered.

**3. One LF, and it belongs to the prefix.** The constant is
`"acp/task-envelope/v1\n"` and the formula adds no separator of its own, exactly
as `ACCOUNT_INTEGRITY_PREIMAGE_PREFIX_V1` does. This is a decision about bytes
and it had three defensible readings; the one written here is pinned by a test
that asserts the last byte is `0x0a`, that there is exactly one, and that the
byte after it is `{`. `v1` is frozen: a change to the encoding is a **new**
constant with a new name, and no history is ever rehashed.

**4. `issuedAt` and `contractVersion` are in, with their consequences stated.**
Both are fields, and §6.2 says every field. So re-issuing the same packet at a
later instant is a **new revision** — which is the honest answer, because a
re-issue is a new grant even when the words match. And moving `CONTRACT_VERSION`
changes the digest of envelopes issued under the new contract; digests recorded
under the old one are not migrated, because nothing rehashes history.

**5. The function takes `unknown` and parses.** A signature typed against
`TaskEnvelope` would be trusting the caller's cast, and a hand-assembled config
with one extra key would receive a digest of something that is not an envelope.
The parse is the gate: what is hashed is always the value the contract accepted.
Refusals reuse the existing vocabulary — `ZodError` from the parse, and
`LedgerCanonicalizationError` for a value that parses and still has no canonical
form. **No error class is added.**

## No version moves

Neither `CONTRACT_VERSION` nor `API_CONTRACT_VERSION` moves.

`CONTRACT_VERSION` describes the durable meaning of a recorded event. This
packet records nothing: no event type, no payload key, no migration, no column,
no history reinterpreted. It adds a pure function and the constant it reads.

`API_CONTRACT_VERSION` describes the shape a browser or a CLI receives. No DTO,
no route and no error code moves. Nothing computed here crosses the wire yet.

## Consequences

The revision digest exists and is pinned by three literal vectors. It is the
only artifact of this packet that a later one cannot recompute differently
without a test going red — every other drill here would compute new bytes the
new way and agree with itself.

`envelope_sha256` and `submissionDigest` are now two real functions that a drill
can hold at once, and one does: re-electing a route moves the submission digest
and leaves the revision digest still; changing the objective moves the revision
digest and leaves the submission digest unmoved. That second half is N01 stated
as an assertion rather than as prose. The drill lives in
`runtime/test/submission/` because it is the only tree that reaches both real
producers — `@acp/runtime` may import `@acp/ledger` and not the reverse — and
restating either preimage by hand would have made it agree with itself.

## What this does not close

**This packet does not close N01.** Nothing here is wired into the submission
path. `daemon-child` still parses the envelope, still checks two fields of it
against the config, and still compares only the submission digest — so two
packets differing in objective and authority still reach that door under one
identity. Closing N01 means making the door compare this digest, and that is the
packet the DT names; it is not deferred to "later", it is deferred to a named
successor.

**There is no revision coordinate yet.** `(task_id, revision_number)` with its
own `revision_id`, the additive `revision_number` / `attempt_number` columns on
`control_plane_events`, and `task_revision_read_model` are P-05/B. Nothing here
numbers a revision, stores one, or projects one; this packet answers only "what
digest identifies this revision", not "which revision is this".

**No CAS, no assignment under concurrency.** How `legacy_attempt_number` is
allocated monotonically per task belongs to P-18/M4, and
`docs/audit/architecture/database/streams/index.md` §1.1 owns it.

**Nothing about the submission door.** `UNIQUE(client_scope,
client_request_key)`, the three outcomes of contracts §15 — replay, `CONFLICT`,
new revision — and the `REQUEST_INVALID` / `AUTHORITY_REFUSED` vocabulary are
the door's, and the door is P-14/P-15.
