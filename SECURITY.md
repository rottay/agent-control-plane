# Security

The threat model for the Agent Control Plane, and the mechanisms that hold it.

Every load-bearing claim below carries an **anchor**: the file and the literal
that make the claim true. The architecture fence greps each anchor and fails on
absence, so this document cannot drift from the code it describes — if a
mechanism is renamed or removed, `pnpm check` fails here rather than leaving a
security document quietly describing something that no longer exists.

## Reporting

This repository is published at
`https://github.com/rottay/agent-control-plane` and is private. There is no
external reporting channel and no security mailbox; inventing one would be
worse than saying so. Raise a security concern with the repository owner
directly.

## What this system is

A local, single-host control plane. It runs on an operator's own machine,
reads and writes one SQLite ledger on that machine, and serves a read-mostly
HTTP surface on loopback. It is not a multi-tenant service, it has no user
accounts, and it terminates no TLS.

**Nothing here is adopted into real operation.** Adoption is a single explicit
decision that happens after P8 certification and a separate P9 authorization.
Until then this system observes and decides; it does not act.

## The boundary is loopback, and that is titular

The observation surface shows every task, worker and transition with no
authentication in front of it. That is a deliberate design statement, not an
omission: the data is already on the operator's own machine, and a login on a
loopback-only surface buys ceremony rather than security.

What makes it safe is the bind address, which is therefore **not** a
deployment preference. `0.0.0.0` would publish the whole control plane to the
local network, so the constant is fixed in code and the reasoning is recorded
in an ADR.

> Anchor: `packages/entrypoints/gateway/src/constants/index.ts` — `SERVER_BIND_HOST = "127.0.0.1"`
> Anchor: `docs/architecture/0003-read-only-observation-plane.md` — `The listener binds loopback, and that is a constant`

The port is not part of the boundary: a caller may choose another.

## The write door, and why it is armed differently

Reads are free. Writes are not, because a write reachable by anything that can
reach the port is a different risk from a read.

The guard is armed inside the **write registrar**, not sprinkled over handlers.
That is structural rather than remembered: a future write route registered
through the same registrar is guarded because of where it is registered, and a
contributor cannot forget the guard because there is nowhere to forget it from.

Three properties, each mechanical:

- **Fail-closed.** With no token file configured, every write answers `403`
  rather than proceeding. An unconfigured door is shut, never open — the
  alternative is the failure mode where a deployment that forgot the flag is
  wide open and looks fine.
- **Constant-time comparison over digests.** The supplied value is hashed and
  the hashes compared with `timingSafeEqual`, so neither the bytes nor the
  *length* leaks through timing. Hashing first is what makes the operands
  equal-length, which `timingSafeEqual` requires.
- **Two write routes, both named.** `API_WRITE_ROUTES` is a separate frozen
  table, so "what can mutate?" has one short answer that grows visibly.

> Anchor: `packages/entrypoints/gateway/src/bearer/index.ts` — `timingSafeEqual`
> Anchor: `packages/entrypoints/gateway/src/bearer/index.ts` — `Fail-closed`
> Anchor: `packages/kernel/protocol/src/routes/index.ts` — `export const API_WRITE_ROUTES`

## No secret enters this repository

The law is absolute and it is law 9 of `AGENTS.md`: no secret enters this
repository, the ledger, read models, logs, checkpoints, prompts, artifacts or
commits.

It is enforced in three independent places rather than trusted once:

- **At the contract.** Record-shaped schemas are refined with a scanner that
  walks to a bounded depth and refuses denied key names and credential-shaped
  stems. An opaque reference such as `credentialRef` is permitted; a bare
  credential is not. A record that carries one fails validation before it can
  be appended.
- **At the repository.** The fence scans every tracked file for the *shape* of
  live credential material — private key blocks, provider keys, cloud access
  key ids, signed web tokens — rather than for the word "secret", so a document
  that discusses credentials is fine and a file that carries one is not. The
  single exemption is the contracts test that proves the scanner works, and it
  is bounded structurally: an exempt path must be a test file **and** must
  actually call the scanner.
- **By file name.** A short list of basenames and suffixes may never exist in
  any directory of this repository.

> Anchor: `AGENTS.md` — `### 9. No secrets, anywhere`
> Anchor: `packages/kernel/contracts/src/schemas/credential-guards/index.ts` — `findCredentialViolations`
> Anchor: `scripts/check-architecture.mjs` — `carries credential material`
> Anchor: `scripts/check-architecture.mjs` — `FORBIDDEN_BASENAMES`

## The owner account file lives outside every repository

