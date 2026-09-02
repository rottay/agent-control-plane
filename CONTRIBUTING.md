# Contributing

Thank you for looking. Before you spend time on a change, read this page — the
rules here are unusual on purpose, and two of them will surprise you.

## Two things to know first

**You cannot push, and neither can we.** `.githooks/pre-push` refuses
unconditionally. There is no argument, environment variable, ref pattern or
remote that makes it allow a push, and no remote is configured. This is not a
misconfiguration to be helpfully fixed: it is the authority regime this
repository runs under, and `pnpm check` verifies that the hook still denies.

**Nothing here is adopted into real operation.** The system observes and
decides; it does not act. Adoption is a single explicit decision that happens
after P8 certification and a separate P9 authorization. A contribution that
assumes production usage is assuming something that has not happened.

Because of both, the useful contribution today is a **proposal**, an issue, or
a reviewed patch — not a pull request against a remote that does not exist.
Open a discussion describing what you want to change and why, and the owner
will tell you whether it is in scope and how to get it reviewed.

## Setting up

```sh
pnpm install
git config core.hooksPath .githooks
pnpm check
```

The second line is not optional. A fence that is installed but not armed is not
a fence, and the third line will tell you if you skipped it.

Requirements are pinned: Node `>=22.17.0 <23` and pnpm `>=10.26.2`. The
versions are exact on purpose — see below.

## `pnpm check` is the contract

```sh
pnpm check   # fence → lint → typecheck → tests
```

It runs the architecture fence **first**, before the compiler and the tests,
because the fence is what decides whether a change was allowed to be made at
all. It checks write-set conformance, the roadmap digest, authority literals,
the pre-push denial, the hook path, the absence of remotes and credential
stores — and, since G10, that the documentation still matches the code it
describes.

If `pnpm check` fails, that is the answer. Do not work around it, and do not
weaken a law to make your change fit: propose the law change separately, with
its reasoning, as its own decision.

## The three rules that shape every change

These come from `AGENTS.md`, which is the full operating law. They are written
here in contributor form.

### 1. An exact write-set

Every change is authorized as a specific list of paths. Touch nothing outside
it. If your change needs a file the list does not name, **stop and propose the
addition** rather than widening scope quietly — the fence will refuse the diff,
and that refusal is the mechanism working.

### 2. A single writer per worktree

One writer at a time on a given worktree, subagents included. Two writers
produce a diff neither can account for.

### 3. Independent validation

A change is verified by someone who did not write it, against the same diff.
Local commits require a `CommitAuthorizationReceipt` from that independent
verifier. "The tests pass" is evidence; it is not authorization.

## What good evidence looks like

This repository prefers a failing fixture to a paragraph. If you add a law,
show it firing on a case that should fail and staying silent on one that should
pass. If you fix a bug, add the test that would have caught it. If you make a
measured claim in a document, cite the file and the literal that make it true —
`SECURITY.md` shows the pattern, and the fence greps those anchors.

Report outcomes exactly: if a check fails, say so and show the output.

## Where code goes

Twelve packages under five strata, and a package's stratum decides what it may
import:

| Stratum | Packages | May be imported by |
| --- | --- | --- |
| `kernel` | `contracts`, `protocol` | everything |
| `persistence` | `ledger` | domains, edges, entrypoints |
| `domains` | `runtime`, `accounts`, `observation` | edges, entrypoints |
| `edges` | `providers`, `durability` | entrypoints |
| `entrypoints` | `daemon`, `gateway`, `cli`, `console` | nothing |

Every package sits at `packages/<stratum>/<name>/`, and each one's import
allowance is a fence law with a named list — not a convention. A cross-stratum
reach the table does not permit fails the fence by name.

Tests mirror sources: a file at `<package>/src/a/b/index.ts` is tested by
`<package>/test/a/b/index.test.ts`. A test path that mirrors nothing must be a
registered test-only domain. The fence asserts the correspondence in both
directions, so a test tree cannot drift away from the code it covers.

## Dependencies

The graph is frozen. Adding a dependency is an owner-level decision, not a
detail of your change:

- install scripts are denied by default — the build allow-list holds exactly
  one adjudicated entry;
- shared versions live in one catalog in `pnpm-workspace.yaml`, so two packages
  cannot disagree about a version;
- the lockfile is checked for packages that may never enter the graph at all.

If your change needs a new dependency, propose it separately and say what it
buys that the existing surface cannot.

## Documentation is checked, not trusted

Since G10 the fence reads the documentation:

- a package README that enumerates its exports is checked against that
  package's pinned surface, in both directions — a name no barrel exports
  fails, and an export a "complete list" omits fails;
- `docs/api-reference.md` must be a bijection with `API_ROUTES`;
- every load-bearing claim in `SECURITY.md` names a file and a literal, and the
  fence greps each one;
- the ADR template must keep its required sections, and every record must be
  numbered contiguously and appear in the corpus index.

So if you change an export, a route, a security mechanism or an ADR, the
document that describes it changes in the same commit. That is enforced.

## Git

- Conventional commits: `type(scope): description`.
- No `Co-Authored-By` and no AI attribution in commit messages.
- No emojis, in code, commits or documentation. Text icons only: `✓`, `✗`, `→`,
  `•`.
- Never `git restore` or `git checkout --` on a directory, never
  `git reset --hard`, never `stash` or `clean`. Fix the broken lines directly.
  These have destroyed work here before, which is why they are named.

## Licence

The repository is MIT (`LICENSE`). By proposing a change you agree it may be
distributed under those terms.
