# ADR 0120 — An envelope states its instruction once, and a superseded task is refused by name

- Status: accepted (P-16, cut A1, recorded 2026-09-26).
- Supersedes: none.
- Superseded-by: none.

## Context

Since P-06 (ADR 0093) a `TaskEnvelope` stated its instruction twice: `content`, the
typed block list every producer reads, and `objective`, a string an equality refine
held to the first `text` block. Decision 160 (ND-Q1 (b)) retired `objective` with the
first contract bump of P-16; P-15/D4 re-pointed it there, and decision 219 left it in
the P-16 row. The 2.8.0, 2.9.0 and 2.10.0 bumps did not carry it.

Decision 184 (D-B-1, from P-26/B) named a second debt the same bump repeats.
`TaskEnvelope.contractVersion` admits only the version in force, and
`readRecordedTask` re-parses the stored envelope. So after a bump, a task entered under
the previous version is unreadable, and it failed as a generic parse
(`ENVELOPE_UNREADABLE`), not by name. Nothing is lost before P9, because there is no
operational history, but the refusal must come by name, before any spend, and the path
must be declared.

Both debts meet in one cut because the retirement moves the envelope's preimage. That
is ADR 0076's identity class: `envelope_sha256` differs for the same work issued before
and after (decision 48). So `CONTRACT_VERSION` moves, and D-B-1 fires on the first
bump P-16 makes.

The brief (`p16-a1/brief-v1`, measured at `5a81512`) was pre-audited by Kimi K3
(`ACCEPT_WITH_CORRECTIONS`; three blocking text corrections, adopted). Its ND-1 to
ND-14 recommendations were adopted as rulings. Two stop-rulings followed during the
write, both audited `ACCEPT`: the version is tested by membership in the supported set
(`ContractVersion` is not exported), and one daemon test file may import `node:sqlite`
(Decision, Five).

## Decision

### One — the field goes, and the version moves for an identity (decision 220)

`TaskEnvelope` no longer declares `objective`, and the refine that tied it to the first
`text` block is gone. The envelope is a `z.strictObject`, so an envelope that still
carries the field is refused at every door as an unknown key at the envelope's own
path (`[]`, `keys: ["objective"]`). `content` is the only statement of the instruction.
`attachGuards` still runs over the whole value, so the credential guards cover
`content`; no guard is lost.

`CONTRACT_VERSION` goes `2.10.0` → `2.11.0`. `SUPPORTED_CONTRACT_VERSIONS` grows from
nine to ten members and keeps `2.10.0` for ever. `AdmittedContractVersion` follows
the symbol, so the three shapes that admit only the version in force (`TaskEnvelope`,
`WorkerSlot`, `CommitAuthorizationReceipt`) refuse `2.10.0` and admit `2.11.0`.

No column holds `objective`. Every SQL cohort list closes at or before `2.9.0`
(migrations 16, 22, 23 and 25), so `2.11.0` falls in `NOT IN`, as `2.10.0` did. No
migration follows: `MIGRATIONS` stays 27.

The three bump acts (ADR 0072) are re-proved on the task stream at `2.11.0`. Act 1 is
the doors' existing pin, so no source changes: a new `2.10.0`-stamped task, initiative
or registry event is refused with words that name both versions, and an exact replay
of a stored `2.10.0` event returns its record. Act 2: the stored envelope's
`contractVersion` equals the intake event's, which equals `CONTRACT_VERSION`. Act 3:
a `2.10.0` task history opens, reads, verifies and rebuilds row for row under `2.11.0`,
and then takes new work.

### Two — the reader reads the version before the shape (decision 221)

`readRecordedTask` (`runtime/src/recorded-task`) gains two words, so
`RECORDED_TASK_REFUSALS` goes from five to seven:

- `ENVELOPE_VERSION_MISMATCH`;
- `ENVELOPE_VERSION_SUPERSEDED`.

