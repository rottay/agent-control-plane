# ADR 0060 — No evidence anchor resolves from emptiness or a comment

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

ADR 0059 bound the backend gate's evidence to code: for a code path the anchor
had to appear outside the cited file's comments, and six pointers were
re-anchored because they had been quoting docblocks. The removal it shipped was
line-oriented and said so — "this is not a parser and must not become one". It
dropped any line whose first non-space characters open or continue a comment,
and cut a trailing `//` that was not inside a string.

Three ways to satisfy a citation with nothing survived that. Measured against
the parent of this commit, with the §22b section evaluated in isolation over the
shipped record (the method in `docs/audit/evidence/index.md` §4.1):

```
CONTROL baseline (39 real pointers)   failures=0  pointers={"resolving":39}
NEG anchor empty (all 39 blanked)     failures=0  pointers={"resolving":39}
NEG anchor written as an em dash      failures=0  pointers={"resolving":39}
NEG anchor only in a BLOCK comment    failures=0  pointers={"resolving":39}
```

The first two are one defect: `flatten("")` is `""`, `String.includes("")` is
true of every string, and nothing guarded the anchor. A record could certify
seven clauses by citing seven paths and quoting nothing at all, and the em dash
reaches the same place from a cell that looks filled in, because `beCell` reads
`—` as the empty cell a markdown table cannot carry legibly.

The third is the line filter's shape. It caught the line that OPENS a block and
the ` * ` lines that continue one in the JSDoc style this repository writes
everywhere — which is why the defect stayed latent — and kept the interior line
of a bare block:

```
/*
TOOL_LOOPBACK_HOSTS
*/
```

That middle line opens nothing and continues nothing, so the filter called it
code. It is not a corner case; it is the shape a writer reaches for when quoting
a paragraph.

The same measurement found the rule wrong in the other direction as well. On
`export const R = /^https?:\/\//.source + "…"` the trailing-comment cut walks
the line character by character, meets the `//` inside the regex literal, and
discards the rest of the line — so the gate manufactured a refusal against an
honest citation. A law that fails closed against correct evidence is not merely
inconvenient: it teaches the next writer to re-anchor away from real code.

## Decision

**The removal becomes a lexical scan.** The cited file is tokenized with the
TypeScript scanner the repository already installs, comments are replaced by a
single space, and the anchor is compared against what is left. A comment becomes
a space rather than nothing so that removing one cannot join two fragments of
code that were separate in the source.

**A `/` is re-scanned as a regular expression unless the previous token is one
after which division is legal.** This is not a refinement; it is the whole
difference between a scanner and a scanner that works here. Measured over this
repository's versioned code: with the re-scan, **0 scanner errors** across the
318 `.ts` and 7 `.mjs` files; without it, **955 errors in
`scripts/check-architecture.mjs` alone**, which is the file the record cites most
often. The error direction is chosen deliberately: if the heuristic misjudges a
division as a regular expression the text is KEPT, so the law can fail to remove
something but can never delete code and invent a refusal.

**Four refusals are named rather than implied.** An empty anchor, a cited file
that is empty, a cited file with no code outside its comments, and a cited path
whose extension the record cannot scan each fail with their own sentence. The
existing "which that file does not state" is unchanged, byte for byte, because
three probes assert it.

**The fence now imports a package, and pins the fact.** `typescript` was already
a root devDependency and already named in `ROOT_DEV_DEPENDENCIES`; nothing was
installed for this packet. But the file opened by calling itself "deliberately
dependency free", and five laws elsewhere cited that self-description as the
reason they compare tables as text instead of importing them. One word of it is
now false.

The repair is not a corrected sentence. A sentence is what ADR 0059 was about:
prose that describes a mechanism outlives the mechanism, and nothing goes red.
So the fence states its authorized import set as data and checks it against a
static analysis of its own source on every run, fail-closed in both directions —
an import the set does not name, and a name the file no longer imports. The six
self-referential sentences were rewritten in the same commit to say what is
actually load-bearing and remains true: the fence imports **no package of this
repository** and runs before any build, so a compiled package may not exist when
it runs. That is the reason those five laws needed; "dependency free" was a
stronger claim than any of them used.

**The scanned form of a cited file is memoized by path.** The record cites 19
code files across 39 rows and the fence itself up to seven times; without a
cache a 1.1 MB file is tokenized once per citation. The cache is keyed by the
path, is filled during the one section that reads these files, and does not
outlive the run.

## Why extending the scan to `.tsx` was not chosen

`BE_CODE_EVIDENCE` stays `.ts`, `.mts`, `.js`, `.mjs`, and this packet adds a
guard rather than a wider table: a row citing any other extension than those
plus `.md` and `.json` is refused by name.

The measurement is the reason. Over this repository's **56 versioned `.tsx`
files the scanner raises 343 errors even with `LanguageVariant.JSX`**, against 0
over the 318 `.ts` and 7 `.mjs`. JSX text is not tokenizable without a parser's
context, and a scan that errors is a scan that may drop code and refuse honest
evidence — the exact direction this ADR just spent a section avoiding. Extending
the table needs a different technique and belongs to a packet that can measure
it. What could not be left standing is the silent version: an unscannable
extension falling through to "read the file whole" would reopen ADR 0059's
defect through the extension door, so the door is closed loudly instead.

## What an anchor proves, and what it does not

An anchor proves **location, not conduct and not reachability**. That a string
appears in a token of a cited file says the file states it; it says nothing
about whether the code runs, whether any test exercises it, or whether the
security property the clause claims actually holds. Strings count as code,
**including inert ones** — a constant nobody reads satisfies a pointer, and most
of the 39 real anchors are phrases inside string literals: refusal messages,
`describe` titles, computed notes. This is deliberate, because those literals
are what a deletion actually takes with it, and it is the ceiling of the
instrument. The behavioural test remains separate and obligatory; ADR 0058 said
so and nothing here changes it.

## Consequences

**The record did not move.** All 39 rows resolve under the new rule with no
re-anchoring, which was measured before the rule was written. ADR 0059 moved six
rows; this packet moves none, so the receipt's counts — seven of seven, 39
resolving pointers, five owed rows — are unchanged and the diff to the record is
one paragraph of prose.

**A dependency is now a declared thing.** Adding an import to the fence is a
two-line change: the import, and the entry in the set that authorizes it. That
is friction on purpose, and it is the same shape as every other register in this
file.

**The fence no longer runs in a checkout without `node_modules`.** It never
needed to — `pnpm install` precedes `pnpm check` in AGENTS.md, in CI and in the
pre-push hook — but the property is now genuinely gone rather than merely
unused, and a probe that copies the fence to a temporary directory has to carry
module resolution with it.

**A cited file that is only comments is now refused for saying so.** Under the
old rule it failed as "which that file does not state", which sends a reader to
search for a string in a file that has nothing in it.

## Not in this record

The scanner is not generalized. `stripComments`, which this fence uses in a
hundred other laws, is untouched: ADR 0059 recorded why its `/\*[\s\S]*?\*\//`
arm is wrong for this job — measured at 460 lines swallowed — and replacing it
repository-wide is a packet with its own write-set and its own negatives.
`codeBeforeLineComment` also stays, with one consumer left: the structural
topology law of section 23, which is outside this write-set. Nothing here
certifies the backend, closes the program, or touches the deployment phase; the
gate's own exit code still depends on the documentation bridge this packet does
not open.
