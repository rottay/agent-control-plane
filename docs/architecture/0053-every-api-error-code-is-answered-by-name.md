# ADR 0053 — Every API error code is answered by name

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

`API_ERROR_CODES` is a closed vocabulary of fifteen words
(`packages/kernel/protocol/src/schemas/index.ts:205-282`). Both write doors
answer it. The gateway answers with `STATUS_BY_CODE`
(`packages/entrypoints/gateway/src/errors/index.ts:44`), a
`Record<ApiErrorCode, number>` — total by type, one status per code, and the
compiler will not accept it otherwise. The CLI answered with `refusalExitCode`,
a `switch` that named six codes and sent the other nine to `EXIT_USAGE` through
a `default:` arm.

ADR 0049 measured this when it closed the verb-to-route registry and declined to
widen: "`refusalExitCode` is untouched here. **Owed as `R1b`, before backend
closure**" (`0049-one-map-names-what-each-door-answers.md:195-202`).

**Nothing was misrouted.** That measurement is worth stating plainly, because it
is what bounds this record. The codes the two CLI doors actually raise are six —
`BAD_REQUEST`, `NOT_FOUND`, `WRITE_REFUSED` and `LEDGER_UNAVAILABLE` from both,
plus `CLAIM_HELD` and `INTERNAL` from the tool-call door — and five of them had
explicit arms. `BAD_REQUEST` earned its `2` honestly. `LEDGER_INTEGRITY` and
`CAPABILITY_UNSUPPORTED` never reach this function at all: the first is decided
by `fromLedgerError` and the second by `lifecycleExitCode`. So the CLI's
published exit-code table was true as written.

The defect was the sixteenth code. A new member of `API_ERROR_CODES`, or an
existing code a door starts raising, became a `2` — and a `2` tells an
operator's script that the arguments were wrong, which is the one response that
cannot help. The number was not chosen for that code by anyone; it was inherited
from a catch-all. A closed vocabulary answered by a catch-all is a table that
agrees with any future, which is the same thing as agreeing with none of them.

One further fact, measured while writing the falsifying fixture rather than
predicted: an off-vocabulary code did not simply become a `2`. The decider chose
`2` and returned it, and then `ApiError.parse` — one line later, building the
envelope — rejected the unknown code with a schema error. So the failure a
caller actually saw came from the validation layer, about a code, several frames
away from the door that had already silently decided the exit number. The
fail-open produced both a number nobody chose and an incoherent report of it.

## Decision

The `switch` becomes a table, and the miss becomes a refusal.

`EXIT_BY_CODE: Record<ApiErrorCode, number>`
(`packages/entrypoints/cli/src/cli/index.ts`) names all fifteen codes, mirroring
the shape `STATUS_BY_CODE` already has at the other door. There is no
`default:`, so **a sixteenth member of `API_ERROR_CODES` is a compile error**,
and `pnpm check`'s typecheck stage is that half's enforcement — the union is
erased before any runtime assertion could observe it.

`refusalExitCode` reads the table through a lookup that is allowed to miss and
throws `UnnamedRefusal` when it does. The compiler cannot produce a miss in a
build it has checked; a cast at a door, a hand-built refusal or a code
deserialized off a wire by a driver can. Those are exactly the three cases the
`default:` used to answer with `EXIT_USAGE`, and there is no number that is
right for a code this package has never heard of. Refusing is the honest answer:
a script sees a crash it can investigate rather than a `2` it will act on.

**Every number is the number the code already returned.** Six were explicit and
nine were inherited from the `default:`, and all fifteen are unchanged:

| Code | Exit | Was |
| --- | --- | --- |
| `NOT_FOUND` | `4` | explicit |
| `CONTRACT_VERSION_MISMATCH`, `LEDGER_UNAVAILABLE` | `5` | explicit |
| `WRITE_REFUSED` | `6` | explicit |
| `CLAIM_HELD` | `7` | explicit |
| `INTERNAL` | `1` | explicit |
| `BAD_REQUEST`, `METHOD_NOT_ALLOWED`, `AUTH_REQUIRED`, `WRITE_BEARER_UNCONFIGURED`, `TOOL_SERVERS_UNCONFIGURED`, `STREAM_CAPACITY`, `LEDGER_INTEGRITY`, `CAPABILITY_UNSUPPORTED`, `SCENARIO_UNCONFIGURED` | `2` | `default:` |

The suite proves it rather than the record claiming it: every one of the fifteen
is driven through the real lifecycle door with an injected driver that refuses
with that code, and the exit number is compared against a table written
independently of the decider's (`packages/entrypoints/cli/test/cli/index.test.ts`).

