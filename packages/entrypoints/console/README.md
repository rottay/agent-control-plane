# `@acp/console`

The local operator surface. A browser application that reads the observation
plane through `@acp/protocol` and renders it.

## Scope

This package renders the contract; it defines none of it. Every shape it holds
comes from `@acp/protocol`, and that is its only workspace dependency — the
architecture fence asserts that the package links no ledger and no database
driver anywhere, so browser-safety is a property of the build rather than a
habit of the authors.

Nothing here is adopted into real operation. Adoption is a single explicit
decision that happens after P8 certification and a separate P9 authorization.

## One dependency, and why it is only one

`@acp/protocol` is the only contract the console is allowed to import. It
carries no `node:` builtin, no filesystem access, no database driver and no
reach into the persistence stratum — which is what makes it importable from a
browser bundle at all. The gateway and the CLI may depend on both the protocol
and the ledger package; the console may depend on the protocol alone.

This README names no ledger package either, and that is not squeamishness: the
fence's browser-package law scans **every** file under this package for that
name, README included, because a document is one copy-paste away from a source
file.

Three consequences the console lives with, by design:

- **No absolute path ever crosses.** The ledger's location arrives as a digest
  and a bare file label, never as a path.
- **No event payload ever crosses.** A timeline item carries the event's key
  names and its serialized size. Payload contents are the one part of an event
  the contract does not fix, so they are the one part a browser must not hold.
- **Unknown keys are rejected.** Responses are parsed against strict schemas,
  so a field that appeared server-side fails at the boundary instead of being
  rendered.

## Every route reads, except one deliberate write

The client issues `GET` for every view. It issues exactly one `POST`, and that
is recorded here rather than left to be discovered: recording a roadmap
version, through the gateway's guarded write registrar.

That write carries the bearer token the operator supplies in the interface.
With no token configured the gateway answers `403` — the door is shut by
default, and the console has no way to open it on its own.

## Views

| View | Reads |
| --- | --- |
| `overview-view` | the plane's summary state |
| `tasks-list-view` / `task-detail-view` | the task read model, paged, and one task |
| `workers-list-view` / `worker-detail-view` | the worker read model, paged, and one worker |
| `events-view` | the event stream, paged by cursor |
| `status-view` | pragmas, migrations, head and projection status |
| `integrity-view` | the integrity report, problems included |
| `portfolio-view` | the initiative portfolio |
| `workspace-view` | one initiative's detail |
| `timeline-view` | an initiative's scoped event timeline |
| `agents-view` | an initiative's scoped agent summaries |
| `graph-view` | the initiative's task graph |
| `logs-view` | the observation log surface |
| `accounts-view` | accounts, quota confidence, and the action history |
| `roadmap-document-view` | the stored roadmap document, and the one write |
| `not-found-view` | an unmatched hash route |

Routing is hash-based, so the application is a static bundle with no server-side
route table to keep in sync.

## The live-DOM evidence tools stay test-scope

`jsdom` and `axe-core` are devDependencies, and the fence asserts twice over
that they stay that way: the manifest says they are test-scope, and a separate
law asserts that no file under `src/` names either of them. Both checks are
needed, because nothing else stops a `src/` module importing one and pulling a
DOM implementation and an accessibility engine into the shipped bundle.

## Tests

`pnpm test` runs the `console` project. The suite renders components against a
live DOM and asserts the rendered result, and the parity suite in the gateway
package proves that what this application projects is the server's answer
unchanged — route by route, including ordering, pagination and the absence of
credential-shaped keys.
