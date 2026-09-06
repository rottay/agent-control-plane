# ADR 0051 — The policy version pin is data, not code

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

ADR 0018 records a consequence in the imperative present:

> Editing `packages/domains/accounts/policy/capability-policy.json` changes the
> elected model with a byte-identical source tree, and the recorded
> `capabilityPolicyVersion` moves with it. That is the V2 gate criterion.
>
> — `docs/architecture/0018-the-submission-path.md:114-119`

It was not true as written, and the boundary audit's row 11 said so.

The capability registry carries an editorial law that is worth having: **a
content change requires a version change.** Same content under a new version is
a lawful re-cut. Same version under different content is not a nuance — every
`capabilityPolicyVersion` already written into a route or an event becomes a lie
about what was in force when it was chosen. The loader cannot enforce it, because
it sees one document and has no idea what that version meant yesterday. The fence
can, by pinning each published version to the digest of the content published
under it.

The trouble was where the pin lived. It was a `const POLICY_VERSION_DIGESTS`
inside `scripts/check-architecture.mjs`. So publishing a policy meant editing the
fence — and `scripts/` is source. Changing the elected model required a source
change, and ADR 0018's "byte-identical source tree" was false by exactly one
JavaScript literal.

## Decision

The table moves to `scripts/policy-version-digests.json`, and the fence
validates it fail-closed.

```json
{
  "comment": ["Published capability-policy versions, pinned by content digest.", "…"],
  "document": "packages/domains/accounts/policy/capability-policy.json",
  "versions": {
    "2026-08-30.1": "6fee0b39…3922",
    "2026-09-06.1": "1112b310…976b"
  }
}
```

A policy re-cut is now two data edits — the document and the pin — and no `.mjs`
at all. ADR 0018's consequence becomes true as written.

### Where it lives, and why not beside the document

The pin is an **assertion about** the registry made by the authority that
polices it, not a part of the registry. Co-locating them would put claim and
subject under one owner, invite a future `accounts/**` law to scope over the
pin, and add a file to a published workspace package for a script's benefit.

`scripts/` already holds exactly this shape. `scripts/restate-server.pin.json`
has been the tracked, declarative, digest-bearing content authority for a binary
the package manager never sees, and the fence has read it fail-closed on every
degenerate input for as long as it has existed. R14 copies that standing; it does
not invent it.

The fence owns the file. No package imports it, no runtime code reads it, and the
write-set excludes every `packages/**` source path, so for this packet the
discipline is enforced by construction rather than by convention.

### The validation, fail-closed in every direction

Relocation is only worth anything if the reader refuses. A law that skipped a
missing or malformed pin would be **weaker than the literal it replaced and would
still print green** — the one way to get this packet badly wrong.

| # | Condition | Verdict |
| --- | --- | --- |
| L1 | the pin file is absent | refuse |
| L2 | the pin file is not JSON | refuse |
| L3 | `versions` is absent, not an object, or empty | refuse — it pins nothing |
| L4 | a row's value is not 64 lowercase hex | refuse — no trust-on-first-use |
| L5 | `document` is not the attested path | refuse |
| L6 | the registry itself is absent | refuse |
| L7 | the document declares no `policyVersion` | refuse |
| L8 | the published version has no row | refuse |
| L9 | the row does not equal the document's digest | refuse |
| L10 | all pass | one note, naming the version and the row count |

**L6 closes a gap the previous law actually had.** The old code read
`if (policyDocument !== null)`, so a deleted registry attested nothing and said
nothing about it. The relocated law is strictly stronger there.

**L5 is why data cannot redirect the read.** The document this law attests is a
literal in the fence, and the pin's own `document` is compared against it. A pin
able to name its own subject could attest something nobody ships and report green
about it, which is not a pin.

### What is deliberately not done

**The pin file is not itself digest-pinned in JavaScript.** That would rebuild
the wall this record demolishes: a re-cut would once again require editing
`.mjs`. Its integrity comes from being tracked, bound to the write-set, reviewed
and shape-checked — the same standing the Restate pin has, and the same standing
the repository already accepts for `docs/ROADMAP.md` and `.githooks/pre-push`
with the difference that those two *are* digest-pinned precisely because nothing
else validates their shape.

**No validator is extracted.** `scripts/architecture/roots.mjs` was extracted
because one question was answered by hand at twenty-three call sites. This law has
one call site. Five literal checks inline are the law.

**No JSON Schema, no version field, no loader, and no generalization to a "pin
registry".** `restate-server.pin.json` stays its own law with its own message.

**The accounts loader does not read it.** A document that attested itself would
be no attestation, so the loader keeps validating `policyVersion` as a non-empty
string and knows nothing about digests. R14 changes no runtime behaviour, no
wire, no export, no dependency and no contract version.

**No policy version is bumped.** The shipped `capability-policy.json` is
byte-identical across this packet and still hashes to
`1112b310314acc3a8bf54d19fe94151514e3cfb3cbb5bc3946e0eace1c50976b`. Both
historical rows survive: `2026-08-30.1` is kept because the versions a registry
published are what routes and events already recorded, and a pin deleted once the
document moved on would stop being able to say what was in force when they were
written.

## Evidence

Eight synthetic-tree probes in `scripts/architecture/roots.test.mjs` drive the
real fence as a subprocess: N1 withheld, N2 malformed, N3 empty, N4 unknown
version, N5 digest mismatch, N6 malformed digest, N7 misdirected pin, and P1 a
positive control. Each asserts a nonzero exit **and its own law's message** — a
synthetic tree trips many unrelated laws, so an exit code alone identifies
nothing.

**Every fixture declares a version the old literal never carried.** A fixture
reusing `2026-09-06.1` would have been answered by the hardcoded table too, so
the probe would have passed before this packet as well as after and proved
nothing about where the fence read its row. Declaring `2099-01-01.1` means only a
fence that genuinely consults the data file can produce the expected message, and
all eight were observed failing at the parent commit for exactly that reason.

**P1 is the neutralization control.** Without it the seven negatives could all be
passing on some other law's failure text. It asserts the green note's presence
and the pin law's own refusals' absence — never exit 0, which a synthetic tree
cannot produce.

The gate criterion is demonstrated rather than asserted: a disposable re-cut that
bumps the version, re-digests the document and appends a row touches exactly two
paths, neither ending `.mjs`, and the fence stays green.

## Consequences

- Publishing a capability policy is a data change. ADR 0018's consequence is true
  as written, and boundary-audit row 11 is closed.
- The fence's editorial law is stricter than before, not looser: seven refusal
  states plus a registry-absent refusal the old law did not have.
- `PATH_SCOPED_LAWS` stays at **112**. This is a single-file law, not a
  path-scoped one; it registers no scope and calls no `requireScope`.
- The ADR corpus moves 50 → 51.
- Append-only rows remain documented in the pin's own `comment` and are not
  mechanically enforced — L8 and L9 examine only the version the document
  currently declares. That is parity with the law being replaced, which read
  `Object.hasOwn` for the current version alone, and not a regression. Enforcing
  append-only is a separate law and a separate packet.