After the JSON parse and before the one `TaskEnvelope.safeParse`, the reader reads
`contractVersion` off the stored object by itself. It reads it only from a plain object
that owns the key, only as a string, and only if the string is a member of
`SUPPORTED_CONTRACT_VERSIONS`. The checks run in this order:

1. The version is absent, not a string, malformed or never supported →
   `ENVELOPE_UNREADABLE` at `envelope`. This is the existing word and path: bytes with
   no readable version are not an envelope.
2. The version differs from the intake event's `contractVersion` →
   `ENVELOPE_VERSION_MISMATCH` at `envelope.contractVersion`. This is integrity, not
   history, because the payload's version is the event's (act 2).
3. The version is supported but is not `CONTRACT_VERSION` →
   `ENVELOPE_VERSION_SUPERSEDED` at `envelope.contractVersion`. This is lawful history
   that this build does not run.

Only after these checks come the parse, the digest check and the rest, exactly as
before. `word` is `null` on both new refusals, and no value is echoed.

**The declared path is re-submission** under the version in force, through
`acp intake` or `POST /api/v1/tasks`. No bulk tool exists and none is needed before
P9.

**Before spend, by construction.** The daemon's recorded form calls the reader at
start and throws `StartupError("the recorded task is refused: <word> at <at>")` before
any walk, lease, dispatch or provider spawn. No daemon source changes. E3 and E4 prove
this through `runDaemonChild`, over an operator ledger planted with a `2.10.0`
recording and the V-C1 fake Claude:

- the start rejects with the named refusal;
- the fake's echo file does not exist;
- the task's event list is byte-identical before and after;
- the task has no `RUN_STARTED`, `LEASE_ACQUIRED`, `EFFECT_INTENDED`, `DISPATCH_*`,
  `PROMPT_OCCURRENCE_RECORDED`, `USAGE_*` or `RESPONSE_OCCURRENCE_RECORDED` event;
- no execution marker is written;
- `verifyIntegrity().problems` is `[]`.

E5 is the planting helper's positive control: the same plant left at `2.11.0` starts
and walks to `CHECKPOINTED`.

**A declared limit: the digest of a superseded envelope is not re-derived.**
`envelopeSha256` parses with the current `TaskEnvelope`, so it cannot hash bytes of a
superseded shape, and `SUPERSEDED` fires on bytes whose digest was not checked.
Instead, the version claim is corroborated by the hash-chained intake event (check 2).
A tampered envelope version cannot pose as lawful history unless the chain says so
too. The chain catches an edit that does not recompute it from genesis and the head.
A writer with raw database access who recomputes everything is outside what the chain
alone proves: the E3/E4 fixture is such a rewrite (triggers taken out and put back,
head and watermark recomputed), and `verifyIntegrity` returns `[]` on it. Neither word
leads to spend.

### Three — the API minor, and the doors as they are (decision 222)

`API_CONTRACT_VERSION` goes `0.24.0` → `0.25.0`. This is the minor ADR 0116 first
assigned to P-16/A1 and ADR 0118 re-took. `TaskIntakeRequest` embeds `TaskEnvelope`,
so the request shape loses the field, and `LEDGER_CONTRACT_VERSION` follows
`CONTRACT_VERSION` by derivation.

It is a minor, not a major, on the house's reading. The route surface is unchanged and
no remaining field changes meaning. The refusal that a caller who still sends
`objective` observes is stated in `docs/api-reference.md`, not hidden.

No door changes. The strict object reports the unknown key at the envelope's own path,
so the doors answer:

- gateway: `400 BAD_REQUEST`, detail `envelope`;
- CLI: `BAD_REQUEST` at `request.envelope`, exit `EXIT_USAGE`;
- runtime intake: `ENVELOPE_INVALID` at `envelope`.

Each writes no event, no publication and no artifact row (E2). Mapping the key into
the path would be a door edit for a cosmetic gain.

### Four — L-P16A1-1 (decision 223)

