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
| 0003 | [The read-only observation plane](0003-read-only-observation-plane.md) | accepted, amended by 0013, 0020 |
| 0004 | [Durability, the supervisor, and the recovery law](0004-durability-and-supervisor.md) | accepted |
| 0005 | [The Restate driver, and what adoption would mean](0005-restate-driver-and-adoption.md) | accepted |
| 0006 | [Daemon process lifecycle](0006-daemon-process-lifecycle.md) | accepted |
| 0007 | [Inert launchd template](0007-launchd-template-and-p2-closure.md) | accepted |
| 0008 | [Packaged entry, config-file contract, and one launchd lifecycle](0008-packaged-entry-and-launchd-lifecycle.md) | accepted |
| 0009 | [Shadow observation boundary, metric mapping, and the STOP law](0009-shadow-observation-boundary.md) | accepted |
| 0010 | [The provider adapter boundary](0010-provider-adapter-boundary.md) | accepted, amended by 0019 |
| 0011 | [The accounts registry and shadow routing](0011-accounts-registry-shadow-routing.md) | accepted |
| 0012 | [Structural normalization: one topology, mirrored trees](0012-structural-normalization.md) | accepted |
| 0013 | [The plane's first write route](0013-the-first-write-route.md) | accepted |
| 0014 | [Repository topology: five strata, and what may depend on what](0014-repository-topology.md) | accepted, amended by 0015 |
| 0015 | [The topology's package names, restated: 0014 amended, not superseded](0015-topology-nomenclature-restatement.md) | accepted |
| 0016 | [A driver declares what it cannot do, and the declaration is checked](0016-driver-capability-declaration.md) | accepted |
| 0017 | [The ledger sequence is the stream, and the only cursor](0017-the-stream-boundary.md) | accepted |
| 0018 | [The submission path elects the route, and the walk still does not](0018-the-submission-path.md) | accepted |
| 0019 | [The owned session lifecycle](0019-the-owned-session-lifecycle.md) | accepted |
| 0020 | [The explicit tool operation](0020-the-explicit-tool-operation.md) | accepted |
| 0021 | [Worktree arbitration](0021-worktree-arbitration.md) | accepted |
| 0022 | [The fenced lease](0022-the-fenced-lease.md) | accepted |
| 0023 | [Many walks, one plane](0023-many-walks-one-plane.md) | accepted |
| 0024 | [Write-set conformance](0024-write-set-conformance.md) | accepted |
| 0025 | [The tool-coordinate claim](0025-the-tool-coordinate-claim.md) | accepted |
| 0026 | [Both doors take the claim](0026-cross-process-tool-effect-arbitration.md) | accepted |
| 0027 | [The production endpoint hosts every service the driver declares](0027-the-production-gate.md) | accepted |
| 0028 | [A resumed stream restates its identity](0028-the-resumed-stream-identity.md) | accepted |
| 0029 | [The lifecycle door recovers what it acts on](0029-the-lifecycle-door.md) | accepted |
| 0030 | [An external audit is a frozen dated record, not an authority](0030-the-audit-record.md) | superseded by 0061 |
| 0031 | [The API cancels through the same operation the CLI does](0031-the-lifecycle-api-door.md) | accepted |
| 0032 | [An engine that answers is not an engine that failed](0032-the-invocation-the-engine-forgot.md) | accepted |
| 0033 | [The daemon records what it spawned, so recovery can prove what to stop](0033-the-daemon-reaps-the-engine-it-started.md) | accepted |
| 0034 | [The instruction channel: what the plane asks a model, and the two transports it may not ask yet](0034-the-instruction-channel.md) | accepted |
| 0035 | [The router reads the usage the ledger recorded](0035-the-router-reads-recorded-usage.md) | accepted |
| 0036 | [A recorded operator action reaches the election](0036-operator-state-reaches-the-election.md) | accepted |
| 0037 | [The switch records only what happened](0037-the-switch-records-only-what-happened.md) | accepted |
| 0038 | [A binding for every account the switch may reach](0038-a-binding-for-every-account-the-switch-may-reach.md) | accepted |
| 0039 | [The checkpoint the walk claims is one it wrote](0039-the-checkpoint-the-walk-claims-is-one-it-wrote.md) | accepted |
| 0040 | [A binding declares the provider it serves](0040-a-binding-declares-the-provider-it-serves.md) | accepted |
| 0041 | [The plane records the pressure a provider reports](0041-the-plane-records-the-pressure-a-provider-reports.md) | accepted |
| 0042 | [The elector reads the pressure the plane recorded](0042-the-elector-reads-the-pressure-the-plane-recorded.md) | accepted |
| 0043 | [A failed execution records what its trail already said](0043-a-failed-execution-records-what-its-trail-already-said.md) | accepted |
| 0044 | [The walk plays a switch it did not decide](0044-the-walk-plays-a-switch-it-did-not-decide.md) | accepted |
| 0045 | [One door records what an account's state became](0045-one-door-records-what-an-accounts-state-became.md) | accepted |
| 0046 | [The switch lands on the account it chose](0046-the-switch-lands-on-the-account-it-chose.md) | accepted |
| 0047 | [The policy decides on what it measures](0047-the-policy-decides-on-what-it-measures.md) | accepted |
| 0048 | [Telemetry reads the route the walk writes](0048-telemetry-reads-the-route-the-walk-writes.md) | accepted |
| 0049 | [One map names what each door answers](0049-one-map-names-what-each-door-answers.md) | accepted |
| 0050 | [A span is parented only where the ledger resolves it](0050-a-span-is-parented-only-where-the-ledger-resolves-it.md) | accepted |
| 0051 | [The policy version pin is data, not code](0051-the-policy-version-pin-is-data.md) | accepted |
| 0052 | [The daemon binds a transport it was given a client for](0052-the-daemon-binds-a-transport-it-was-given-a-client-for.md) | accepted |
| 0053 | [Every API error code is answered by name](0053-every-api-error-code-is-answered-by-name.md) | accepted, amended by 0060 |
| 0054 | [The baseline measures the walk that actually runs](0054-the-baseline-measures-the-walk-that-actually-runs.md) | accepted |
| 0055 | [A vendor endpoint is an edge behind a port](0055-a-vendor-endpoint-is-an-edge-behind-a-port.md) | accepted |
| 0056 | [The registry gains a producer, never a second one](0056-the-registry-gains-a-producer-never-a-second-one.md) | accepted |
| 0057 | [CI runs the gate it can run, and owes the rest](0057-ci-runs-the-gate-it-can-run-and-owes-the-rest.md) | accepted |
| 0058 | [The backend certifies what the fence can compute](0058-the-backend-certifies-what-the-fence-can-compute.md) | accepted |
| 0059 | [The gate's evidence binds to code, never to comments](0059-the-gates-evidence-binds-to-code.md) | accepted |
| 0060 | [No evidence anchor resolves from emptiness or a comment](0060-no-anchor-resolves-from-emptiness-or-a-comment.md) | accepted; mechanism superseded by 0063 |
| 0061 | [The fence admits a living specification, not a frozen record](0061-the-fence-admits-a-living-specification.md) | accepted |
| 0062 | [The gate proves the coverage it runs, and owes the runs it never had](0062-the-gate-proves-the-coverage-it-runs.md) | accepted |
| 0063 | [The extractor reads grammar, not lexical luck](0063-the-extractor-reads-grammar-not-lexical-luck.md) | accepted |
| 0064 | [A restored ledger is a different ledger, and the path digest cannot say so](0064-a-restored-ledger-is-a-different-ledger.md) | accepted |
| 0065 | [Coverage says since when, not whether it was true](0065-coverage-says-since-when-not-whether-it-was-true.md) | accepted |
| 0066 | [The revision digest covers the whole envelope, or it identifies nothing](0066-the-revision-digest-covers-the-whole-envelope.md) | accepted |
| 0067 | [The revision coordinate rides the stream it already has](0067-the-revision-coordinate-rides-the-stream-it-already-has.md) | accepted |

Where to start: **0001** for why the ledger is the only authority, **0002** for
what that authority is made of, **0012** and **0014** for how the repository is
shaped, and **0010** for the boundary a new provider crosses.