**The two doors are pinned to each other by the fence.** The compiler pins each
table to the vocabulary separately, but the two tables never meet:
`STATUS_BY_CODE` is module-private, the CLI does not depend on `@acp/gateway`
and must not, and no third module names both. So a law in
`scripts/check-architecture.mjs` reads both files as text and asserts they name
the identical codes, both directions — the technique the api-reference law
already uses for `SURFACE_MAP`, chosen for the same two reasons: the fence is
dependency-free and runs before any build, and reading the source is the only
way to compare a private table with anything at all. It asserts two named files,
selects nothing by path, and so registers no scope and calls no `requireScope`.

## Why re-assigning the nine was not chosen

It is a real question, and it has a real answer that is not this record's.

Four of the nine are the gateway's 503 family — `STREAM_CAPACITY`,
`TOOL_SERVERS_UNCONFIGURED`, `SCENARIO_UNCONFIGURED` and, in the gateway's
table, `LEDGER_UNAVAILABLE` — and a plane that is temporarily unable to serve is
what `EXIT_UNAVAILABLE = 5` exists to say. `AUTH_REQUIRED` and
`WRITE_BEARER_UNCONFIGURED` arguably earn numbers of their own, on exactly the
reasoning that earned `EXIT_CLAIM_HELD` and `EXIT_CAPABILITY_UNSUPPORTED` theirs.

But the CLI's exit codes are a published contract that scripts branch on, and
changing one of them is a behaviour change to that contract: it moves the
table in `packages/entrypoints/cli/README.md`, and it can only be argued code by
code. Folding it into the packet that makes the vocabulary total would mean a
record whose central claim — nothing about the fifteen changed — is false, and a
diff in which the mechanical half and the arguable half cannot be reviewed
apart. Totality first, with every number preserved and asserted, leaves the
re-assignment a small and well-posed successor rather than a larger one.

## Why the table was not exported for the test to read

A test that imported `EXIT_BY_CODE` and asserted things about it would be
asserting the table against itself, and it would grow the package's public
surface to do it — this decider has been module-private since it was written,
and nothing outside the file imports it. Instead the suite drives all fifteen
codes through `run` with an injected driver that raises `LifecycleRefused`, so
what is measured is what a caller receives. The off-vocabulary fixture is the
same shape: a cast code through the same door, asserted to be refused by name.
Both were red before this change and are green after, and the fifteen-code
fixture goes red if a single number is re-assigned.

## Consequences

An unknown code now crashes the process instead of exiting `2`. That is the
trade, taken deliberately: an exit code is an answer, and this package would be
inventing one on behalf of a caller it does not understand. A crash is
diagnosable and a wrong `2` is not — it is acted on.

The guard is unreachable from a build the compiler has checked, which means it
is code whose only proof is a test that casts around the type. That is
acceptable here for the same reason `STATUS_BY_CODE`'s totality is: the value of
the type is that it makes the runtime branch unnecessary, and the value of the
branch is that it stays correct when someone reaches the function from outside
the type system.

Adding a code to `API_ERROR_CODES` now costs two edits rather than one: the
gateway's status and the CLI's exit number. Both are compile errors until they
are made, and the fence names the mismatch if only one is. That is the cost this
record is buying.

The exit-code table in the CLI's README does not move, because no number moved.
It gains one sentence recording that the table is now total over
`API_ERROR_CODES` by construction rather than by inspection.

## Not in this record

**The re-assignment of the nine.** The 503 family earning `EXIT_UNAVAILABLE`,
and `AUTH_REQUIRED` / `WRITE_BEARER_UNCONFIGURED` earning their own numbers, is
the successor question described above. It is a behaviour change to a published
CLI contract, it moves the README's exit-code table, and it is owed its own
record and its own packet.

**The two CLI README debts ADR 0049 excluded by name.** Nothing serializes two
runs of `tool-call` (`packages/entrypoints/cli/README.md:135-144`), and the
claim that every printed document is schema-parsed (`:148-153`). 0049 cites them
at `:122-131` and `:133-140`; the paragraphs moved down the file after it landed
and their words did not, so the spans above are the re-measured ones. "Neither
is this packet's to fix" was true when 0049 said it and it is true here.

**Whether every `PROJECTION` arm has a live behavioural comparison.** Owed to
the computed closure gate, as `0049-one-map-names-what-each-door-answers.md:203-205`
records.

**The gateway's table.** It was already total by type and is untouched. This
record changes one door to match the other; it does not change the vocabulary,
the statuses, or anything the API answers.
