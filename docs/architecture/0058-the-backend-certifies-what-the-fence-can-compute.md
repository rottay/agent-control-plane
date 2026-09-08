# ADR 0058 — The backend certifies what the fence can compute

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

The V2 roadmap's backend acceptance criterion asks for a gate over seven
clauses, and it chooses its words: **computed by the fence, derived,
withheld-is-failure**. Not a document somebody wrote at the end.

Every one of the seven clauses was already proved before this record existed.
Service independence is proved by a drill that runs the assembled path with the
pinned server ports unbound and by a path-scoped law that keeps the telemetry
edge out of the production import graph. Door equivalence is proved by a parity
suite where the CLI builds its rows from the ledger without seeing the server's
answer. A kill without duplication is proved in two halves, split by an import
law rather than by neglect. Stream resumption, payload absence on recorded
surfaces, the remote refusal and the policy-only model switch each have their
own named mechanism. So this packet is not one that proves criteria. What was
missing was the **aggregate**, and any way to notice when it stopped being true.

The failure mode the criterion is aimed at is specific and this repository has
seen it twice. A certification written once is accurate on the day it is
written and silently wrong afterwards: a suite gets renamed, a law is deleted in
a cleanup, a file moves, and the document still says the criterion is met. The
P8 matrix handles this by being honestly dated — anchored to the HEAD it was
written against, re-read by nobody. That is the right instrument for a phase
that closed. It is the wrong one for a claim that is supposed to hold now.

The other constraint is what a fence can honestly do. It cannot execute a drill.
A law that tried would be asserting the whole test suite from inside the linter,
which is exactly the overreach the P8-E preaudit corrected when it replaced
"absence" with **resolution**.

## Decision

`docs/certification/v2-backend-certification.md` is a **live** record, and
§22b of `scripts/check-architecture.mjs` is the gate that reads it on every run.

The record states the seven criteria with a verdict each, the evidence pointers
behind every proven one as `(path, anchor)` pairs, and the disclosure rows the
claim would overstate itself without. Five laws refuse the ways it could be
dishonest:

- **L-R19-1** — the record exists and parses; a table that parsed as empty is a
  failure, not a pass.
- **L-R19-2** — the seven criteria are total in both directions against the
  frozen `BE_CRITERIA`. Absence is a failure, and so is a name the fence does
  not define.
- **L-R19-3** — every row carries a verdict from `{PROVEN, OWED}`. Present with
  no verdict is withheld, and withheld is a failure.
- **L-R19-4** — a proven criterion's pointers resolve: the path in the tree and
  the anchor in the file, compared whitespace-normalised so a reflowed paragraph
  does not break a citation while a renamed suite does. **This is the
  derivation.**
- **L-R19-5** — an owed row carries a reason long enough to be one, a
  destination from a closed set of four, and an authorization the fence holds by
  exact name in `BE_OWED_AUTHORIZED`.

The three computations fold into `certificationBackend` and print as
`V2_BACKEND_CERTIFIED`, after `STRUCTURAL_TOPOLOGY_CERTIFIED` and only on a
passing run. A withheld input fails the fence rather than printing a receipt
with a hole in it, which is the same semantics §23 established at P8-E.

The record also absorbs the harness-port disposition, which needed a home and
no code: the port named in the roadmap is realized at the edge by ADR 0019's
adjudication, and the tool-client dependency it was paired with is moot because
the protocol port is hand-rolled and no such dependency is declared anywhere in
the tree.

## Why an authorized-owed register was chosen over the two alternatives

The gate has to answer one question the roadmap does not: what does a computed
gate do with a criterion that is honestly incomplete?

**Receipt-or-silence was rejected.** Print the receipt when all seven are
proven, and otherwise print a note and pass. This is the reflex and it is wrong
in the one word the roadmap chose deliberately: it makes withholding free, which
makes the gate a report. A report cannot fail, and a thing that cannot fail is
not a gate.

**Treating owed as an input that did not hold was rejected too**, for the
opposite reason. It sounds like the strict answer, but it means the packet lands
a red `pnpm check` on the day it lands, and a repository that normalises a red
gate has no gate at all. The strictness would be spent on the wrong thing:
disclosures are exactly what an honest certification carries.

`BE_OWED_AUTHORIZED` takes the third road. It names which rows are permitted to
be owed and where each is discharged, and the agreement runs **both ways**. An
owed row the register does not name is unauthorized withholding and fails. A
register entry whose row the record later proves is a stale authorization and
fails, which forces the register to shrink in the same commit that closes a row
rather than accumulating dead permissions. When it reaches zero, the receipt
becomes the unconditional claim with no law change.

This is the shape the repository already uses everywhere an exception exists:
`PRODUCT_AUTHORITY_EXEMPT`, `ROOT_DEV_DEPENDENCIES`, `DUPLICATION_ADJUDICATED`.
The lesson that made it non-negotiable is recent — an authorization inherited
**by name** is how a widening hides while the allow-list stays textually
unchanged. Naming is the mechanism, not the ceremony.

## Why the record is not a JSON sidecar

Relocating the policy version pin out of this file and into data was the right
call for a table that gets re-cut. It does not transfer here. The seven criteria
are fixed by the roadmap and their statuses change once, at closure. A sidecar
would create two homes for one fact — the exact shape the eval-lane laws exist
to refuse — and the reasoning that makes the record readable would have nowhere
to live. One file, and the fence parses it.

## Consequences

**The gate is now sensitive to renames, and that is the feature.** Any of the
39 pointers can break the fence by having its anchor edited. That cost is
deliberate: a citation nobody would notice going stale is the defect this record
exists to make impossible. The anchors are compared whitespace-normalised and
case-insensitively so that reformatting prose is free; renaming a `describe` is
not, and should not be.

**The fence now prints two receipts, so a sentence in §23 became false.** It
said the structural receipt was the output's last line. Both comments that said
so are corrected in the same change, naming the two receipts in order. A packet
that adds a law about tracked falsehoods does not leave one standing.

**The record must be maintained in the same commit as the code it cites.** A
packet that renames a suite named here must update this record, exactly as a
packet that adds a route must update the API reference. That is one more
document in the maintenance surface, and it is the price of the document being
true rather than dated.

**Five disclosures are now stated where they can be counted.** They were
previously spread across ADRs, a roadmap appendix and evidence outside the tree.
Their destinations are `OWNER_GATED` for the two the owner holds,
`POST_AUDIT_FOLLOW_UP` for the two the audit does, and `CLOSURE_DEBRIEF` for
governance. The receipt renders the count, so nobody can close the program
without meeting them.

**This record does not close the program.** It certifies the backend and
nothing more. The closure declaration is a separate act, taken by the closure
debrief against the roadmap's own text; the presentation wave and the deployment
phase stay excluded exactly as they were.
