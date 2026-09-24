# ADR 0107 — A result is read by reference, behind authorization

- Status: accepted (P-15 escalón F, recorded 2026-09-23).
- Supersedes: none.
- Superseded-by: none.
- Amends: L-P07A-1, in its own fence row, to admit the protocol's schemas one name wide
  (decision 151). The gateway's "observation is free on this plane" stays true of every
  GET but one, which a closed table names (decision 150).

## Context

Contratos §10 makes a result recoverable by reference and digest, and readable **behind
authorization**. §4.3 accepts a result only from the real door, CLI **and** API, never from
a fixture, and parallelism `:143` forbids substituting a direct call to the port for that
door. Until this escalón the daemon executed a recorded task and published its result as a
`RESPONSE` artifact (P-15/D), but nothing could read it back: no route, no verb, and no way
for a caller to learn an effect's id, because an event's payload never crosses the API.

Tests §8.1 lists public HTTP and CLI responses among the protected sinks. Model output may
travel only on a private channel or be read "por una lectura explícitamente autorizada",
and that read must be audited before the fixtures, never added after a failure. F0 did
that: decision 149 froze the inventory of the two authorized reads before this escalón
wrote a line.

## Decision

### One — one credential, one private read, a visible table (decision 150)

`taskEffectResult` (`GET /api/v1/tasks/:taskId/effects/:effectId/result`) is the plane's
one private read. The gateway registers it through `registerPrivateGet`, the read-side
twin of the write door's structural guard. A server with no bearer answers
`403 PRIVATE_READ_UNCONFIGURED`. A missing or wrong bearer answers `401 AUTH_REQUIRED`,
the same answer for both. The handler runs only after those two checks, so an
unauthenticated caller learns nothing about what exists. Every answer on the path, a 200
or an error, carries `Cache-Control: no-store` -- including the framework's own refusals
before the route runs (`FST_ERR_BAD_URL` for `%zz`, `FST_ERR_MAX_PARAM_LENGTH` for an
over-long id) and the not-found answer, which since v3 set the header for every path
(verifier V3).

The protocol names the route in a third closed table, `API_PRIVATE_READ_ROUTES`, beside
`API_WRITE_ROUTES`. `API_ALLOWED_METHODS` stays `["GET"]`, and the write table stays at
six.

**One credential authorizes writes and model-output reads until P-36's read policy.**
The write bearer file is reused (F-ND-1 (a1)). There is no least privilege between the
two uses, and this escalón claims none. `PRIVATE_READ_UNCONFIGURED` is its own word, not
the write door's `WRITE_BEARER_UNCONFIGURED`: a reader told "no write can be authorized"
has been told something false. `API_ERROR_CODES` goes 15 → 16. The CLI answers the new
word with `EXIT_USAGE`, as it answers its twin. No CLI door raises either, because the
CLI's authorization is filesystem access.

**The objective precedent (C-F2).** `GET /api/v1/initiatives/:initiativeId` serves an
initiative's objective from the private plane on an unguarded GET (decision 76). The
objective is an internal plan document, not one of §8.1's protected content classes
(prompt, tool arguments, model output), so it is not in the table. "Private plane ⇒
guarded" is **not** the rule. The rule is that model output is read only behind the
bearer. This escalón does not widen the table to the objective. If that is ever wanted,
it is a P-14 errata.

**On the CLI**, `acp result` is the authorized read, and its authorization is the
operator's own access to the ledger and to the plane beside it: root `0700`, objects
`0600`. It opens the ledger query-only. Its refusals follow the existing exit table:
- `EXIT_NOT_FOUND` for an absent effect or another task's;
- `EXIT_INTEGRITY` when the plane cannot give the bytes back;
- `EXIT_USAGE` for a bad id or a refused block.

It prints the document as JSON whatever `--format` says, as `tool-call` does.

### Two — one reader, over one reader by reference (decision 152)

**`readByReference(ledger, {artifactReferenceId, scopeKind, scopeId})`** is the
ledger's one read of the private plane that holds nothing.
- It checks that the root stands (present, not a symbolic link, a directory) **before**
  opening the plane, because the plane creates an absent root and a read must create
  nothing.
