# @acp/cli

The read-only observation CLI of the Agent Control Plane.

`acp` answers questions about a ledger. It changes nothing, and that is
structural rather than promised: the ledger is opened with `readOnly: true`,
which puts SQLite itself into query-only mode, and no code path in this package
calls `append()` or `rebuildReadModel()`. A CLI that could repair a ledger would
be a CLI that could rewrite recorded history.

Scope note. This is the CLI of the P1 observation plane. It observes a ledger
and nothing else. There is no daemon, no orchestrator, no lease engine, no
provider adapter and no account switching here. P1 is complete, but completion
is not adoption: nothing in this package is used by any real operation.

## Usage

```
acp <command> --database <path> [options]
```

| Command             | What it answers                                              |
| ------------------- | ------------------------------------------------------------ |
| `overview`          | One screen: state, counts, integrity verdict and capabilities |
| `tasks`             | Task projections, filtered and cursor paginated                |
| `task <task-id>`    | One task with its most recent events                           |
| `workers`           | Observed worker identities                                     |
| `worker <identity>` | One worker with its most recent events                         |
| `events`            | Ledger events in sequence order                                |
| `status`            | Pragmas, applied migrations and projection metadata            |
| `integrity`         | Hash chain, schema shape and projection verification           |

Global options:

| Option              | Meaning                                        |
| ------------------- | ---------------------------------------------- |
| `--database <path>` | The ledger to read. Required, never guessed.   |
| `--format <format>` | `human` (default) or `json`.                   |
| `-h`, `--help`      | Usage.                                         |
| `-V`, `--version`   | API contract, ledger contract, schema version. |

Filters and pagination:

| Option               | Applies to | Meaning                                   |
| -------------------- | ---------- | ----------------------------------------- |
| `--state`            | `tasks`    | Task state                                |
| `--role`             | `workers`  | Worker role                               |
| `--provider`         | `workers`  | Provider segment of the identity          |
| `--task`             | `events`   | Task identifier                           |
| `--type`             | `events`   | Control plane event type                  |
| `--emitted-by`       | `events`   | Emitting worker identity                  |
| `--to-state`         | `events`   | Resulting task state                      |
| `--cursor`           | collections | Opaque cursor from the previous page     |
| `--limit`            | collections | Page size, 1 to 200                      |
| `--skip-integrity`   | `overview` | Report counts without verifying the chain |

Examples:

```sh
acp overview --database ./control-plane.sqlite
acp tasks --state RUNNING --limit 20 --database ./control-plane.sqlite
acp events --task 0f0a... --format json --database ./control-plane.sqlite | jq '.items[].type'
acp integrity --database ./control-plane.sqlite
```

## The five laws this CLI keeps

### 1. The ledger is explicit

`--database` is required. There is no default, no environment variable and no
search of the working directory. A tool that guesses which ledger it is reading
is a tool that eventually reads the wrong one and reports confidently about it.

### 2. Read only, structurally

`openLedger(path, { readOnly: true })` is the only way this package opens a
ledger. The handle refuses mutation, SQLite refuses mutation, and the append-only
triggers in the schema refuse mutation. The test suite asserts the file is
byte-identical after every command has run against it.

### 3. Everything printed is contract-validated

Every document is parsed by the schemas in `@acp/api-contracts` before it is
rendered, in both formats. The CLI and the future HTTP server therefore publish
the same shapes, and the mapping code in `observation/index.ts` — which is the new code
between two careful layers — cannot quietly emit a field the contract does not
describe. A projection that drifted fails loudly here instead of printing a
plausible answer.

### 4. No path, no payload, no lower-layer message

- The ledger path never appears in any output. A ledger is identified by a
  digest of its resolved path plus its bare file name, which is enough to tell
  two ledgers apart and useless for reaching either.
- Event payload values never cross. Only the payload key names and the
  serialized byte size do, because payloads are the one part of an event whose
  contents the contract does not fix.
- A failure is reported as a closed error code and a fixed sentence. Messages
  from SQLite, from `@acp/ledger` or from a schema are never forwarded: those are
  precisely where a path or a rejected value would escape.

### 5. No dependency

Argument parsing is `node:util` `parseArgs`. The observation surface is a handful
of read-only verbs; a parser library would be supply chain risk bought for
nothing. The package links `@acp/api-contracts` and `@acp/ledger`, and nothing
else.

## Output formats

`--format human` is for a terminal: aligned columns, short digests, a stated
`(none)` where a collection is empty rather than a bare header.

`--format json` is the machine contract. It prints the validated DTO and nothing
around it, pretty printed with a trailing newline, so a terminal reader and a
`jq` pipeline see the same bytes. Errors in this format are the `ApiError`
envelope on stderr.

## Exit codes

| Code | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| `0`  | The question was answered.                                   |
| `1`  | Internal failure, including a response that failed to parse. |
| `2`  | The request was malformed: bad command, option, or filter.    |
| `4`  | The task or worker asked for is not recorded.                 |
| `5`  | The ledger could not be read.                                 |
| `6`  | The ledger is not trustworthy: integrity check failed.        |

The codes are closed and distinct on purpose. A script that cannot tell "I asked
wrongly" from "the ledger cannot be read" from "the ledger is not trustworthy"
will retry an integrity failure as if it were a typo.

`acp overview` is the one command that answers without a readable ledger: it
reports `UNAVAILABLE` and exits `5`. `EMPTY` and `UNAVAILABLE` are different
facts — a control plane with no events and a control plane that cannot open its
ledger look identical to anything that only counts rows, and they mean opposite
things.

## Pagination

Cursors are opaque strings. Hand back `page.nextCursor` unchanged; do not do
arithmetic on it. The events cursor happens to be a sequence today, and treating
that as an interface would make changing the pagination strategy a breaking
change for every reader.

## Tests

`src/cli.test.ts` exercises the whole surface in process against disposable
ledgers created and removed in a temporary directory. It asserts the read-only
posture, the contract validation, the absence of the path and of payload values
in every command and both formats, the exit codes, and the integrity path — the
last by deliberately breaking the stored hash chain and showing the CLI reports
`DEGRADED` and exits `6`.
