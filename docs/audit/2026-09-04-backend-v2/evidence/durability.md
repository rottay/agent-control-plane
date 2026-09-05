# acp-durability — audit report (snapshot 4569478)

Paths are snapshot-relative to `scratchpad/acp-snapshot`.

## Scores + justification

**Restate encapsulado/reemplazable: 7/10.** The SDK fence is real and it holds. `@restatedev/restate-sdk` appears under an import specifier in exactly five source locations, all inside `packages/edges/durability`: `src/contracts/index.ts:2`, `src/drivers/restate-driver/index.ts:12,18`, `src/drivers/restate-endpoint/index.ts:4,5`, plus that package's own test at `test/drivers/restate-driver/index.test.ts:9,46`. Every other hit in the tree is prose. The gate that pins this (`scripts/check-architecture.mjs:10208-10254`) parses import specifiers rather than scanning substrings, fails if the positive set is empty, and counts decoy files that name the package without importing it, so it cannot pass vacuously. Only `packages/edges/durability/package.json:25` lists the SDK. The result types are shaped so an engine-minted identity has nowhere to land (`src/submit/index.ts:120-123, 173-176, 402-405`). Deductions: thirteen `RESTATE_*` constants sit in the domain, the mode list is declared three times, and the port has no polymorphic consumer, so substitutability has never been exercised.

**Durabilidad y recuperación (engine side): 7/10.** The drills are the strongest evidence in this repository: real pinned server, real endpoint child processes, real `SIGKILL`, with discriminators rather than bare waits and negatives that make the positives mean something. The deductions are about the composed system rather than the engine. No drill kills a daemon in `RESTATE` mode, the spawned server is not detached and nothing reaps it afterwards, the four supported verbs have no production caller, and the digest guard is drilled only on the SQLite lane.

## Findings

**D1 — The daemon's Restate server is orphaned by a daemon SIGKILL, and nothing reaps it.** Class 1.
Evidence: `packages/edges/durability/src/server-handle/index.ts:250-262` spawns the pinned binary with no `detached` and no process group of its own, so a `SIGKILL` to the daemon leaves the child running. The only stop is the unwind resource at `daemon/src/mode-restate/index.ts:326-337`, which runs on graceful shutdown. `recoverStaleLock` (`daemon/src/singleton/index.ts:144-181`) unlinks the pidfile and signals nothing, even though the surviving status document records the server pid (`daemon/src/index.ts:322`). The next start then hits `assertReservedPortsFree` (`daemon/src/lifecycle/index.ts:165-177`), finds ingress 8080 held by the orphan, and refuses. The provenance sweep that reaps orphans exists only in test files (`daemon/test/drills/index.test.ts:353`). No drill covers this: every `mode: "RESTATE"` daemon test uses SIGTERM, and the one SIGKILL-the-daemon drill (`:752`) runs in `SQLITE_SUPERVISOR` with the port check off.
Impact: a hard-killed Restate daemon leaves a live server holding the pinned ports and no supported way to clear it.
Minimal fix: read the server pid from the surviving status document during recovery, verify its identity the way `probeIdentity` already does, and stop it. Add a `RESTATE` daemon-SIGKILL drill asserting the restart succeeds. Phase: next.

**D2 — `RestateDriver` is never constructed in production; four SUPPORTED verbs have no assembled caller.** Class 2.
Evidence: the only non-test `new RestateDriver` is `packages/edges/durability/src/drivers/restate-child/index.ts:480`, the drill child. The daemon's `startRestateMode` builds the object and the gate workflow, then calls `sendAdvance` and `attachAdvance` directly (`packages/entrypoints/daemon/src/mode-restate/index.ts:197-208, 295-303`); it holds no driver. `OrchestrationDriver` appears as a parameter or field type in no `src` file. So the declaration of all four verbs as `SUPPORTED` (`restate-driver/index.ts:749-763`) describes an object the assembled daemon never instantiates. This is the residual half of what ADR 0027 closed: the gate is now hosted on the production endpoint, but nothing in production releases one.
Impact: the capability declaration is a claim about a library, not about the running plane.
Minimal fix: give the daemon a driver instance and route the verbs through it, or restate the capabilities as a property of the endpoint. Phase: next.

