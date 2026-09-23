# ADR 0106 — One canonical-instant authority

- Status: accepted (P-15 escalón I, recorded 2026-09-23).
- Supersedes: none.
- Superseded-by: none.
- Amends: none. ADR 0105's D1 made the ledger's projection the one home of `isInstant`
  inside the ledger package; this record moves the rule itself to `@acp/contracts` and
  keeps the ledger's name as a re-export.

## Context

The canonical instant is ISO-8601 in UTC with exactly three fraction digits and an
uppercase `Z`, and a real calendar date: the form a round-trip through `Date`
reproduces. It is the only form in which text order is time order, which is why every
door that orders or compares instants as text holds its operands to it (ADR 0103, the
two-operand rule).

The owner's order is that no new duplication goes to P-37 by default. The census at
D4-final (HEAD `c1bb414`) found four copies of this one rule in `src`:

| Site | What it was | Origin |
| --- | --- | --- |
| ledger `projection` `isInstant` | regex and `Date` round-trip | inherited (2026-09-10), re-homed by P-15/D1 |
| protocol `schemas` `CanonicalInstant` (private) | the same, as zod | **introduced by P-15/R** |
| contracts `artifact-record` `Instant` (private) | the same, as zod, with two messages | inherited (P-36/local A) |
| daemon `arbiter` `CANONICAL_INSTANT` | the regex, checking a normaliser's output | inherited (V2 concurrency C2) |

And one name that looked like a fifth: runtime `enforcement`'s `isInstant`, which is
not a copy — it borrows the contract's `Timestamp` through `Lease.shape.expiresAt`, a
different, offset-bearing rule. The protocol also held a second declaration of
contracts' `Timestamp` (`z.iso.datetime({ offset: true })`), inherited since P1B. The
accounts and telemetry instant grammars are the offset-bearing family and are not
touched here (telemetry may not import contracts at all):

| Site | Family | Owner |
| --- | --- | --- |
| telemetry's parser regex (any fraction length, `Z` or `±HH:MM`, to epoch nanoseconds) | offset-bearing; a different function, not a predicate | stays: the fence forbids telemetry the import |
| accounts `quota` `ISO_INSTANT` (`:236`) | offset-bearing and calendar-strict: seconds optional, any fraction length, `Z` or `±HH:MM` | **P-19** (accounts, quota and routing), row obligation |
| accounts `routing` `ISO_INSTANT` (`:642`) | the same grammar, mirrored byte for byte from `quota` and pinned against it by a test | **P-19**, the same obligation |

The two accounts declarations are one inherited grammar declared twice in one
package; neither is canonical, so neither folds into this record's predicate. Folding
them into one accounts-local constant is P-19's, which opens that package's quota and
routing, and the P-19 row carries the obligation. "Left in place" names its holder.

## Decision

### One — the authority (decision 146)

`@acp/contracts`' `primitives` module, the lowest layer, beside `Timestamp`, holds:

- `isCanonicalInstant(value: unknown): value is string` — the one predicate;
- `CanonicalInstant` — the one schema, `z.string().refine(isCanonicalInstant, …)`. It
  calls the predicate and restates nothing.

The grammar is module-private: nobody can build a second predicate from it.

The four consumers read it:

- the ledger's `projection` drops its pattern and body and re-exports
  `isCanonicalInstant` as `isInstant`; the barrel name and every caller are unchanged;
- the protocol's registry instant (`RegistryPublicationRequest.effectiveFrom`) is the
  contracts `CanonicalInstant`;
- the artifact record's `Instant` is `CanonicalInstant`;
- the lease arbiter's output check is `isCanonicalInstant`; its input stays lenient,
  since normalising is its role.

**Behaviour-neutral, proved rather than argued.** Before any source moved, the four
pre-change copies were run over one matrix of 24 vectors — real and impossible dates,
leap days and a leap second, hour 24, the two edges of the calendar, six-digit years,
missing or extra fraction digits, a lowercase `z`, offsets, a space, the empty string,
`null` and a number — from `dist` rebuilt at `c1bb414` with a clean tree. The three
predicates agreed on every vector, and the arbiter's outputs were recorded. That table
is `contracts/test/testing/canonical-instant-vectors/index.json`, read from disk, and
the contracts, protocol, ledger (the barrel's `isInstant` and the registry door's
instant fields) and daemon arbiter suites each reproduce it after the change.

