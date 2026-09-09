# ADR 0061 — The fence admits a living specification, not a frozen record

- Status: accepted.
- Supersedes: ADR 0030.
- Superseded-by: none.

## Context

ADR 0030 decided that `docs/audit/` holds one folder per audit, named
`<date>-<subject>/`, pinned to the commit it examined and frozen once committed,
and that **the nineteen paths enter the fence as nineteen exact literals**. That
was true of the tree it described. It is no longer true of the tree.

What sits under `docs/audit/` today is not an audit. It is a consolidated
specification of what this control plane must become — architecture, data model,
contracts, requirements, quality rubric, packet inventory and the coordination
mandate — and it says so in its own first paragraph: "una sola documentación
estable: no hay ciclos, versiones ni carpetas fechadas compitiendo entre sí".
Thirty-eight documents, no dated folders, each concept owned by exactly one file
and linked from the index. The owner authorized the consolidation and the
withdrawal of the twenty-five superseded drafts after an independent review.

Three statements could not all be true at once, and
`docs/audit/implementation/migration/index.md` §1 named the contradiction rather
than routing around it:

- the standing authority says an audit is a frozen dated record, not an
  authority, and that `docs/ROADMAP.md` stays canonical;
- the fence requires every tracked and untracked path to sit inside an exact
  write-set, one literal per file, and its block for this folder enumerated
  twenty-two paths of the 2026-09-04 package;
- the consolidated documentation exists, the drafts are withdrawn, and the tree
  no longer matches either of the first two.

The measured cost of leaving it unresolved was a red gate. At HEAD `e1c9b35` the
fence exited 1 with exactly 61 refusals: **18** tracked paths missing (the
withdrawn `2026-09-04-backend-v2/` package, deleted from the working tree but
still in the index), **37** paths outside the exact write-set (the consolidated
documents, which no literal declared), and **6** product-environment refusals.
Both certification receipts — `STRUCTURAL_TOPOLOGY_CERTIFIED` and
`V2_BACKEND_CERTIFIED` — are withheld on a failing run, so a red gate here also
meant the backend could not certify.

The six product-environment refusals are the part worth recording, because they
are not a write-set problem at all. That law iterates every tracked and untracked
file that is not one of eight exempt paths, and no amount of declaring a path
exempts its content. Seven occurrences across five documents tripped it, and
every one of the seven names the product **in order to exclude it**: a cutover
row saying adoption is unauthorized, a verification note saying identity is read
from request metadata rather than from a terminal session's name, a kickoff
instruction saying not to touch other repositories. ADR 0030 anticipated exactly
this case and deliberately left it open: "Whether a future audit may quote
prohibitions verbatim... There is precedent for handling such a document per
path when it arises; nothing is pre-widened for a document that does not exist."
The document now exists.

## Decision

**The block admits the living specification: 42 literals.** The thirty-eight
consolidated documents, each pinned by SHA-256 against HEAD `e1c9b35` when the
packet opened, plus the three support paths the previous block already carried
(`scripts/check-architecture.mjs`, `docs/architecture/0030-the-audit-record.md`,
`docs/architecture/index.md`) and this record. One path per literal, no glob:
`WRITE_SET` is consulted through `new Set(WRITE_SET).has(relativePath)`, so
`docs/audit/**` would match nothing, and the one prefix mechanism in that file
stays closed. Every one of the thirty-eight was checked with `git check-ignore`
before it was written down — the defect that already cost two documents, whose
`coverage/` segment `.gitignore` captured by name.

`AGENTS.md`, `CLAUDE.md` and `docs/ROADMAP.md` take **no new literal**. The
migration document asks that they be checked, and the check has an unambiguous
answer: all three are already declared in `P0_WRITE_SET` and again in
`PUBLICATION_WRITE_SET`. A third entry would be a duplicate, which the packet's
first rule forbids and which the fence would not catch, since `WRITE_SET`
resolves to a `Set`.

**The withdrawal is confirmed through `RETIRED_PATHS`, not through the index.**
Removing the eighteen literals is not sufficient on its own: the conformance loop
iterates `git ls-files --cached --others`, which still lists a deletion that has
not been staged, so the eighteen would have migrated from "tracked path is
missing" to "path is outside the exact write-set" and the gate would have stayed
red in a new dialect. The eighteen are therefore named in `RETIRED_PATHS`, where
`retiredInIndex` absorbs them during the pending-deletion window and the
retired-path law refuses them permanently if they ever come back. This is the
route that leaves the gate green **without a writer mutating the shared index**,
which the coordination contract reserves to the commit window.

