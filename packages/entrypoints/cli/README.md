# @acp/cli

The observation CLI of the Agent Control Plane.

`acp` answers questions about a ledger. **Every read verb opens it query-only;
three named verbs — `tool-call`, `cancel` and `attach` — share one short-lived
writable handle, and between them append at most one row each: `tool-call` a
receipt, `cancel` a cancellation, `attach` nothing at all.** The first narrowing
is V2-B4b stage 3D's and the second is V2 L2's, and both are stated rather than
softened: what changed is not "this CLI now writes", it is that three named
verbs do and every other one still cannot.

For every verb but those three, the posture is unchanged and structural rather
than promised: the ledger is opened with `readOnly: true`, which puts SQLite
itself into query-only mode. Nothing in this package calls `append()` or
`rebuildReadModel()` — every row that lands is appended by `@acp/runtime`,
which is the one authority on what a tool call or a cancellation may be. A CLI
that could repair a ledger would still be a CLI that could rewrite recorded
history, and this one cannot.

Scope note. This is the CLI of the P1 observation plane. It observes a ledger
and nothing else. There is no daemon, no orchestrator, no lease engine, no
provider adapter and no account switching here. P1 is complete, but completion
is not adoption: nothing in this package is used by any real operation.

## Usage

```
acp <command> --database <path> [options]
```

| Command             | What it answers                                                          |
| ------------------- | ------------------------------------------------------------------------ |
| `overview`          | One screen: state, counts, integrity verdict and capabilities             |
| `tasks`             | List task projections, filtered and cursor paginated                      |
| `task <task-id>`    | One task with its most recent events                                      |
| `workers`           | List observed worker identities                                           |
| `worker <identity>` | One worker with its most recent events                                    |
| `events`            | List ledger events in sequence order                                      |
| `status`            | Ledger pragmas, applied migrations and projection metadata                |
| `integrity`         | Verify the hash chain, the schema and the projections                     |
| `submission`        | Re-elect a daemon config's route by policy and print the updated document |
| `switch-decision`   | Fold recorded provider pressure into a switch decision and print it       |
| `tool-calls`        | List the tool calls recorded against one task                             |
| `tool-call`         | Execute one explicit tool call and record what it did                     |
| `cancel`            | Stop a durable invocation and settle the ledger once                      |
| `attach`            | Rejoin a durable invocation already in flight                             |

The table above said eight while there were fourteen: `submission`,
`switch-decision`, `tool-calls`, `tool-call`, `cancel` and `attach` all landed
without it. Where each command meets the API — and which two meet nothing,
because the plane serves no route that plans or decides — is declared in
`SURFACE_MAP` (`packages/kernel/protocol/src/surface-map/index.ts`), the one
place the CLI/API relation is written down.

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

### 2. Read only for every verb but three, structurally

`openLedger(path, { readOnly: true })` is how this package opens a ledger for
every verb except `tool-call`, `cancel` and `attach`. The handle refuses
mutation, SQLite refuses mutation, and the append-only triggers in the schema
refuse mutation. The suite drives every read verb and asserts the event count
and the applied-migration set are unchanged afterwards — a claim about every
read verb, checked by running every read verb.

`tool-call` is the exception the DT granted, and it is bounded three ways. It
takes the **only** writable open in this package, and the architecture fence
asserts that mechanically rather than trusting this paragraph. It probes the
ledger read-only first, so it can neither create a database at a mistyped path
nor migrate one — it executes, and migrating is not executing. And what it
appends is one receipt, written by the shared operation rather than by any code
here.

`cancel` and `attach` are V2 L2's exceptions, and they take **the same** open
rather than a second one: `openForWrite` is exported from the tool-call module
and called by the lifecycle door, so the fence law that admits exactly one
writable `openLedger(` in this tree is still satisfied by counting openings, not
by counting verbs.

They are bounded further than `tool-call` is, in one way that is worth stating.
An operator supplies four coordinates — `--task`, `--attempt`, `--mode` and
`--scenario` — and nothing else. Everything the drivers need is **recovered**
from the ledger by `restateInvocation` and verified against the submission
digest that rides every event of the attempt: the invocation identity, the
instant, the emitting worker, the initiative and the route. There is no flag for
any of them, because a flag would be a second authority for a value the log
already holds. `--mode` is the one thing that cannot be recovered and is
therefore required and never inferred — probing an engine and falling back to
the other one is precisely what drill D4 refuses.

An attempt that has not yet reached `RUN_STARTED` has recorded no route, so
there is nothing to recover and the verbs refuse, naming `attempt.route`. That
window is a daemon-internal one, and it is refused rather than guessed.

**One bound `tool-call` does not have: nothing serializes two runs of it.** A tool call
spends its coordinate by recording *after* the tool answers, so two overlapping
invocations for the same coordinate both find it unspent and both run the tool.
The API door closes that inside one gateway process; a CLI invocation is a new
process every time and carries no such registry, so **CLI against CLI** — a
script retrying on a timeout is the likely case — and **CLI against the
gateway** are both open. The ledger still keeps exactly one row per coordinate,
so recorded history stays truthful; what is not guaranteed is that the tool ran
once. Closing it needs a lock the ledger itself arbitrates, covering both doors,
and that is a later packet.

### 3. Everything printed is contract-validated

Every document is parsed by the schemas in `@acp/protocol` before it is
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
nothing. The package links `@acp/protocol` and `@acp/ledger`, and nothing
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
| `2`  | The request was malformed: bad command, option, or filter — or it named an attempt that had already ended (`TASK_TERMINAL`, printed as a document). |
| `4`  | Nothing is there to act on, from either of two sources: the ledger holds no such task, worker or attempt (an envelope on stderr), or the ledger holds the attempt and the engine answered that it holds no invocation at its address (`INVOCATION_NOT_FOUND`, printed as a document on stdout). Not a retry loop: confirm the endpoint is registered, then ask once more — the ledger remains the authority on what the task did. |
| `5`  | The ledger could not be read, the engine could not be reached, or the effect's postcondition could not be established (`POSTCONDITION_UNKNOWN`, printed as a document, nothing appended). |
| `6`  | The recorded history will not carry this write: an integrity check failed, or a write door — `tool-call` or a lifecycle verb — refused because the ledger disagrees with the coordinates the request named (`WRITE_REFUSED`). Both write doors answer with this code. Nothing about the invocation was wrong, so it is neither a `2` to argue with nor a `5` to retry. |
| `7`  | Another caller holds this tool coordinate.                    |
| `8`  | This engine does not serve the lifecycle verb that was asked. |

The codes are closed and distinct on purpose. A script that cannot tell "I asked
wrongly" from "the ledger cannot be read" from "the ledger is not trustworthy"
will retry an integrity failure as if it were a typo.

`7` and `8` are the two that exist because a collapse would make a wrapper retry
the one answer that cannot change. A lost tool claim (`7`) says the winner is
recording the receipt, so read it rather than repeating the call. A capability
gap (`8`) says this engine will never serve this verb, however often it is
asked — which is the opposite of `5`, where the engine could not be reached and
a retry is exactly the right response. (`7` predates V2 L2 and was missing from
this table; it is stated here now.)

A driver refusal is printed as the JSON document on stdout with its closed
`refusal` name, while a door refusal is the `ApiError` envelope on stderr, so the
two are told apart by structure rather than by exit code alone.

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