Provider credentials are the operator's, not the plane's. The owner account
file is read from the operator's home directory, never from a repository, and
its permissions are checked before its contents are trusted.

The check is **exactly** `0600` — not "no group or world write". A file anyone
can read is a file whose contents are not the owner's alone, and an owner file
that fails the check is refused rather than read.

> Anchor: `packages/domains/accounts/src/registry/index.ts` — `Exactly 0600`
> Anchor: `README.md` — `~/.rottay-agent-control-plane/accounts.local.json`

Contracts carry opaque locators — `keychain://`, `profile://`, `file://` —
never material.

## Redaction is absence, not masking

No response carries an absolute path: the ledger's location crosses as a digest
of the path plus the bare file label. No response carries an event payload: a
timeline item carries the event's key names and its serialized size only.

This is proven rather than intended. The parity suite asserts that no
credential-shaped or transcript-shaped key appears on any route in any client,
and that a blanked value is detected rather than accepted as redacted.

> Anchor: `packages/kernel/protocol/src/parity/index.ts` — `hasObservationPrivacyViolation`

## Supply chain

The dependency graph is frozen and the install is inert.

- **Install scripts are denied by default.** The build allow-list holds exactly
  one adjudicated entry, `better-sqlite3`, which needs a native build. Every
  other package installs without running a lifecycle script.
- **The telemetry beacon is excluded.** The upstream server package and the
  install-time telemetry beacon it pulls may never enter the graph, and neither
  may the vendor CLI or a container harness. The fence holds that list by name
  and asserts their absence from the lockfile and from every tracked file,
  rather than trusting the manifests. This document does not spell the names:
  the law is that they appear in no tracked file, and a security document that
  broke it to describe it would be its own counterexample.
- **The external server is pinned by digest, twice.** The Restate server is not
  an npm dependency. It is acquired by an explicit operator command, never by a
  lifecycle hook, and the pin file is the content authority: the archive must
  hash to the recorded digest **and** the extracted binary must hash to its
  own. Pinning only the archive would leave the binary self-attested, so a
  substituted binary with a matching receipt would pass.
- **The SDK version is exact.** A range would let a replay-determinism fix
  arrive unreviewed.

> Anchor: `pnpm-workspace.yaml` — `onlyBuiltDependencies`
> Anchor: `scripts/check-architecture.mjs` — `P2C_FORBIDDEN_NAMES`
> Anchor: `scripts/restate-server.pin.json` — `binarySha256`
> Anchor: `pnpm-workspace.yaml` — `"@restatedev/restate-sdk": 1.16.9`

## The repository cannot publish itself

Pushing **denies by default**. The owner authorized publishing committed `main`
on 2026-09-03, and the hook is the mechanical form of exactly that: it permits
`refs/heads/main` to `refs/heads/main` on `origin` at the canonical URL,
fast-forward only, and only when `ACP_OWNER_PUBLISH=1` is set for that single
command. Deletions, tags, other branches, other remotes, non-fast-forward
updates and credential-bearing URLs are each refused by name. No agent may set
that variable or add a remote.

The fence does not read the hook, it runs it — thirteen denied cases and two
permitted ones, against fake refs with no network — and it verifies that
`core.hooksPath` still points at it, because a fence that is installed but not
armed is not a fence. It also asserts the configured remote is the canonical
one by exact URL and that the URL carries no credentials, so a token cannot
live in `git config`.

Publishing the repository is not operational cutover. P9 stays deferred, and
the fence still refuses a cutover claim or a `NEXT_P9` marker in the roadmap.

> Anchor: `.githooks/pre-push` — `PUSH DENIED by the Agent Control Plane publication fence.`
> Anchor: `.githooks/pre-push` — `ACP_OWNER_PUBLISH`
> Anchor: `scripts/check-architecture.mjs` — `PUBLISH_URL`

Local commits are allowed only with a `CommitAuthorizationReceipt` from an
independent verifier.

## What is deliberately out of scope

Stated plainly, so absence is never mistaken for oversight:

- **Authentication on the read plane.** Out of scope by decision; loopback is
  the boundary.
- **TLS.** Nothing terminates it. A loopback listener on the operator's own
  machine has no transport to protect from whom.
- **Multi-tenancy and authorization roles.** There is one operator.
- **Network hardening of the pinned server.** It is a local process the
  operator starts, under the same loopback assumption.
- **Sandboxing of provider processes.** Adapters spawn from exactly one
  allow-listed site with an explicit four-variable environment allow-list and
  no shell, which bounds the blast radius; it is not a sandbox and is not
  claimed as one.
