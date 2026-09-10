# ADR 0063 — The extractor reads grammar, not lexical luck

- Status: accepted.
- Supersedes: ADR 0060, in its mechanism clauses only.
- Superseded-by: none.

## Context

ADR 0060 decided that the backend gate reads a cited file's CODE, and that the
removal of its comments "becomes a lexical scan". The scan tokenizes the file
with the TypeScript scanner, replaces each comment with one space, and answers
one question by hand: at a `/`, is this division or the start of a regular
expression? A scanner cannot know. It has to guess from the token before the
slash, and 0060 shipped that guess as a set of token kinds, `TS_DIVISION_AFTER`.

The guess was wrong four times, and each time the repair was correct and
insufficient:

- **R19c** — a `}` that closes a `${…}` had to be re-read as template, or the
  literal's own closing backtick opened a fresh template that ran to end of
  file and returned every comment below it as string text.
- **R19e** — `)` closes both `if (…)` and `(a + b)`, so the set could not
  decide it by kind; a parenthesis stack was added, and with it an invariant
  (parentheses balance, braces balance, no literal unterminated) whose breach
  returns nothing.
- **R19f** — the keyword that IS the operand stayed misread:
  `({ default: 4 }).default / 2` divides, `default` is correctly absent from
  the set, and the slash was re-scanned as a regular expression that closed on
  the first `/` of the comment behind it.