**The one visible change: the refusal, not the verdict** (ND-I1). No door's verdict moved
on any vector (the verifier's probe: 106 vectors, 11 doors, zero differences). What a
refusal looks like did move, at the protocol's `effectiveFrom` and the artifact record's
instant fields:

- **the message.** The protocol's message and the artifact record's two ("…with
  milliseconds", "…a real calendar instant") become one: "expected the canonical instant:
  ISO-8601 in UTC with milliseconds, a real calendar date". The protocol's old shape
  failures also carried zod's default "Invalid string: must match pattern …";
- **the issue code.** A shape failure was `invalid_format` (the regex) and is now
  `custom` (the refine);
- **the issue count.** A shape failure raised two issues at the field — the regex's and
  the refine's — and now raises one.

The path is unchanged. No suite pinned any of the old texts, and nothing reads the code
or the count at these fields. Where a message surfaces at all: the artifact record's in
the thrown `LedgerValidationError` of the ledger's artifact-event door and the artifact
plane's refusal, never persisted, never hashed. The protocol's surfaces nowhere outside
the process: the CLI registry verb answers a fixed message and puts only the field path
in its refusal detail (`cli/src/registry/index.ts:66-74`).

### Two — the census rulings (decision 147)

- **The protocol's `Timestamp` is folded** (Q-I1): it imports the contract's instead of
  declaring a second one. The same zod call; its uses are unchanged. The contract's
  `Timestamp` was module-private to contracts until now — used inside it, on neither
  barrel — so this record exports it. Its verdicts were captured before the fold from
  both copies (contracts through `ControlPlaneEvent.occurredAt`, the protocol through
  `HealthResponse.observedAt`) over 20 vectors, they agreed on every one, and the matrix
  carries them; the contracts and protocol suites reproduce them.
- **The runtime's lease `isInstant` is renamed `isLeaseTimestamp`** (Q-I2): it is the
  `Timestamp` rule, and sharing a name with the canonical check invited a reader to take
  one for the other. Renamed only; tightening the lease door to the canonical form is an
  enforcement decision, not this record's.
- **Named finding, not fixed here: the lease arbiter rolls impossible dates over.** Its
  lenient input goes through `Date.parse`, so February 30th becomes March 2nd, hour 24
  the next midnight, and 2026-02-29 becomes March 1st. The canonical output check cannot
  see it, because the output is a real date. Refusing such inputs changes what the lease
  door admits. **Owner: P-18** (fencing and recovery), whose row carries the obligation.
  It is latent, not an open door: in production the arbiter's `now` is the composition's
  own clock, `new Date().toISOString()`, and every `expiresAt` it reads is derived from
  that clock, so both are canonical by construction; the config-file door cannot set a
  clock. The lenient path is reachable only by a programmatic `clock` — the tests. The
  arbiter's suite pins today's behaviour, rollovers included.

### Three — the law (decision 148)

**L-P15I-1, "one canonical-instant predicate in src".** Over every tracked
`packages/*/*/src/` `.ts` and `.tsx` file, comments stripped, only contracts'
`primitives` may hold the rule. What the matcher sees, all text-level:

- the grammar's distinguishing text, three digits then `Z`, in a regex literal or as an
  escaped string: `\d{3}`, `\\d{3}`, `[0-9]{3}`, `\d\d\d`, `\\d\\d\\d` or
  `[0-9][0-9][0-9]`, followed by `Z` or `[Z]`;
- a `toISOString()` result compared by `===`, `!==`, `==` or `!=`: the direct call in
  either order, where a reversed operand is matched only as a plain dotted or called
  chain (`v === d.toISOString()`, `v === new Date(v).toISOString()`);
- zod's own spelling, `datetime({ … precision: 3 … })`, as `z.iso.datetime` or
  `z.string().datetime` — a complete second predicate, which agreed with the home on
  every vector the verifier tried.

The offset-bearing family holds none of these. No exception is named: the arbiter's
`toISOString()` normalises and compares nothing. `PATH_SCOPED_LAWS` 153 → 154.

**The stated limit, as a family** (v2, verifier 06 and Fable C3; the L-P07C-1 precedent
of decision 144). Every spelling below was re-bitten on a disposable copy after v2 and
still passes, so the fence claims nothing over it:

- a round-trip through an intermediate variable (`const s = d.toISOString(); s === v`);
- a comparison that is not an equality operator: `Object.is(…)`,
  `.localeCompare(v) === 0`, `.slice(0) === v`;
- another method with the same output: `toJSON()`, `Date.prototype.toISOString.call(d)`;
- the grammar assembled at runtime: string concatenation, `String.fromCharCode`, or a
  digit class other than those listed above;
- another spelling of the `Z`: `/…z/i`, `(?:Z)`, `\x5A`, `[Zz]`;
- optional chaining or bracket access: `toISOString?.()`, `?.toISOString()`,
  `["toISOString"]()`;
- a reversed operand holding whitespace, a cast, `?`, quotes or extra parentheses:
  `v === new Date(v as string).toISOString()`, `v === (new Date(v)).toISOString()`;
- zod's precision given by a constant or an options object rather than the literal
  `precision: 3`;
- code the stripper hides (below);
- a `.js` or `.mts` file under `src`, which the naming and write-set laws refuse on their
  own.

**The stripper became string-aware** (v2). The fence's `stripComments` removed a `//` or a
`/*` through the end of the comment wherever it appeared, including inside a string, a
template or a regular-expression literal, so `const u = "a//b";` hid the rest of its line
from this law and from every other law that reads through it. It now scans: strings,
templates (with `${…}` read as code) and regular-expression literals are copied whole, and
a comment is a comment outside them — **where the scan classifies each `/` correctly**.
A `//` right after a `:` is still not a comment, as before. Ten fixed controls run at the
fence's start and fail it if the stripper regresses. Over the whole repository the change
moved no other law's result: the fence's output is identical line for line apart from the
new control's line.

The limit (v3, verifier 06), inherited by every law that reads through `stripComments`:
whether a `/` opens a regular expression or divides is a heuristic over the previous
token, not a parse. A regex literal after `)` (`if (s) /a\/*b/.test(s)`, read as a
division) or after a keyword outside the scanner's set, and a JSX closing tag `</…>`
followed on the same line by a string holding `"/"`, `///` or `/*`, can put the scan out
of step, and the code after a later `//` or `/*` is then hidden. The old stripper hid the
same cases, so this is no regression: over all 470 tracked `.ts`, `.tsx`, `.mjs` and `.js`
files, v2 never hides code v1 showed. One expected-limitation control pins the regex-after-`)`
case, so a future fix fails the fence and forces this paragraph to be rewritten.

## Consequences

- One rule, one place; a fifth copy fails the fence.
- `CONTRACTS_SCHEMA_EXPORTS` 166 → 169 (`isCanonicalInstant`, `CanonicalInstant`, and
  `Timestamp` for the protocol's fold).
- `CONTRACT_VERSION`, `MIGRATIONS`, `API_CONTRACT_VERSION` and
  `RUNTIME_PUBLIC_EXPORTS` do not move.
