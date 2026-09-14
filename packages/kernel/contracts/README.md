# `@acp/contracts`

The frozen runtime vocabulary of the Agent Control Plane. Every shape the
ledger, the runtime domain, the adapters, the accounts domain and the
observation plane are allowed to agree on is declared here, once.

## Scope

This package declares shapes and validates them. It implements no behaviour,
opens no file, spawns nothing and reaches no network: its entire production
dependency surface is `zod`, which the architecture fence asserts by import
specifier rather than by trusting this sentence.

Nothing here is adopted into real operation. Adoption is a single explicit
decision that happens after P8 certification and a separate P9 authorization.

## Why one package

A contract that two packages declare is two contracts. Consumers must not
redeclare these shapes locally — the fence's dependency laws exist so that a
package which needs a shape must depend on this one to get it, and so that a
divergence becomes a compile error rather than a runtime surprise nobody sees
until the two sides disagree about a field.

The one deliberate exception is `@acp/protocol`, which re-exports `EXIT_OK`
and `EXIT_USAGE`. The gateway is forbidden by a standing fence law from naming
this package at all, and the protocol package is the sanctioned route to
kernel material — so the two constants pass through rather than being
redeclared.

## Capability modules

`src/schemas/index.ts` is a pure re-export barrel: it defines nothing and
names each capability module once. The fence asserts that purity, and asserts
this table against the barrel.

| Module | What it declares |
| --- | --- |
| `primitives` | the shared scalars — `CONTRACT_VERSION`, timestamps, uuids, repo-relative paths |
| `credential-guards` | the credential and transcript scanners, and the refinement that attaches them |
| `shared-references` | opaque references: a digest paired with the path it names |
| `worker-identity` | the worker role vocabulary and the identity string it composes |
| `worker-slot` | a slot's shape: its identity, its bounds and its state |
| `lifecycle` | the task lifecycle states and the transitions between them |
| `task-envelope` | the unit of authorized work: objective, authority, exact write-set, budget |
| `checkpoint` | what a record carries — digests and references, never content |
| `control-plane-event` | the append-only event shape the ledger chains |
| `commit-authorization` | the receipt a local commit requires, and what it binds |
| `execution-boundary` | the provider-neutral execution port: routes, requests, normalized events |
| `durability-plane` | the shapes the durability port exchanges with its drivers |
| `initiatives` | the initiative stream: registration, status, roadmap versions |
| `account-record` | an account and its actions, with the refusal vocabulary |
| `usage-limits` | the bounds a quota estimate is computed against |
| `exit-codes` | the process exit convention, declared here because it is shared |
| `bounded-identifier` | the one grammar a configured name must satisfy, shared by the tool edge and the recorder |
| `artifact-record` | artifacts §2's vocabularies and the six strict shapes of an artifact event in the registry stream |

## The laws these shapes carry

- **Strict objects.** Object schemas are built with `strictObject`, so an
  unknown key is a validation failure rather than a silently carried field. A
  producer that grows a field fails at the boundary instead of leaking it.
- **One version written, a set admitted.** `CONTRACT_VERSION` is the single
  literal a **producer** stamps. `SUPPORTED_CONTRACT_VERSIONS` is the set a
  **reader** admits, and `ContractVersion` is `z.enum` of it, so a record
  written under a version outside the set cannot be parsed as if it were
  current. The two are separate because a `z.literal` answers both questions
  with one value and is therefore symmetric: moving it would make every record
  already written under the previous value unreadable, which is not what a
  version bump should mean. **The set holds two members from P-18/protocolo C**,
  which is the escalón that moved `CONTRACT_VERSION` to `"2.3.0"`; `"2.2.0"`
  stays in it for ever, because every event any earlier build recorded carries
  it. ADR 0072 recorded what that escalón owed, and ADR 0076 pays it. **It holds
  three from P-18/protocolo F**, which moved the literal to `"2.4.0"` on the same
  criterion — a recomputed identity and a per-payload version — and keeps
  `"2.3.0"` beside `"2.2.0"` for the same reason (ADR 0078). **It holds four
  from P-36/local D**, which moved the literal to `"2.5.0"` for a different
  reason, stated as one: decision 41 fixes a cohort of revision records by
  `contract_version`, and a cohort keyed on a version nobody moved could not
  exist. The bump pays that cohort, not an identity; `"2.4.0"` stays readable
  for ever beside the other two (ADR 0084). **It holds five from P-32/captura
  B**, which moved the literal to `"2.6.0"` on C's criterion again: the ledger
  recomputes a usage stream's id from its coordinate, and every declaration
  names its adapter's normalization policy; `"2.5.0"` stays readable for ever
  beside the other three (ADR 0089).
