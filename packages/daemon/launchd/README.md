# The launchd template

A tracked, path-neutral **template**. It is not a working launch agent, and
nothing in this repository installs, loads or copies one.

## What this is

`com.rottay.agent-control-plane.plist.template` is a valid property list exactly
as tracked: its placeholders sit inside `<string>` elements, so `plutil -lint`
accepts the file a reviewer actually reads rather than only a rendered
stand-in. It names no account, no home directory, no repository path and no
machine — every value that would tie it to one is a `{{PLACEHOLDER}}`.

`RunAtLoad` and `KeepAlive` are both `<false/>`, and they are **present** rather
than omitted. launchd defaults `RunAtLoad` to false, but a document that does
not say so no longer states what it does, and inertness on its face is the
entire claim.

Every key that would let launchd start the daemon on its own is refused by
name: `StartInterval`, `StartCalendarInterval`, `WatchPaths`,
`QueueDirectories`, `StartOnMount`, `Sockets`, `MachServices` and
`inetdCompatibility`.

## Rendering

`renderLaunchAgent` is a pure function of a template and a value set: identical
inputs produce a byte-identical document, always. Nothing is stamped, nothing is
read from the environment, and no path is discovered. `writeLaunchAgent` is the
only function that touches the filesystem, and it writes only under
`.acp-local/launchd/`, owner-only, atomically.

The two are separate so that determinism, substitution safety and inertness can
all be proven with no destination existing at all.

## Loading it is a human act, and it is not automated

**No code in this repository invokes `launchctl`, and nothing writes under
`~/Library/LaunchAgents`.** The architecture fence asserts both repository-wide,
and the drills assert it again from inside this package.

If an operator decides to load a rendered agent, they do it themselves, having
read the rendered file first. The command is recorded here **only** so that
"never automated" is a statement about something concrete:

```
# Not run by anything in this repository. An operator types this, or nobody does.
cp .acp-local/launchd/<label>.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist
```

Because `RunAtLoad` is false, even a loaded agent does nothing until it is
started deliberately. There is no step in P2 that performs any of this, and no
P2 gate depends on it having been performed.

## P2E is not adoption, and it does not close P2

Producing an inert artifact is not installing one. **P2E is not P2 completion
in the sense of product adoption**, and no cutover is authorized by anything in
this directory.

It does not close P2 in any other sense either. The roadmap's P2 criterion is a
daemon startable under launchd, and this template's command contract does not
match the daemon that exists: `daemon-child` takes a JSON document as `argv[2]`,
not a config-file path, and no packaged executable bridges them. Pointing
`programPath` at a hand-written wrapper would prove something about that
wrapper, not about this control plane. **P2 stays in progress** until P2F
supplies the missing contract and one disposable launchd lifecycle drill.
