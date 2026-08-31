# ADR 0013 — the plane's first write route

- Status: accepted (P8-8D-pre).
- Context: the observation plane has been read-only since P1. The workspace
  needs to record roadmap versions, which is a write. This record states the
  laws that admission carries, so the exception stays an exception.

## Decision

One named write route — `POST /api/v1/initiatives/:initiativeId/roadmap` —
mediated by the landed `decideRoadmapVersion`, whose content lives in a
content-addressed store the ledger owns.

## Why one named route, not a write plane

A plane that becomes writable in general is a different system from one that
admits a single, named, decision-mediated write. The read plane's method list
(`API_ALLOWED_METHODS`) therefore does **not** move: it still says `["GET"]`,
because it still describes the nine reads. The exception is recorded in a
second frozen table, `API_WRITE_ROUTES`, which currently holds one name. A
reader asking "what can mutate?" gets one short answer, and adding a second
name is a visible edit to a list whose whole purpose is to be short.

Softening the first table instead would have reclassified all nine reads to
say something weaker about themselves, in order to describe one route. That is
the shape of change this repository has repeatedly refused: a claim is not
made cheaper by making it vaguer.

## Why the decision mediates, and the endpoint never decides

`decideRoadmapVersion` already exists, already owns the six-name refusal
vocabulary, and already reasons over a folded head it is handed rather than a
ledger it reads. The endpoint's job is to gather what the decision needs, hand
it over, and append exactly what a grant produced. It never computes a digest
the decision did not ask for, never appends anything the decision did not
grant, and never re-implements a check the decision already makes.

This gives the door its split. A body that is not a well-formed request fails
the **schema** and answers **400** — the caller sent something malformed. A
well-formed request the decision refuses answers **409** with the refusal's own
name — the caller sent something coherent that conflicts with the recorded
state. Collapsing the two would tell a caller "you typed it wrong" when what
actually happened is "someone else moved the head", which is the one thing a
concurrent writer most needs to distinguish.

## Why the content is stored, and why the store is the ledger's

The Checkpoint law says a record carries digests and references, never content.
A roadmap document cannot live in an event payload, and should not: the ledger
is a chain of small, canonical facts. So the bytes go to a content-addressed
store and the event records the digest.

The store is the **ledger** package's, not the server's. The ledger already
owns the data root, the CLI already resolves references through it, and a
second package owning the bytes would be a second authority over what a digest
in the ledger means. Placing it anywhere else would have meant two ways to
resolve one reference.

## Why publication is atomic, and existing objects are verified

Two laws, both about what a filesystem actually promises:

**Atomic publication.** Bytes are written to a temporary name in the same
directory and renamed into place. A reader sees a complete object or none.
A plain write at the final path leaves a torn file after any crash, and a torn
file whose *name is a digest* is worse than a missing one — its name is a claim
about content it does not have.

**Verify, never trust.** Publishing content whose digest already exists
re-reads the stored bytes. Equal bytes are a no-op, which is what makes a
retried write safe. Unequal bytes are refused rather than overwritten:
overwriting would destroy the evidence of a collision or corruption at the
exact moment it mattered.

**There is no delete.** No function removes an object. An append-only ledger
whose referenced bytes could be removed is append-only in name only. Removing
an artifact is a deliberate operator act against the filesystem, outside this
API.

## Why the guards scan the content

A roadmap document is free text, and this is the one route on which free text
enters the plane. It is scanned for credential and transcript material on
ingest, with the same contract guards every other surface uses.

This is a deliberate cost, not an oversight: a document that legitimately
discusses a field named `apiKey` will be refused. The alternative is admitting
unscanned free text into an append-only store that the UI and the CLI both
read — the exact failure four surfaces of redaction work exist to prevent. A
roadmap is not worth the exception.

## The write seam

The read path stays pinned read-only: `openLedgerSource` opens with
`{ readOnly: true }` and nothing changes that. The write uses a **short-lived
writable handle**, opened and closed inside the write module, so the server's
long-lived handle can never append. The capability is scoped to the one module
that needs it rather than granted to the process.

## Consequences

- `API_CONTRACT_VERSION` moves `0.2.0` → `0.3.0`. Additive in shape, but the
  minor moves for a reason no read-only addition had: a reader that assumed
  nothing it sends mutates anything was right at `0.2.0` and is wrong at
  `0.3.0`.
- The api-contracts README's "GET only" claim is falsified and replaced; its
  pinned fence literal moves with it.
- Every other route's method set is byte-unchanged, and its 405 behaviour is
  asserted to be so.
