# `@acp/observation`

The shadow-mode boundary of the Agent Control Plane.

## Scope

**This is P3A: allowlisted roots and fail-closed admission, and nothing above
it.** Passive collectors are P3B, the baseline is P3C, and the ledger-to-client
parity contract is P3D.

Shadow mode observes **only** passive artifacts already emitted, or synthetic
scenarios, under two ignored roots. It never attaches to, inspects credentials
of, signals, or writes into any live session.

Importing this package has **no side effects**, and could not have any: the
production modules import no process, network, signal or mutating filesystem
API at all.

**P3A is not P3 completion**, and it is **no product adoption**.

## The boundary

Two allowlisted roots, `.acp-local/shadow/artifacts` and
`.acp-local/shadow/scenarios`. No entry point accepts a path — a caller supplies
a *name*, and the package resolves the root itself. A caller that could name a
directory could name someone else's.

One rule is stricter than its predecessors in this repository: **an absent root
is refused, never created.** A collector that can create the directory it reads
from can be aimed anywhere and will report, truthfully and uselessly, that it
found nothing. Observation admits what already exists.

Nine classified refusals: `PATH_SUPPLIED`, `BAD_ARTIFACT_NAME`,
`PATH_NOT_ABSOLUTE`, `PATH_NOT_CANONICAL`, `OUTSIDE_ALLOWLIST`, `ROOT_ABSENT`,
`NOT_OWNED_FILE`, `UNSAFE_PERMISSIONS`, `TOO_LARGE`. The size bound is taken
from the `stat` before the file is read; a bound applied to something already in
memory is not a bound.

## Capability is removed, not declined

The roadmap forbids attaching, signalling and writing. Rather than promise
restraint, the package has no means: no `node:child_process`, no network
builtin, no signal API, no `process.env`, and no mutating `node:fs` call in any
production module — including into its own roots. A test reads the sources and
the architecture fence asserts the same, so a later edit cannot quietly
reintroduce what was deliberately left out.

## What comes next

P3B adds passive parsers; P3C adds the baseline over a disposable shadow ledger
bound to the frozen 21-type event vocabulary; P3D proves the ledger, CLI and UI
agree exactly across all nine frozen routes. The metric mapping and the STOP law
that governs an inexpressible measure are in
`docs/architecture/0009-shadow-observation-boundary.md`.
