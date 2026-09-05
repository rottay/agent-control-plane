# ADR 0045 — One door records what an account's state became

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

The switch executor names the transition it cannot perform. Step 1 of the
declared eleven is `MARK_ACCOUNT_DRAINING`, and the executor's own comment says
what happens to it (`packages/domains/runtime/src/switch-executor/index.ts:127-131`):

```
1 MARK_ACCOUNT_DRAINING  — no event; the plan's `accountStatus` is never
                           appended here and the plan vocabulary has no
                           account-state event. Where that transition gets
                           recorded is F4/F5's question.
```

ADR 0042 deferred that question deliberately, and ADR 0044 landed the walk that
plays a decided switch — so the question is now downstream of a walk that
actually runs.

The reason nothing recorded it is structural rather than missing. Exactly one
place in the tree appends an `AccountActionEvent`, and it lived in an
entrypoint: `packages/entrypoints/gateway/src/account-actions/index.ts`. A
domain-stratum caller cannot reach an entrypoint — that is what the strata are
— so the only way to record an account transition was through the HTTP door.
The plane could decide a switch, play it, and record everything about it except
what became of the account.

Two facts about that door make its relocation less simple than moving a
function. It resolves the owner file to establish a baseline, because an
account's *existence* comes from the file and only its *operational lifecycle*
comes from the ledger. And the refusal it produces when that resolution fails
is not private: `ACCOUNTS_UNAVAILABLE` reaches an HTTP 409 payload with its
detail, which is a wire-visible answer this packet is not authorized to move.

## Decision

The append moves down one stratum, and the baseline crosses the seam as a
value.

`recordAccountAction` now lives in `packages/domains/runtime/src/actions/index.ts`,
beside the reader `readAccountActions` that has always been its sibling. Its
input carries `{accountId, baseline, action, setState, actor, note, recordedAt,
eventId}` and a source that lists the account's recorded actions and names the
ledger path. It takes **no file path**: it never calls `loadAccountsFile` or
`readAccounts`, names no owner file, and imports no gateway symbol.
`@acp/protocol` is not in the runtime's allowlist, so the writer declares its
own input over kernel primitives rather than reusing the wire request — and the
allowlist was **not** widened to avoid that.

The gateway keeps the name and becomes a delegating wrapper — the shape that
same file already uses for `foldEffectiveState`. It resolves the baseline
through its existing `readAccounts` path, maps the two refusals that depend on
that resolution (`ACCOUNTS_UNAVAILABLE` with its detail, and the
`UNKNOWN_ACCOUNT` an absent account produces), and hands the rest to the one
writer. Its public signature, its four-refusal contract, its status codes and
its payload are unchanged, and its own suite passes with no assertion edited.
The runtime's outcome is the ledger-side subset — `UNKNOWN_ACCOUNT`,
`ALREADY_IN_STATE`, `WRITE_CONFLICT` — which the wrapper returns unchanged.

The concurrency behaviour is preserved rather than reimplemented: the fold runs
from the baseline value over the recorded history, the version is
`(newest recorded version) + 1`, the idempotency key is
`<accountId>/1/action.<version>`, the two race codes become `WRITE_CONFLICT`,
and the writable handle is closed in `finally`.

`L-F4C-1` makes the one-door claim mechanical instead of promising it in prose.
Over `packages/domains/*/src/**` and `packages/entrypoints/*/src/**`:
`appendAccountAction(` may be called from exactly one source, named as a
literal; that file must **still** name it, so the law cannot pass vacuously
once its permitted producer goes away; and no source outside
`packages/kernel/contracts/**` may construct an action whose `resultingState`
is the literal `"EXHAUSTED"` or `"COOLDOWN"`. The roots probe drives all three
halves and adds the negative control that keeps the third honest: an
operator-supplied state threaded through as a **value** stays lawful, because
that is precisely what the override verb exists for.

## Why moving the whole seam was not chosen

The obvious relocation takes the file path with it: the runtime writer would
call `loadAccountsFile` itself and reproduce the gateway's four refusals whole.
It was rejected because of what travels with `ACCOUNTS_UNAVAILABLE`. That
refusal carries a detail that reaches an HTTP payload, so reproducing the
mapping in the runtime would either duplicate a wire-visible answer in two
strata or force an edit to the route — a path outside this packet's write-set,
and a change to an API contract this packet has no authority to change.

Passing the baseline as a value costs one field at the seam and buys the
property that matters: any caller able to establish a baseline can record,
including a caller that is forbidden the owner file entirely. The daemon is
exactly such a caller, by its own config door.

## Why widening the vocabulary was not chosen

`ACCOUNT_ACTIONS` stays four, and `EXHAUSTED` and `COOLDOWN` remain
**unrecordable by machine decision**. This is chosen, not overlooked.

No verb implies either state. Recording one would mean either inventing a fifth
verb — building a vocabulary ahead of the caller that needs it — or
manufacturing `OWNER_OVERRIDE`, which records that an owner overrode something
when no owner did. ADR 0044 created a *carrier* for the status without a
consumer, so the state has somewhere to travel and nothing yet reading it at
the far end.

The gap is two of four members and not the whole seam: `DRAINING` and
`AUTH_REQUIRED` are recordable today, through `DRAIN` and `REAUTH_REQUIRED`,
and those are the two a switch actually needs. When a caller for the other two
exists, the packet that writes it can widen the vocabulary against a real
reader. Until then `L-F4C-1`'s third half keeps a machine from forging either
one, and the operator's own `OWNER_OVERRIDE` path — which may set any status,
including these two — is untouched.

## Consequences

**The door is relocated but not yet reachable by any new caller, and none was
manufactured.** Two independent, measured reasons: `L-F4B-1` fences the only
elector, which decides and prints and may not write; and the only writable
in-walk caller ADR 0044 created, `considerSwitch`, runs in a process the config
door forbids the owner file — so it cannot establish a baseline. This packet
moves the door and stops. The plausible next caller is an operator-facing CLI
account verb, and it is not this packet's.

**Two names now exist for one behaviour**, and the fence's duplication register
records why: `recordAccountAction` is exported by `@acp/runtime` and by the
gateway wrapper, because `routes/index.ts` calls it under that name and is
outside this write-set. What makes the claim checkable is `L-F4C-1` rather than
the register entry: exactly one source appends.

**The read ceiling stays where it was.** The write path never applied
`readAccountActions`'s page ceiling and still does not, because preserving
behaviour means preserving that too. An account with a very long action history
folds all of it on every write; the bound belongs to a later packet with a
measurement behind it.

**A future account-state event must come through this door.** That is the point
of naming the site in a law: the next packet that wants to record a transition
extends the writer or the vocabulary, and cannot quietly open a second append.

## Not in this record

Who calls the door. The CLI account verb, the switch executor's step 1 becoming
a real append, and whether a played switch drains its outgoing account are all
later questions, and each needs a caller that can establish a baseline.

Whether the daemon should ever read the owner file. It should not, on ADR 0018
and D5; the baseline-value form is what makes that stay true.

The `EXHAUSTED`/`COOLDOWN` verbs themselves, deferred above with the reason.
