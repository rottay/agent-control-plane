# Runbook — starting and stopping the control plane

Everything on this page was checked against the source at the commit that
introduced it. Where a command has a flag, the flag exists; where a page names
an error string, that string is in the code. If something here turns out not to
match the system, the page is wrong and should be fixed, not worked around.

## About the paths in these examples

The examples use concrete scratch paths under `/tmp/acp-ops` so that a reader
can run this page top to bottom, verbatim, on a machine that has never run the
plane before, and see the real output. They are deliberately not production
paths.

**If you are the operator running the real plane, substitute your own paths.**
In particular, your accounts file lives outside every repository, at
`~/.rottay-agent-control-plane/accounts.local.json` with mode `0600`, and no
example on any of these pages ever reads, writes, or prints it.

## Prerequisites

Node and pnpm versions are pinned by the repository, not by preference:

```sh
cat .nvmrc
node -e 'console.log(require("./package.json").engines)'
```

`.nvmrc` says `22.17.0`, and the root manifest declares
`{"node":">=22.17.0 <23","pnpm":">=10.26.2"}`. A different major will fail
installs whose own engine ranges disagree.

```sh
node --version
pnpm --version
pnpm install
```

### Point Git at the repository's own hooks — required, once per checkout

```sh
git config core.hooksPath .githooks
```

**Do this before running any check.** It is per-checkout local Git config, so a
fresh clone does not have it, and nothing sets it for you. Two things depend on
it: `.githooks/pre-push` refuses every push unconditionally, and the
architecture fence verifies that the hook path is actually active — a fence that
merely *believed* the hook was armed would be worth nothing.

Without it, the health check below fails on exactly this, and says so:

```
Architecture fence FAILED with 1 violation(s):
  ✗ core.hooksPath is <unset> but must be .githooks; run: git config core.hooksPath .githooks
```

That is the fence working, not a broken tree. Run the line above and continue.

### Acquire the Restate server binary — required once, uses the network

```sh
node scripts/acquire-restate-server.mjs
```

