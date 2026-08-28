# ADR 0011 — The accounts registry and shadow routing

- Status: accepted for P5
- Date: 2026-08-28
- Supersedes nothing. Constrained by ADR 0001 (the ledger is the authority),
  by the frozen contracts ADR 0002 depends on, and by ADR 0010's rule that a
  provider adapter is handed no authority it does not need.

## Context

P5 adds accounts, quotas and switching: which account a packet runs on, how much
of its quota is left, and what happens when it runs out. The roadmap places this
before write permissions on purpose — a control plane that cannot tell one
account from another cannot keep two of them isolated.

Three things make this phase different from its predecessors. The input is a
file the **owner** writes, outside every repository, that names where
credentials live. The output is a **decision** about where work should run. And
neither the file nor the decision may be acted on in P5: this is shadow mode.

## Decision

**One package, one direction, no authority.** `@acp/accounts` owns the owner
file's admission law, the registry, and — from P5B onward — quota estimation,
the router and the switching machine. It is a domain package: it computes and
recommends. It starts nothing, writes nothing and resolves nothing.

### The owner file is read-only, and this package cannot find it

The file at `~/.rottay-agent-control-plane/accounts.local.json` is the owner's,
mode `0600`, never committed and never mirrored into this repository. It is
read; it is never written, moved or created.

**This package holds no default path and reads no environment variable**,
including `HOME`. Every entry point takes the path explicitly, and calling the
loader with nothing is a classified refusal at runtime rather than a type error.

That is a stronger rule than "be careful", and it exists because of what the
weaker version costs. A loader with a default path can be called with no
arguments, and the first thing that will call it with no arguments is a test —
which then reads the owner's real accounts on a developer's machine, passes, and
proves nothing. Hermetic fixtures are only hermetic if reaching the real file
requires naming it.

### Admission is a ladder, and every rung has its own refusal

Absolute → canonical → regular file → owned by this uid → mode exactly `0600` →
size-bounded → parseable → valid. A caller that cannot tell "the file is
missing" from "the file is world-readable" will treat both as "no accounts", and
the second one is an incident.

Two rungs are deliberately stricter than this repository's earlier admissions.
Mode `0600` is required **exactly**, rather than "no group or world write":
elsewhere the concern is that someone else can modify a file, but an owner file
that anyone can *read* has already failed at the only thing it is for. And a
symlink is refused rather than followed, so no rung below the canonical check
can be aimed at a file other than the one that was named.

### The envelope is defined here; the record stays in the contract

`AccountsFile` is `{ contractVersion, accounts: AccountRecord[] }`, strict:
exactly those two keys, and a third is a refusal rather than a field to ignore.
It is defined in `@acp/accounts` because the owner file is this package's
concern — **P5 changes no contract**. The records inside it are validated by
`AccountRecord` from `@acp/contracts`, so the shared shape has exactly one
definition and every consumer gets it at once.

The strictness is implemented in this package rather than delegated to a schema
library, because the package's dependency surface is pinned to `@acp/contracts`
and `@acp/ledger` and the envelope is two keys. The record validation, which is
the part with real structure, comes from the contract.

### A refusal names a path, never a value

The refusal type carries `{ reason, at }` and has no message field. A
validator's message is read to classify it and then **discarded**; the only
thing that leaves is a JSON path this package constructed.

This is the decision the whole package is arranged around. The owner file is the
one document in this system that legitimately names where credentials live, so a
refusal that quoted what it choked on would be the most likely place in the
codebase for material to escape — into a log, a test snapshot, a bug report
pasted into a chat. Making the refusal structurally incapable of carrying a
value is cheaper than auditing every error string forever.

Key names are the case that needs care, because a key name *is* a path and must
be reportable for the refusal to be useful. An unexpected key is named unless it
fails a grammar check or the credential vocabulary in `@acp/contracts`
recognises it as material, in which case it becomes `<key>` at its parent path.
The contract's vocabulary is used rather than a local pattern list: **a second
privacy vocabulary in this package would be one more thing to keep in agreement
with the first**, and the first is the one every other package already trusts.

The corollary is stated so no later reader has to infer it: what that vocabulary
does **not** recognise, this package admits. A shape the guards should refuse is
a change to `@acp/contracts`, made once, where every consumer receives it —
never a local exception here.

