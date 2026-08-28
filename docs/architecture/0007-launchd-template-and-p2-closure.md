# ADR 0007 — Inert launchd template

- Status: accepted for P2E as `P2E_TEMPLATE_READY`. **This ADR does not close P2.**
- Date: 2026-08-27
- Extends ADR 0006 (daemon process lifecycle).
- Superseded on the closure question by **ADR 0008 (P2F)**, which supplies the
  packaged entry and the config-file contract this template's
  `[PROGRAM_PATH, CONFIG_PATH]` shape always implied, and drives one real
  launchd lifecycle. The template itself is unchanged by P2F.

## Scope, stated first

P2E adds a tracked template, a deterministic renderer, a strict validator and
their drills. It installs nothing, loads nothing and copies nothing.
**P2E is not product adoption**, and **no cutover** is authorized by it. The
owner authorizes cutover at P9 and nothing else does.

**P2 remains in progress.** An earlier draft of this ADR closed it, and that was
wrong. The roadmap's P2 criterion is a daemon startable under launchd; what
exists is a well-formed inert template whose command contract does not match the
daemon in this repository — `daemon-child` takes a JSON document as `argv[2]`,
not a config-file path, and no packaged executable bridges the two. An operator
could point `programPath` at their own wrapper, but that proves something about
their wrapper, not about this control plane. Closing P2 on that basis would
certify a capability the repository cannot execute. P2F supplies the missing
contract and one disposable launchd lifecycle drill; the status flips there.

## Decision

### 1. The artifact is a template, and it is inert on its face

The tracked file is path-neutral: no account, home directory, repository path or
machine-specific value appears in it, only placeholders. Because those
placeholders sit inside `<string>` elements, the template is a valid plist
exactly as tracked, so `plutil -lint` checks the artifact a reviewer reads
rather than a rendered substitute.

`RunAtLoad` and `KeepAlive` are present and false. Presence is required rather
than relying on launchd's own default, because a document that omits them no
longer states what it does. Every automatic start trigger is refused by name.

### 2. The validator parses; it does not scan text

This is the load-bearing decision of the phase.

A regular expression over the raw document cannot see structure, and the case
that matters is a duplicate key. A document carrying `RunAtLoad` twice — once
`<false/>`, once `<true/>` — satisfies every substring check, and `plutil -lint`
accepts it outright, because lint permits duplicates and conversion silently
keeps one. launchd then resolves the duplicate by its own rules. A text-based
validator would bless a document whose effective behaviour it never examined.

So `validateTemplate` and `validatePlist` run a small strict reader for the one
fixed shape this package emits: exactly one top-level `<dict>`, a sequence of
`<key>` elements each followed by exactly one value, values limited to string,
boolean and array-of-string. It refuses unparseable or truncated documents
(`MALFORMED_PLIST`), any duplicate key in either order (`DUPLICATE_KEY`), any
key outside the known set, any unexpected value type, and any nested dict. All
policy questions — inertness, forbidden keys, value types — are asked of the
parsed structure.

**Truncation is classified as truncation.** Every cut point of a well-formed
document returns `MALFORMED_PLIST`, including cuts that land inside a tag. An
earlier draft let a mid-tag cut fall through to `UNEXPECTED_VALUE`, which
described a truncated document as a type error; the reader now settles the
end-of-input question before it asks any type question.

### 3. `plutil` runs in tests, never in production

ADR 0006 established exactly two production subprocess sites, each allow-listed
by path and purpose. A validator that shelled out to `plutil` would be a third,
added for a lint — the weakest possible reason to widen the strongest law in the
package.

The system parser is instead used in the drills, where `node:child_process` is
already a permitted test-only import, and one drill asserts that the TypeScript
reader and `plutil -convert json` agree on all six values and both booleans. Two
independent readers that must agree is a stronger claim than one reader checking
itself, and it costs nothing structural.

### 4. Rendering is pure; writing is separate and local-only

