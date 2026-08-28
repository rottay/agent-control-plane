# ADR 0008 — Packaged entry, config-file contract, and one launchd lifecycle

- Status: accepted for P2F Stage A
- Date: 2026-08-27
- Extends ADR 0006 (daemon process lifecycle) and ADR 0007 (launchd template).
- **Stage A does not close P2.** The roadmap status moves in Stage B, after the
  lifecycle drill has been reproduced by an independent verifier.

## Context

P2E produced a well-formed inert template and, correctly, did not close P2. The
roadmap criterion is `daemon local y arranque controlado por launchd`, and three
things were missing: the child entry took a JSON document as `argv[2]` rather
than a config-file path, the package exposed no executable, and nothing had ever
been started by launchd.

An operator could have supplied a wrapper. That would have proved something
about their wrapper.

## Decision

### 1. Two self-imposed laws are replaced by two narrow ones

"No package `bin` before P8" (ADR 0006 §11) and "no file invokes `launchctl`"
were **repository-internal placeholders**, adopted when there was no executable
and no drill that needed to start one. They were never the owner's law. The
owner's law — no adoption into real operation before P8 certification and a
separate P9 authorization — is untouched, and a disposable drill that boots its
job out again is not adoption.

They become: exactly one `bin`, `acp-daemon` → `./dist/bin/acp-daemon.js`; and
exactly one file may drive launchd, with exactly the verbs `bootstrap`,
`kickstart`, `print` and `bootout`, on a `com.rottay.acp-drill-` label only.
`load`, `unload`, `enable` and `disable` stay forbidden **everywhere, including
in that file** — those are the verbs that persist.

### 2. The entry takes one positional config path

Not a `--config` flag. The committed template fixes the shape: `Program` is
`PROGRAM_PATH` and `ProgramArguments` is `[PROGRAM_PATH, CONFIG_PATH]`, exactly
two strings, and the validator refuses a third. The artifact already in the
repository dictates the contract, which is what "no caller wrapper" means
concretely — what launchd executes is the built form of a tracked file, with
nothing an operator wrote in between.

The entry stays thin and delegates to the existing `runDaemonChild`.
`daemon-child.ts` keeps its JSON-argv mode, so every P2D drill keeps working and
nothing already verified moves.

### 3. The interpreter is materialized into the ignored artifact

A launchd gui job runs with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Node on this
machine is installed outside that PATH, so a tracked `#!/usr/bin/env node` would
fail at exec and every drill run would hit its own stop condition.

The tracked source therefore keeps the portable shebang — host-specific bytes
never enter a tracked file — and the `build` script rewrites the first line of
the **ignored** `dist/bin/acp-daemon.js` to the building Node's `execPath`, then
sets the executable bit. That is the same legality class as an `.acp-local`
render: the host-specific form exists only in build output.

The alternative, an `EnvironmentVariables` placeholder in the template, was
rejected. It would have reopened the strict reader, the template, `KNOWN_KEYS`
and the nested-dict refusal — a far larger delta for no gain in fidelity.

A preflight executes the built entry under exactly the launchd default PATH and
expects the classified usage exit, so interpreter resolution is proven **before**
any launchctl verb runs.

### 4. The config file is held to the same law as a rendered path

launchd hands the entry one argument, so a file decides everything the daemon
does. It must be absolute, free of `..`, realpath-identical, a regular file,
owned by the current uid, not group- or world-writable, and within a size bound
checked on the `stat` rather than after reading — a bound applied to something
already in memory is not a bound.

Content is validated by the **existing** `parseDaemonChildConfig`. One schema,
not two that can drift. Refusals are classified exit codes (`2` usage, `3` path,
`4` content) and never echo file content.

The entry reads **no environment**. launchd controls the environment of a job it
starts, so an entry that read from it would take instructions from something no
reviewer sees.

### 5. The daemon root resolves from module location, not the working directory

Recorded because it is load-bearing here for the first time: a launchd job's
working directory is whatever the plist says, so a root derived from `cwd` would
move when the job did. It is derived from the module's own location, which is
why the drill can read the daemon's published status from a different process.

### 6. One lifecycle, and nothing survives it

`render → bootstrap → kickstart → ready → bootout`, with four properties that
make it disposable rather than an installation:

- the label is unique per run and prefixed `com.rottay.acp-drill-`, so a
  leftover can always be told from a real agent;
- the plist is bootstrapped **by path** from a disposable root, so nothing
  enters the user's agent directory — asserted by digesting that directory's
  listing before and after;
- `RunAtLoad` stays false, so bootstrapping alone starts nothing and the start
  is an explicit `kickstart` — which is precisely "arranque controlado", and
  means the template's inertness is not weakened to make the drill work;
- `bootout` runs in `finally`, with a prefix-scoped sweep afterwards that parses
  the domain listing for this drill's prefix only and boots out by exact label,
  so it can never touch a job the suite did not create.

Readiness polls the daemon's own published status document under a bounded
deadline. That does not make the observation an authority: the drill is an
outside observer reading a published fact, which is what the document is for. A
fixed sleep would prove timing instead of readiness.

**There is no simulation fallback.** If launchd cannot be driven here, the
honest outcome is to stop and report. A simulated start would recreate the
defect that reopened P2, one layer further in and harder to see the second time.

## Consequences

The lifecycle drill invokes the tool with its verb as a separate argument rather
than as one shell string, so the committed P2E scan for shell-shaped invocations
does not match it — that scan is about command shape, and this is genuinely not
one. The bare-token allowance is granted in the fence instead, narrowly.

The package's closed public surface does not change: the entry is an executable,
not a library export, so the export equality pin holds untouched.

## Compliance

The fence asserts the exact `bin`, the tracked portable shebang, the
materialization and `chmod` in `build`, the single launchd-driving file, its
four permitted verbs, the forbidden persisting verbs everywhere, the disposable
label, `bootout` in a `finally`, the unchanged agent-directory ban, and the
absence of any environment read in the packaged entry.
