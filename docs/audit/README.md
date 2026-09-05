# Audits

One folder per audit, named `<date>-<subject>/`, pinned to the commit it
examined and never edited after it closes. Read the folder's own `README.md`
first; it says what each document is and in which order to read them.

| Folder | Snapshot | Contents |
| --- | --- | --- |
| `2026-09-04-backend-v2/` | `4569478` | Backend V2 audit report, architecture rubric, use-case catalog, target data model, architecture decision, twelve evidence reports |

Canonical content is what lives inside a dated folder. The flat files that
briefly sat at this level on 2026-09-04 (`2026-09-04-agent-control-plane-*.md`,
`der.md`, `use-cases.md`, `index.md` and the `*-v2-audit-reports/` directory)
are superseded by `2026-09-04-backend-v2/` and must not be reinstated. A
digest-verified copy of that older layout was kept outside the repository while
the change was in flight, and the owner keeps a durable copy of the current
layout in the documentation archive; neither is a restore source.

Historical note, describing the state before this folder was committed: while
these paths were untracked they sat outside every write-set, so the architecture
fence reported each of them and `pnpm check` stayed red. That window closed when
the governance packet added the nineteen paths to the fence's exact write-set,
one literal per file. See `docs/architecture/0030-the-audit-record.md`.
