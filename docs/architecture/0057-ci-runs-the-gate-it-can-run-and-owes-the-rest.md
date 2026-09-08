# ADR 0057 — CI runs the gate it can run, and owes the rest

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

`.github/workflows/ci.yml` was frozen in P0 as a contract for a repository that
was not yet published. It was published on 2026-09-03, and the contract went
live carrying a sentence about itself:

> CI runs exactly the same gate a local writer runs, and nothing here may
> diverge from `pnpm check`.

That sentence was false on the runner it was written for, and had been since the
day it went live.

`pnpm check` chains four stages — `check:architecture`, `lint`, `typecheck`, and
`vitest run --reporter=dot` over every project the topology defines. Two of
those projects require a Restate server that exists on disk and matches a
tracked pin. `scripts/restate-server.pin.json` carries exactly one platform
entry, `darwin-arm64`, and `scripts/acquire-restate-server.mjs` refuses any
other key with an `AcquisitionError` before it makes a network call. The job
runs on `ubuntu-latest`, which is `linux-x64`, and none of its steps runs the
acquisition script. The binary is therefore absent, and `serverAvailability()`
returns `{ available: false, … }`.

The suites do not skip on that. They assert it:

- `packages/edges/durability/test/lifecycle-operation/index.test.ts:400`, under
  a title that says the intent out loud — "has a verified server to run against,
  and fails rather than skipping" — and four more assertions of the same
  equality in `test/drivers/drills/index.test.ts` at `:881`, `:935`, `:1016` and
  `:1097`, one of which explains itself: "a drill suite that skipped here would
  be indistinguishable from one that passed, and the adoption decision rests on
  these drills."

There is no `skipIf`, no `runIf`, no environment variable and no availability
branch anywhere in either tree. That is the correct design, and it is exactly
why the workflow's promise could not be kept: the suites were built so that an
unavailable server is a failure, and CI gave them an unavailable server.

**The defect is larger than the durability edge, which is the part that had been
measured wrong.** An earlier map of this decision recorded that the daemon
drills were platform-independent, on the strength of `startRestateMode` taking
an injectable `readAvailability`. A preaudit refuted it and the measurement
holds:

- `packages/entrypoints/daemon/test/drills/index.test.ts` spawns the real child
  binary (`dist/daemon-child/index.js`) in `mode: "RESTATE"` at nine sites. The
  child runs production code — `daemon-child` calls `startDaemon`, which calls
  `startRestateMode` with no `readAvailability` key — so it resolves
  availability itself, throws `ModeError`, and dies. The injection exists in
  exactly one place in the whole tree and it is in-process; the child's config
  crosses as JSON over argv, and a function does not fit through that.
- `packages/entrypoints/daemon/test/drills/lifecycle/index.test.ts` mounts the
  server in-process through `startPlane`, also with no injection, and its gate
  drills emit `mode: "RESTATE"` receipts.

So two projects are red on Linux, not one.

They differ in an important way. The durability edge separates cleanly: its
three test files are two server-bound trees and one hermetic driver suite that
scripts `globalThis.fetch` and binds nothing. The daemon does not. Its
server-bound and hermetic tests are interleaved inside single files — ten
top-level describes in the drills suite alone, mixing "the SQLite mode" and
"what the child will accept" with "the Restate mode" — so no glob separates
them.

## Decision

**CI runs the gate it can run on its runner, names the two projects it cannot,
and owes them.**

Three things change together.

**1. `durability` splits in two, by glob and by nothing else.**
`durability-server` takes `test/lifecycle-operation/**` and
`test/drivers/drills/**` and keeps the port-binding group order; `durability`
keeps the hermetic driver suite and joins group 0 with every other project that
binds nothing. No test moved, no assertion was relaxed, and no availability
branch was added. Locally the union is byte-for-byte the suite that ran before —
there are no tests under the edge's `src/`, and the edge has exactly three test
files, one on one side and two on the other.

**2. The daemon is excluded whole.** Splitting it means moving describes between
files in a suite that emits receipts, and that is test surgery with its own
risk. It is owed to the follow-up that will run these on Linux, which needs the
split anyway.

**3. The workflow declares its subset by positive enumeration, and the fence
computes the guard.** The `Check` step runs the four stages `pnpm check` chains,
with the vitest stage naming its fifteen projects one by one.

Naming them positively rather than excluding two was forced, and the reason is
worth recording because it looks like a free choice and is not. Vitest 3.2.4
compiles `--project '!name'` to a negative lookahead and combines repeated
filters with `.some()`. One negation works. **Two negations are a tautology**:
every project name fails to equal at least one of them, so `.some` admits
everything. Measured against the pinned `dist` — the two-negation form selects
all 151 files, the same as no filter at all. There is no `--exclude-project`, and
no single wildcard covers `daemon` and `durability-server` without also taking
`durability`, which CI must run. A filter in `vitest.config.ts` would have
suppressed the projects locally too, where they pass.