- It hands the plane a lease store that refuses every holding.
- It returns the plane's own `READ` or `REFUSE`, plus the root's two words `ROOT_ABSENT`
  and `ROOT_NOT_A_DIRECTORY` (`REFERENCE_READ_ROOT_REFUSALS`). The plane's sixteen
  refusals do not move.

`readInitiativeObjective` now reads through it, with the refusals and texts it always
threw, and the objective reader's private copy of the refusing lease store is gone.

**The daemon's copy is inherited debt with an owner.** `daemon/src/composition`
(`:270`) still holds its own `READER_LEASE_STORE` for the instruction-block reader. That
file was outside this escalón's write-set. The owner is **P-18**, whose packet row
carries the obligation: fold the copy into `readByReference` when P-18 reopens the
daemon's composition for recovery.

**`readEffectResult(ledger, {taskId, effectId, block})`**, in the runtime's
`operation-result` concept, is the one reader of a result. That concept is the one
L-P07A-1 admits to the full contract, so it is the one place a result document is parsed
on the way out. It decides in this order:

1. **The effect under this task.** Another task's effect is `NOT_FOUND`, exactly like no
   effect.
2. **No outcome.** `NO_OUTCOME`.
3. **The outcome's integrity**, which the ledger's triggers already hold: an outcome
   without its instant or its contract version is `LedgerIntegrityError`. It is checked
   before the outcome's word is read, so an unresolved outcome missing its instant
   throws rather than answering (v3, verifier V4: the code's order, which the text now
   follows).
4. **The unresolved words.** `OUTCOME_UNKNOWN` and `CANCELLED` are their own answers,
   never a failure and never a result.
5. **The pair's integrity, or no pair.** Half a pair, or a current-cohort `SUCCEEDED`
   without one, is `LedgerIntegrityError`, never a cohort. No pair is
   `NO_RESULT_RECORDED`, with the cohort that explains it: `PRE_RESULT` for the six
   versions in `PRE_RESULT_REFERENCE_CONTRACT_VERSIONS` (now on the ledger barrel),
   `CURRENT` otherwise.
6. **The pair.** The bytes come through `readByReference` under the task's own scope.
   The reader then checks, in order, and the first check that fails decides the word:
   - the reference is a `RESPONSE` (`CLASS_REFUSED`, v3). The ledger's door already
     refuses a pair of another class at append, so this is the reader's own hold on the
     same rule rather than its only guard;
   - the reference's digest against the row's (`DIGEST_MISMATCH`);
   - UTF-8, JSON and the result contract (`DOCUMENT_INVALID`, which covers
     `usageReference`, since the contract refines it);
   - the document's effect and status against the row's (`DOCUMENT_DISAGREES`). The
     ledger's door checks class, scope and digest, never the document's content, so
     this is the one line that catches a mis-planted pair.

   Any refusal is `RESULT_UNREADABLE` with its word, and no partial document is ever
   returned.
7. **A block, only when asked** (F-ND-4, `?block=` / `--block`). It must be a block of a
   `RESULT` that names its own reference, otherwise the answer is `BLOCK_REFUSED`. That
   reference must be a `RESPONSE` (`CLASS_REFUSED`), and its bytes must be the digest
   and the length the document declares (`BLOCK_DISAGREES`). This is how an answer long
   enough to overflow the block list is readable: the overflow is one `document` block
   naming a markdown artifact.

**The class check is the one line between a planted block and the prompt (v3, Fable
C1).** The ledger's door checks the pair's class, scope and digest, never a document's
content, and the task's envelope lives under the same `TASK` scope as its result. So a
`RESPONSE` whose `document` block names the envelope's reference, with the envelope's
own digest and length, is admitted by the door, and without the check its block read
would have served the prompt through the authorized read, whose inventory is
`RESPONSE` alone. It is unreachable from the doors and reachable by a ledger writer that
plants a document; the test that plants it (N-F-24) is refused `CLASS_REFUSED`.