- **F-1** (R19f's own follow-up) — `?.` is not always followed by a name;
  `f?.(…)` and `a?.[…]` put the next token in operand position, and reading
  those as divisions turned a `/[//]/` into a comment that erased the line.

Measured on this fence, in the section evaluated in isolation over the shipped
record (the method in `docs/audit/evidence/index.md` §4.1), the same class was
still open after all four:

```
value! / 2; // TOOL_LOOPBACK_HOSTS               failures=0  pointers={"resolving":39}
value as number / 2; // TOOL_LOOPBACK_HOSTS      failures=0  pointers={"resolving":39}
4 satisfies number / 2; // TOOL_LOOPBACK_HOSTS   failures=0  pointers={"resolving":39}
{} / 2; // TOOL_LOOPBACK_HOSTS                   failures=0  pointers={"resolving":39}
f()! / 2; // TOOL_LOOPBACK_HOSTS                 failures=0  pointers={"resolving":39}
```

Every row is an anchor renamed out of its cited file and restated in a line
comment after such a statement. The gate certified all of them. The same shapes
fail in the other direction too — `v! / 2; export const X = "…"`, with the
anchor in plain code, returned `failures=1 pointers=null` — so the error
direction was not chosen either.

These are not five defects. A non-null assertion, a type assertion, an object
literal, a function expression, a class expression, a call, an index, `as
const`, `satisfies` and `undefined` all end an operand, and none of them ends
in a token any list of kinds names. The instrument was the defect: **a list of
token kinds cannot express a grammar.** Codex said so when the two first
counterexamples were reported — adding tokens to the division list does not
distinguish their grammatical contexts — and the owner directed the repair at
the parser this repository already installs.

## Decision

**The extractor parses.** `beCodeTokens(path, content)` builds a `SourceFile`
with `ts.createSourceFile`, takes each literal's range from the AST, and sweeps
the gaps between them. The rule is three sentences and they are the whole of it:

1. the file is parsed, and any syntactic diagnostic leaves it stating no code
   at all;
2. the literals — string, the parts of a template, regular expression, JSX
   text — are code, with exactly the text the parser gives them;
3. every `//` or `/*` outside a literal opens a comment, which becomes one
   space.

The question "does this `/` divide?" is never asked. Outside a literal the
grammar admits identifiers, keywords, numbers, punctuation and comments; the
only punctuation beginning with `/` is `/` and `/=`, and a `/` followed by `/`
or `*` is neither. A division followed by a regular expression puts the second
slash inside a literal's range. `TS_DIVISION_AFTER`, `TS_CONTROL_HEAD` and
`TS_MEMBER_ACCESS` are deleted rather than extended.

**The literal ranges come from `forEachChild`, and the comment extents from
`getTrailingCommentRanges`.** Not `getLeadingCommentRanges`: it collects only
after a line break, so it returns nothing at the `//` of `a = 1; // c`.

**A file with any syntactic diagnostic states no code, and this is a rule of
admission rather than a claim of validity.** "Diagnostic" means what
`program.getSyntacticDiagnostics(sourceFile)` reports for the `typescript`
version this repository pins — **5.9.3**, exact in `package.json` and in the
lockfile — under the options the fence declares (`allowJs`, `noLib`,
`noResolve`, `types: []`, `ScriptTarget.Latest`) and the extension map
`.ts`/`.mts` → TypeScript, `.js`/`.mjs` → JavaScript. Raising `typescript` is a
change to what this gate admits and obliges a re-run of the corpus measurement
below. What the rule does not claim is semantic validity: an unknown regular
expression flag (`/a/q`) raises no syntactic diagnostic and is admitted, which
is correct, because a checker's complaint about a literal does not move where
that literal ends.

The diagnostics come from the **public** API over a one-file `Program` with a
nine-method `CompilerHost` that answers from memory and never touches `ts.sys`.
The internal `sourceFile.parseDiagnostics` field holds the same answer, is
absent from `typescript.d.ts`, and would rest the rule on something the package
does not promise. The public route also reports TypeScript syntax used in a
`.js` or `.mjs`, which the extension map wants.

**A fifth refusal is named.** `whose cited file has syntactic diagnostics; no
code from that file is admitted as evidence`. It is a fifth rather than a
rewording of "holds no code outside its comments", because that sentence is
FALSE of a file with a syntax error and this law's principle is that a refusal
says the most useful true thing: one reader is told to write code, the other to
fix syntax. The two causes are distinguished without reading the file twice —
every non-comment character is emitted and every comment becomes one space, so
a file with any content comes back with at least one character, and the empty
string has exactly one source.

**The shebang is protected before the sweep.** The parser reads `#!…` as trivia
rather than as a node, so it lies inside no literal's range; an unterminated
`/*` inside it would otherwise open a comment running to end of file and delete
the code below. `#!/usr/bin/env node /* X` followed by `export const KEEP = 1;`
has **zero diagnostics**, so nothing else would have caught it. Codex measured
this against the prototype and required the protection.

**JSX text is a literal kind.** `ScriptKind.JS` parses JSX, so a `.mjs` holding
JSX arrives with no diagnostic at all and its text is content. This is not a
widening of `BE_CODE_EVIDENCE`: `.tsx` is still refused by extension.

**The mirror is still a restatement.** `beCodeOnly(path, text)` in
`scripts/architecture/roots.test.mjs` states the three sentences by hand, plus
the two things that could make the two readers disagree while `P2` stayed
green: the extension map, and which diagnostics API is asked. R19d's reason for
a hand-written mirror is unchanged — a mirror that read the rule out of the
fence would agree with a rule somebody weakened — and the mirror is 30 lines
where it was 70, because the rule it restates is three sentences where it was
four clauses, three token sets and two stacks.

**Measured, before the rule was written and again by the writer who landed it.**

| Measure | Result |
| --- | --- |
| Corpus: `.ts` + `.mjs` versioned files | 325 (318 + 7), 7 359 167 bytes |
| Files with syntactic diagnostics | **0** |
| Code text byte-different from the scanner's | **0 of 325** |
| Evidence pointers in the shipped record | **39, all resolving, none re-anchored** |
| Probes over the four packets' shapes plus R19g's | 29; scanner wrong on 17, parser wrong on 0 |
| Extractor over the 19 cited files, median of 5 | 89 ms (scanner 55 ms), budget ≤150 ms |
| Suite | 202 probes; `BE_REFUSALS` 24 entries |

The record did not move. The diff to `docs/certification/v2-backend-certification.md`
is one paragraph of prose, for the same reason ADR 0059 gives: prose that
describes a mechanism outlives the mechanism, and nothing goes red.

## What this record supersedes in ADR 0060, and what it leaves standing

Superseded, and only these: **"The removal becomes a lexical scan"** and **"A
`/` is re-scanned as a regular expression unless the previous token is one
after which division is legal"**. Both were true of the mechanism and both are
now false.

Standing, unchanged: 0060's **four refusals** and their sentences byte for
byte; the ceiling that **an anchor proves location, not conduct and not
reachability**, and that strings count as code including inert ones; the
**exclusion of `.tsx`** from `BE_CODE_EVIDENCE`; the **import pin of section
22a** and the register `FENCE_IMPORTS_AUTHORIZED`, which gains nothing here
because `typescript` was already in it; the **memoization by path**; and the
addendum A1-δ in full, including the amendment to ADR 0053.

Also standing, and worth naming because it is the reason four packets were
needed rather than one: 0060's choice to keep text when the guess went wrong
was measured false in R19e, and the invariant that replaced it is what R19g
generalizes. The scanner's degradation ("a scan that has lost sync returns
nothing") becomes the parser's ("a file with any syntactic diagnostic states no
code"), which is a strict superset: `const value = 4 4;` has balanced
parentheses and braces and no unterminated literal, so the scanner returned
text for it and this extractor returns nothing.

## Why the token tree was not chosen

The obvious implementation walks `node.getChildren()` to the leaves and takes
each token's leading and trailing trivia. It was prototyped and measured. It
agrees with the chosen variant byte for byte over all 325 versioned files, and
diverges where it matters:

| Source | AST ranges | Token tree |
| --- | --- | --- |
| `export const A = 1;` + `/** X */` | drops | **keeps** |
| `function f() {}` + `/** X */` | drops | **keeps** |
| `export const A = 1;` + `/* X */` | drops | drops |
| `export const A = 1; /** X */` | drops | drops |

The parser attaches a trailing JSDoc to the `EndOfFileToken` as `jsDoc`, so
that token is no longer a leaf and its trivia is never read. A docblock left
after the last statement of a file is exactly this law's defect class in the
shape a writer produces by accident, and one of this repository's own `.tsx`
files ends that way. The chosen variant does not depend on where the parser
hangs a docblock; the token tree also costs 2.2× (619 ms against 287 ms over
the corpus). `N52` and `M18` are the probes, and they are declared as a
discriminator against an implementation rather than as a correction of one.

## Why more tokens were not added to the list

The repair that fits in one line is to put `ExclamationToken`, `CloseBraceToken`
and the rest into `TS_DIVISION_AFTER`. Codex refused it in the consultation
that opened this packet, and the reason is structural rather than aesthetic: a
token kind does not carry its grammatical context. `}` ends an object literal
(division follows) and also a block (a regular expression follows); `)` was
already the entry 0060 admitted it could not decide by kind, and R19e had to
carry a stack for it. Each addition would have been a new guess with its own
counterexample, and the sequence R19c → R19e → R19f → F-1 is the evidence that
the sequence does not terminate.

## Consequences

**The fence now builds a `Program` per cited file.** 89 ms over the 19 files
the record cites where the scanner took 55 ms, memoized by path as before. The
budget is written down (≤150 ms) so the next packet has something to fail.

**The gate's behaviour is pinned to a compiler version.** It always was — the
scanner came from the same package — but the surface is wider now, so the pin
is stated: raising `typescript` is a change to what this gate admits, and the
corpus measurement has to be re-run with it.

**A file that stops parsing loses every citation into it, loudly.** Today no
versioned file does. `pnpm typecheck` would see it first; the fifth refusal
names the cause when it does not.

**Four packets of hard-won scanner reasoning are now history.** R19c's template
re-scan, R19e's stack and invariant, R19f's property-name clause: the
mechanisms are gone, and their behavioural probes are not. `N22b`,
`N24b`–`N24e`, `N31`–`N35`, `N41`–`N45` and `M1`–`M15` are green under the
parser with no fixture rewritten, which is what makes this a change of
mechanism rather than a change of rule.

**The `.tsx` exclusion now stands on a different reason.** 0060 excluded it
because the scanner raised 343 errors over this repository's 56 `.tsx` files
even with the JSX language variant. The parser reads all 56 with no diagnostic
at all, so widening `BE_CODE_EVIDENCE` is now possible — and it stays closed,
because what a certification may cite is a decision with its own write-set and
its own negatives, not a side effect of changing an instrument.

## Not in this record

**`.tsx` is not admitted.** The guard at `L-R19-4` is unchanged and refuses any
extension outside `.ts`, `.mts`, `.js`, `.mjs`, `.md`, `.json` by name. The
packet that widens it owes its own measurement of what those files would then
be allowed to prove.

**`stripComments` is not generalized.** ADR 0059 recorded why its
`/\*[\s\S]*?\*\//` arm is wrong for this job — measured at 460 lines swallowed,
including a law's own refusal — and this extractor is confined to `L-R19-4` as
0060 left it. Replacing it across the hundred other laws that use
`stripComments` is a packet with its own write-set and its own negatives.

**Nothing here certifies the backend or adopts anything into operation.** The
record resolves identically before and after; the gate's exit code depends on
what it always depended on, and P8 certification and P9 authorization are
untouched.
