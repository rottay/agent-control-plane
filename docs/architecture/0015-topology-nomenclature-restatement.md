# ADR 0015 — The topology's package names, restated: 0014 amended, not superseded

- Status: accepted (P8-E, recorded 2026-09-02). Supersedes: none.
  Superseded-by: none.
- Amends: ADR 0014. The decision recorded there stands unchanged; this record
  restates its nouns and decides the convention under which it does so.

## Context

ADR 0014 recorded the five-strata topology in the names the joint audit used
on 2026-08-31: `api-contracts`, `adapters`, `server` and `ui`. Its Decision,
layer-table, public-and-internal and Consequences sections — the normative
body, not only the Context — carry those names.

G7 (`446673f`) then renamed the four packages by responsibility, under the
owner's ruling: `api-contracts → protocol`, `adapters → providers`,
`server → gateway`, `ui → console`. The `@acp/*` specifiers moved with them,
which dates 0014's "folders move, imports do not": that sentence was true of
G1', the move it was written for, and G7's own packet record in the fence is
where the rename is reasoned. The fence retired the four old prefixes so
nothing can be created under them again. From that commit on, 0014 described
the landed tree in names the tree no longer had, while every README was
corrected in G10 and the roadmap's topology section was deferred to P8-E by
name.

The corpus is append-only (`index.md`): a landed record is never edited to
reflect a later decision. The same corpus has one earlier amendment — 0003,
amended by 0013 — carried as a new record plus a line of index prose, with the
old record's file untouched and no `Superseded-by` field written. The template
prescribes the paired `Supersedes` / `Superseded-by` for a decision that
*changes*. This decision did not change; its nouns did. P8-E's preaudit
measured that ambiguity — the practiced shape against the template's field
pair — and ruled it once, against the packet's own first recommendation of a
dated block inside 0014.

## Decision

**0014 stands, byte-untouched.** Its Context describes the pre-decision flat
state and is historical by design; its normative sections are read with the
names below. Where 0014 and this record differ, this record's tables are the
current ones and 0014's are the audit's — the same decision under two dates.

### The strata, with the landed names

```
packages/
  kernel/        contracts, protocol
  persistence/   ledger
  domains/       runtime, accounts, observation
  edges/         providers, durability
  entrypoints/   daemon, gateway, cli, console
```

This table is `PACKAGE_STRATA` in the architecture fence, declared once and
read by every resolver call; the classification law asserts the tree against
it in both directions, and the certification receipt is folded from that
assertion rather than restating it.

### The layer table

1. `kernel` imports nothing in-repo, except `protocol → contracts`.
2. `persistence → kernel` only.
3. `domains → persistence, kernel`. `runtime → accounts` is the only
   permitted domain-to-domain edge.
4. `edges → domains, persistence, kernel`. `durability → runtime` implements
   the port; the reverse is what the fence refuses forever. The
   `edges → runtime/scenarios` edge is declared rather than incidental.
5. `entrypoints →` any lower stratum. Nothing imports an entrypoint from
   `src/`. `console → kernel/protocol` only, which is the browser-safety law
   restated as a layer rule.

### Public and internal packages

- **Public** (MIT, no `private` key since G10, export pin mandatory):
  `contracts`, `protocol`, `ledger`, `runtime`, `accounts`, `observation`,
  `providers`, `durability`.
- **Internal** (`private: true`, `UNLICENSED`): `daemon`, `gateway`, `cli`,
  `console` — the entrypoints. They are the product, not the library.

0014 wrote "durability when it exists"; it has existed since G5. 0014 wrote
"published" of the public side; nothing publishes before P9, and the G10 flip
changed the manifests, not that.

### The amendment convention, decided

An **amendment** — a later record that changes how an earlier one is *read*
without changing what it *decided* — is practiced as a new record plus index
prose: the new record carries `Amends: ADR NNNN` in its header, `index.md`'s
row for the old record reads "accepted, amended by NNNN", and the old record's
file is not touched. That is the shape 0003 and 0013 already had; this record
makes it the rule rather than a precedent.

The paired `Supersedes` / `Superseded-by` fields are **reserved for true
supersession** — a decision replaced by another — and are set on both records
then, as the template says. Writing `Superseded-by: 0015` on 0014 would state
that the five-strata decision was replaced. It was not; it was renamed. A
durable record must not carry a false verb to satisfy a template.

The fence's numbering and index-bijection law verifies this record as the
fifteenth contiguous one, and its index row, for free; it reads no header
field, and this record does not ask it to.

## Why an in-place amendment block inside 0014 was not chosen

Because `index.md` forbids it in so many words: a record is never edited to
reflect a later decision. A dated block appended inside 0014 is that edit,
softened only by being an append within the file — a shape this corpus has
never used. It would also end 0014's byte identity, when the byte identity of
landed records is exactly what makes the corpus a history rather than a
snapshot.

## Why the supersession pair was not chosen

Because the verb is wrong. Supersession means the decision was replaced; the
five strata, the layer table and the public/internal split are in force
exactly as 0014 decided them. A `Superseded-by` written for a rename would be
the prose-versus-bytes drift this tranche exists to kill, placed in the one
document class meant to be read in two years.

## Why leaving 0014 alone, with no record, was not chosen

Because the ADR corpus is where a reader goes for the topology, and 0014's
normative body names four packages that do not exist. G10 corrected every
README; the roadmap's topology section restates in the same packet as this
record; a corpus left stale while every other surface was corrected would be
the least-read document being the least true.

## Consequences

- 0014 is byte-identical after this packet, and stays so. A reader of 0014
  finds the amendment through the index row, then here.
- `index.md` gains this record's row, and its 0014 row reads "accepted,
  amended by 0015". Reading the corpus in order now shows the topology
  decided, the packages renamed, and the record restated — which is the
  history the corpus exists to keep.
- Future amendments follow this record's shape; future supersessions follow
  the template's pair. The two are distinct by definition now, so the
  ambiguity P8-E's preaudit measured cannot recur as a judgement call.
- The roadmap's topology section is restated in the same packet, with a note
  recording that the rename landed in G7 and the restatement was P8-E's
  deferred act; the G-packet narrative there keeps its original names, because
  it describes what each packet landed under the names of its day.

## Not in this record

What the topology *is* and why — that is 0014, unchanged. The rename's own
reasoning and its dedup half — G7's packet record in the fence. The
certification computation this packet also lands — the fence's §23 and the
roadmap's Estado line, which the fence pins in lockstep.
