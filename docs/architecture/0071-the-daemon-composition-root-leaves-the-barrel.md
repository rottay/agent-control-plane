# ADR 0071 — The daemon composition root leaves the barrel

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

`packages/entrypoints/daemon/src/index.ts` was two things at once: the
package's closed public surface and the composition root that assembles the
daemon — around 1,860 lines of seam builders (`instructionFor`, `switchPortFor`,
`landingFor`, `conformanceGateFor`, `checkpointSourceFor`, `executionPortFor`),
both walk forms, and the bounded stop/terminate wrappers, all inside the
barrel file. Structure §1 measured the file at 1,981 lines and named it the
hotspot; §2 :108 reserves the barrel for "startDaemon, stopDaemon,
terminateDaemon y tipos", and §5 :270 forbids declarations in a barrel, which
`DaemonOptions`, `StopResult` and `DaemonRun` violated wherever they sat.

The file also carried two `createExecutionEffects({` constructions (:857 and
:1219) that were the same walk composed twice, inline, with their
dependencies arriving by closure — the duplication E2 of this packet exists
to remove.

## Decision

The packet is cut in two fence-green steps (the DT adjudication in
`.acp-local/evidence/p13/acp-p13-kimi-dt-adjudication-v1.md`), and this
record covers both.

**Escalón 1 — pure extraction.** The composition root moves, byte for byte,
to `packages/entrypoints/daemon/src/composition/index.ts`. No symbol is
renamed and no behaviour changes: the two walk forms travel still inline, the
conformance gate, checkpoint source and execution port keep their exact
bodies, and the two `createExecutionEffects` sites are untouched. The barrel
is reduced to exactly the §2 :108 surface — `startDaemon`, `stopDaemon`,
`terminateDaemon` and the types, re-exported, never declared. The
observation and recovery helpers (`readOwnStatus`, `recoverOwnStaleLock`)
and the seven launchd names move with the root and are exported from the
composition module; there are no external importers of `@acp/daemon`, so no
compatibility re-export is kept. The suites that imported the moved names
from the barrel now import them from `src/composition/index.js`.

The architecture fence re-scopes its composition laws to the new file in the
same step — `DAEMON_PUBLIC_EXPORTS` is redefined to the closed barrel and the
launchd subset is pinned by equality over the composition module; the
spend, harness, pressure, switch, instruction, lease and walk-cap laws plus
nine `PATH_SCOPED_LAWS` scopes follow the code. A law never reads an empty
site at any commit.

**Escalón 2 — one walk construction.** The two inline constructions collapse
into a single builder in `packages/entrypoints/daemon/src/composition/walk/index.ts`,
with its dependencies named as parameters, and the composition partitions
into `walk/`, `ports/` and `usecases/` per §2 :109. `runComposedSqliteWalk`
lands beside the builder as the one `runSqliteMode({` literal both walk forms
call. A fixture of equivalence over the single, scheduled and one-item
scenarios — with hand-written expectations, never a comparison against the
previous implementation — proves the collapse is behaviourally exact, and the
same three cases run through the wrapper itself over a drill ledger, a granted
lease and a real worktree, so the checkpoint port and the lease-bound switch
port are covered rather than assumed (DT adjudication V11.1). The spend,
pressure and switch laws re-scope to the new leaf.

Two corrections the implementation forced, recorded rather than smoothed over:

- **The multi-walk registry row does not retire.** The region it names — the
  beats registry, the targeted reap and the scheduler ports — turned out to be
  scheduler machinery rather than walk construction, so it stays in the
  composition root and its row stays with it. What disappeared is the
  duplicated walk construction inside `ports.run`, not the region.
- **The two walk context shapes get a leaf of their own.**
  `src/composition/types/index.ts` holds `WalkEffectsInput` and
  `ComposedSqliteWalkInput`: they are the contract between the root and the
  walk module, and both sides now read them from one place (DT adjudication
  V11.2). It is a pure type leaf, so it carries no mirrored suite — the
  topology law bounds where a test may live and does not require one for a
  file with no conduct, and `packages/persistence/ledger/src/types/index.ts`
  is the standing precedent.

## Why keeping the root in the barrel was not chosen

The §5 anatomy rules are the authority and they are not new: a barrel is a
small explicit list of re-exports, and it holds no declarations. Leaving the
root where it was made every future composition change a barrel change,
widened every diff an auditor had to read to find the public surface, and
kept three interfaces (`DaemonOptions`, `StopResult`, `DaemonRun`) declared
inside the very file whose only job is to say what is public. Extracting only
the types and leaving the functions would have halved the file without
removing the conflict of roles.

## Why a compatibility re-export layer was not chosen

Re-exporting the moved names from the barrel for one packet would have made
the narrowing reversible in silence — an allow-list is an upper bound, and a
re-export is exactly how a withdrawn name grows back with the fence green.
The package has no external importers (the fence's own inventory says so), so
the only consumers of the change are this package's suites, which update in
the same write-set. Closing the surface outright is cheaper than guarding a
wider one, and the membership check fails a regression in either direction.

## Why unifying the walks in the same step as the extraction was not chosen

Each step leaves the tree deployable and the suite green, and the two steps
fail in different ways: an extraction can move a seam badly, a unification
can change behaviour while leaving every line plausibly in place. One commit
that did both would make a red suite un-diagnosable between the two causes —
and the fence's per-literal laws over the two construction sites (spend,
pressure, switch) stay meaningful only while both sites exist, which the
two-step cut preserves until the second step removes them together.

## Consequences

The fence's daemon pins now read `src/composition/index.ts` (and, after
escalón 2, `src/composition/walk/index.ts` for the walk laws); any future
packet composing daemon seams edits the composition module, not the barrel.
The barrel file shrinks to the surface and nothing else, and the
`test/index.test.ts` mirror pins both halves: the barrel no longer exporting
the moved names, and the composition module exporting them. P-37 inherits a
cleaner base for its folder renames, and the launchd surface stays where its
declaring leaves are — only the re-export moved.

## Not in this record

The folder renames toward the §2 target tree (`process/`, `supervision/`,
`modes/`, `observability/`, `shared/`, and the fate of `src/constants/`) are
P-37 seams and are deliberately not anticipated here. `daemon-child` does not
move: the config door stays in `src/daemon-child/index.ts` and only the
composition leg of L-C-3b re-scopes. Whether `readOwnStatus` and
`recoverOwnStaleLock` eventually live under an observability or process
folder is a P-37 question; this packet lands them in the composition module
because that is where their code lives today.
