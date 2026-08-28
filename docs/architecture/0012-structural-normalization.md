# ADR 0012 — Structural normalization: one topology, mirrored trees

- Status: accepted for the P5N checkpoint
- Date: 2026-08-28
- Supersedes the P5B folder/index law recorded in `scripts/check-architecture.mjs`
  §21. Constrained by ADR 0001 (the ledger is the authority) and by the owner's
  structural ruling of 2026-08-28.

## Context

This repository grew a layout one packet at a time. Tests sat beside the code
they exercised, because that is what each packet's fence asked for; modules sat
wherever the packet that created them put them. By the end of P5B the result was
two conventions in the same tree — `providers/<name>/index.ts` with a sibling
test in the adapters package, flat modules with sibling tests everywhere else —
and a fence rule that actively required the colocated form in two named trees.

The owner has ruled a single topology for the whole repository. This ADR records
it, the measurement it was decided against, and the sequence by which the
existing code is brought to it.

## Decision

**One topology, repository-wide.**

- Product code lives at `packages/<pkg>/src/<domain>[/<subdomain>]/index.ts[x]`.
  Meaningfully nested domains are allowed; every domain folder is entered
  through its own `index.ts[x]`.
- Tests live at `packages/<pkg>/test/<domain>[/<subdomain>]/index.test.ts[x]`,
  a **separate mirrored tree**. Fixtures and helpers live under the
  corresponding mirrored test domain.
- **Zero** `*.test.*` or `*.spec.*` anywhere under `src/`.
- The only package-root product exception is `src/index.ts[x]`, a stable public
  barrel. The only mirrored root exception is `test/index.test.ts[x]`, for
  whole-package assertions.
- **There is no `errors.ts` exception.** An error module is a domain like any
  other and lives at `src/errors/index.ts`. The two flat `errors.ts` files that
  exist today, in `accounts` and `adapters`, are normalization candidates rather
  than grandfathered roots.

**Naming law.** Every domain directory segment is lowercase kebab-case —
`status-badge`, `use-async-resource`, `hash-route` — mirrored identically under
`test/`. No adjacent duplicate semantic segment: `format/format/index.ts` is
refused and collapses to `src/format/index.ts`. A leaf file whose name repeats
its parent domain folds into that domain's own index rather than growing a
`<name>/<name>/` wrapper.

**Tests are typechecked.** An untypechecked test is not evidence. Moving a test
tree out of `src/` moves it out of every package's `tsconfig` `rootDir`, so each
cohort admits the configuration paths that put it back.

### Why a mirror rather than colocation

Colocation optimizes for the moment you are editing one file. A mirror optimizes
for every other moment: what the package's public surface is, which domains have
evidence and which do not, and whether a test's subject is a domain or a
combination of them. The deciding argument was the last one. Under colocation a
test of two domains has to be filed under one of them, and the path then lies
about what the test is for.

### Integration tests are a named class, not a loophole

A test whose true subject is a *combination* of domains is filed under a
**pseudo-domain** under `test/` that names the combination, with no `src/`
counterpart. This is bounded deliberately: a pseudo-domain exists only for a
test with genuinely multiple subjects, and **each instance is adjudicated by the
DT in the cohort ruling — never invented by an implementer.** Seven exist today,
named in the inventory adjudication.

## The census

Measured with a disjoint classifier, not `grep -v`, and reconciled between the
committed baseline and the frozen P5C work:

| Scope | Total | Tests/spec | Index product | Non-index product |
| --- | --- | --- | --- | --- |
| Tracked at HEAD `a6f4ef5` | **177** | 60 | 16 | 101 |
| Live worktree | **179** | 61 | 17 | 101 |

The two frozen untracked P5C files account for the difference exactly: one test
and one index.

The 60 committed tests under `src/` relocate mechanically to mirrored trees. The
**101 non-index product modules are semantic-adjudication candidates, not blind
moves** — deciding that a module is a domain, a subdomain, or content that folds
into a parent's index is a judgement about meaning, and it is the DT's. No
per-package figure is asserted anywhere without the classifier run that produced
it.

## Cohort order

**contracts → ledger → api-contracts → observation → cli → adapters → daemon →
runtime → ui → server → accounts.**

Two dependencies fix the tail. `packages/ui` is the largest semantic surface —
29 non-index modules plus Vite entry and asset references — and goes late, after
the configuration-path law is settled against smaller trees. `server` follows
`ui` and `cli` because its `tsconfig` deep aliases point at their build output.
`accounts` is last, after P5C resumes and commits, so no cohort has to reason
about a frozen packet's half-written module.

## Relocation mechanics

The P4R precedent becomes law.

- **The only permitted byte delta in a relocated file is an import specifier or
  a self-path string** — `../` depth, `./claude.js` → `./index.js`,
  `join(HERE, …)` targets. Any other byte is a finding. This is what makes a
  cohort audit a mechanical check rather than a re-review.
