# Architecture decision records

The decisions this control plane is built on, in the order they were taken.

The corpus is **append-only**. A record is never edited to reflect a later
decision and never renumbered once it lands; a decision that changes gets a new
record whose `Supersedes:` line names the old one, and the old record gains a
matching `Superseded-by:`. That is what makes the corpus a history rather than
a snapshot — reading it in order shows how the system was reasoned about, not
only where it ended up.

Numbers are unique and contiguous, and the architecture fence enforces both.
The rule exists because it was once broken: a topology ADR was commissioned as
0013 while 0013 was already the first write route, and nothing checked. Write
new records from `_template.md`, which carries the required fields.

| # | Record | Status |
|---|---|---|
| 0001 | [Where state authority lives](0001-control-plane-authority.md) | accepted |
| 0002 | [The SQLite event ledger](0002-sqlite-event-ledger.md) | accepted |
| 0003 | [The read-only observation plane](0003-read-only-observation-plane.md) | accepted, amended by 0013 |
| 0004 | [Durability, the supervisor, and the recovery law](0004-durability-and-supervisor.md) | accepted |
| 0005 | [The Restate driver, and what adoption would mean](0005-restate-driver-and-adoption.md) | accepted |
| 0006 | [Daemon process lifecycle](0006-daemon-process-lifecycle.md) | accepted |
| 0007 | [Inert launchd template](0007-launchd-template-and-p2-closure.md) | accepted |
| 0008 | [Packaged entry, config-file contract, and one launchd lifecycle](0008-packaged-entry-and-launchd-lifecycle.md) | accepted |
| 0009 | [Shadow observation boundary, metric mapping, and the STOP law](0009-shadow-observation-boundary.md) | accepted |
| 0010 | [The provider adapter boundary](0010-provider-adapter-boundary.md) | accepted |
| 0011 | [The accounts registry and shadow routing](0011-accounts-registry-shadow-routing.md) | accepted |
| 0012 | [Structural normalization: one topology, mirrored trees](0012-structural-normalization.md) | accepted |
| 0013 | [The plane's first write route](0013-the-first-write-route.md) | accepted |
| 0014 | [Repository topology: five strata, and what may depend on what](0014-repository-topology.md) | accepted, amended by 0015 |
| 0015 | [The topology's package names, restated: 0014 amended, not superseded](0015-topology-nomenclature-restatement.md) | accepted |

Where to start: **0001** for why the ledger is the only authority, **0002** for
what that authority is made of, **0012** and **0014** for how the repository is
shaped, and **0010** for the boundary a new provider crosses.
