# ADR 0016 — A driver declares what it cannot do, and the declaration is checked

- Status: accepted (V2-B2-1, recorded 2026-09-03).
- Supersedes: none.
- Superseded-by: none.

## Context

The plane has two orchestration drivers over one shared core: the SQLite
supervisor in `@acp/runtime` and the Restate driver in `@acp/durability`. ADR
0004 established that neither is a degraded path and that authority never
leaves the ledger; ADR 0005 recorded the Restate driver's journalled shape.

Neither record says what happens when the two engines genuinely differ. They
do differ. Restate offers durable timers, awakeables, invocation attach and
cancellation; a single process walking a plan offers none of them. Until now
that difference lived only in prose, which has two failure modes and the
repository has already met both elsewhere: a reader assumes parity that does
not exist, or a driver quietly emulates a feature — an in-process `setTimeout`
calling itself a durable timer — and the emulation is indistinguishable from
the real thing right up to the restart that loses it.

B2 is about to make those verbs real on one driver and not the other, one
packet at a time. Before any of them is implemented, the plane needs a way to
say which are available that a caller can rely on and a reviewer cannot be
asked to take on trust.

## Decision

`OrchestrationDriver` gains `capabilities(): DriverCapabilities` and the four
verbs the capability vocabulary names — `cancel`, `reattach`, `signal`,
`timer` — each returning `Promise<DriverOutcome>`, a union of an accepted
result and a typed `DriverRefused`.

The declaration lives in `@acp/contracts`' durability-plane module, beside
`DriverStatus`, because it is the same kind of thing: a self-report a reader
may see and a driver must satisfy. It carries no application fact.

It has **two** states, `SUPPORTED` and `UNSUPPORTED`, and deliberately not a
third. Model capabilities carry `UNKNOWN` because a model's abilities are only
learnable by drilling a real subject; a driver's are knowable by construction,
because the code that would call the engine is in this repository. A third
state here would be somewhere to hide.

Verbs and properties are two shapes, not one flat enum. `SERIALIZED_PER_TASK`
is a fact about how an engine schedules, with no method to invoke, so it cannot
be checked against behaviour the way a verb can.

The declaration is not decorative, and that is the load-bearing half of this
record. For every verb:

> `capabilities().verbs[v] === "UNSUPPORTED"` **if and only if** `v()` returns
> a `DriverRefused` for every input.

`driverCapabilityMismatches` states that law once, in the domain that owns the
port, and both drivers' suites apply it to the real driver object. Both
directions are rejected: declaring `SUPPORTED` while refusing, and declaring
`UNSUPPORTED` while doing the work. The architecture fence additionally pins
both drivers' declarations by equality, so a capability cannot be flipped
without the packet that flips it being visible in the diff.

At this record's landing, both drivers declare all four verbs `UNSUPPORTED`
and refuse. Each later B2 packet flips exactly one Restate entry and lands the
drill that earns it. The SQLite entries are expected never to move.

## Why "just implement the verbs and let the types speak" was not chosen

A type signature says a method exists, not that it does anything. A driver may
satisfy `OrchestrationDriver` completely while every verb returns a refusal, or
while one verb silently no-ops and returns success. Both compile; both mislead
a caller reading the port. The capability declaration exists precisely to make
that difference visible, and the correspondence law exists because a
declaration that can disagree with its own behaviour is worth less than no
declaration at all — it is a claim with the appearance of a guarantee.

## Why a third `UNKNOWN` state was not chosen

It would be a convenient place to defer, and every deferral it enabled would be
indistinguishable from an honest one. The roadmap already carries `UNKNOWN` for
model capabilities, where it is correct because the subject is external and
opaque. A driver is neither.

## Why emulating the missing verbs on SQLite was not chosen

An in-process timer, a fake attach or a best-effort cancel would make the two
drivers look interchangeable while behaving differently under exactly the
conditions the durability plane exists for — a restart, a crash, a lost
process. The roadmap forbids simulated parity for this reason, and an honest
`UNSUPPORTED` is a better answer than a working-looking approximation.

## Consequences

- Four methods land on the port before any is implemented. The alternative —
  one member per packet — would change the port, both drivers, both barrels and
  the export pins four separate times on the plane's highest-traffic files. The
  cost paid here is a diff containing four methods whose only behaviour is a
  typed refusal.
- `DriverAccepted` is empty today. Each packet that makes a verb real widens
  that arm with what the verb actually produces, rather than this record
  inventing a field in advance.
- `DRIVER_REFUSALS` has one member, `CAPABILITY_UNSUPPORTED`. A second reason
  arrives with the packet that can return it.
- A capability flip is now a reviewable event: it changes a pinned fence
  literal, so it cannot ride along inside an unrelated change.
- Callers gain a way to ask a driver what it offers without calling a verb to
  find out, which is what routing and the console will need later.

## Not in this record

- Any verb's behaviour. This record decides the declaration and the law; B2-2
  through B2-5 decide what the verbs do.
- Whether `SERIALIZED_PER_TASK` is true of either driver. It is declared
  `UNSUPPORTED` by both until a packet drills it.
- Provider-session reattach, which is a different object at a different
  boundary and belongs to the harness packet.
- Any API route or console surface over the declaration. The capability is on
  the port and in the package surface only.
- Cancellation propagating into a running provider process.