The words a `RESULT_UNREADABLE` may carry are a total record over the plane's sixteen,
the root's two and the reader's five, so a new plane word fails to compile before it
reaches a door's `detail`.

**Discovery (C-F4).** `taskEffects` (`GET /api/v1/tasks/:taskId/effects`) and
`acp effects <task-id>` list a task's effects through a new ledger read,
`listTaskEffects(taskId)`, in the order their intentions were recorded. The list carries
ids, coordinates, outcome words and `hasResult`, never a reference, a digest or a byte.
It is a plain unguarded read, bounded: the ledger reads one row past `MAX_TASK_EFFECTS`
(1000), and the answer is the first 1000 with `truncated: true` when there are more,
never a 500 (v3, verifier V7). It is a sibling route rather than a field on `TaskDetail`,
so the console's reading of the task detail, and the CLI `task` projection under parity,
stay byte-untouched.

### Three — the wire carries the contract itself (decision 151)

`TaskEffectResultResponse.result.document` is `ResultContractSchema`, imported from
`@acp/contracts` (C-F1): the protocol may import contracts, and a mirror would be the
second authority P-07's DT refused. L-P07A-1 admits `protocol/src/schemas` one name
wide, by a map of its own. Every key of the response is present in every state, `null`
where the state has nothing to say, and the refinement holds the table:
- `result` is present exactly under `RESULT`;
- the outcome is `null` exactly under `NO_OUTCOME`;
- an unresolved outcome is its own word;
- a cohort is stated exactly under `RESULT` (always `CURRENT`) and `NO_RESULT_RECORDED`;
- the document's effect and status are the row's;
- a block only under a `RESULT`, at its declared length.

A result that cannot be read is never a 200 beside partial data: it is `500
LEDGER_INTEGRITY` with the closed word as its only `detail`.