- **Only the version in force is emitted.** The other half of the pair above,
  and the debt ADR 0072 named. `AdmittedContractVersion` is `z.literal` of
  `CONTRACT_VERSION`, and it governs the three shapes that are instruments of
  **new work** — `TaskEnvelope`, `WorkerSlot`, `CommitAuthorizationReceipt` —
  plus the ledger's append door for a genuinely new insertion. A set that is
  right for reading history would be wrong there: it would let a producer choose
  which of two versions to stamp, and a producer that can choose is a producer
  whose output nobody can predict. `ControlPlaneEvent` deliberately keeps
  `ContractVersion`, because that schema is what the ledger re-parses over every
  stored row; the ledger separates issuing from reading by *when* instead, so an
  exact replay of an already recorded event is exempt while a new insertion is
  not.
- **One key per fact.** An event's `idempotencyKey` has exactly two lawful
  forms, and which one applies is not the producer's choice: a payload carrying
  a complete V2 coordinate (`revisionNumber` and `attemptNumber`) must use
  `buildV2IdempotencyKey`, and a payload without one must use
  `buildIdempotencyKey`. Two admissible forms for one fact would let the same
  fact enter twice under different names, so a producer that meets a conflict
  cannot change namespace to make it a new operation.
- **No credential may enter a record.** `credential-guards` refines the
  record-shaped schemas with a scanner that walks to a bounded depth and
  refuses denied key names and credential-shaped stems. An opaque reference
  such as `credentialRef` is permitted; a bare `token` is not. This is law 9 of
  `AGENTS.md` made mechanical rather than remembered.
- **Digests and references, never content.** A checkpoint names what it refers
  to and carries the digest that pins it. Content lives in the artifact store
  the ledger owns; the record carries the digest only. The same holds for the two
  occurrence types of P-18/protocolo D, `PROMPT_OCCURRENCE_RECORDED` and
  `RESPONSE_OCCURRENCE_RECORDED`: what a run sent and what it received travel
  as digests and byte counts, and the transcript guard refuses the keys a
  conversation would ride under (ADR 0077). The three outbox types of
  P-18/protocolo F carry ids, vocabulary words, an instant and an opaque
  response handle: the credential guard refuses a handle shaped like live
  credential material, and `OUTBOX_FAILURE_CODES` closes the words a failed
  delivery may give as its reason (ADR 0078).
- **A key's grammar is the contract's, and its computation is not.**
  `ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1`, the two effect prefixes of
  P-18/protocolo C and `OUTBOX_COMMAND_ID_PREIMAGE_PREFIX_V1` of P-18/protocolo
  F each declare a versioned preimage here, with its own trailing LF, and
  `@acp/ledger` computes the digest: this package may reach no `node:` builtin.
  A `v1` prefix is frozen; a new encoding is a new name.

## Consumers

Eight packages depend on this one directly: `@acp/protocol`, `@acp/ledger`,
`@acp/runtime`, `@acp/accounts`, `@acp/observation`, `@acp/providers`,
`@acp/durability` and `@acp/daemon`.

The three that do not — `@acp/gateway`, `@acp/cli` and `@acp/console` — reach
the vocabulary through `@acp/protocol` instead. For the gateway that is a law
rather than a preference: a standing fence check refuses the name
`@acp/contracts` anywhere in its live code, its manifest and its tsconfig. The
console depends on `@acp/protocol` alone and is browser-safe by construction —
the fence asserts it links no ledger and no database driver.

## Tests

`pnpm test` runs the `contracts` project. The suite is adversarial: it asserts
that unknown keys, credential-shaped field names, transcript-shaped field
names and a mismatched contract version are all rejected, and that every
accepted shape survives a JSON round trip unchanged.
