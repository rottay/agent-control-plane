# ADR 0032 — An engine that answers is not an engine that failed

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

`RestateDriver` had two opposite treatments of one engine fact, and the
asymmetry is what makes this record necessary rather than tidy.

`cancel` let a `404` and a `409` fall through to settlement: the engine is not
running this invocation, which is exactly the postcondition act 2 exists to
reach. `reattach` threw on **every** non-ok status, `404` included, with the
number interpolated into prose — and `SupervisorError` carries a message and
nothing else, so the status was unreachable to a caller and unprintable by
policy.

The consequence reached both doors. The CLI reported exit `5`, "the engine could
not be reached, look again". The API answered `503 LEDGER_UNAVAILABLE`. Both are
retry hints, and both were false: the engine had been reached, and had answered.
A caller looping on that answer would loop forever.

The gateway door said so in writing. Its comment claimed that "a server that
could not be reached, an address that does not resolve **or an invocation the
engine never heard of** are failures of the CHANNEL, not answers about the
work". The drills had measured the opposite all along: a never-issued key
answers `404` from a real server with the ledger untouched. The sentence was not
a mistake about the world so much as a description of the driver's limitation,
written as though it were one — the door had no way to tell the two apart, so
the comment explained the behaviour it was stuck with.

ADR 0029 deferred exactly this, by name: *"A typed status on `DriverOutcome` …
is a durability-edge change, deferred by name."* L2 and L3 are what made it
worth carrying: before them there was no door, and a refusal nobody presents is
a refusal nobody needs. `DRIVER_REFUSALS` is a kernel enum, and the cheapest
moment to widen one is while it has exactly two consumers.

## Decision

`DRIVER_REFUSALS` gains a fourth member, **`INVOCATION_NOT_FOUND`**: *the engine
was reached and answered that it holds no invocation at this address.*
`RestateDriver.reattach` returns it on `404` instead of throwing, and both doors
present it as a not-found rather than as an unreachable engine.

**Definite about the answer, silent about the cause.** The member says what the
engine said and nothing about why, because the driver cannot know why without
reading the engine's response body — which this plane refuses to do, and which a
pinned test already enforces.

**Only `404` maps. `409` on attach has no measured semantics at
`restate-server 1.7.7`; it is a throw until a drill produces one.** Every other
non-ok status — `409`, `403`, `400` and every `5xx` — keeps today's throw.
Inferring attach-`409` from the admin cancel's `409` would be inference rather
than measurement: every `409` this repository has measured or stubbed is on
another path, and the drills show that an attach to a completed invocation
answers the result rather than a conflict.

**`cancel` is byte-identical.** Its branch was not touched; only its comment was
restated in the new vocabulary. On that path the settlement decides rather than
the engine — an invocation the engine no longer holds may still have an intent
the ledger must close — which is the opposite of `reattach`, where a `404` is
the whole answer because there is nothing to settle. One engine status, two
paths, two honest treatments. A drill asserts the event trail is unchanged.

**Unreachable stays a throw.** Connection failure, DNS failure, `5xx`: the
channel failed and no answer exists. Turning a channel failure into a refusal
would be the mirror image of the bug this record fixes.

**The status number is branched on and discarded.** No door prints it, no ledger
row carries it, no response body names it. The refusal name is the whole answer.

**Nothing is appended.** `reattach` appended nothing before and appends nothing
now.

## Why the name is not `INVOCATION_UNKNOWN`

`UNKNOWN` is already this vocabulary's epistemic marker: `POSTCONDITION_UNKNOWN`
means "could not be established". Reusing it for a *definite* answer is exactly
the ambiguity worth avoiding — one member would mean "I could not find out" and
its neighbour would mean "I found out, and the answer is no". `NOT_FOUND` is
definite, keeps the vocabulary's `NOUN_STATE` shape beside `TASK_TERMINAL` and
`CAPABILITY_UNSUPPORTED`, and lines up with all three surfaces that present it:
HTTP `404`, the API code `NOT_FOUND`, and the CLI's `EXIT_NOT_FOUND`.

`CAPABILITY_UNSUPPORTED` was wrong for it because the engine *can* reattach and
simply has nothing to reattach to. `TASK_TERMINAL` was wrong because the
**ledger** is the authority on terminality, and it may hold a live attempt whose
engine record has aged out.