- Historical write-set arrays are **rewritten** to the new paths one for one.
  This is authorized explicitly: the arrays are a record of what each packet was
  authorized to create, and a record that names a path which no longer exists
  has stopped being one. Renames are count-neutral, so the ADR 0010/0011
  arithmetic stays true.
- Every old path is appended to `RETIRED_PATHS` in the same cohort commit, so a
  retired location cannot come back beside its replacement.
- Every exact-path constant moves in the same commit: `HTTP2_ALLOWED_FILE`, the
  `SPAWN_ALLOWED_FILES` entries, `ADAPTERS_SPAWN_SITE`/`CALLER`, the P3D deep
  aliases, the count comments, and any ADR authority literal that names a path.
- Each cohort extends its package's fence scan to `packages/<pkg>/test/` with
  the package's test-only allowlist, **and** the fence gains a repo-wide
  assertion that every `packages/*/test/**` file is covered by some package
  scan. Coverage cannot be lost by omission — which is exactly how it would be
  lost, since the existing scans select by the `src/` prefix and would silently
  stop applying the moment a test left it.
- Configuration paths that reference moving sources are named in advance and
  admitted per cohort: `vitest.config.ts`, each package `tsconfig.json` (or a
  `tsconfig.test.json` plus a base reference), `packages/ui/index.html`,
  `packages/daemon/package.json`'s `bin`, and
  `packages/server/tsconfig.json`'s alias targets.

## The gate, and why its activation list starts empty

The fence carries the topology and naming laws as executable rules over an
**activation list that begins empty**. Each cohort adds its own tree in the same
commit that makes that tree compliant.

Switching the law on repository-wide in one step was considered and rejected. It
would have failed every gate from the moment it landed until the last cohort
completed — and a fence that cannot be committed against stops being a fence and
becomes a thing people work around. Activating tree by tree keeps every commit
in the checkpoint green and makes each cohort's completion visible as a single
line in the fence.

The law the gate replaces is retired in the same edit. The P5B rule required a
test *beside* an implementation-bearing index and granted an `errors.ts` root
exception; both are now false, and leaving it live would have fired on the very
first relocation this checkpoint performs.

## Freeze mechanics

The P5C router packet is frozen mid-flight, and the rule is the simplest one
available: **the frozen work never moves.**

- `packages/accounts/src/routing/**` stays untracked exactly where it is. The
  dirty P5C hunks in `packages/accounts/src/index.ts` and in
  `scripts/check-architecture.mjs` stay dirty exactly where they are. No move,
  no delete, no quarantine, no reverse-edit, and — as everywhere in this
  repository — no stash, restore, reset or clean.
- The P5C test relocation, the `test/` tree's tsconfig and vitest coverage, and
  the `P5C_WRITE_SET` path correction are **deferred to the accounts cohort**,
  where the configuration paths are admitted and P5C has resumed. No structural
  packet before then touches a P5C byte.
- **P5C does not resume until full compliance is green and committed.** Then
  P5D, P5E, and P6.

An earlier mechanism relocated the frozen test into the mirrored tree during the
first structural commit. It was executed and then superseded: the relocated test
landed outside every TypeScript project — `rootDir: ./src` — so it could not be
parsed, and the frozen *source* failed lint thirty-three times wherever it sat.
Neither problem is a structural packet's to fix. Leaving the work untouched and
proving the commit elsewhere is strictly better, because it is the only variant
that changes nothing about the frozen packet at all.

### The honesty rule for the freeze window

While P5C is frozen, **the canonical live tree is red on `pnpm check`**, by the
frozen WIP's own never-gated bytes. That is a fact about work in progress, not
about anything this checkpoint commits.

The commit law — every commit green on the full gate — is therefore satisfied
**over exactly the committed content**: each structural candidate is built into
a disposable tree from `HEAD` plus the staged patch alone, and the full gate is
run there and recorded. **No commit in this checkpoint claims the live tree is
green**, and no reader of a green receipt should conclude that it was. The
distinction is written down here because a receipt that quietly meant something
weaker than it said would be worth less than no receipt.

The audit follows the same rule: a cohort is audited against the candidate
patch, not against the working tree that happens to surround it.

## Staging discipline

Structural commits stage the enumerated relocations, the fence's structural
hunks, and nothing else. The fence file carries frozen P5C hunks in the same
working tree, so staging is per-hunk rather than per-file, and **no P5C byte
ever enters a structural commit.**

## Consequences

Good: one convention instead of two; a path that explains its purpose; test
coverage that is visible as a tree rather than inferred from siblings; and a
fence that states the layout rather than a series of packet-local habits.

Costs: a hundred and one modules need a semantic decision each, and the
checkpoint blocks P5C and P6 until they are made. The alternative — normalizing
opportunistically as packets touch files — was rejected because it leaves the
repository in two conventions indefinitely, which is the state that produced
this ADR.

## Not in this checkpoint

No behaviour change of any kind. No dependency change. No contract change. No
product adoption and no cutover: this is a layout, and a layout adopts nothing.
