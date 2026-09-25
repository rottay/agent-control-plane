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
| 0067 | [The revision coordinate rides the stream it already has](0067-the-revision-coordinate-rides-the-stream-it-already-has.md) | accepted, §6 amended by 0068, §4 amended by 0072 |
| 0068 | [The fold keeps the highest attempt, and the sidecar reads what is stored](0068-the-fold-keeps-the-highest-attempt-and-the-sidecar-reads-what-is-stored.md) | accepted |
| 0069 | [A tool error is never a success, whatever the transport said](0069-a-tool-error-is-never-a-success-whatever-the-transport-said.md) | accepted |
| 0070 | [One payload-keys projection serves both doors](0070-one-payload-keys-projection-serves-both-doors.md) | accepted |
| 0071 | [The daemon composition root leaves the barrel](0071-the-daemon-composition-root-leaves-the-barrel.md) | accepted |
| 0072 | [The V2 key composes at the contract, and the door reads every supported version](0072-the-v2-key-composes-at-the-contract.md) | accepted |
| 0073 | [Every attempt opens with its own identity, assigned once](0073-every-attempt-opens-with-its-own-identity.md) | accepted |
| 0074 | [The outbox is a store with a version, before it is a queue](0074-the-outbox-is-a-store-with-a-version.md) | accepted |
| 0075 | [Every coordination store names its own incarnation](0075-every-coordination-store-names-its-own-incarnation.md) | accepted |
| 0076 | [An effect is looked up by its logical key, and the contract grows a version to say so](0076-an-effect-is-looked-up-by-its-logical-key.md) | accepted |
| 0077 | [A prompt occurrence is a use, never a blob, and a late answer keeps its origin](0077-a-prompt-occurrence-is-a-use-never-a-blob.md) | accepted |
| 0078 | [A command intention commits with its quarantine, and the contract grows a version to say so](0078-a-command-intention-commits-with-its-quarantine.md) | accepted |
| 0079 | [A known outcome is reused, never redelivered, and a present-invalid word is refused by name](0079-a-known-outcome-is-reused-and-a-present-invalid-word-is-refused-by-name.md) | accepted |
| 0080 | [The producer speaks the V2 coordinate, and the protocol half is delivered](0080-the-producer-speaks-the-v2-coordinate.md) | accepted |
| 0081 | [An artifact is a subject of the registry before its first byte moves](0081-an-artifact-is-a-subject-of-the-registry.md) | accepted |
| 0082 | [A blob lease excludes the second publisher, and no clock releases it](0082-a-blob-lease-excludes-the-second-publisher.md) | accepted |
| 0083 | [A publication names its bytes only after they survive the fsync](0083-a-publication-names-its-bytes-only-after-they-survive-the-fsync.md) | accepted |
| 0084 | [A revision of the new cohort names its envelope by reference, never by digest](0084-a-revision-names-its-envelope-by-reference-never-by-digest.md) | accepted |
| 0085 | [A role resolves from the registry alone, or not at all](0085-a-role-resolves-from-the-registry-alone.md) | accepted |
| 0086 | [An initiative enters by command and by API, and its objective never touches the stream](0086-an-initiative-enters-by-command-and-by-api.md) | accepted |
| 0087 | [A task enters once by its client's key, with its revision and its envelope by reference](0087-a-task-enters-once-by-its-clients-key.md) | accepted |
| 0088 | [A settlement fold never invents a number, and a late report revises, never rewrites](0088-a-settlement-fold-never-invents-a-number.md) | accepted |
| 0089 | [Usage is a declared stream and a measured observation, and the door settles them in the same transaction](0089-usage-is-a-declared-stream-and-a-measured-observation.md) | accepted |
| 0090 | [A usage recorder reports what the adapter already normalized, and restarts never reinvent an epoch](0090-a-usage-recorder-reports-what-the-adapter-normalized.md) | accepted |
| 0091 | [A price interval is published whole by document and version, or not at all](0091-a-price-interval-is-published-whole-by-document-and-version.md) | accepted |
| 0092 | [A price is found inside its pinned catalog version, or named missing, never zero](0092-a-price-is-found-inside-its-pinned-catalog-version.md) | accepted |
| 0093 | [An instruction's content is an ordered list of discriminated blocks, contract v1](0093-an-instructions-content-is-an-ordered-list-of-discriminated-blocks.md) | accepted |
| 0094 | [The task envelope carries the instruction's content, and both doors validate it](0094-the-task-envelope-carries-the-instructions-content.md) | accepted |
| 0095 | [The instruction is resolved on the private side of the adapter boundary, and its prompt occurrence is recorded](0095-the-instruction-is-resolved-on-the-private-side-of-the-adapter-boundary.md) | accepted |
| 0096 | [The API and local legs carry the composed instruction, and the prompt occurrence is closed by construction](0096-the-api-and-local-legs-carry-the-composed-instruction.md) | accepted |
| 0097 | [A result is an ordered list of output blocks under its effect, contract v1](0097-a-result-is-an-ordered-list-of-output-blocks-under-its-effect.md) | accepted |
| 0098 | [An effect records its result by reference, with its outcome, and SUCCEEDED requires it](0098-an-effect-records-its-result-by-reference-with-its-outcome.md) | accepted |
| 0099 | [A transport, a process and an operation are three facts, and output bytes live on the private side](0099-a-transport-a-process-and-an-operation-are-three-facts.md) | accepted |
| 0100 | [An effect answers with a published result and its response occurrence](0100-an-effect-answers-with-a-published-result-and-its-response-occurrence.md) | accepted |
| 0101 | [The Claude adapter speaks the observed CLI](0101-the-claude-adapter-speaks-the-observed-cli.md) | accepted |
| 0102 | [The exceptional producers speak the V2 coordinate](0102-the-exceptional-producers-speak-the-v2-coordinate.md) | accepted |
| 0103 | [A delivery pins the price catalog version it will be valued against](0103-a-delivery-pins-the-price-catalog-version-it-will-be-valued-against.md) | accepted |
| 0104 | [Registry configuration is published through one door that derives its digest](0104-registry-configuration-is-published-through-one-door-that-derives-its-digest.md) | accepted |
| 0105 | [The daemon consumes a recorded task and appends the whole chain](0105-the-daemon-consumes-a-recorded-task-and-appends-the-whole-chain.md) | accepted |
| 0106 | [One canonical-instant authority](0106-one-canonical-instant-authority.md) | accepted |
| 0107 | [A result is read by reference, behind authorization](0107-a-result-is-read-by-reference-behind-authorization.md) | accepted |
| 0108 | [A client reaches its model with a credential it never holds outside the boundary](0108-a-client-reaches-its-model-with-a-credential-it-never-holds-outside-the-boundary.md) | accepted |
| 0109 | [A tool is called only under the schema it was allowed with](0109-a-tool-is-called-only-under-the-schema-it-was-allowed-with.md) | accepted, amended by 0117, 0118 |
| 0110 | [The roadmap-version law runs inside the append](0110-the-roadmap-version-law-runs-inside-the-append.md) | accepted |
| 0111 | [A roadmap version declares its steps, all or none](0111-a-roadmap-version-declares-its-steps-all-or-none.md) | accepted |
| 0112 | [The Claude adapter admits what a capture shows](0112-the-claude-adapter-admits-what-a-capture-shows.md) | accepted, amended by 0114 |
| 0113 | [Two roadmap versions diff by step, read by number](0113-two-roadmap-versions-diff-by-step.md) | accepted |
| 0114 | [The Claude adapter keys a shape by what its captures show](0114-the-claude-adapter-keys-a-shape-by-what-its-captures-show.md) | accepted |
| 0115 | [A step declares its task graph, all or none, and READY is pure](0115-a-step-declares-its-task-graph-and-ready-is-pure.md) | accepted |
| 0116 | [A task changes step only by a recorded link](0116-a-task-changes-step-only-by-a-recorded-link.md) | accepted |
| 0117 | [A tool's output interface is pinned, and structured content is admitted only when its text carries it](0117-a-tool-output-is-pinned-and-carried-only-as-text.md) | accepted |
| 0118 | [A tool server is asked what it serves, and nothing is recorded](0118-a-tool-server-is-asked-what-it-serves-and-nothing-is-recorded.md) | accepted |

Where to start: **0001** for why the ledger is the only authority, **0002** for
what that authority is made of, **0012** and **0014** for how the repository is
shaped, and **0010** for the boundary a new provider crosses.