**The outcome vocabulary moves to contracts (Four; the DT's ruling on v1).** The wire
needs the four outcome words, the ledger owned them (`EFFECT_OUTCOME_STATUSES`), and the
protocol may import contracts but not the ledger. A copy in the protocol pinned equal to
the ledger's by a test was v1's answer; it is still a second declaration, and the owner's
rule is that no new duplication is made. So the set moves down on P-15/D2's mould for the
usage vocabularies:
- a new contracts module, `effect-outcome`, declares `EFFECT_OUTCOME_STATUSES` and its
  type leaf derives `EffectOutcomeStatus`; both are on the two contracts barrels
  (`CONTRACTS_SCHEMA_EXPORTS` 169 → **171**, one new capability module and its README
  row);
- the ledger re-exports both under the same names from the same leaf, so its barrel and
  every importer read them unchanged, and the ledger's re-export is the same array
  object;
- the two SQL CHECK texts that spell the four words (the attempt's `outcome` and the
  effect's `outcome_status`) stay byte-for-byte, and a ledger test holds each equal to
  the set, in order;
- the protocol's `outcomeStatus` is `z.enum(EFFECT_OUTCOME_STATUSES)`, imported.

`EFFECT_RESULT_STATES` stays declared once, in protocol, as the response's own words:
two of them, `OUTCOME_UNKNOWN` and `CANCELLED`, are also outcome words, because an
unresolved outcome is its own answer rather than a failure. **`CONTRACT_VERSION` does
not move**: a declaration moved and no recorded shape did — the same four words, the
same CHECKs, the same event payloads. No new fence law: D2's guard trio is the guard,
as it was for the usage vocabularies — the export pin, the value-list test in contracts,
and the CHECK equality test in the ledger.

**The effect id is the ledger's shape, stated once.** The route's parameter is the
protocol's one sha-256 grammar, 64 lowercase hex, which is what `effect_read_model`'s
check admits: the schemas module exports it to the routes module inside the package as
`EffectIdParam`, not on the package barrel, and the routes module holds no regex of its
own. (Exported under its own name rather than as `Sha256Hex`, because contracts already
exports a `Sha256Hex` and the fence's cross-package name law refuses a second export of
one name.) That is stricter than the result contract's `effectId` bound of 1..200, which
stays the document's.

**Inherited debt, named with its owner.** The protocol's private `Sha256Hex` is itself a
duplicate of contracts' `Sha256Hex`, byte for byte, and it predates this escalón: it has
18 uses in `protocol/src/schemas` at the base (+3 by F) plus the declaration, and contracts keeps its own off the barrel. F did not
introduce it; F reuses it under a new name. It is not folded here. The fold is **P-37**'s,
and its packet row carries it: put contracts' `Sha256Hex` on its barrel, delete the
protocol's copy, and `EffectIdParam` then aliases the contracts one.

`API_CONTRACT_VERSION` goes 0.18.0 → **0.19.0**: two routes and one error word. The
route surface moves:
- `API_ROUTES`: 20 → 22. A correction to the prestate, which said 21 → 23: the brief's
  "21" was never measured, and the table at the base holds 20;
- `SURFACE_MAP`: 30 → 32, pairing `effects` with `taskEffects` GET (projection) and
  `result` with `taskEffectResult` GET (document);
- `PARITY_BINDINGS`: +2 routes.

`CONTRACT_VERSION` and `MIGRATIONS` do not move, because a read adds no recorded shape;
`CONTRACTS_SCHEMA_EXPORTS` moves only for the vocabulary's declaration (169 → 171).

### Four — the laws (decision 153)

**L-P15F-1, "a result's bytes leave the plane only through readEffectResult, to two
doors".** It applies over every tracked `packages/*/*/src/` `.ts` and `.tsx` file,
comments stripped:
- (i) `resultArtifactReferenceId` is named only by the eight files that record,
  publish or read it: the ledger's row, projection and its types, and types; the
  runtime's events and execution chain; and the result concept with its type leaf. No
  door names it; the doors derive `hasResult` from the pair's presence;
- (ii) `readByReference(` has two callers, the objective reader and the result reader;
- (iii) `readEffectResult(` is called only inside two function bodies, once each:
  `effectResult` in the gateway's `effect-result` module and `buildEffectResult` in the
  CLI's `observation` module. It is function-level since v4 (verifier v3 §2): a second
  exported function in the door module, `rawResult(…) { return readEffectResult(…) }`,
  behind an unguarded GET, served model output while a per-file rule stayed green. A
  call anywhere else in those files, a second call in the body, or none at all fails;
- (iv) inside `effectResult` and `buildEffectResult` no logger, console, telemetry,
  stream publication, standard stream or event append is named.

- (v) the doors' own wrappers are held to one registration each (v3, verifier V1).
  Before v3, a new unguarded GET calling the gateway's exported `effectResult` served
  model output with no bearer and no `no-store` while every other clause stayed green
  (B07, proved end to end). Now `effectResult(` is called exactly once in gateway
  `src`, inside the `registerPrivateGet(app, API_ROUTES.taskEffectResult, …)`
  registration, and `buildEffectResult(` exactly once in cli `src`, inside `runResult`,
  which the handler table binds to `result`. Zero sites is a stale law.

Stated limit: a text-level matcher, so an alias, a bracket call or a re-export under
another name is not seen, and what `stripComments` hides it does not read (ADR 0106
§Three). Clause (iv) reads names inside two function bodies: it does not see a logger
reached through a file-level helper the function calls (B11), nor a file write
(`writeFileSync`, `appendFileSync`, `createWriteStream`) or a network send (`fetch`)
there (Fable C3).

**Errata (P-15/E, 2026-09-23):** Stated limit (Fable, F post-audit R4): clauses (iii) and (v) count call sites. A closure that captures the one lawful `readEffectResult(` / `effectResult(` call inside the door's own body and escapes it by assignment to module-level state is one site inside the body and is not seen — the alias family's sibling, deliberate rather than accidental.

**L-P15F-2, "every private read route is registered behind the bearer".** Every name in
`API_PRIVATE_READ_ROUTES` is registered through `registerPrivateGet` and through no
unguarded registrar. `registerPrivateGet` registers nothing outside the table. The
registrar refuses an unconfigured server, then checks the bearer, and only then runs
its handler, in that order. Stated limit (B09): the order is read from the first textual
`return handler(`, so a conditional earlier call assigned to a variable before the
bearer check is not seen. And L-P07A-1's amended row does not see a namespace import
read by a computed key (B13).

`PATH_SCOPED_LAWS` 154 → **156**. `RUNTIME_PUBLIC_EXPORTS` 296 → **299**
(`readEffectResult`, `EffectResultRequest`, `EffectResultReading`).

### Five — the door-to-result drills, and what they close (decision 154)

The daemon's execution drill gains P-15/F's rows, on D4's harness. Each row:
- enters by a real door, the compiled `acp intake` or `POST /tasks` on a spawned
  `acp-server`;
- runs the recorded daemon through its packaged entry against a synthetic child behind
  the real Claude adapter's argv;
- reads the result back through **both** new doors, by an effect id a door gave it.

The rows:
- **PC-F1, CLI intake.** The answer is padded past the block list. It is read as one
  document block by reference, then by `?block=0` / `--block 0`. The two doors give
  equal documents, and the block's text is the answer, verified.
- **PC-F2, HTTP intake.** A short answer is read inline, and a block read is refused
  by name.
- **D-F-3.** The captured authentication failure is `NO_RESULT_RECORDED` / `FAILED` /
  `CURRENT`.
- **D-F-6.** `is_error` with exit 0 is a `FAILED` `RESULT` with its document.
- **D-F-7.** A child killed mid-stream is `FAILED`, and the output it had given is its
  `FAILED` document (P-07 Q-D9 applied by D3's decider). It is never `SUCCEEDED` and
  never `NO_OUTCOME`. This is what the code does, measured by the drill. The prestate
  expected no document there, and the drill corrected it.

Each run carries a sentinel in its instruction, which the child echoes into its answer.
- **Positive control:** the sentinel is in the authorized reads.
- **Absence sweep:** it is in none of the following:
  - the event stream from its first row;
  - the public GETs: events, the task, the overview and the effects list;
  - the server's own output;
  - the CLI's stderr;
  - every row of every SQLite file beside the ledger.

The private plane and the daemon's evidence root are the declared private side and are
not swept. On the running server the drills also check:
- `403` from a server started without a bearer;
- `404` for another task's effect, identical to an absent one;
- `405` on the other methods;
- a byte flipped under the plane: `500 LEDGER_INTEGRITY` / `CONTENT_DOES_NOT_VERIFY` on
  HTTP and `EXIT_INTEGRITY` with empty stdout on the CLI.

**E's obligation.** D-F-4 (`API_KEY`, E's substitute `fetch` replaying a recorded
Messages stream) and D-F-5 (`LOCAL_OR_SELF_HOSTED`, E's fake OpenAI-compatible stream)
need E's real clients, which are not committed. **E is not acceptable without those two
rows**, entering by a real door and reading back through `acp result` and the private
GET. The P-15 packet row carries the obligation.

**B15 closes in two stages (F-ND-8).** F closes B15's **code** acceptance: real doors
both ways, synthetic children. The register's B15 row flips at M2 only with G's
authorized smoke S1, or with an explicit DT ruling that synthetic children suffice. The
requirement row carries that marker now.

## Consequences

- An effect's result is readable, and readable only through two authorized doors:
  - the bearer-guarded route;
  - the CLI verb under filesystem authorization.
- A caller learns effect ids from a plain list that carries no content.
- One reader by reference in the ledger, one result reader in the runtime.
- One credential for writes and reads, stated rather than implied, until P-36.
- Pins: `API_CONTRACT_VERSION` 0.19.0, `API_ERROR_CODES` 16, `API_ROUTES` 22,
  `SURFACE_MAP` 32, `RUNTIME_PUBLIC_EXPORTS` 299, `PATH_SCOPED_LAWS` 156,
  `CONTRACTS_SCHEMA_EXPORTS` 171.
- The effect outcome vocabulary has one declaration, in contracts.
- Inherited debt with owners:
  - the daemon's lease-store copy → P-18;
  - D-F-4/D-F-5 → E;
  - B15's M2 flip → G/S1 or a DT ruling.
