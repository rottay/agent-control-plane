# ADR 0104 — Registry configuration is published through one door that derives its digest

- Status: accepted (P-15 escalón R, recorded 2026-09-23).
- Supersedes: none.
- Superseded-by: none.
- Amends: none. ADR 0085 "Not in this record" is not edited; this record names the
  debt it left and pays it. The streams dictionary's `content_digest` row gains an
  errata line (ND-R1).

## Context

A first task needs three registry documents before it can run:

- a `MODEL_VERSION`, which the intake's `resolveAssignment` reads as registered and
  eligible;
- the role and slot's `ROUTING_ASSIGNMENT_GLOBAL`, which `getGlobalRoutingAssignment`
  reads;
- a `PRICE_TABLE` covering the model under `CLI_SUBSCRIPTION`, which the dispatch
  door of ADR 0103 holds every delivery's pin to.

Until this record no entrypoint wrote any of them. `appendRegistryEvent` had no
caller in `cli/src`, `gateway/src` or `daemon/src`; only the ledger's internals and
the suites wrote the registry, straight on the ledger and with placeholder digests.

That is a **P-14 errata**. The packet table says P-14 includes «el bootstrap del
registry único y de la asignación de rol versionada» (`packets/index.md:156`), and
ADR 0085 "Not in this record" deferred «any product door — a CLI verb or a gateway
route that publishes a `MODEL_VERSION` or an assignment» to P-14 B or C. B and C
delivered the initiative and intake doors only, and the bootstrap was neither
delivered nor named as debt. Fable's pre-audit of D (C-D6) found it unowned; the DT
assigned it to P-15 as escalón R, after C and before D, so that D's door-to-result
drill seeds through a real door rather than through `appendRegistryEvent`.

The DT's answers settled the open questions:

- **ND-R1 (a).** The digest of an inline document is the SHA-256 of its payload's
  canonical JSON; publishing the payload as an artifact (b) is refused.
- **ND-R2.** CLI only; no HTTP parity, because no specification row asks for it.
- **C-R1.** The ledger door verifies the digest, for every writer.
- **C-R3.** A single-caller law on the L-P07C-1 F1 mould.
- The duplicate `effective_from` of a `PRICE_TABLE` is refused at the registry door
  (Q-C3's history), and the replay comparison excludes the author.

## Decision

**One — one orchestration, in the ledger.** `publishRegistryDocument`, a concept of
`@acp/ledger` with its own type leaf (`registry-publication/`), on the initiative
registration's precedent. It publishes exactly three kinds —
`PUBLISHABLE_DOCUMENT_KINDS`: `MODEL_VERSION`, `PRICE_TABLE`,
`ROUTING_ASSIGNMENT_GLOBAL` — and refuses the other eleven by name
(`REGISTRY_KIND_NOT_PUBLISHABLE`): each has an owner in a later packet, and a generic
door would be a second authority for them.

The operator states the kind, the document id and version, the parent, the instant
from which the version rules, the author and the payload. The door derives, and
never accepts:

- `contentDigest` = `sha256Hex(canonicalJsonStringify(payload))` (Two);
- `idempotencyKey` = `registry/<documentId>/<documentVersion>`, one per version;
- `eventId` = an RFC 4122 version 5 UUID over that key, under its own namespace
  `REGISTRY_PUBLICATION_UUID_NAMESPACE` (`2f704b2b-1dc7-40df-b428-95feb11010de`),
  pinned by vectors derived with an independent implementation;
- `occurredAt` and `recordedAt`, the door's instant, handed in by the caller;
- `contractVersion`, the version in force.

**No second validator.** The payload's shape (decisions 71 and 88), the model
versions an assignment or an interval names, the lineage, and the two rules below
are the ledger door's. The publication reads the door's `LedgerValidationError` and
answers `REGISTRY_DOCUMENT_REFUSED` with the field and the closed word at the head of
the door's message (`PRICE_TABLE_REFUSALS`, `GLOBAL_ASSIGNMENT_REFUSALS`,
`REGISTRY_DOCUMENT_REFUSALS`), or none when the issue carries none. The candidate is
parsed by the door's own `normalizeRegistryDocument`, exported from the ledger module
for this and not copied, **before** it is compared with a recorded version, every
field included: an offset or no-millis instant, a fractional parent or an empty id
is a form refusal at its field, never a conflict, and an empty author is refused
even where the rest is an exact replay, since the author is not compared (post-audit
C1).

