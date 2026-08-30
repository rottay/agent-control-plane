# `@acp/accounts`

The account registry of the Agent Control Plane: the owner file's admission
law, the opaque references it carries, and the read-only registry built over
them.

## Scope

**P5 is complete**: the package scaffold, the owner-file loader, the admission
ladder, the registry, quota estimation with its reset calendar, the quota-aware
router and the switching policy, all exported from `src/index.ts` behind a
closed surface the architecture fence pins by equality.

Importing this package has **no side effects**. `loadAccountsFile` reads when it
is called, and only then, from a path the caller supplies. Nothing here writes,
creates or removes anything.

This is **shadow mode**, and no product adoption. Nothing in P5 starts a
provider session, authenticates against anything, opens a socket or touches a
product repository. The router and the switching machine, both landed,
*recommend*; they never act. Adoption is a separate owner decision at P9 that
nothing here anticipates or authorizes.

## The owner file, and why this package cannot find it

The owner's account file lives at
`~/.rottay-agent-control-plane/accounts.local.json`, with mode `0600`, outside
every repository. It is never committed and never mirrored here.

That path appears in this sentence and in ADR 0011, and **nowhere in the
code**. Every entry point takes the path explicitly; there is no default, and
this package reads no environment variable at all — not `HOME`, not anything.
The architecture fence asserts the absence rather than trusting this paragraph.

The reason is narrow and worth stating plainly: a loader that knows a default
path is a loader that can be called with no arguments, and a test that calls it
with no arguments reads the owner's real accounts. Calling it with nothing is
therefore a refusal (`PATH_NOT_SUPPLIED`) at runtime, not a compiler opinion a
caller can cast away. Fixtures live under the real temporary root, are created
and removed by the test that made them, and are never named
`accounts.local.json`.

## The admission ladder

Each rung has its own classified refusal, so a caller and a test can tell the
failures apart:

| Rung | Refusal |
| --- | --- |
| a path was supplied at all | `PATH_NOT_SUPPLIED` |
| absolute | `PATH_NOT_ABSOLUTE` |
| canonical — `realpath` equals the input | `PATH_NOT_CANONICAL` |
| exists | `OWNER_FILE_ABSENT` |
| a regular file | `OWNER_FILE_NOT_REGULAR` |
| owned by this uid | `OWNER_FILE_NOT_OWNED` |
| mode **exactly** `0600` | `OWNER_FILE_UNSAFE_PERMISSIONS` |
| within the size bound | `OWNER_FILE_TOO_LARGE` |
| parseable JSON | `OWNER_FILE_NOT_JSON` |
| a valid accounts file | `OWNER_FILE_UNEXPECTED_KEY`, `OWNER_FILE_INVALID`, `OWNER_FILE_CREDENTIAL_MATERIAL`, `OWNER_FILE_TRANSCRIPT_MATERIAL`, `DUPLICATE_ACCOUNT_ID` |

Two rungs are stricter than their precedents elsewhere in this repository.
`0600` is required **exactly**, not merely "no group or world write": an owner
file that anyone can read has already failed at the only thing it is for. And
the canonical check refuses a symlink rather than following it, so no check
below it can be aimed at a different file than the one that was named.

The size bound is applied twice — against the `stat`, and against the bytes
actually read. A file can grow between the two, and a bound that only ever
consulted metadata would be a bound on what the filesystem claimed.

## The envelope, and unknown keys

An accounts file carries exactly two keys:

```json
{ "contractVersion": "2.0.0", "accounts": [ /* AccountRecord */ ] }
```

Any third key is a refusal, not a field to ignore. A loader that ignores keys
it does not recognize will accept a file written for a newer, incompatible
shape and then act on half of it.

The envelope is defined and enforced in this package. The records inside it are
validated by the `AccountRecord` contract exported from `@acp/contracts`, which
is where the shared shape lives — P5 changes no contract.

## Refusals name a path, never a value

This is the discipline the package is built around, and it is why the refusal
type has an `at` field rather than a `message`.

The owner file is the one document in this system that legitimately names where
credentials live. A refusal that quoted what it choked on would be the single
most likely place for material to escape — into a log, a test snapshot, a bug
report. So a validator's message is **read to classify and then discarded**; the
only thing that leaves is a JSON path this package constructed itself. There is
no branch anywhere in the loader that can place a value in a result.

Key names are the interesting case, because a key name *is* a JSON path and so
has to be reportable. An unexpected key is named — unless the "name" fails a
grammar check, or the credential vocabulary in `@acp/contracts` recognises it as
material, in which case it is reported as `<key>` at its parent path. That
vocabulary is used rather than a local pattern list on purpose: a second privacy
vocabulary in this package would be one more thing to keep in agreement with the
first. The tests assert that a credential-shaped value or key produces a refusal
with **zero bytes** of it in the result.

The same vocabulary is applied to open-map key names on the **admission** path
as well, because the contract's traversal does not: `findCredentialViolations`
runs its value patterns over string *values* and a stem match over *keys*, never
the value patterns over a key name. `knownLimits` is the only free-key map in
`AccountRecord`, so it is the only place that gap is reachable, and a
credential-shaped key there is refused rather than admitted. That is the same
function on the same class of input the refusal path already hands it — the
admission path was missing the call. The traversal fix belongs in
`@acp/contracts` and is deferred to a contracts packet; P5 changes no contract.

## Opaque references are never resolved

`authProfileRef` and `credentialRef` are opaque locators — `keychain://`,
`profile://`, `file://` — carried exactly as written and **never
dereferenced**, in P5 or by this package in any phase. The material they name
stays outside this repository. `isolatedConfigRoot` is shape-checked here and
nowhere else: the directory itself is admitted by `@acp/adapters` at session
start, which is the component that owns filesystem admission for a session.

## Reading, not writing

`@acp/ledger` is a declared dependency because P5D reads quota observations
from the event log. It is a **read-only** dependency by law: no production
source in this package contains an append, and the architecture fence scans for
it. The switching machine P5D adds returns candidate events as values; drills
that append do so through a disposable shadow ledger, never through this
package.

`@acp/accounts` never imports `@acp/runtime`. The direction is settled in ADR
0011 and runs the other way: `runtime` will consume this package in P6.

## What is deferred, and to where

The accounts **UI** and the `drain` / `account-ready` / `reauth-required`
actions are **deferred to P8 by DT ruling**. P5 ships the read model a UI will
one day project — `AccountRecord` plus the router's recommendation — and no
route, because a tenth observation route is a contract change outside P5.
