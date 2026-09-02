# Backup and restore

## The mechanism, stated plainly

**The plane exposes no backup API.** There is no backup verb on the CLI, none on
the HTTP surface, none anywhere. The mechanism is a file-level copy taken while
nothing is writing, and this page says so rather than implying a facility that
does not exist.

## Why "stop the writers" is not boilerplate here

The ledger is SQLite, opened for writing with:

```
journal_mode = WAL
synchronous  = NORMAL
```

WAL means committed data can live in `acp.sqlite3-wal` rather than in
`acp.sqlite3`, until a checkpoint folds it back. So copying only the main
database file while a writer is live can produce a file that is missing recent
commits, or is torn.

There are exactly two correct approaches, and both start by stopping every
writer:

1. **Clean close, then copy one file.** After a clean shutdown SQLite
   checkpoints and removes the sidecars. Verify they are gone, then copy
   `acp.sqlite3` alone.
2. **Copy all three as a unit.** If `-wal` or `-shm` are present, copy
   `acp.sqlite3`, `acp.sqlite3-wal` and `acp.sqlite3-shm` together, to the same
   destination directory, as one set.

Readers do not need to stop: `acp` and the server open the ledger with
`readOnly: true`.

## About the paths in these examples

They are concrete scratch paths under `/tmp/acp-ops` so this page can be run
verbatim. **A real operator substitutes their own ledger and backup paths.**
Nothing here touches `~/.rottay-agent-control-plane/accounts.local.json`.

## Taking a backup

```sh
mkdir -p /tmp/acp-ops/ledger /tmp/acp-ops/backup
node -e '
const { openLedger } = require("./packages/persistence/ledger/dist/index.js");
const ledger = openLedger("/tmp/acp-ops/ledger/acp.sqlite3");
ledger.close();
console.log("ledger created and closed cleanly");
'
```

Stop every writer, then check for sidecars:

```sh
ls -1 /tmp/acp-ops/ledger/
```

- **No `-wal` or `-shm` listed** — the close was clean. Copy the one file:

  ```sh
  cp /tmp/acp-ops/ledger/acp.sqlite3 /tmp/acp-ops/backup/acp.sqlite3
  ```

- **`-wal` or `-shm` present** — a writer did not close cleanly, or is still
  running. Stop it, look again, and if they persist copy all three:

  ```sh
  cp /tmp/acp-ops/ledger/acp.sqlite3 /tmp/acp-ops/backup/acp.sqlite3
  cp /tmp/acp-ops/ledger/acp.sqlite3-wal /tmp/acp-ops/backup/acp.sqlite3-wal
  cp /tmp/acp-ops/ledger/acp.sqlite3-shm /tmp/acp-ops/backup/acp.sqlite3-shm
  ```

Never copy the `-wal` without its database, or the database without a `-wal`
that exists. They are one artefact in two or three files.

## Restoring

Stop everything that could open the ledger, put the files back as a set, and
then **prove the restore rather than assuming it**.

```sh
mkdir -p /tmp/acp-ops/restored
cp /tmp/acp-ops/backup/acp.sqlite3 /tmp/acp-ops/restored/acp.sqlite3
```

If your backup includes sidecars, copy those too, into the same directory.

### Proof step 1 — the hash chain verifies

```sh
pnpm --filter @acp/cli build
node packages/entrypoints/cli/dist/index.js integrity --database /tmp/acp-ops/restored/acp.sqlite3
```

`integrity` is the operator-reachable wrapper over the ledger's own
verification: it walks the chain and reports whether every event's digest still
follows from the one before it. A restored file that verifies is a restored file
whose recorded history is intact.

### Proof step 2 — a surface starts cleanly against it

```sh
node packages/entrypoints/gateway/dist/bin/index.js --ledger /tmp/acp-ops/restored/acp.sqlite3
```

A clean start against the restored ledger is the second half of the proof: the
file verifies *and* the software will open it.

Stop it with `SIGTERM` when you have seen it start.

### What is deliberately not in this page

There is no "rebuild the read model" step, because there is no operator surface
that offers one. `rebuildReadModel()` is unreachable from the CLI and from the
server on purpose — the CLI's own doc block states that no path in the package
calls it, and the HTTP surface exposes only `verifyIntegrity`. If a rebuild
surface for operators is ever wanted, that is a source change with its own
decision to make, not a sentence someone adds to a runbook.

## If integrity fails on a restored file

Do not try to repair it. There is no supported repair, and inventing one means
rewriting recorded history. Go back to an earlier backup and verify that one.
A ledger that cannot be verified is evidence about the backup, and the honest
response is to say so.
