# ADR 0010 — The provider adapter boundary

- Status: accepted for P4
- Date: 2026-08-28
- Supersedes nothing. Constrained by ADR 0001 (the ledger is the authority) and
  by the frozen contracts ADR 0002 depends on.

## Context

P4 adds read-only adapters for three coding agents — Claude headless, Kimi ACP
and the Codex App Server — in that order. The roadmap requires spawn, stream,
interrupt, a health probe, classified errors, isolated config roots and
sessions, structurally read-only reviewers, and no product write.

Three providers, three protocols, three ways to be wrong about stopping a
process. The question this ADR answers is where the shared truth lives.

## Decision

**One package, one process boundary.** `@acp/adapters` holds the contract, the
session controller and the spawner. Provider modules are pure: they build
argv, read a handshake and turn bytes into signals. They are handed no means to
spawn, open a file or reach a ledger, so the boundary holds by construction
rather than by discipline.

`src/process/spawn.ts` is the only file importing `node:child_process`;
`src/session.ts` is its only caller. The architecture fence asserts both.

### Who ends a session

A terminal failure initiates its own teardown: the failure path invokes the
handle's idempotent close (SIGKILL and reap on the exact owned PID) before the
stream ends, so `FAILED` implies the kill has been initiated and does not
depend on a caller reaching `close()`. The reviewer guarantee would otherwise
rest on the caller's diligence, which is not where a guarantee belongs.

On the success path the caller must consume `events()` to completion and then
call `close()`, or use structured cleanup. **Abandoning the iteration is not
cancellation** — breaking out of the loop leaves the child running until
`close()` is called.

### Output bounds and decoding

`spawn` has no `maxBuffer` — that is an `exec`/`execFile` option it silently
ignores. Mandating it would have enforced a dead argument while
`OUTPUT_BUDGET_EXCEEDED` had nothing behind it. The bound is therefore a manual
byte count across stdout **and** stderr, taken on raw bytes *before* decoding,
because counting decoded characters would let multibyte output exceed a byte
budget it had already blown. Decoding is stateful (`node:string_decoder`), so a
codepoint split across two chunks survives.

### Capability evidence has a subject

`CapabilityState` is `CONFIRMED | UNKNOWN | REFUSED`. Evidence is `PROTOCOL`,
`RUNTIME` with `subject: "FAKE" | "REAL"`, or `NONE`. **`CONFIRMED` requires
protocol evidence or a real-subject runtime drill.**

This distinction is the point. A fake proves our parser and our machinery. It
proves nothing about whether a real provider streams, resumes or cancels, and
without the subject field "CONFIRMED requires evidence" would be satisfiable by
evidence about ourselves — which is how a capability table ends up describing
the fixtures. CLI `--help` text is adjacent observation and never evidence; the
bounded `--version` probe proves only that a binary exists.

Consequence, stated so no later reader has to infer it: **`STREAMING`,
`RESUME`, `SESSION_ID`, `MODEL_PIN` and `PROTOCOL_CANCEL` enter and leave P4 as
`UNKNOWN` for all three providers.**

The roadmap's requirements are still met, because they are properties of the
*adapter*, not warranties about the *provider*: fail-closed streaming
machinery, a health probe in the frozen shape, a closed error taxonomy, and an
interrupt that always works because the signal floor is ours. A provider-native
cancel runs before the ladder when one is ever proven; until then the ladder is
signal-only and the capability stays `UNKNOWN`.

`doctor` is install-level diagnostics for all three providers. It is **not** the
session health probe, and the two are never conflated.

### Events are normalized; the caller owns the ledger record

Adapters emit normalized events, each mapped to a type the frozen 21-type
vocabulary already declares. The **caller** constructs any full
`ControlPlaneEvent` — idempotency key, attempt, `fromState`/`toState` and the
change-of-state law the contract enforces — so no `superRefine` in
`@acp/contracts` is ever an adapter's to satisfy, and adapters never append.

**STOP law.** A provider signal inexpressible under the frozen vocabulary halts
the packet and escalates to the DT. It is never grounds to widen
`@acp/contracts`, never grounds to press an unrelated type into service, and
never grounds for a mid-packet schema change. This is the same law P3C adopted
for the shadow baseline, and it exists because the first inexpressible
measurement always arrives mid-packet, when refusing is hardest.

### Read-only roles

Two layers, and only one of them is load-bearing. The provider's own read-only
setting is set where one exists — Claude and Codex have one; **Kimi's is
`NOT_SHOWN_LOCALLY` and its approval toggles are not a read-only mode**, so
describing them as one would be a false native-flag claim. The guarantee rests
on the local structural layer for all three: a reviewer descriptor carrying a
write-enabling flag never becomes a process, and a reviewer session emitting a
write-class signal is killed.

### Admissions

A caller supplies a name or an already-owned directory, never an arbitrary
path. `admitBinary()` lives in `spawn.ts` — the admission belongs with the
authority that re-asserts it immediately before exec — and brands only after
absolute, canonical, regular-file and owner checks. Config roots and workdirs
are admitted the same way and additionally refused if they sit inside a product
checkout. An absent root is refused, never created: a component that creates
the directory it is pointed at can be aimed anywhere and will report,
truthfully and uselessly, that it found nothing.

Config roots for drills live under a disposable ignored base. **Persistent
account roots and credential selection are P5**, and no credential enters this
repository in any form.

## Arithmetic

P4 is **40 packet entries across 32 distinct paths**; P4A is exactly 24. The
convention is the standing one: entries are the sum of the packet array
lengths, distinct is `new Set` over their union, within phase scope. Repeated
paths are `src/index.ts` (A, B, C, D), `scripts/check-architecture.mjs`
(A, B, C, D, E) and `packages/adapters/README.md` (A, E); 40 − 8 = 32.

This supersedes an earlier 33/25, which was computed over arrays that omitted
the six co-located test paths and `session.ts`. A test file is its own path.

## Consequences

Good: one place to get process handling right; a capability table that cannot
flatter itself; a taxonomy that cannot quietly widen the frozen contract.

Costs: capabilities stay `UNKNOWN` through P4, so a later phase must do the
protocol work to confirm them; and the machinery for setting `CONFIRMED` ships
without anything in P4 able to exercise it. That is deliberate — the alternative
was a table that claimed more than the evidence supports.

## Not in P4

No accounts, credentials or quotas. No leases or writes. No product pilot, no
certification, no cutover. No LangGraph, no gateway, no second durable runtime,
and no npm dependency beyond `@acp/contracts`.
