# ADR 0014 — Repository topology: five strata, and what may depend on what

- Status: accepted (P8-T, recorded 2026-08-31). Supersedes: none.
  Superseded-by: none.
- Numbering note: this record was commissioned as 0013 and renumbered.
  0013 was already the plane's first write route, and the corpus is
  append-only — so the collision was a defect in the commission, not a
  question about which record wins. The fence now refuses a duplicate or
  non-contiguous ADR number, which is the check that was missing.

## Context

Eleven packages sit flat under `packages/`. Flatness is not a neutral default:
a directory listing of eleven peers asserts that they have equal architectural
weight, and they do not. `@acp/contracts` imports nothing and everything
imports it; `@acp/ui` is a browser application that may see only DTOs. Those
two sit side by side, indistinguishable by path.

The owner ruled the flat state unacceptable for a public release, and a joint
audit — three memos, a synthesis, two delta passes, one adjudication each —
converged on the shape recorded here. This record states the decisions so the
migration executes against a written law rather than against a memory of a
review.

## Decision

Five strata, each a directory under `packages/`, each carrying a
dependency rule the architecture fence can check:

```
packages/
  kernel/        contracts, api-contracts
  persistence/   ledger
  domains/       runtime, accounts, observation
  edges/         adapters, durability
  entrypoints/   daemon, server, cli, ui
```

Folder name equals package name. Two levels maximum. The `@acp/*` npm
specifiers are invariant across the whole migration — folders move, imports do
not — with exactly one registered exception, `@acp/durability`, which is a new
package rather than a rename.

### The layer table

1. `kernel` imports nothing in-repo, except `api-contracts → contracts`.
2. `persistence → kernel` only.
3. `domains → persistence, kernel`. `runtime → accounts` is the only
   permitted domain-to-domain edge.
4. `edges → domains, persistence, kernel`. `durability → runtime` implements
   the port; the reverse is what the fence must refuse forever. The
   `edges → runtime/scenarios` edge is declared rather than incidental — see
   below.
5. `entrypoints →` any lower stratum. Nothing imports an entrypoint from
   `src/`. `ui → kernel/api-contracts` only, which is the browser-safety law
   restated as a layer rule.

### Public and internal packages

A package is one or the other, explicitly, because an export pin on an
unclassified package guards a surface with no declared audience:

- **Public** (semver-governed, published, README + changelog, export pin
  mandatory): `contracts`, `api-contracts`, `ledger`, `runtime`, `accounts`,
  `observation`, `adapters`, and `durability` when it exists.
- **Internal** (`private: true`, no compatibility promise): `daemon`,
  `server`, `cli`, `ui` — the entrypoints. They are the product, not the
  library.

The fence asserts the classification against each manifest. Nothing publishes,
tags, or drops `private: true` until `LICENSE`, `SECURITY.md` and
`CONTRIBUTING.md` land together in G10; until then the enforcement is what
already stands — the unconditional pre-push refusal, `private: true`
everywhere, and zero remotes.

### Extensibility: a bounded registration seam, and no more

The transport union stays **closed**. Three transports — CLI subscription, API
key, local or self-hosted — are an architectural fact about how a model is
reached, not a list users extend.

The provider list becomes a **validated-descriptor registration surface**: the
kernel keeps the descriptor's shape and drops the membership, and first-party
providers ship registered in the composition root. This replaces a frozen
`CLI_SUBSCRIPTION_PROVIDERS` tuple that made "add a provider" a patch to the
package every other package imports.

The boundary is drawn deliberately and does not move later: **no runtime
plugin loading, no remote code, no marketplace.** A control plane that spawns
model processes under the owner's own credentials is the wrong place to
execute code it discovered at runtime. Registration is a compile-time
composition, and the extension guide says so in its first paragraph.

### Types, and the absence of drawers

Interfaces, types and enums are owned by the bounded context that defines them
and are exposed through that context's `folder/index` entrypoint. Co-locating a
module's types with its implementation is conforming; the prohibition is on
global type bags and on types loose outside any entrypoint. No
`shared`, `utils`, `common` or `types` package may exist, and the fence
refuses one.

The dedup law, stated once so it stops being re-litigated: **a value two
contexts must agree on has exactly one declaration and a duplication gate; a
four-line predicate two contexts happen to share does not.** The first is a
correctness invariant — `TOKENS_USED_MAX`, declared four times today, collapses
to one authority. The second is a coincidence — `isRecord` stays hand-rolled in
its six modules, because a package built to hold it would attract everything
that is not quite domain.

## Why five strata rather than three planes or a package per context

Three planes read well and check poorly: the coarser the grouping, the fewer
distinct rules the fence can enforce, and a law this repository cannot execute
is a law it does not have. A package per bounded context fails in the other
direction: P8-8A measured one dependency edge at five synchronized declaration
sites — manifest, lockfile, tsconfig reference, fence dependency law, fence
reference pin — and the brief that declared "the full kit" still missed the
fifth. Six domain packages across eleven consumers is a bookkeeping surface
that drifts.

Five strata is the shape where every boundary carries a rule the fence checks
and no boundary is bought with bookkeeping. Contracts subdivide by folder
inside one package (G6); promotion to a package requires a proven consumer
boundary, not a hunch.

## The two adjudicated edges

**`edges → runtime/scenarios`.** The drill machinery moves from `toy/` to
`scenarios/`, off the main barrel and onto the `@acp/runtime/scenarios`
subpath. It is production source, not test scaffolding: the daemon's own
product source consumes it, and after the durability split the drivers do too
— five imports from the code that becomes `@acp/durability`. Declaring the
edge in the layer table keeps that visible at every import site instead of
letting it arrive as a side effect of the split.

**The topology constants move to the kernel.** `LOOPBACK_HOST` and the pinned
ports are contract-rank facts, so `runtime/src/constants/` becomes
`kernel/contracts/src/topology/`. Recorded here because it makes the kernel's
first non-schema context a decision rather than an accident of tidying. The
constants name Restate paths as strings and declare no SDK dependency, so the
"zero `@restatedev/restate-sdk` outside `edges/durability`" gate must match the
**import specifier**, never the substring `restate`.

## Consequences

- A directory listing now states architecture. `packages/kernel/contracts` and
  `packages/entrypoints/ui` no longer look like peers, because they are not.
- Every dependency rule above is a fence row. Adding a forbidden edge fails the
  build rather than a review.
- The migration is expensive exactly once. Sixty-four relative tsconfig
  references, the vitest roots, the workspace glob and 291 literal package
  prefixes inside the fence all move; the tree therefore moves in **one atomic
  packet** (G1'), after G0 has retired the literals behind a single resolver
  and rehearsed it against a synthetic two-level layout.
- `STRUCTURAL_TOPOLOGY_CERTIFIED` is a computation, not a declaration: the
  layer table green, zero stale paths, the move-map fully applied, no literal
  package path in any law, and every path-scoped law reporting a non-empty
  scope. A law that matches nothing must fail rather than pass quietly, which
  is the failure this whole tranche exists to make impossible.

## Not in this record

The migration's packet-by-packet mechanics (G0–G10), which live in the
roadmap's P8-T tranche; the licence choice, which is the owner's; and the
documentation set, which G10 writes against this topology once it exists.
