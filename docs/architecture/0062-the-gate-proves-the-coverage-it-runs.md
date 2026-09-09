# ADR 0062 — The gate proves the coverage it runs, and owes the runs it never had

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

ADR 0057 split the vitest topology so the hosted runner could run the fifteen
projects it supports and name the two it cannot. `L-R18-1` computes that subset
in both directions and `L-R18-2` requires the workflow to say what it excludes
and why. Both laws are about **CI's declaration**. Neither is about the other
half of the arrangement, which 0057 stated in prose and left unchecked:

> Both run green locally on darwin-arm64 under `pnpm check`, which is unchanged
> and still runs everything.

That sentence is the whole basis on which `durability-server` and `daemon` are
called OWED rather than absent. It rests on a binary that is not in the package
graph, is not tracked, and arrives only when an operator runs
`scripts/acquire-restate-server.mjs`. If that binary were missing, the two
suites would fail loudly — but only for whoever ran them. If it were present and
substituted, they would pass against something the pin does not describe. In
neither case did anything in the repository state, as a checked fact, that the
host which is supposed to prove the coverage actually can.

The owner's ruling of 2026-09-09 authorized P-04 inside M0 (option A) and
delegated the runner and binary selection to the DT within the scope §3.3
already fixed. That ruling also fixed the distinction this record is built
around: **a written configuration is not an executed run.** Three states can be
true of a suite, and conflating any two of them is how a gate comes to report
confidence it never earned.

The measured state of the third class, on the day this record lands: the hosted
workflow has four runs, all `failure`, on `a92756b`, `6336fec`, `eab4bfe` and
`46a70bd`. `a92756b` is the newest, and the nine commits after it — P-02, P-03
and their follow-ups — have never been pushed, because publication is the
owner's act and no writer here performs it. Every one of those four runs
predates the commit at which the fence became green in the region R18 touched.
There is therefore **no green CI run to point at**, and nothing in this
repository may be written as though there were.

## Decision

**The macOS coverage claim is proved where it runs, declared as unprovable
where it does not, and the run CI never had is recorded as empty rather than
implied.**

Three things are fixed together.

**1. The runner is the operator's darwin-arm64 host, and the binaries are the
ones already pinned.** No new runner, no new service, no new pin, no
dependency, no upgrade. `node` `22.17.0` (`.nvmrc`), `pnpm` `10.26.2`
(`packageManager`), and the Restate server `1.7.7` for `darwin-arm64`
(`scripts/restate-server.pin.json`, archive digest and binary digest both). The
selection is what §3.3 anticipated — "a macOS runner with the pinned binaries
supports the suites specific to that system today" — and it costs nothing
because the host already exists and already runs the suites.

**2. `L-P04-1` turns the local half into a measurement.** On the host the pin
describes a build for, the law requires the binary to be present at the
convention the runtime states and to hash to the pin's `binarySha256`:

- the install directory is read from `RESTATE_SERVER_INSTALL_DIR` in
  `packages/domains/runtime/src/constants/index.ts`, not restated here, so a
  law aimed at a path nothing runs from is not a shape this can take;
- the digest is computed over the file's own bytes. The receipt the acquisition
  script leaves in the install directory is not consulted, for the reason the
  pin's own comment gives: a substituted binary carrying a matching receipt
  would pass a check that read the receipt;
- on success the note names the two projects — `durability-server` and `daemon`,
  taken from `CI_OWED_PROJECTS` rather than restated — as covered on the host
  that runs them, and says which binary at which path it proved that with.

**3. On any other host the same law says what it cannot say.** The branch is
not a hardcoded platform string. It is whether `process.platform + "-" +
process.arch` is a key the pin describes a build for — the same question
`platformKey()` and the acquisition script ask. The pin carries `darwin-arm64`
alone, so `ubuntu-latest` (`linux-x64`) takes the second arm, where the law
reports no violations and proves nothing, and says so in those words. The fence
stays green on the runner, and it stays green there without asserting anything
about macOS. When P-38 adds the Linux pin the runner begins taking the first arm
with no edit to this law.

**The three classes, named so they cannot be blurred.** `L-P04-1` requires this
record to state each of them as a literal:

| Class | Meaning | Where it is established |
|---|---|---|
| `TESTS_RUN_LOCALLY` | executed on this host, this toolchain, these binaries | `L-P04-1`, first arm, every run |
| `CI_CONFIGURED` | declared in the workflow the runner executes | `L-R18-1` and `L-R18-2`, both directions |
| `CI_RUN_VERIFIED` | a run on the runner whose result was observed | nothing in the fence; this record |