The new path-scoped law, "a stored envelope's version is read before its shape, and
refused by name", covers `packages/domains/runtime/src/recorded-task/index.ts`, so
`PATH_SCOPED_LAWS` goes 174 → 175. In the comment-stripped source it requires:

- exactly one `TaskEnvelope.safeParse(`;
- a `refuse(` call for `ENVELOPE_VERSION_MISMATCH` and one for
  `ENVELOPE_VERSION_SUPERSEDED`, each before that parse (whitespace after the
  parenthesis is formatting);
- a membership test over the supported set before both refusals: the literal
  `SUPPORTED_CONTRACT_VERSIONS` and an `.includes(` call, both after the last import
  statement.

An empty or absent file fails on the empty scope.

The brief named `ContractVersion.safeParse(` as the version parse.
`ContractVersion` is `z.enum(SUPPORTED_CONTRACT_VERSIONS)`, which `@acp/contracts`
does not export. Exporting it would add two paths and move the
`CONTRACTS_SCHEMA_EXPORTS` pin (185). So the ruling took the ledger's own mould
(`unsupportedContractVersion`): a `typeof` guard and membership in the set, which is
exactly that enum's success predicate.

**Declared limit.** This is a text-level shape law over one file. It does not see a
version read through an alias or through a helper in another file, a membership test
spelled otherwise, a second reader elsewhere, or anything `stripComments` hides. It
reads text positions, not control flow, so four more seeds stay fence-green: a
same-file helper called after the parse, refusals in dead code, the refusal text
inside a string literal, and the order between `MISMATCH` and `SUPERSEDED`. The order
between the two words is the tests'; the reader tests kill all four. That
the reader is the only re-parse of a stored envelope in `src` was measured by grep:
the other `TaskEnvelope` parse sites (`runtime/src/intake`, `conflict-graph`,
`daemon-child`) parse envelopes issued now. The law does not hold that fact.
Behaviour is carried by the reader's tests (P2, N3–N6) and by E3/E4.

### Five — one daemon test file may import `node:sqlite`, to plant history (decision 223)

The E3/E4/E5 fixture must turn an intake that a `2.11.0` build recorded into a
`2.10.0` recording. No door can author one. The fixture takes these steps:

1. It publishes the planted envelope bytes, with `objective` equal to the first text
   block (what a `2.10.0` build stored), through the real artifact plane under the
   task's scope.
2. It rewrites the intake event's `contractVersion`, envelope reference and digest.
3. It recomputes the chain, head and watermark from genesis, with the two append-only
   triggers taken out and put back verbatim (the ledger suite's `restampHistory`
   mould).
4. It rebuilds the projections.

The fixture's digest is computed and declared test-locally as
`sha256(ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1 + canonicalJsonStringify(raw))`. The
two-method rule's parse step is omitted on purpose, because the `2.11.0` schema must
refuse these bytes. E5 asserts that for a lawful `2.11.0` envelope the test-local
digest equals `envelopeSha256`.

Step 3 needs raw SQLite, which the daemon import law refused in every daemon file. The
carve is file-scoped and `isTest`-guarded. `DAEMON_SQLITE_FIXTURE_FILE` names
`packages/entrypoints/daemon/test/bin/acp-daemon/index.test.ts`, and both the
allowed-import check and the `RUNTIME_FORBIDDEN_BUILTINS` check honour it for
`node:sqlite` alone. It is not a member of `DAEMON_TEST_ONLY_IMPORTS`, which would
admit every daemon test. The law's note line names the file.

The carve is fixture-only:

- no daemon source touches SQLite;
- the daemon manifest's exact dependency and devDependency pins are unchanged;
- no `requireScope` call or `PATH_SCOPED_LAWS` row is added.

### Six — the pinned vectors, restamped by their recorded methods (decision 224)

- **Envelope identity.** The three vectors (`ledger/test/envelope-identity`) are
  recomputed by the file's two methods, `envelopeSha256` and `node:crypto` over
  `envelopeIdentityPreimageV1`, which agree. Vector 2's subject, "differing only in
  `objective`", no longer exists, so it becomes an envelope that differs only in its
  first text block (ND-9). The prefix `ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1` is
  unchanged: a field change is not an encoding change.
