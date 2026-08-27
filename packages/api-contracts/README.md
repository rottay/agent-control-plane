# `@acp/api-contracts`

The browser-safe contract for the Agent Control Plane observation surface.

## Scope

This package describes what a reader of the control plane is allowed to see. It
describes nothing about how that surface is served and implements none of it.

**P1B is not P1 completion**, and this package shipped before the server, the
CLI and the UI existed. All three now consume it and P1 has closed. Completion
is still **no product adoption**: nothing here is connected to, observed from or
used by any real operation, and adoption still happens once, after P8
certification and a separate P9 authorisation.

## The boundary this package exists to hold

| Consumer | May depend on |
| --- | --- |
| `@acp/ui` | `@acp/api-contracts` only |
| `@acp/server` | `@acp/api-contracts` and `@acp/ledger` |
| `@acp/cli` | `@acp/api-contracts` and `@acp/ledger` |

The UI never links a database driver, never sees an absolute path and never
holds an event payload. The architecture fence asserts each of those rather
than trusting this table.

## What the contract guarantees

- **Two version lines.** `API_CONTRACT_VERSION` is the shape a reader receives.
  `LEDGER_CONTRACT_VERSION` is the durable meaning of a recorded event. They are
  deliberately different numbers and every response carries both.
- **Strict objects.** Unknown keys are rejected. A projection that grew a field
  server side fails at the boundary instead of leaking it.
- **Redacted database identity.** The absolute ledger path never crosses. A
  digest of the path and the bare file label do.
- **No payload values.** A timeline item carries the event's key names and
  serialized size, never its payload. Payload contents are the one part of an
  event the contract does not fix, so they are the one part a browser must not
  hold.
- **GET only.** Every route is a read. There is no mutating shape in this
  package because P1 has no write surface to describe.
- **Explicit emptiness.** The overview distinguishes `EMPTY` from `UNAVAILABLE`
  and `ACTIVE` from `DEGRADED`, and states in data that routing, accounts and
  leases do not exist in this phase.

## Usage

```ts
import { API_ROUTES, OverviewResponse, taskPath } from "@acp/api-contracts";

const response = OverviewResponse.parse(await readSomething(API_ROUTES.overview));
const detail = taskPath("0f2a1a34-0f6f-4d55-9d0a-2a4b1d3e5f60");
```

Route helpers validate before they encode. A caller that passes a traversal
segment gets a thrown validation error rather than a request to somewhere else.

## Tests

`pnpm test` runs the `api-contracts` project. The suite is adversarial by
design: it asserts that unknown keys, credential shaped field names, transcript
shaped field names, absolute paths, unsafe route parameters, invalid cursors and
limits, and a mismatched contract version are all rejected, and that every
accepted shape survives a JSON round trip unchanged.