The third class is held here because the fence cannot hold it. The fence reads a
working tree and asks git read-only questions; neither answers what a hosted
runner did. Its standing value is **`CI_RUN_VERIFIED: NONE`**, and that literal
is what the law checks — on this host and on the runner alike. A `PASS` is never
born from an absence, and the absence is therefore written down.

**Linux stays `PROVISIONAL`, with its exclusions named one by one.** §3.3 says
the current hermetic coverage on Linux runs a subset and names what it excludes;
`P-38` adds the missing pins and the per-host service tests, and only then does
Linux become complete. Nothing in this packet advances that, and nothing in it
pretends the same suite runs on both systems today.

## Why a hosted macOS runner was not chosen

It is the arrangement that would discharge `CI_RUN_VERIFIED` for these two
projects, and it is the obvious answer to the question this packet asks.

It was not chosen because the owner's ruling forbids new spending, new
infrastructure and new services, and a hosted macOS runner is all three: it is
billed per minute at a multiplier, it needs the acquisition script to run inside
CI — which is Option B, explicitly deferred by 0057 and pinned against by
`L-R18-1`'s seven-step check — and it would put a 185 MB download of an
unpinned-in-CI binary on the critical path of every push. The scope §3.3 fixed
is a runner that supports the macOS-specific suites *today*, and the operator's
host does, at zero cost.

The cost of that choice is stated rather than hidden, and it is the same cost
0057 already recorded one level up: these two projects are proven on one
platform, by one machine, and no independent party corroborates them. This
record does not reduce that exposure. It makes it legible, and it makes the
local half a measured fact instead of a sentence.

## Why the law was not written as a platform allow-list

The first shape considered was a law that reads `darwin-arm64` from a constant
in the fence and requires the binary whenever the host matches it. It is
shorter, and it is wrong in a way that only shows up later.

A hardcoded platform makes the law's silence on every other host a *coincidence
of the constant* rather than a consequence of the pin. It would keep proving
nothing on Linux after P-38 pinned a Linux build, because the constant would not
have moved. Reading the branch off the pin's platform table means the law's
scope is exactly the set of platforms this repository claims it can acquire a
server for — which is the set the acquisition script enforces at run time and the
set `L-R18-1` subtracts its OWED projects from. One source, three consumers.

It also makes the second arm testable without lying about the host. A probe
writes a synthetic tree whose pin describes a platform that is not the one the
probe runs on, and the law takes the runner's branch for the runner's actual
reason. No environment override exists to tell the fence it is somewhere it is
not, and none was added: a seam that can be told "you are on Linux" is a seam
that can be used to skip the proof this law exists to compel.

## Consequences

- **`pnpm check` now costs one SHA-256 over 185 MB.** Measured on this host at
  153 ms, read and hash together, against a gate that already runs for minutes.
  It is paid on every run, including runs on hosts where the law then proves
  nothing, because the pin is read before the branch is taken.
- **The corpus is append-only, so the third class is expensive to change.** The
  day a pushed commit with a green fence produces a verified run,
  `CI_RUN_VERIFIED: NONE` stops being true, and correcting it takes a
  superseding record rather than an edit to this one. That is deliberate: the
  claim "CI has been observed green" should cost a decision, not a commit
  message.
- **The two OWED projects now have two laws between them and a false claim.**
  `L-R18-1` keeps CI from silently running or silently dropping them;
  `L-P04-1` keeps the local coverage from being asserted by a host that cannot
  produce it. Neither says anything about the runner having executed them.
- **`PATH_SCOPED_LAWS` stays at 117**, the ADR corpus moves 61 → 62, the write
  set gains one distinct path, 577 → 578, and the literal-path scan's live count
  moves 314 → 315 with its distinct count unchanged at 191 — the one new literal
  names a file a live law already held. Its epoch homes move 172 → 173, which is
  `P04_WRITE_SET` itself: a write-set array is a frozen record by name, and this
  packet adds one.
- **A writer without the binary sees the fence fail before the suites do.** That
  is the intended direction, and it is a new obstacle for anyone cloning this
  repository on a Mac who has not yet run the acquisition command. The refusal
  names the path and the reason, and the acquisition script is one command.

## Not in this record

The Linux pin, the hermetic runner set and the per-host service tests — `P-38`,
which is where Linux stops being `PROVISIONAL`. Whether CI should ever acquire
the server itself, which is Option B and still deferred. The daemon's
file-level split into hermetic and server-bound suites, which `P-38` needs and
0057 declined to perform. And the publication of any commit at all: `main` has
nine commits the canonical remote has never seen, and moving them is the owner's
act, not a writer's and not this record's.