### The vocabulary is applied to open-map key names as well as values

Because the contract's traversal does not. `findCredentialViolations` runs its
value patterns over every string *value* and a stem match over every *key*; it
never runs the value patterns over a key name. So a key that is itself
live-credential-shaped satisfies the record's own guard, and `knownLimits` — the
only `z.record` in `AccountRecord`, and therefore the only place a caller
chooses the key — is the one surface where that gap is reachable.

The loader closes it at admission by calling the same function on each of those
keys. This is not a second vocabulary: it is the same function on the same class
of input the *refusal* path already hands it, and the admission path was simply
missing the call. The distinction matters because an admitted record does not
stay here. `AccountRecord` is, by its own definition, the projection allowed in
SQLite, the read model and the UI — so a credential-shaped key admitted in P5A
reaches storage in P5C/P5D and a screen in P8, and the roadmap forbids a secret
entering any of them.

The **traversal** fix belongs in `@acp/contracts`, applied once for every
consumer rather than at each boundary that happens to notice. P5 changes no
contract, so it is **deferred to a future contracts packet** and recorded here;
this call site closes the hole in the meantime.

### Opaque references are carried, never resolved

`authProfileRef` and `credentialRef` are `keychain://`, `profile://` or
`file://` locators. They travel exactly as written and are **never
dereferenced** — not in P5, and not by this package in any later phase. The
material they name stays outside this repository. No credential enters this
repository in any form, at any time.

`isolatedConfigRoot` is shape-checked here and admitted nowhere else. The
directory is admitted by `@acp/adapters` at session start, which is the
component that owns filesystem admission for a session and re-asserts it
immediately before it is used. Two components admitting the same directory at
different times is how a check gets skipped by each in the belief the other did
it.

### Shadow output is never a ledger write

`@acp/ledger` is a dependency because P5D reads quota observations from the
event log. It is **read-only by law**: no production source in this package
contains an append, and the architecture fence scans for it rather than trusting
this sentence.

The switching machine returns candidate events **as values**. A drill that wants
to see them in a log appends them itself, to a disposable shadow ledger, through
the P3 pattern. A domain package that could append would be a package that could
assert a state transition happened, and in this system the ledger is the
authority for that — ADR 0001.

### Dependency direction

`runtime` will consume `@acp/accounts` in P6. **`accounts` never imports
`runtime`.** Runtime orchestrates; accounts is a domain it consults. Recorded
here because the pull in the other direction arrives the moment the switching
machine wants to know whether a session is still alive, and the answer is that
it asks its caller rather than reaching for the orchestrator.

### The UI is deferred to P8

The accounts UI and the `drain` / `account-ready` / `reauth-required` actions
are **deferred to P8 by DT ruling**. P5 ships the read model such a UI would
project — `AccountRecord` plus the router's recommendation — and **no route**,
because a tenth observation route is a change to the frozen observation contract
and that is outside P5's scope.

### STOP law

A quota signal, account state or switching outcome that cannot be expressed
under the frozen 21-type event vocabulary halts the packet and escalates to the
DT. It is never grounds to widen `@acp/contracts`, never grounds to press an
unrelated event type into service, and never grounds for a mid-packet schema
change. This is the same law P3C adopted for the shadow baseline and P4 for the
adapters, and it is restated here because the pressure to break it always
arrives mid-packet, when refusing is hardest.

## Consequences

Good: one place where an account is admitted; a refusal vocabulary that cannot
leak the document it refuses; a domain that can be tested without a provider, a
network or an account, because it starts nothing.

Costs: the owner must pass a path to every entry point, which is less convenient
than a default and is the point. And the registry is only as good as the file —
this package validates shape and admission, and can say nothing about whether an
account still exists at the provider. That question needs a session, and a
session is P6 at the earliest.

**P5A is not P5 completion.** It is the scaffold, the loader and the admission
law; the quota estimator, the router and the switching machine follow in P5B,
P5C and P5D, and P5E closes the phase.

## Not in P5

No product adoption and no cutover. No provider session, no authentication, no
network. No credential resolution of any kind. No write permissions — those are
P6. No certification, which is P8, and no adoption, which is the owner's single
explicit decision at P9.
