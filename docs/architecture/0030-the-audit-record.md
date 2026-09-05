# ADR 0030 — An external audit is a frozen dated record, not an authority

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

On 2026-09-04 an independent fleet audited the backend V2 at snapshot
`4569478`: one orchestrating auditor, twelve named read-only auditors, and a
rubric applied to the same snapshot. The result is nineteen Markdown files — a
top-level `README.md` and, under `2026-09-04-backend-v2/`, an audit report, a
rubric, a use-case catalogue, a target data model, an architecture-decision
document and twelve evidence reports.

The owner decided the material belongs in this repository permanently rather
than in a chat log or an external archive. That decision created a problem the
fence surfaced immediately and correctly: `WRITE_SET` is an exact-literal
lookup over every tracked and untracked path, so nineteen untracked files under
`docs/audit/` were nineteen violations, and `pnpm check` stayed red for as long
as they sat there undeclared. Two `daemon` launchd drills that shell out to the
fence and assert exit 0 failed with it. Nothing was wrong with the files; they
were simply outside the law.

An audit is also a peculiar kind of document to commit. It contains findings
about this repository's own gaps, an ordered list of what its author thinks
should be fixed, and a data model for a system that does not exist yet. Left
undeclared, it is noise the fence reports forever. Declared carelessly — as a
living document, or as an authority — it becomes a second roadmap competing
with `docs/ROADMAP.md`, which `AGENTS.md` makes canonical.

## Decision

`docs/audit/` holds one folder per audit, named `<date>-<subject>/`, pinned to
the commit it examined and **frozen** once committed.

**The nineteen paths enter the fence as nineteen exact literals.**
`V2DOCSAUDIT_WRITE_SET` in `scripts/check-architecture.mjs` lists each file and
is spread into `WRITE_SET`. There is no glob: `WRITE_SET` is consulted through
`new Set(WRITE_SET).has(relativePath)`, so `docs/audit/**` would match nothing,
and the one prefix mechanism in that file is closed by design and is not
reopened. The array is append-only **by dated folder** — a later audit declares
its own array beside this one and never widens this one.

**This folder is a baseline, not an authority.** Nothing under `docs/audit/`
authorises any packet, and nothing in it reorders the original V2 roadmap. The
audit's own proposed ordering (`audit-report.md` §8, and the condensed order in
`2026-09-04-backend-v2/README.md`) is the auditor's opinion recorded at a date,
not a work order. `docs/ROADMAP.md` remains the canonical authority, exactly as
`AGENTS.md` states, and the owner's sequencing decision stands: finish the
original V2 unchanged, then re-audit and open a separate remediation roadmap.

**The whole folder is frozen, including the documents that read as living
ones.** `use-cases.md`, `data-model.md` and `architecture-decision.md` describe
a target rather than the tree, and would otherwise drift. They do not evolve in
place. A revision is a new dated audit folder, or an ADR in
`docs/architecture/`; a landed record is never edited to reflect a later
decision.

**The old layout is refused by the exact write-set itself.** The flat
`*-davila.md` files, `der.md`, `index.md`, the `*-v2-audit-reports/` directory,
the raw fence and suite logs and the `.acp-local` listing that briefly sat at
this level on 2026-09-04 are superseded and must never be reinstated. They were
never tracked, and any path not in the array fails the write-set check on the
next run.

## Why a glob or a lane envelope was not chosen

`docs/audit/**` is the shape everyone reaches for first, and the fence cannot
express it: the write-set gate is a `Set.has()` on the exact relative path, so
a glob is silently inert — it would appear to declare the folder while
declaring nothing. The one prefix mechanism that does exist is a closed lane
envelope, and reopening it to admit a documentation folder would widen the
broadest whitelist in the file to solve the narrowest problem in it.

## Why `RETIRED_PATHS` entries for the old layout were not chosen

Adding the ~20 superseded paths to the retired block would refuse them a second
time. They are already refused: the write-set is exact, so any path not listed
fails, and the old names are not listed. The only effect would be to grow the
frozen block that this very audit criticises for growing. The prohibition is
recorded here instead, where a reader looks for the reason rather than the
mechanism.

## Why a new law or exemption was not chosen

A `docs/audit`-scoped law was drafted and withdrawn as unnecessary, and no
exemption of any kind is taken. Measured against the fence's own patterns, the
nineteen files trip nothing: zero credential-material matches, zero product
tokens, zero forbidden roadmap literals, no persisting `launchctl` verb, and the
one `accounts.local.json` mention is a path string inside a schema diagram,
where the credential-store law is a filename law. `PATH_SCOPED_LAWS` therefore
stays at 91, and every content law keeps scanning `docs/audit/` unchanged and
unweakened. A folder that needs an exemption to be committed is a folder that
should have been amended instead.

## Consequences

**The fence now passes with the audit in the tree**, and the two launchd drills
that shell out to it pass with it. The cost is nineteen literals in a file that
is already long, and one more array a future reader must scroll past.

**Three passages were amended before the freeze**, because they described the
transient state that committing them ends. `docs/audit/README.md:19-20`,
`2026-09-04-backend-v2/README.md:84-86` and `rubric.md:7` each announced that
`pnpm check` was red until a packet added `docs/audit/**` to a write-set — a
claim that names a glob the fence cannot express and a condition this commit
closes. They now read as historical notes about the pre-commit window and point
here. No finding, score, count or verdict was touched; the amendments are
confined to sentences about the folder's own tracking status.

**Local absolute paths and a cross-repository reference were sanitised before
the freeze.** `audit-report.md:4` and `rubric.md:4` carried a developer's home
directory as the repository path; `README.md:16-17`,
`2026-09-04-backend-v2/README.md:84` and `evidence/structure.md:3` carried
scratchpad paths and a path inside another Rottay repository. No fence law fired
on any of them and none is a secret, but this repository is published, its own
output laws refuse absolute paths on every surface, and law 7 keeps it silent
about other Rottay repositories. They are now repo-relative or generic. What
remains disclosed is deliberate: the audit names its date, its snapshot SHA, its
requester and its authoring models, which is what makes a dated record
checkable.

**A frozen folder cannot be corrected.** If a finding is later shown wrong, the
correction is a new dated audit or an ADR, and the wrong finding stays where it
is. That is the price of a record whose value is that nobody edited it
afterwards.

**The nineteen files are pinned by digest at the freeze.** The combined digest
of their sorted `sha256  path` manifest is
`e02ecee9d571fe9ae67116335d539a5bb5b575d34ab969025396d25cec8b4852` before the
amendments above; the manifest after them is recorded in the packet's
source-ready report. No fence law asserts either — a reader who wants to check
that the folder was not edited can recompute it, and a later packet may pin it
if drift is ever observed.

## Not in this record

- **What the audit found, and what to do about it.** The findings are the
  folder's own content; the remediation programme is the separate roadmap the
  owner ordered after the original V2 completes, and it is not authorised here.
- **Whether a future audit may quote prohibitions verbatim.** An audit that
  quotes `AGENTS.md` law 7 word for word would trip the product-token law, and
  an archived fence run would reintroduce the `launchctl` trap that the raw logs
  carried. There is precedent for handling such a document per path when it
  arises; nothing is pre-widened for a document that does not exist.
- **Where durable copies of this material live outside the repository.** That is
  the owner's archive and deliberately not named here.