**D3 — Engine vocabulary in the domain's `constants` module, and the mode list declared three times.** Class 2, and self-declared.
Evidence: `packages/domains/runtime/src/constants/index.ts` exports the engine's object name (118), its two handler names (121, 124), its state key (133), the SDK and server versions (63, 75), the server pin path and install dir (136, 139), the data-root segment (89), and four port constants; `src/index.ts:115,120-130` re-exports them all. The edge names this honestly: `packages/edges/durability/src/contracts/index.ts:47-53` calls it "split residue" and "owed work". Separately the mode vocabulary is written out three times: `DRIVER_MODES` (`packages/kernel/contracts/src/schemas/durability-plane/index.ts:29`), `DAEMON_MODES` (`packages/entrypoints/daemon/src/lifecycle/index.ts:22-27`), and a bare literal at `daemon/src/status/index.ts:79`.
Impact: a Temporal edge would inherit Restate's service names from the domain or fork the constants module.
Minimal fix: move the object, handler, state-key and version constants into the edge's contracts, leaving ports and data roots behind; derive the two other mode lists from `DRIVER_MODES`. Phase: next.

**D4 — On the Restate lane a resubmission with a changed digest is answered by idempotency replay and never reaches the continuity guard.** Class 2.
Evidence: `deriveInvocation` (`runtime/src/submission/index.ts:137-150`) computes the invocation id from task id and attempt alone; the digest is carried but not hashed in. That id is the `idempotency-key` on every ingress path (`durability/src/submit/index.ts:96, 153, 253, 320`). A second submission for the same task and attempt with a different route, and therefore a different digest, is the same call to the engine, which replays the first answer, so `assertInvocationContinuity` (`runtime/src/core/step-executor/index.ts:123-165`) never runs. The N4 drills that prove the refusal (`daemon/test/drills/execution/index.test.ts:863,909`) build a `SqliteSupervisor` and cover only that lane.
Impact: the caller is told the walk succeeded under its route when the first route ran. The ledger is not corrupted, but the answer is about a different request.
Minimal fix: bind the digest into the derived invocation id, or add a Restate-lane drill that resubmits with a changed route. Phase: next.

**D5 — `RestateDriver.advance()` always throws, so the port's central method is not a substitution point.** Class 3.
Evidence: `restate-driver/index.ts:1010-1028` runs the two continuity guards, then throws `SupervisorError` unconditionally, while the port declares `advance` returns what was appended or null on a replay (`packages/domains/runtime/src/contracts/index.ts:198-201`). Deliberate and documented, but a caller holding the port cannot advance a task without knowing which implementation it holds. The port functions as a conformance schema the suites check with `driverCapabilityMismatches`, not as an interface anything programs against.
Minimal fix: narrow the port to what both drivers honour, or state in it that `advance` is the SQLite lane's one-step form. Phase: later.

**D6 — Cancellation never reaches the provider child, and `SQLITE_SUPERVISOR` cannot cancel at all.** Class 4.
Evidence: `packages/domains/runtime/src/contracts/index.ts:218-224` states the verb cancels the durable invocation, "not a running provider process"; `restate-driver/index.ts:815-820` repeats it and names the missing harness port. `SqliteSupervisor` declares all four verbs `UNSUPPORTED` and refuses each with a typed outcome (`packages/domains/runtime/src/drivers/sqlite-supervisor/index.ts:165-203`), checked field-exactly by the drills. A mechanism to stop a child does exist, wired to lease loss rather than to cancel: `AgentHarness.interrupt` (`packages/edges/providers/src/harness/index.ts:112,163`). Correctly absent and honestly declared, recorded so the product claim is not read wider than the code.

## Drill-by-drill table