A note on a sentence that could be misread: the block's own docblock said the old
layout "is refused by the exact write-set itself, not by `RETIRED_PATHS`". That
was about the pre-0030 flat layout, which was **never tracked**. These eighteen
were tracked, so the reasoning does not carry over, and the docblock now says so.

**The five documents were corrected; no law was touched.** Rule 3 of the
migration spec is explicit — "Si un documento no puede entrar sin debilitar una
ley, el documento se corrige, no la ley" — and the short path was available and
refused. Adding `docs/audit/` to `PRODUCT_AUTHORITY_EXEMPT`, or dropping a token
from `PRODUCT_TOKENS`, would have turned the gate green in one line and cost the
law. Instead the seven passages were rewritten to state the same prohibition
without naming the thing prohibited: adoption "en repositorios de producto",
identity read from request metadata rather than "del nombre de la sesión de
terminal". Each rewritten line still forbids what it forbade;
`PRODUCT_AUTHORITY_EXEMPT` still holds eight paths, `PRODUCT_TOKENS` still holds
nine tokens, and neither is edited by this packet.

**The roles are reconciled by reframing, not by rewriting the laws.**
`docs/audit/kickoff.md` records the mandate the owner approved: Kimi K3 is the
DT, coordinates local commits and is the habitual auditor; one Claude Opus
integrates directly on `main` and is the only canonical writer; Codex reviews
Kimi's own edits and milestones. `AGENTS.md` still carried an earlier fleet —
mechanical implementers in isolated worktrees, a separate strict auditor — and
`CLAUDE.md` told subagents to take "their own isolated worktrees", which the
kickoff forbids outright. Neither document loses a law. `AGENTS.md` gains a
"Reparto vigente" section stating that the kickoff distribution is the active
one and that the other rows are catalogue roles not currently staffed;
`CLAUDE.md` replaces the isolated-worktree clause with the disjoint scope the
kickoff actually defines — files, outputs and resources, not folders. The ten
laws, their eleven required literals in `AGENTS.md` and their five in
`CLAUDE.md`, are untouched. Law 1 remains true where there is one worktree.

**The roadmap points at the specification without ceding authority, and the
digest is re-pinned over the content that moved it.** `docs/ROADMAP.md` gains one
paragraph after its "Evidencia de diseño y revisión" block, naming `docs/audit/`
as the planning source for architecture, contracts, requirements and packet
sequence, admitted through this record, and restating that where the two speak
the roadmap governs and that moving that condition is a separate act of the
owner. Nothing was deleted. The seven `ROADMAP_LITERALS` and the status literal
are intact and the four forbidden literals stay absent.

Rule 2 forbids a blind digest replacement, so the arithmetic is recorded here
rather than only performed:

| | Value |
| --- | --- |
| `ROADMAP_SHA256` before | `bf4c63b5a230e48f348847d8aee64cb61bd0e5696e9cd35b9531e796333b5a9a` |
| `ROADMAP_SHA256` after | `feaa94aa1e7ccdbbb8bec18374f44889e6cd267acadfe7b8e204e8064951c052` |
| What moved it | the single added paragraph described above, inserted after the review-evidence block; no other line of `docs/ROADMAP.md` changed |

The re-pin lands in the same commit as the edit, because a digest pinned in one
commit to content that arrives in another certifies nothing.

**This record and ADR 0030 form the corpus's first `Supersedes` /
`Superseded-by` pair.** The convention has been stated since the beginning —
`_template.md` says to "write a new one and set the `Supersedes` /
`Superseded-by` pair on both", and `docs/architecture/index.md` repeats it — but
no record had ever exercised it: all sixty said `none.` or `nothing`. The
practised precedent was the one-directional `Amends:` used by ADR 0015, 0019 and
0020, none of which gave the amended record a back-reference. ADR 0030 gains one
line and nothing else. Its body, its evidence and its count of nineteen stay
exactly as they were written, because a record whose value is that nobody edited
it afterwards cannot be corrected into agreement with a later tree.

## Why an exemption for `docs/audit/` was not chosen

