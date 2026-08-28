# ADR 0009 — Shadow observation boundary, metric mapping, and the STOP law

- Status: accepted for P3A
- Date: 2026-08-27
- Extends ADR 0001 (ledger authority). Governs all of P3.
- **P3A is not P3 completion**, and it is **no product adoption**.

## Scope, stated first

P3 observes. It reads passive artifacts already emitted, or synthetic
scenarios, and computes a baseline from them. It never attaches to, inspects
credentials of, signals, or writes into any live session — not the product
environment named in the roadmap, not any other repository in this workspace,
and not any terminal multiplexer session. Those names are deliberately not
spelled here: this repository's fence forbids product references in tracked
files, and an ADR that needed an exemption to state a prohibition would be
widening the exemption list to say "we do not do this". No provider adapter, no
account handling, no Restate expansion, no new observation route, no cutover.

## Decision

### 1. Allowlisted roots, and a package that creates nothing

Two ignored roots, `.acp-local/shadow/artifacts` and
`.acp-local/shadow/scenarios`. No public entry point accepts a path: a caller
supplies a *name*, and the package resolves the root itself, exactly as the toy
scenario root and the daemon root already do.

One law is deliberately stricter than P2's: **`resolveObservationRoot` refuses
an absent root rather than creating it.** A collector that can create the
directory it reads from can be aimed at a fresh directory anywhere and will
report, truthfully and uselessly, that it found nothing there. Observation
admits what already exists.

Admission is fail-closed on nine classified refusals: `PATH_SUPPLIED`,
`BAD_ARTIFACT_NAME`, `PATH_NOT_ABSOLUTE`, `PATH_NOT_CANONICAL`,
`OUTSIDE_ALLOWLIST`, `ROOT_ABSENT`, `NOT_OWNED_FILE`, `UNSAFE_PERMISSIONS`,
`TOO_LARGE`. The size bound is taken from the `stat`, before the file is read;
a bound applied to something already in memory is not a bound.

### 2. Capability is removed, not declined

The roadmap forbids attaching, signalling and writing. The honest way to
guarantee that is for the code to have no means:

- no `node:child_process` — it can attach to nothing;
- no network builtin — it can reach nothing;
- no signal API — it can disturb nothing;
- no `process.env` — credentials are not reachable, even by accident;
- **no mutating `node:fs` call in any production module** — it can write
  nothing, including into its own roots.

These are asserted structurally, by the architecture fence and by a test that
reads the sources, rather than demonstrated behaviourally. A capability that is
absent cannot be misused by a later edit that forgets why it was declined.

### 3. The shadow ledger is a fixture, not an authority

Measurements live in a **disposable shadow ledger** under
`.acp-local/shadow/**`, opened through `@acp/ledger`'s public API. This is
materially what every P2 drill already did with disposable ledgers, and it is
what gives the parity contract teeth: the three-way equality runs over data
produced, chained and rebuilt by the same components the claim is about,
instead of over a second ungoverned format that would itself need validating.

Bounds, all binding:

1. shadow instances exist only under the allowlisted ignored roots;
2. writes go through `@acp/ledger` only, from P3C modules, **never** from
   `collect/**`, which stays structurally read-only;
3. the daemon and runtime packages never open a shadow ledger;
4. drills delete only their own roots, after a realpath/prefix check;
5. shadow content is synthetic task-lifecycle chains under the frozen
   vocabulary below — nothing observed from any live session.

A plain report file was rejected: no chain, no rebuild proof, and a second
format to drift. The production ledger was rejected outright — P3 observes; it
does not add facts to the authority.

### 4. The metric mapping, bound to the frozen vocabulary

`CONTROL_PLANE_EVENT_TYPES` is 21 types and contains no observation or metric
type. `packages/contracts` is untouchable in P3. Every measure is therefore
expressed in the existing vocabulary, with contract-legal payloads:

| Measure | Mapping |
| --- | --- |
| DT routing | `TASK_CLASSIFIED`, counted by the payload's classified reason |
| tokens | `ATOMIC_STEP_COMPLETED.payload.tokensUsed` — a named, bounded, non-negative integer, summed; artifact-supplied, never estimated |
| time | event-carried timestamps only, per task; **never** a wall clock |
| rework | `TASK_STATE_CHANGED` transitions whose target re-enters a state the task has already left |
| acceptance | `AUDIT_COMPLETED.payload.verdict` over its closed verdict set, plus terminal outcomes (`TASK_FAILED`, `TASK_CANCELLED`, commit-reaching completion) |

Every shadow event parses against the frozen `ControlPlaneEvent` schema, and
payload keys pass the existing credential and transcript guards.

### 5. The STOP law

**A measure that cannot be expressed under the frozen 21-type vocabulary and
the bounded payload budget is a STOP condition.** The packet halts and
escalates. It is never grounds for editing `packages/contracts`, never for
misusing an event type to mean something it does not, and never for a
mid-packet schema widening.

This is written down because the pressure arrives at the worst moment: mid
packet, with one measure left, where widening a frozen contract looks like a
small accommodation and is instead the end of the contract being frozen.

### 6. Measurements carry no clocks

Durations come from event-supplied timestamps. No test compares against a
clock, and no receipt embeds a run date; receipts record content digests,
counts, and event-derived durations. A receipt that changes when nothing
changed is a receipt nobody rereads — this repository has already published one
per-run-varying digest as evidence and had to correct it.

### 7. Fixture naming convention

Synthetic fixtures — including the anti-mutation drill's live-looking target —
use neutral names drawn from the artifact grammar (`[a-z0-9][a-z0-9._-]*`), and
**must not** spell any product repository name or session-tool name. A fixture
that did would trip the repository-wide reference fence this same packet adds,
and the failure would look like a policy violation rather than a naming
accident.

## Consequences

The observation package's public surface is closed and pinned by equality in
both directions, the form P2F Stage B had to adopt after the upper-bound form
failed once here. The package declares no `bin` and depends on exactly
`@acp/contracts` and `@acp/ledger`.

P3D's parity test resolves the CLI and UI row models through test-only deep
aliases in `vitest.config.ts`, so neither package's entry point widens for a
test-only need.

## Compliance

The fence asserts the allowlisted roots, the absent-capability laws, the
dependency surface, the closed export set, the no-`bin` rule, the deep-alias
targets and their single importer, and the repository-wide absence of product
and session-tool references in code.