See [the durable runtime section](#the-durable-runtime-and-its-ports) for what
this does and why the binary is not an npm dependency. **Some tests assert
against a genuinely installed, verified binary, so the full suite does not pass
until this has run.** It is the one step on these pages that touches the
network.

## The one command that says whether the tree is healthy

```sh
pnpm check
```

It runs, in order: the architecture fence, ESLint, the TypeScript build, and
the full test suite. Any non-zero exit means one of those four failed, and the
output names which. Run it before and after anything on these pages.

**It has two prerequisites, both above**: `core.hooksPath` set, and the Restate
binary acquired. On a fresh checkout with neither, it fails on the hook path
first and on drill assertions second — both are missing setup, not defects. With
both done, it exits `0`.

## Building the two operator surfaces

Both are TypeScript packages that must be built before their binaries exist:

```sh
pnpm --filter @acp/cli build
pnpm --filter @acp/server build
```

- `@acp/cli` produces `acp` (`packages/entrypoints/cli/dist/index.js`).
- `@acp/server` produces `acp-server` (`packages/entrypoints/server/dist/bin/index.js`).

## Reading a ledger with `acp`

`acp` is read-only by construction: it opens the ledger with `readOnly: true`,
which puts SQLite itself in query-only mode, and no path in the package calls
`append()`. It cannot repair a ledger, and that is deliberate — a tool that
could repair recorded history could also rewrite it.

`--database` is required and has no default. The CLI does not guess which
ledger you mean.

Run against a ledger that does not exist yet, it refuses by name rather than
inventing one — worth seeing once, because it is the shape of every refusal
this CLI makes:

```sh
node packages/entrypoints/cli/dist/index.js status --database /tmp/acp-ops/ledger/acp.sqlite3
echo "exit: $?"
```

On a machine where that path has never existed, this prints
`acp: LEDGER_UNAVAILABLE: the ledger could not be opened` / `acp: LEDGER_OPEN`
and exits **5**. That is the documented, expected outcome — the CLI does not
create a ledger as a side effect of being asked to read one.

To get a real reading, create the ledger first (this is the same snippet
[backup and restore](./backup-restore.md) opens with) and run `status` again:

```sh
mkdir -p /tmp/acp-ops/ledger
node -e '
const { openLedger } = require("./packages/persistence/ledger/dist/index.js");
const ledger = openLedger("/tmp/acp-ops/ledger/acp.sqlite3");
ledger.close();
console.log("ledger created and closed cleanly");
'
node packages/entrypoints/cli/dist/index.js status --database /tmp/acp-ops/ledger/acp.sqlite3
```

Now it prints the head, the event count, the applied migrations and the
projections — and, usefully for the next page, `journal mode  wal`.

The verbs are exactly these eight — no more:

| verb | answers |
| --- | --- |
| `overview` | the plane's summary counts |
| `tasks` | the task page |
| `task` | one task's detail |
| `workers` | the worker page |
| `worker` | one worker's detail |
| `events` | the event page, filterable by `--task`, `--type`, `--emitted-by`, `--to-state`, `--cursor`, `--limit` |
| `status` | ledger head, event count, contract version |
| `integrity` | the hash-chain verification |

## Starting the server

```sh
node packages/entrypoints/server/dist/bin/index.js --ledger /tmp/acp-ops/ledger/acp.sqlite3
```

The flags are:

| flag | meaning |
| --- | --- |
| `--ledger <path>` | required; the ledger to read |
| `--accounts-file <path>` | optional; the owner's accounts file |
| `--write-bearer <path>` | optional; the file holding the write token |
| `--port <number>` | optional; rejected unless it parses and is ≤ 65535 |

Every path flag must be absolute. The entry classifies its own refusals —
`UNKNOWN_FLAG`, `FLAG_WITHOUT_VALUE`, `PATH_NOT_ABSOLUTE`, `PORT_NOT_A_NUMBER`,
`PORT_OUT_OF_RANGE`, `LEDGER_PATH_REQUIRED` — and never echoes the value you
typed, so a mistyped path does not end up in a log.

### Two fail-closed behaviours worth knowing before you start

**Accounts.** Until a start invocation passes `--accounts-file`, the accounts
surface answers `UNAVAILABLE` with reason `ACCOUNTS_FILE_UNCONFIGURED`. That is
a true statement about the process, not an error. Which invocation wires the
path is an operational decision, and it is yours.

**Writes.** Until a start invocation passes `--write-bearer`, every write
answers **403 `WRITE_BEARER_UNCONFIGURED`** — an unconfigured door is shut, not
open. With a token file configured, a request that presents no credential and a
request that presents the wrong one both answer **401 `AUTH_REQUIRED`**, and
they are indistinguishable on purpose: telling them apart would confirm to an
unauthenticated caller that a header it guessed had the right shape.

The token file itself must be an absolute, canonical path, a regular file, owned
by the running user, and mode `0600`. Anything else is refused by name
(`PATH_NOT_ABSOLUTE`, `PATH_NOT_CANONICAL`, `TOKEN_FILE_NOT_REGULAR`,
`TOKEN_FILE_NOT_OWNED`, `TOKEN_FILE_UNSAFE_PERMISSIONS`, `TOKEN_FILE_ABSENT`,
`TOKEN_FILE_EMPTY`, `TOKEN_FILE_TOO_LARGE`). The token is the trimmed contents,
so a trailing newline from your editor is not part of it.

Run this verbatim to see the whole fail-closed path with no secret involved:

```sh
mkdir -p /tmp/acp-ops/ledger
node packages/entrypoints/server/dist/bin/index.js --ledger /tmp/acp-ops/ledger/acp.sqlite3 --port 70000
echo "exit: $?"
```

It exits `2` and prints the reason word `PORT_OUT_OF_RANGE`, followed by the
usage block listing the four flags. **The value you typed is not echoed** —
`70000` appears nowhere in the output, which is the property that matters when
the mistyped argument is a path rather than a port.

## The durable runtime and its ports

The Restate server is **not** an npm dependency — the published server package
pulls a postinstall network beacon, so it is acquired as an external pinned
binary instead, by an explicit operator command:

```sh
node scripts/acquire-restate-server.mjs
```

That is the command that actually acquires. It uses the network once, checks the
URL is HTTPS and inside the pinned boundary, allows a single redirect hop,
verifies the platform and the SHA-256 against the pin, and unpacks into
`.acp-local/tools/` inside this checkout — a directory Git ignores. Nothing
downloads at import time and no install hook is involved; the fetch happens
only because you typed this line.

Afterwards — or any time you want to know the state without fetching:

```sh
node scripts/acquire-restate-server.mjs --verify-only
```

`--verify-only` **does not fetch**. On a machine that already has the verified
binary it prints `installed: VERIFIED`; on one that does not it prints
`installed: ABSENT` and refuses with
`no verified binary is installed and --verify-only will not fetch`, exiting 1.
Both are correct answers to "is it there?" — neither is a way to get it there.

The pin lives in `scripts/restate-server.pin.json` (version `1.7.7`), which
records the release, the asset host and path prefix, and per-platform digests.

The loopback addresses are part of the contract, not a preference:

| constant | value |
| --- | --- |
| `LOOPBACK_HOST` | `127.0.0.1` |
| `RESTATE_INGRESS_PORT` | `8080` |
| `RESTATE_ADMIN_PORT` | `9070` |
| `RUNTIME_SERVICE_PORT` | `9080` |

If one is already in use the daemon **refuses to start** rather than moving:
`refusing to start: loopback port(s) already in use: …`. A daemon that silently
moved would pass its own drills and then not be where anything expects it.

## Stopping

Stop the server or daemon with `SIGTERM`, not `SIGKILL`. The daemon's supervised
shutdown is what reaps the Restate server it started; killing it outright
bypasses that and leaves the server behind with nothing owning it. If you need
to confirm afterwards:

```sh
ps -Ao pid=,command= | grep 'restate-server-1.7.7/restate-server' | grep -v grep
```

An empty result is the expected one. If it is not empty, see
[troubleshooting](./troubleshooting.md).

## What this plane deliberately does not do

- No push, no remote. The repository has none, and `.githooks/pre-push` refuses
  unconditionally.
- No product cutover. Adoption into real operation is a separate, unauthorised
  step and nothing on these pages performs it.
- No browser-rendered evidence. The browser bridge does not connect in this
  environment; that is a standing result, recorded rather than worked around.
