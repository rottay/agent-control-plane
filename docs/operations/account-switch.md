# Switching the account the plane uses

## Two different things called "the account"

They are separate mechanisms and confusing them is the usual mistake:

1. **What the owner file declares** — which accounts exist, their plan, their
   limits, their declared reset schedule. This is a file the owner edits.
2. **What actually governs an account's operational state** — decided by the
   ledger once any action has been recorded against that account.

The rule between them is exact, and one function implements it for both the
read and the write path so the two cannot disagree:

- **No action ever recorded** → the owner file governs.
- **Any action recorded** → the ledger governs from then on, newest wins.

And the case people assume backwards: **editing the owner file afterwards does
not override a recorded action.** The file cannot know what the operator did on
Monday, so letting it win would erase a recorded decision with an unrecorded
one. The correction path is always an explicit act that gets its own receipt.

## The owner file

It lives outside every repository, at
`~/.rottay-agent-control-plane/accounts.local.json`, mode `0600`. **No command
on any of these pages reads it, prints it, or copies it**, and no example uses
its real path — the examples below use a scratch file so they can be run
verbatim without going anywhere near it.

The loader requires: an absolute path, a canonical path (on macOS `/var/...`
resolves to `/private/var/...` and the non-canonical form is refused —
correctly, since a symlinked owner file could point somewhere none of its checks
ever looked), a regular file, owned by the running user, mode exactly `0600`,
within the size ceiling, and matching the contract's shape.

## Wiring a different accounts file

Which file the plane reads is decided by the start invocation, not by a
convention or an environment variable:

```sh
node packages/server/dist/bin/index.js \
  --ledger /tmp/acp-ops/ledger/acp.sqlite3 \
  --accounts-file /tmp/acp-ops/accounts/accounts.local.json
```

Absent the flag, the accounts surface answers `UNAVAILABLE` with
`ACCOUNTS_FILE_UNCONFIGURED` — a true statement about the process rather than a
failure. Nothing infers the path from `$HOME`, because a plane that guesses
where secrets live is a plane that eventually reads a file nobody meant to give
it.

To point at a different file, stop the process and start it with a different
`--accounts-file`. There is no reload: the path is a property of the running
process.

Run this verbatim to see the permission rung refuse, with no real file involved:

```sh
mkdir -p /tmp/acp-ops/accounts
printf '{}' > /tmp/acp-ops/accounts/wrong-mode.json
chmod 0644 /tmp/acp-ops/accounts/wrong-mode.json
ls -l /tmp/acp-ops/accounts/wrong-mode.json
```

A file at `0644` is refused by the loader, and the accounts surface reports
`ACCOUNTS_FILE_UNREADABLE` with the rung in `detail` — never a value from the
file.

## Changing an account's operational state

Once the plane is running with an accounts file **and** a write bearer, state
changes are recorded actions, not file edits. The verbs are exactly four:

| action | resulting state |
| --- | --- |
| `DRAIN` | `DRAINING` |
| `ACCOUNT_READY` | `AVAILABLE` |
| `REAUTH_REQUIRED` | `AUTH_REQUIRED` |
| `OWNER_OVERRIDE` | whichever state you choose |

`OWNER_OVERRIDE` is the only one that carries a state selector, and the only one
where you say what the resulting state is rather than the verb implying it.

Each action is appended to an account-scoped, append-only stream with its own
sequence, and answers with a receipt naming that sequence. Refusals are named:
`UNKNOWN_ACCOUNT`, `ALREADY_IN_STATE` (a no-op is refused, not silently
granted), `ACCOUNTS_UNAVAILABLE`, `WRITE_CONFLICT`.

An optional note rides the same content guards as every other write, which means
**a note that looks like a credential is refused and never echoed**. Do not put
tokens in notes; the guard is there because someone eventually would.

## Reading the effective state back

```sh
node packages/cli/dist/index.js status --database /tmp/acp-ops/ledger/acp.sqlite3
```

In the UI, an account whose state comes from a recorded action is marked
**operator-set**, with the action and its instant available on the mark, and the
owner file's baseline kept in a disclosure beside it — so the two facts are
never collapsed into one number a reader has to take on faith.

## What switching accounts is not

- It is not a config reload. Stop and restart with the flag you want.
- It is not an edit to a running plane's state. Edits to the file do not
  override recorded actions; a correction is an explicit action.
- It is not reversible by deleting the action. The stream is append-only. The
  way back is another recorded action, which is the point of having a record.