- **PC-D3's trail** (`D4_V1_TRAIL_SHA256`). It uses the method its docblock records:
  1. a `git archive be3b06f` scratch clone;
  2. a control run on the unmodified archive, which reproduces `f61ca58b…ed93`;
  3. one run with A1's contract edits applied (the version, the supported set, the
     field and refine removal, and the drill's envelope literals without
     `objective`), which gives `96593135…89e5`.

  That value replaces `b11912ea…a346`, the 2.10.0 restamp, and the canonical tree
  passes with it.
- **The `restampedAsLifted` event-digest moulds** restamp to `2.8.0` and are
  invariant.

## Why the alternatives were not chosen

**One refusal word, with `at` telling the cases apart (ND-1).** A superseded task is
lawful history, and the operator re-submits it. A mismatched one is corruption, and
the operator quarantines and investigates it. Different actions need different words.

**Re-deriving a superseded envelope's digest (ND-3 (b), (c)).** Hashing the raw
canonical JSON with the V1 prefix in `src` would be a second digest producer, which
"one producer, one algorithm" refuses. Keeping a version-keyed historical schema alive
in contracts is a library with no consumer before P9. The chained event corroborates
the version, and neither word spends.

**Proving zero spend only at the reader, with fake ports (ND-7 (b)).** The P-16 row
demands "cero eventos de proveedor" through the real start. A reader-level test proves
the refusal, not that the daemon stops on it. That test stays (N3–N6), and it is not
the proof.

**A ledger-exported seam that restamps a stored event.** It would add paths outside
the write-set, a new public ledger export and a moved exports pin, and it would put a
history-forging capability on the ledger's public surface. The test-local carve keeps
that capability in one test file.

**Mapping the unknown key into the door's path (ND-5).** Each door would change for a
cosmetic gain, and the fields a door never echoes would stay unechoed anyway.

## Consequences

- Every envelope issued from `2.11.0` hashes differently from the same work under
  `2.10.0`. No historical digest is migrated, because no history is rehashed.
- A task recorded under any supported version other than `2.11.0` cannot be run by
  this build. It is refused at start by name, and it must be re-submitted. An inline
  daemon config written for `2.10.0` must be re-authored (ND-11): an inline config is
  issued now, not history, and it is refused generically at `daemon-child`.
- A caller that still sends `objective` receives a `400` from `0.25.0`.
- One daemon test file can open SQLite. The fence names it, and any second file stays
  red.
- Every future bump re-uses these two words unchanged: `SUPERSEDED` fires for each
  member of the set except the current one, which N3 enumerates from the set, not by
  hand.

## Not in this record

- **D-S1-2**, the lawful `NO_COMMIT` path. An empty write-set is refused after the
  provider chain (`runtime/src/enforcement`), and the ruling must come before any spend
  and with no default. It stays in the P-16 row for a later cut (D2 on map v3, with
  N03). A1 touches no enforcement path.
- The `READ_ONLY` / `workspaceMode` vocabulary (P-17), and a `COMPLETED` lifecycle
  state (P-21).
- Receipt v2, the verification and audit runners, and the remaining P-16 cuts (A2, B,
  C, D1–D2).
- The spec wording that lists "objetivo" among the envelope's covered content
  (database §6.2, execution): it names the instruction as a concept, and spec edits are
  P-16/0's (ND-10).
- The `INSTRUCTIONS_MAX_CHARS` chars/bytes mix, which is the P-06 row's named debt.
- A pre-existing gap in the daemon import scanner (`IMPORT_SPECIFIER`), not introduced
  by A1: it does not see a dynamic `import("node:sqlite")` in another daemon test (the
  verifier's bite D1 stayed green), and the same gap would let a dynamic
  `import("node:net")` through. It is left for a later fence cut.
