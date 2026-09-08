# ADR 0059 — The gate's evidence binds to code, never to comments

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

ADR 0058 landed a computed gate over the seven backend clauses, and the record
it reads opens with a promise: "Rename a suite that proves a clause, delete a
law, move a file, and the gate is red on the next run." An independent re-audit
of the whole backend
(`.acp-local/evidence/reaudit/acp-v2-old-backend-reaudit-fable-v1.md`, SHA-256
`83d2af8499444dfba4d50b3c0809698375d7de4b332b4f3c25483da5a5cca4a0`, executed
2026-09-08 against this commit's parent) set out to falsify that sentence and
did.

The measurement, in a disposable copy and with the record left untouched. The
record's `BE-2` row cited `scripts/check-architecture.mjs` for the anchor
`Old-V2 B-E, R1b: every API error code is answered by name`. That string lives
at line 7193, in the **write-set docblock** of the R1b packet. The law that
actually compares the two door tables lived a hundred lines long, fifteen
thousand lines further down. The auditor deleted that law in full — header
comment to closing brace — and ran the fence:

```
$ grep -c "answered by name at both doors" scripts/check-architecture.mjs
0
$ node scripts/check-architecture.mjs          → exit 0
  ✓ V2_BACKEND_CERTIFIED: 7 of 7 criteria proven; 39 resolving pointers; …
```

The law that proved half of the door equivalence was gone, its computed note
was gone with it, and the gate certified — because `L-R19-4` compared the
anchor against the cited file **whole**, and a comment is part of a file.

This is not one unlucky citation. Classifying all 39 pointers by what the
anchor is bound to gives 21 `describe`/`it` titles or receipt literals, 8
identifiers in source files, 1 key in a tracked data file, 3 identifiers a live
law reads — and **6 bound to prose**: four comments or docblocks in the fence,
one docblock in a source file, and one string in a data registry that no law
reads. For all six, deleting the mechanism while its description survives left
the gate green. Only one of the six had any other net under it, and that net
was an unrelated count pin rather than this gate.

No criterion was falsified. Every cited law existed and printed its computed
note. The defect was in the **binding** between the record and the laws — in
what the gate could honestly claim about itself.

## Decision

**A comment is not evidence.** `L-R19-4` now resolves an anchor against
`beEvidenceText(path, content)` rather than the raw file. For a `.ts`, `.mts`,
`.js` or `.mjs` path the comments are removed first; `.md` and `.json` are
returned whole, because in those a sentence or a key is the content rather than
a description of it.

**The removal is line-oriented, and the reason is specific to this file.** The
obvious implementation is `stripComments`, which this fence already uses in a
hundred places. It is wrong here. Its block-comment arm cannot tell a comment
from a string containing one, and the file most often cited by the record is
the fence itself, which necessarily quotes comment syntax inside its own
refusal messages. Measured on the shipped file, one such literal opened a block
that ran 460 lines and swallowed the policy-pin law's own refusal — a
false negative that would refuse an honest anchor and blame the record. So the
removal drops any line whose first non-space characters open or continue a
comment, and cuts a trailing `//` outside a string using the same
`codeBeforeLineComment` walk the literal-path scan already relies on. It cannot
remove a line that holds code, so it cannot manufacture a refusal.

**The six pointers are re-anchored to literals the laws compute.** Each new
anchor exists in code, disappears with the mechanism, and is not a computed
count:

| Criterion | Was, in prose | Is, in code |
| --- | --- | --- |
| `BE-1` | the fence's `TEST_ONLY_DOMAINS` registry string | the fallback drill's own `it` title, in the drill |
| `BE-2` | the api-reference law's section header | that law's `API_ROUTES parsed as empty` refusal |
| `BE-2` | the R1b packet's write-set docblock | that law's computed note about both doors |
| `BE-3` | a docblock above `deriveInvocation` | `deriveInvocation` itself |
| `BE-4` | the V2-B3c write-set docblock | L1's note that the stream has one id producer |
| `BE-7` | a comment above the policy pin law | that law's `establishes no version` refusal |

`BE-1`'s move is the one that changes file as well as string. Its old anchor
was the `why` of a test-domain registry entry, and the re-audit's sharpest
observation about it is that **no law reads it**: there is no fence law about
the fallback gate, only the drill. A registry string is not a mechanism, so the
pointer now names the drill that is one.

**Two probes hold the property.** `N15` cites an anchor that only a comment
states and requires the refusal, with the same anchor in code as its control.
`N16` is the re-audit's own sequence: a cited file with a law body under a
header comment resolves, and the same tree with the body deleted and the
comment surviving goes red. Both were red against the pre-R19b containment,
which is the only interesting property a probe of this defect can have.

**One disclosure changes destination.** `OWED-R11B-EXPORTER-WIRING` was
destined `POST_AUDIT_FOLLOW_UP` while its own reason ended "the reconciliation
decides the wiring rather than this record". `RECONCILIATION` was already a
member of the closed destination set and was used by no row. The record and
`BE_OWED_AUTHORIZED` are corrected together, because `L-R19-5` compares the
pair by name in both directions and would refuse either edit made alone.

## Why re-anchoring alone was not chosen

Moving the six pointers to code literals and leaving the containment reading
whole files would have made the record true today and left the trap armed. The
next packet to cite a law would have no way to know that quoting its header
comment was the wrong half to quote, and nothing would tell it — the gate would
be green either way. The comment blindness is what makes the class of defect
impossible rather than absent; the re-anchoring is what makes the six honest
now. Neither substitutes for the other, and the probes exist because a rule
nobody can violate in a fixture is a rule nobody has tested.

## Why the record's opening sentence was kept

The sentence "delete a law … and the gate is red on the next run" was false for
six pointers, and the cheap repair is to weaken it to what the gate actually
did: check anchors. That trades a true strong claim for a true weak one and
loses the property worth having. With the containment comment-blind and the six
re-anchored, the sentence is true for all 39, so it stays and the mechanism
moved up to meet it. A certification whose headline claim has been quietly
narrowed is the same instrument as a dated matrix, and this record's whole
standing is that it is not one.

## Consequences

**Prose in a cited code file no longer counts, and that costs something.** A
pointer can now fail for a reason its author did not intend: quoting a
sentence that happens to live in a docblock. The refusal names the file and the
anchor, so the fix is mechanical, and the failure direction is the safe one —
the gate refuses rather than certifies.

**The record's maintenance surface is unchanged in size and sharper in kind.**
It was already true that renaming a cited suite breaks the fence. It is now
also true that deleting a cited law does, which is what ADR 0058 said in the
first place.

**ADR 0058's consequence about destinations is superseded in one word.** It
says the five disclosures are `OWNER_GATED` for the two the owner holds,
`POST_AUDIT_FOLLOW_UP` for the two the audit does, and `CLOSURE_DEBRIEF` for
governance. After this packet the second group is one row, and the fifth
destination in use is `RECONCILIATION`. That record is a landed packet's
narrative and is corrected here rather than rewritten there, in the way this
corpus already handles a superseded sentence.

**The receipt's counts do not move.** Seven of seven, 39 resolving pointers,
five owed rows. Only the destination tally changes, which is the visible half
of the disclosure correction. A packet about the honesty of a gate that also
moved its numbers would be hard to read as either.

## Not in this record

The re-audit's other findings are not settled here. The evidence-trail gap for
seven closing commits, the "17/17 rows closed" wording, and the two pre-recorded
debts it confirmed at HEAD all belong to the closure debrief, which the record
already carries as `OWED-GOVERNANCE-RECEIPTS`. Nothing here closes the program,
certifies the presentation wave, or touches the deployment phase.