Positive enumeration has the wrong failure direction on its own: a sixteenth
project added later would silently never run in CI, and nothing would say so —
the same class of defect as the sentence this record repeals, one level down. So
the direction is bought back mechanically rather than promised.

**`L-R18-1`** parses the project names out of `vitest.config.ts`, subtracts the
two OWED names, and compares the result against the workflow's enumeration in
**both** directions: a project the config defines and CI omits, an OWED project
CI names anyway, and a name CI declares that the config does not define are each
a failure that says which side moved. It also pins the job's seven steps — an
eighth step is how acquisition would arrive — and pins the split, so the
server-bound trees cannot drift back into the project CI does run. CI executes
this fence as the first line of its own gate step, so the check binds on the
runner and not only on a writer's laptop.

**`L-R18-2`** requires the amended comment to carry both excluded names, the
word `OWED`, the `darwin-arm64` reason and the `POST_AUDIT_FOLLOW_UP`
destination. An amendment nobody checks is how the first sentence got to be
false for four days.

**What is OWED, stated as debt rather than as absence.** `durability-server` and
`daemon` are not run on the runner. Both run green locally on darwin-arm64 under
`pnpm check`, which is unchanged and still runs everything. The debt is
discharged by `POST_AUDIT_FOLLOW_UP` B5 — a `linux-x64` server pin, a hermetic
runner set, and a Linux identity probe — and the B-E certification record carries
the OWED row, citing this record.

## Why pinning Linux instead was not chosen

It is the better end state and it is the other half of the row this decision
comes from. Adding a `linux-x64` entry to the pin, widening
`SUPPORTED_PLATFORMS`, and adding an acquisition step would let CI run
everything, and then no subset and no OWED row would be needed at all.

It was not chosen here because it is classified `POST_AUDIT_FOLLOW_UP`, not
old-V2, and the classification is not a formality: the pin is a new supply-chain
surface (a second platform's binary, a second digest, a fetch inside CI), the
daemon suites additionally need the file-level split this record just declined
to perform, and `probeIdentity` returns `UNSUPPORTED_PLATFORM` off darwin, so a
Linux runner would need its own identity work before those drills meant
anything. That is a packet, with its own audit. Choosing it here would have
meant doing it badly and calling the CI question closed.

The cost of deferring is stated rather than hidden: until B5 lands, the Restate
drills and the daemon drills are proven on one platform, by one writer's
machine, and CI cannot corroborate them.

## Why the workflow was not simply left alone

Leaving it meant one of two things. Either CI stays red forever on `main`, in
which case a real failure is indistinguishable from the standing one and the
signal is worth nothing — or the whole `Check` step is quietly dropped, which
trades a false sentence for no gate.

There was a third option that looks like honesty and is not: making the drills
skip when the binary is absent. That would turn every suite in this record's
Context into a suite that passes on a runner that proved nothing, which is the
precise thing those files say, in their own comments, that they exist to
prevent. The exclusion is therefore by **project selection in CI**, and the
suites are untouched.

## Consequences

- **`pnpm check` and CI are no longer the same command, and the workflow now
  says so.** A local writer still runs everything; the runner runs fifteen of
  seventeen projects. Anyone reading `ci.yml` learns which two are missing, why,
  and where the debt goes.
- **The vitest topology gains a project**, 16 → 17. `durability-server` is a
  name that exists so that something can be honestly excluded — the split has no
  other purpose, and locally it changes only which group the hermetic suite runs
  in.
- **A new project must be added in two places.** `L-R18-1` fails the build until
  `vitest.config.ts` and `ci.yml` agree, in both directions. That is the cost of
  a positive list, paid mechanically instead of remembered.
- **`PATH_SCOPED_LAWS` stays at 117.** Both laws read named literals and neither
  registers a scope. The ADR corpus moves 56 → 57, and the write set gains one
  distinct path, 552 → 553.
- **Two `README.md` sentences were corrected.** One claimed CI runs "the
  identical check a local writer runs", which this record makes false; the other
  claimed "13 project scopes", which had already been false through several
  packets and which nothing checked.
- **The evidence that the subset is green on Linux is OWED, not held.** It
  cannot be produced on the machine this packet was written on, and no claim
  that it exists is made anywhere. The first CI run on `main` after this lands is
  the measurement.

## Not in this record

The `linux-x64` pin, the hermetic runner set and the Linux identity probe — B5,
`POST_AUDIT_FOLLOW_UP`, with the daemon's file-level split as its prerequisite.
Whether the eval lane is ever wired into CI, which ADR 0056 left behind the same
workflow contract this record has now amended: the contract is narrower, not
opened, and adding a job is still a separate decision. And the B-E certification
row itself, which is written where the certification record lives and cites this
one.