## Why the retry guidance is bounded rather than "no"

A `404` on the attach path has **two measured causes**, and this is the part a
reader is most likely to need later:

1. **The invocation is genuinely absent** — a never-issued key with the object
   deployed.
2. **The deployment is not registered** — against a bare server the same attach
   paths answer `404` for an *unknown service*. That is a fact about the
   deployment, not about the invocation.

Both are drilled against a real engine, and both answer `INVOCATION_NOT_FOUND`.
A caller whose daemon endpoint is not yet registered would therefore receive it
for a **live** attempt — and, told "do not retry", would abandon real work. So
the guidance is *"not as a loop; confirm the endpoint is registered, then ask
once more — the ledger remains the authority"*, and the ambiguity is recorded by
a test rather than left for an operator to discover.

Reading the body to disambiguate was considered and refused. It is the one thing
that would make the answer precise, and it would put engine-authored text on a
plane surface — the boundary that keeps engine-minted identity out of every
response.

## Consequences

**`NOT_FOUND` now has two sources on the lifecycle route**, deliberately sharing
one code: the ledger pre-check, when the ledger holds no such task or attempt,
and the engine's answer, when the ledger holds the attempt and the engine does
not. To a caller they mean the same thing — there is nothing there to act on.

**The CLI has two presentations of that one code.** The pre-check is an
`ApiError` envelope on **stderr**, about the request; the engine's answer is the
seven-field document on **stdout**, about the work. Same exit `4`, different
streams, and a reader who meets both should not be surprised.

**This is the second and last outcome outside document equality**, beside
`CAPABILITY_UNSUPPORTED` (ADR 0031). The API answers a `404` envelope with no
document; the CLI prints the document with the refusal named in it. The parity
suite asserts that *difference* rather than an equality that cannot hold — both
doors reach the same driver outcome through the same operation, and each
presents it as its own surface's contract requires. An exit code is a shell's
branch; an HTTP status is a retry loop's.

**`API_CONTRACT_VERSION` does not move, and stays `0.13.0`.** The version file's
rule is that the number moves when the shape a browser or a CLI receives
changes. This adds no route, no schema and no error-code member: a reader at
`0.13.0` receives only codes and shapes it already knows and parses every
response identically. One situation moves from a code that was a defect
(`LEDGER_UNAVAILABLE`, whose documented meaning is "could not be reached") to
the existing code that is true. The only client affected is one whose retry
policy keyed on `LEDGER_UNAVAILABLE` for this case — and that client was
retrying an answer that could never change, which is the bug being fixed. A bug
fix that moves a case between two existing codes is not a contract widening, and
the observable change is recorded here, in the api-reference error table and in
the CLI README rather than in a number.

**A silent consumer had to be edited deliberately.** The API door tested one
refusal by name and then built a document unconditionally, so a fourth refusal
would have answered `200` with `ok: false` and no type error would have said so.
The exhaustive `switch` in the CLI failed the build as it should; the gateway's
`if` did not. That asymmetry is worth remembering the next time a closed enum
grows: the compiler finds one class of consumer and nothing finds the other.

**No migration.** No ledger row, projection, checkpoint or stored document
carries a `DriverRefusal`; the value exists only in a door's response for the
life of one request. Nothing written before this record becomes unreadable and
no replay changes.

## Not in this record

- **`409` on the attach path.** Unproven, and a throw until a drill produces
  one. If one ever does, that is new measured semantics and its own
  adjudication, not a local widening here.
- **Reading the engine's body** to separate the two causes of a `404`. Excluded
  above, and pinned against by an existing test.
- **`signal` and `timer` as operator verbs.** Declined by ADR 0029 and
  unchanged.
- **The SQLite supervisor.** It declares all four verbs `UNSUPPORTED` and
  refuses every one `CAPABILITY_UNSUPPORTED`; the correspondence law is a
  biconditional over *refused or not*, never over *which* refusal, so a fourth
  name changes nothing there.
- **Cancelling before `RUN_STARTED`**, mid-beat preemption, and widening the
  pinned ingress result shapes.
