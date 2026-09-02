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

## The laws these shapes carry

- **Strict objects.** Object schemas are built with `strictObject`, so an
  unknown key is a validation failure rather than a silently carried field. A
  producer that grows a field fails at the boundary instead of leaking it.
- **One version line, asserted.** `CONTRACT_VERSION` is a literal, and
  `ContractVersion` is `z.literal` of it — a record written under a different
  contract version cannot be parsed as if it were current.
- **No credential may enter a record.** `credential-guards` refines the
  record-shaped schemas with a scanner that walks to a bounded depth and
  refuses denied key names and credential-shaped stems. An opaque reference
  such as `credentialRef` is permitted; a bare `token` is not. This is law 9 of
  `AGENTS.md` made mechanical rather than remembered.
- **Digests and references, never content.** A checkpoint names what it refers
  to and carries the digest that pins it. Content lives in the artifact store
  the ledger owns; the record carries the digest only.

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