It is one line, it produces green immediately, and there is a ready-made
rhetorical cover sitting in the file: `docs/certification/p8-matrix.md` is
exempt for a closely related reason, and the comment justifying it argues that "a
document that may not quote the prohibition it is certifying compliance with
could not do its job". The argument transfers to these five documents almost
word for word.

It was refused because the exemption's own comment says what it is: "This
exemption exists for exactly that class, and it is narrow: this one path, not the
directory." Extending it to a thirty-eight document folder that will keep growing
is not applying a precedent, it is converting a named exception into a scope. The
cost of the alternative is real and was paid: seven passages of prose had to be
reworded, and the wording is slightly less direct than naming the repository
would be. That is the cheaper of the two prices. A law that yields the first time
a document finds it inconvenient is a law that will yield again, and the whole
value of the product-token rule is that this repository stays silent about
product repositories even when a document has an excellent reason not to.

## Why staging the withdrawal was not chosen

Removing the eighteen literals and staging the eighteen deletions would also have
produced a green gate, with no growth in `RETIRED_PATHS` at all, and it is
arguably the more honest representation of the tree.

It was refused on ownership, not on mechanism. The index is a shared resource,
and `docs/audit/kickoff.md` §5 reserves its mutation to the commit window that
the DT runs — "staging sólo de rutas exactas, nunca `git add` global" — with all
writer mutation suspended. A writer who stages during the packet has changed a
resource outside its write-set and outside its window, and the receipt would be
describing a tree that a verifier could not reproduce from the diff alone. The
`RETIRED_PATHS` route is self-contained in the diff: a reader sees the eighteen
names, the retired-path law keeps them out permanently, and the pending deletion
is confirmed by the same commit that lands this record.

## Consequences

**The gate goes green and the two receipts return.** The 61 refusals fall to 0:
18 by removing the literals and naming the paths as retired, 37 by declaring the
consolidated documents, 6 by correcting the documents that named the product.
`STRUCTURAL_TOPOLOGY_CERTIFIED` and `V2_BACKEND_CERTIFIED` are withheld on a
failing run and therefore reappear — which is what makes their presence, rather
than an exit code alone, the evidence this packet is verified against.

**The block is no longer append-only by dated folder.** ADR 0030 described a
block that grows by a new array per audit. This one describes a folder whose
contents change, so the array will have to be re-derived whenever a document is
added or removed under `docs/audit/`, and a writer who adds a file there without
adding its literal gets a red gate on the next run. That friction is the price of
an exact write-set and it is deliberate; what it must not become is a reason to
reach for a glob, which would declare nothing.

**`RETIRED_PATHS` grows by eighteen and the certification input moves with it.**
The "zero stale paths" input reports the array's length, so the certified count
changes in this commit, and the fence's single retired-path note grows by
eighteen names. Neither is a failure; both are output a verifier should expect to
see change.

**Two documents now disagree about their own subject, on purpose.** ADR 0030
still says `docs/audit/` holds dated frozen folders and that nineteen literals
declare them. That statement is preserved and is now false of the tree, which is
what a superseded record is for. A reader arriving at 0030 is sent here by its
`Superseded-by:` line; a reader who edits 0030 to agree with the tree has
destroyed the history the corpus exists to keep.

**The specification is admitted, not enthroned.** Being inside the write-set
means the fence will not refuse these files. It means nothing else.

## Not in this record

- **Whether the specification becomes operational authority.** It does not, by
  this record or by being admitted. `docs/ROADMAP.md` stays canonical, exactly as
  `AGENTS.md` says, and the migration document's §6 is explicit that admission
  "no convierte esta especificación en autoridad operativa por sí sola". That
  decision is the owner's and is recorded in `docs/audit/decisions/index.md`.
- **P9, cutover, and adoption in any product repository.** All deferred, all
  requiring a separate owner act. Law 8 is untouched and the fence still refuses
  a cutover claim in the roadmap.
- **Publication policy.** Unchanged. `.githooks/pre-push` and its pinned digest
  are outside this packet's write-set and the deny/permit matrix is not touched.
- **The fence's own size.** The migration document's §5 notes that the script is
  long and that moving laws to data is a separate packet, at M13. Admitting
  twenty net literals makes it slightly longer, which is an argument for that
  packet rather than a reason to widen this one.
- **What the specification says.** This record admits thirty-eight documents to
  the write-set. It does not adopt, ratify or schedule any plan inside them.