| Capability | Subject | What the assertion proves | Gap |
|---|---|---|---|
| Endpoint death, 3 fault points (`drills:1113`) | Real server, real child endpoint, real SIGKILL | Plan completes after restart; full event count, one effect marker, zero duplicate keys, read model rebuilds identically | The effect is the toy marker, not a provider child |
| Server death mid-plan (`drills:1180`) | Real server SIGKILLed while a beat is held on a file handshake | Intent durable and below plan length before the kill; after restart on the same data root, one effect and one append set | Endpoint survives; the daemon does not participate |
| Data-root deletion (`drills:1265`) | Real server, `restate-data` removed | Cache absence classifies `DRIVER_BEHIND` and the ledger replays | — |
| Per-task serialization (`drills:1678,1738`) | One child holding beats, named by task id | Same key: one held invocation after a bounded wait. Different keys: two held at once, both named | Discriminator correct |
| Reattach (`drills:1828,1904,1983,2065,2133,2187`) | Real server; attaching client in its own process, SIGKILLed | Attach answers what a blocking submit answers; a fresh process rebuilds the address from coordinates; two concurrent attaches see one effect; wrong segmentation and never-issued keys refuse untouched; a server killed mid-attach rejects rather than guessing | The endpoint-death case starts a replacement endpoint first |
| Cancel (`drills:2276,2359,2425,2493,2543,2627`) | Real server, real cancel-role child SIGKILLed in the settlement window | Order is measured: `NOT_DONE` yields one cancellation; `DONE` closes the outcome before it; `UNKNOWN` appends nothing; `CHECKPOINTED` refuses with zero engine calls; the crash window leaves an open intent a second cancel settles once | Never interrupts a provider child mid-output |
| Timers (`drills:2777-3034`, `lifecycle:503`) | Real server; G3 SIGKILLs it and restarts on the same data root | Fires once; holds the beat while a second task completes beside it; survives endpoint and server death; scheduling twice is one schedule; malformed duration refused with zero engine calls | The endpoint stays alive in G3, so a timer across a daemon restart is untested |
| Gate and signals (`drills:3179-3553`, `lifecycle:360,430`) | G1 and G2 run on the endpoint `startRestateMode` started | Release-before-park returns at once; a different task reaches CHECKPOINTED while the gate still holds; the ledger head is unchanged in both fields; a keyless second resolve is `409` | Through the verb a duplicate signal replays as `{ok:true}`; only a keyless raw request surfaces the conflict |
| Recovery after SIGKILL, SQLite lane (`runtime/test/pilots/recovery/index.test.ts:207`) | Real child, real SIGKILL at 3 fault points | Restart completes; a third run appends nothing and leaves the head unmoved; one effect marker | Not the Restate lane |
| N-walk concurrency (`leases:904`, `daemon-child:337`, `daemon/src/index.ts:361`) | `startDaemon` and the config door | `RESTATE` with more than one walk refuses at both doors; the cap is four | — |

## Files that would change for Restate→Temporal

- `packages/edges/durability/**`, replaced wholesale.
- `packages/domains/runtime/src/constants/index.ts` and `src/index.ts`, for the thirteen `RESTATE_*` constants and their re-exports.
- `packages/kernel/contracts/src/schemas/durability-plane/index.ts:29`.
- In the daemon: `src/mode-restate/index.ts` entire, plus `src/index.ts:71,361,648,677`, `src/lifecycle/index.ts:22-27`, `src/daemon-child/index.ts:337-341`, `src/status/index.ts:79`, and its `package.json` dependency.
- `scripts/acquire-restate-server.mjs`, `scripts/restate-server.pin.json`, and roughly sixty entries in `scripts/check-architecture.mjs`.
- ADRs 0004, 0005, 0016, 0027.

A Temporal driver **could** implement `OrchestrationDriver` unchanged. Nothing in `DurableInvocation`, `OperationCoordinate`, `StepBeat` or `PostconditionProbe` names an engine concept; the advance handler, cache key and ingress shape all live in the edge, and `RestateCacheState`, `DurableStepContext` and `RestateDriverOptions` were moved out of the domain by P8-T G5. Implementing the port would buy nothing today, because no production code consumes it polymorphically (D2, D5).

## Verified claims that hold

- The SDK-specifier fence claim in `packages/edges/durability/README.md:21` is true, and the gate enforcing it is non-vacuous.
- The daemon owns the server's life on the graceful path: `daemon/test/drills/index.test.ts:906` asserts the exact ten-phase order and that the server pid is dead after SIGTERM.
- An unexpected server death is terminal, never a restart and never a silent failover: exit 70 and a `TERMINAL` status (`daemon/test/drills/index.test.ts:1010`).
- The production endpoint hosts both services (`mode-restate/index.ts:197-208`) and S7 act 2 fails closed when the registry does not list them (`:247-258`).
- No engine-minted invocation id reaches any event, read model, report or receipt (`drills:1084-1090`).
- What is durable across process death is the ledger, not the Restate journal.

## Open questions

1. Is the port precheck the intended operator experience after a Restate daemon is hard-killed, or should recovery reap the recorded server pid?
2. Should a duplicate `signal` through the verb report `{ok:true}`? The source says a second release must not be laundered into success, and the engine's idempotency replay does exactly that.
3. Is a second-engine edge actually planned? If not, D2 and D5 are cheaper to close by narrowing the port than by adding a consumer.
