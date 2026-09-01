# Troubleshooting

Every failure class on this page is one the system actually produces. The names
are the strings in the code, not paraphrases, so you can search for them.

## The accounts surface says UNAVAILABLE

The accounts endpoint answers `200` with a `status: "UNAVAILABLE"` body rather
than an error status, because a missing owner file is the plane's honest state
and the commonest one on a fresh machine — not the endpoint failing. The
`reason` is one of exactly five:

| reason | what it means | what to do |
| --- | --- | --- |
| `ACCOUNTS_FILE_UNCONFIGURED` | the start invocation passed no `--accounts-file` | pass it, or accept this state deliberately |
| `ACCOUNTS_FILE_ABSENT` | the path was passed but nothing is there | create the file, or fix the path |
| `ACCOUNTS_FILE_UNREADABLE` | present but the loader refused it | see below — this one has sub-causes |
| `ACCOUNTS_FILE_SCHEMA_REFUSED` | it parsed but does not match the contract | fix the document's shape |
| `ACCOUNTS_FILE_OVERSIZE` | larger than the declared ceiling | the file is not what you think it is |

`ACCOUNTS_FILE_UNREADABLE` covers the path and permission rungs: a path that is
not absolute, a path that is not canonical (on macOS `/var/...` is a symlink and
the real path is `/private/var/...`), a file that is not a regular file, a file
not owned by the running user, or one whose mode is not exactly `0600`. The
`detail` field names the rung, and it never contains a value from the file.

## Every write answers 403 WRITE_BEARER_UNCONFIGURED

The server was started without `--write-bearer`. That is fail-closed by design:
an unconfigured door is shut, not open. Configure a token file and restart —
the token is loaded once at registration, so rotating it is a restart, not a
re-read.

## Every write answers 401 AUTH_REQUIRED

Either no credential was presented, or the presented one did not match. **These
are one answer on purpose.** Distinguishing them would confirm to an
unauthenticated caller that a header it guessed had the right shape. If you are
sure the token is right, check the file itself: the token is the file's trimmed
contents, so an editor's trailing newline is not part of it, and the file must
still be mode `0600` and owned by you.

## A write answers 409 WRITE_REFUSED

The body's message names the refusal. For account actions the vocabulary is
`UNKNOWN_ACCOUNT`, `ALREADY_IN_STATE`, `ACCOUNTS_UNAVAILABLE`, and
`WRITE_CONFLICT`.

`ALREADY_IN_STATE` is not a bug: a no-op is refused rather than silently
granted, because "nothing happened" is not something an append-only log should
have to say.

`WRITE_CONFLICT` means two writes raced and this one lost the idempotency or
event-id check. Re-read the current state and decide again; do not retry blindly,
because each confirmed action is a genuinely new entry in an append-only stream.

## The daemon refuses to start on a port

```
refusing to start: loopback port(s) already in use: 8080
```

The addresses are part of the contract, so the answer to a collision is to fail
loudly rather than to pick a different port — a daemon that silently moved would
pass its own drills and then not be where anything expects it. Find what holds
the port:

```sh
lsof -nP -iTCP:8080 -sTCP:LISTEN
lsof -nP -iTCP:9070 -sTCP:LISTEN
lsof -nP -iTCP:9080 -sTCP:LISTEN
```

If it is a leftover from a previous run, see the next section.

## A restate-server outlived its run

This has happened, and it is why two packets exist. The failure mode: a drill or
a daemon dies between starting the Restate server and the shutdown that would
reap it, and the server survives with nothing owning it — quietly falsifying
later runs.

Find any:

```sh
ps -Ao pid=,command= | grep 'restate-server-1.7.7/restate-server' | grep -v grep
```

The test suites now close this on their own side: both drill files register a
spawned process at the moment its pid is known — before any assertion that
could throw — and their teardowns actively sweep what a test left running,
`SIGTERM` first so a daemon reaps its own server, `SIGKILL` only for a hang. The
daemon suite additionally asserts that no process matching the pinned binary
path survives the file, which covers the one pid a suite can never register: a
server started by a daemon that died before announcing it.

**If you find a stray process on a real machine, treat it as an incident rather
than a chore.** Terminating an unowned process is a decision with a record, not
a cleanup step, and the same reasoning is why the suites detect strays by binary
path but never pattern-kill them.

## `pnpm check` fails

**First, check the two prerequisites** — on a fresh checkout these are the
usual answer, and both are setup rather than defects. The
[runbook](./runbook.md) establishes them:

```sh
git config --get core.hooksPath
node scripts/acquire-restate-server.mjs --verify-only
```

The first must print `.githooks`; if it prints nothing, the fence stops there
with `core.hooksPath is <unset> but must be .githooks`, and the fix is the line
the message itself gives you. The second must print `installed: VERIFIED`; if
it prints `installed: ABSENT`, run `node scripts/acquire-restate-server.mjs`
(without the flag) — the drills assert against a genuinely installed, verified
binary, and roughly sixteen of them fail with
`"reason": "no binary at …/.acp-local/tools/restate-server-1.7.7/restate-server"`
until it exists.

With both established, `pnpm check` runs four things in order; the output names
which one stopped it.

- **Architecture fence.** It prints the violated law in a sentence, e.g. a file
  naming something it may not name, or a write-set that does not match what is
  staged. The fence is meant to be strict; the fix is the code or the declared
  set, not the fence.
- **ESLint.** Ordinary lint output.
- **TypeScript.** `tsc --build --force tsconfig.base.json` across the project
  references.
- **Tests.** The failing suite and assertion are named.

Run the parts individually when narrowing down — noting that the suite and the
fence both depend on the two prerequisites above, so establish those before
reading anything into a failure here:

```sh
pnpm exec node scripts/check-architecture.mjs
pnpm exec eslint .
pnpm exec tsc --build --force tsconfig.base.json
pnpm exec vitest run
```

## The tests pass but a lane behaves oddly on re-run

Run the process-bearing lanes alone before concluding anything. (If they fail
wholesale rather than oddly, check the Restate binary first — see the
prerequisites above.)

```sh
pnpm exec vitest run --project daemon
pnpm exec vitest run --project runtime
```

They bind pinned ports and spawn real processes, so two full suite runs at once
will collide on those ports — the symptom is a port-holder assertion failing in
a drill that is otherwise fine. That is a scheduling collision, not a defect.

## The install refuses on Node version

```
Expected version: ^22.22.2 || ^24.15.0 || >=26.0.0
Got: v22.17.0
```

A dependency's `engines` disagrees with the repository's own Node pin
(`.nvmrc` = `22.17.0`, manifest `>=22.17.0 <23`). Pin the dependency to a
version the declared floor satisfies. Raising the repository's floor to suit a
tool is a deliberate decision about the whole workspace, not a side effect of
installing one.

## No rendered browser evidence

The browser bridge does not connect in this environment. That is a standing
result of the phase, recorded rather than worked around: accessibility and
structural evidence is gathered in-repo under jsdom with a pinned axe ruleset,
and sighted, pixel-level evidence remains owed. Contrast in particular is
excluded from the automated ruleset by name, because a DOM implementation with
no layout and no external stylesheet cannot honestly measure it.