**Idempotent by document and version.** Before appending, the publication reads the
version the stream holds at `(documentId, documentVersion)` with a new read verb,
`Ledger.getRegistryDocumentVersion`. The same kind, digest, parent and instant is a
**replay**: nothing is appended and the recorded version is answered. The author and
the door's instants are **not** compared — a retry reads a new clock, and who
repeats a publication does not make it another version. Any other difference is
`REGISTRY_VERSION_CONFLICT`, naming the first field that differs, in the order
kind, digest, parent, instant; never a new version. A writer that loses the race
between the read and the append meets the winner's row under the derived key, re-reads
and decides again: a replay, or a conflict. A winner that wrote the same coordinate
under another key — a suite, or history — is met by the lineage check instead, and
is re-read the same way; the suite drives both. The unique
`(document_id, document_version)` index stays the backstop.

**Two — the digest of an inline document is its payload's, and the door verifies it
(ND-R1 (a), C-R1).** The streams dictionary defines `content_digest` as the digest of
the content artifact, but decisions 71 and 88 keep a `MODEL_VERSION`'s and a
`PRICE_TABLE`'s content inline in the event, and no artifact is published for them;
the suites wrote placeholders. So, for the three kinds whose content is the payload
(`INLINE_CONTENT_DOCUMENT_KINDS`), the digest is the SHA-256 of the payload's
canonical JSON, and every other kind keeps the artifact's digest. The streams row
carries this as an errata line.

The ledger's registry door **verifies** it in `#assertRegistryDocumentAdmissible`,
first: a document of those kinds whose `contentDigest` is not its payload's is
refused at `contentDigest` with `REGISTRY_CONTENT_DIGEST_MISMATCH`. That binds every
writer — the publication, the suites and any later producer — and not only the CLI.
The check runs after the replay and lineage checks, so an exact replay of a stored
document is still a replay.

The fold does **not** re-verify. Stored history keeps the digests it was written
with; a rebuild reproduces them. This is decision 56's asymmetry: a write invariant
at the door, and a tolerant reading of history. A version written before this record
with a placeholder digest therefore **conflicts at `contentDigest`** when the same
version is republished through the door, because its recorded digest is not the
payload's; its operator publishes the next version instead.

Every suite that published one of the three kinds with a placeholder now derives the
digest from its payload, the five `plantFixtureCatalog` copies P-15/C added among
them. Fixtures of other kinds keep their placeholders.

**Three — one `PRICE_TABLE` version per instant, per document (Q-C3).** A catalog
version is chosen by the instant it takes effect (ADR 0103), so two versions of one
price table taking effect at the same instant leave no version in force there. The
registry door refuses the second in `#assertDocumentLineage`, at `effectiveFrom`,
with `REGISTRY_EFFECTIVE_FROM_TAKEN`. The rule is:

- for `PRICE_TABLE` only, the kind whose version in force C3 defines; widening it
  would change precedence rules C3 did not rule on;
- per document: another catalog at the same instant is another document;
- a write invariant, not a `UNIQUE` index: a migration would abort on a ledger that
  already holds a tie, and the rebuild has no door. A historical tie stays readable
  and rebuilds; `getVigentCatalogPin` answers it with nothing, and ADR 0103's dispatch
  door refuses an ambiguous pin, which is the defence for history. `MIGRATIONS` does
  not move.

ADR 0103's sentence that the ambiguous refusal is reachable only on ledgers written
before this rule becomes true here. P-15/C's door-planted tie test is converted: the
same site now asserts that the plant is refused with zero delta and that version 1
stays in force; the selector's pure test keeps the ambiguity covered.