`renderLaunchAgent(template, values)` is a pure function. Identical inputs
produce a byte-identical document; nothing is stamped, randomised, read from the
environment or discovered from the filesystem.

Substitution is single pass, and the refusals close the shapes that matter:
`UNKNOWN_PLACEHOLDER`, `MISSING_VALUE`, `UNUSED_VALUE`, `UNSUBSTITUTED`,
`VALUE_REINJECTS`, `VALUE_CONTROL_CHAR`, `VALUE_NOT_XML_SAFE`, `BAD_LABEL`.
`UNUSED_VALUE` earns its place: a value silently dropped because the template
stopped referring to it is how a rendered agent ends up pointing at the wrong
binary while every other check still passes.

`writeLaunchAgent` is the only function that touches the filesystem. It writes
to `.acp-local/launchd/<label>.plist` and nowhere else — the directory is
created `0700` and stat-verified, the file is `0600`, the write is
write-then-rename, and containment is checked after `realpathSync` so a symlink
cannot redirect it. `~/Library/LaunchAgents` is banned repository-wide as a
write target.

### 5. One path law per field, because one blanket rule is wrong

"Must exist, and its realpath must equal the supplied path" is right for a
program and a config and wrong for a log destination: launchd creates those, and
`realpathSync` throws on a path that is not there yet. A single rule would force
operators to pre-create log files or push the implementation into an unstated
exception.

- `programPath`, `configPath`: absolute, no `..`, realpath-identical, exists,
  regular file, owned by the current uid, not group- or world-writable;
  `programPath` additionally owner-executable.
- `workingDirectory`: absolute, no `..`, realpath-identical, exists, is a
  directory, owned, not group- or world-writable.
- `stdoutPath`, `stderrPath`: absolute, no `..`, **may be absent**. The
  containment, symlink and ownership guarantees apply to the parent directory,
  which is what decides where the file can appear; when the file already exists
  it is held to the file rules as well.

A launch agent whose program or directory anyone can rewrite is a persistence
mechanism, which is why `UNSAFE_PERMISSIONS` is a refusal rather than a warning.

The wrong-owner negatives use root-owned system files as fixtures
(`/bin/ls`, `/private/etc/hosts`), so they are deterministic on the pinned
platform and need no privilege. `/private/etc/hosts` rather than `/etc/hosts`
because `/etc` is itself a symlink and would be refused first, for a different
reason.

### 6. P2 closure is recorded only when it is true

`docs/ROADMAP.md` reads `P2_IN_PROGRESS`, and `P2_COMPLETE` stays on the fence's
forbidden list. It leaves that list in **P2F**, after a real launchd lifecycle
drill passes under independent verification — the same standard by which
`P1_COMPLETE` left it at P1 closure, applied honestly rather than early.
`PRODUCT_CUTOVER_AUTHORIZED` and `CUTOVER_AUTHORIZED` never leave it: no phase
status may assert cutover authority.

A status line is the one document a reader cannot check against anything else,
which is exactly why it must not run ahead of the evidence.

## Consequences

The daemon's closed public surface widens by the rendering and validation
functions and their types. That is a rendering surface, not an adoption API:
nothing it exposes installs, loads, copies or schedules anything, and the fence
is updated to the new closed size in the same change so the widening is a
decision rather than a drift.

A diagnostic string in the architecture fence had drifted from the literal it
describes — it still announced P2C while the enforced literal was already P2D.
It is now derived from `ROADMAP_STATUS_LITERAL` rather than restated, because
retyping the value being checked is what made it stale in the first place.

## Compliance

The fence asserts the template's inertness and path-neutrality, the absence of
`node:child_process` under `src/launchd/**`, the closed export set, the
repository-wide ban on automated `launchctl` and on writes under
`~/Library/LaunchAgents`, and the roadmap's closure literal. Prose that a later
phase falsifies is caught by the expired-literal table.