**Four — the canonical instant, confirmed.** Every instant the door compares is in
the one canonical form, ISO-8601 with milliseconds in UTC ending in `Z`, which is what
makes text order time order (ADR 0103 §Two). The registry door already holds it:
`normalizeRegistryDocument` refuses an `effectiveFrom`, `occurredAt` or `recordedAt`
that fails `isInstant`, and an interval's instants are held to the same form by the
price table's own check. The request schema holds `effectiveFrom` to it as well, so an
offset is refused before any ledger is opened rather than normalized.

**Five — CLI only (ND-R2).** The door is `acp registry --database <L> --request
<doc>`, the sixth writing verb. The request is read through the uid ladder
`acp tool-call` reads through, and the ledger is taken through the same
`openForWrite`, so L-B4B-11's one writable open is unchanged. `REGISTRY_COMMAND` is a
named literal; `SURFACE_MAP` records `registry` as `CLI_ONLY`, because registry
configuration is an owner act on the local plane and no specification row names an
API door for it. `RegistryPublicationRequest` and `RegistryPublicationResponse` live
in `@acp/protocol`; the request is a strict object of the operator's fields, so a
digest, a key, an event id or an instant of the door's is refused, and it holds the
lineage linear — a first version names no parent, and a later one names the version
before it. No route parses either schema, so `API_CONTRACT_VERSION` and
`API_WRITE_ROUTES` do not move. The response's `recordedBy` is a bounded string, not
a worker identity, because a replay answers the stored version's author and history's
`recorded_by` is open, while the request holds new authors to the identity grammar.

**Six — never a price it was not given.** A `PRICE_TABLE` is data the owner signs.
Nothing defaults an interval, fills an `effectiveTo`, assumes a currency, or derives,
scales or rounds a price. A missing `pricePerMillionNanos`, `currency` or `effectiveTo`
is refused, never defaulted, and the door reads no provider price.

**Seven — one caller (L-P15R-1, C-R3).** In `src/`, only the publication calls
`appendRegistryEvent`, beside the ledger that defines it. The fence reads the syntax
tree of every tracked `src/` `.ts` and `.tsx`, comments aside: a call whose callee is
a property access named `appendRegistryEvent`, or an element access keyed by that
string or a no-substitution template, is refused anywhere else. The publication holds
exactly one call, which is the positive control and the staleness guard; zero files
parsed fails. Stated limit, by family: `Function.prototype` invocation, `Reflect.apply`,
a destructured or aliased method, and a computed key through an identifier.
`PATH_SCOPED_LAWS` 151 → 152.

## Consequences

- An operator bootstraps a first task through doors alone: `acp initiative`,
  `acp registry` three times, then `acp intake`, which resolves the role. The CLI
  suite drives exactly that.
- P-15/D's drill can seed the registry through this door instead of
  `appendRegistryEvent`.
- Every writer of the three inline kinds must state the payload's own digest.
- A second `PRICE_TABLE` version must take effect at another instant than every
  earlier version of its document.

## Not in this record

- An HTTP door. Added only when a specification row asks for one; then the entry
  becomes `DOCUMENT` and the API version moves.
- The other eleven document kinds. Each is published by the packet that owns it.
- A race between two processes. The suite drives the loser's path with two
  connections to one file in one process, which SQLite serializes the same way; a
  two-process drill is not added here.
- Group-writable request documents. The ladder refuses those only for documents that
  name commands the plane will execute, as for `initiative` and `intake`; a registry
  request is not one.

## Verification

- `ledger/test/registry-publication`: PC-R1 to PC-R4, N-R1 to N-R9, the
  `MODEL_VERSION` payload matrix of N-R10 against an oracle, N-R13 on two
  connections, the version 5 vectors and the namespace pin, and a pre-R version that
  conflicts at `contentDigest`.
- `ledger/test/ledger`: C-R1 per kind with zero delta and its scope control, the
  instant rule's scope, a historical tie that opens and rebuilds, the read verb, and
  the converted C-R2 test.
- `protocol/test/schemas`: N-R10's request matrix against an independent oracle, and
  N-R14.
- `cli/test/registry`: the bootstrap through real doors, replay, conflict, the words
  carried through, the ladder and the database refusals.
- The fence: L-P15R-1 and its controls, run on a disposable copy.
