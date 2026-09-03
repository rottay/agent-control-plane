# Metrics baseline for P8 certification

## What this memo is, and the finding that shaped it

The phase plan asks for routing-vs-DT and token/time measurements over the
recorded baseline, pinned by digest. Reconnaissance found that **the recorded
baseline does not exist as durable data**, and this memo does not fabricate it.

The shadow ledger is disposable by design (ADR 0009: measurements live in a
disposable shadow ledger under an ignored root), and the only events carrying
usage figures today are appended by tests. There is no production corpus to
measure because production has not happened — cutover is a separate,
unauthorised step.

So this memo does three separate things and keeps them separate:

1. pins the **measurement machinery** by digest, over a fully frozen chain, so
   every number here is re-derivable byte for byte;
2. reports the **process measurements that are real**, each with its source and
   the HEAD it was computed at;
3. states the four quantitative criteria as a **decision the owner has not yet
   made**, with the three outcomes named.

**The process measurements in section 2 evidence process discipline. They do
not substitute for any of the four quantitative criteria in section 3.** Those
are different claims about different things, and merging them would be the one
dishonest move available here.

## 1. The machinery, pinned by digest

The public path is `buildShadowLedger(name, events)`. It appends exactly the
events it is given, reads the chain back from the ledger rather than from the
input, verifies integrity, measures, rebuilds the read model from the events
alone, measures again, and refuses unless both answers match — which is what
makes the measurement a property of the chain rather than of the run.

### Prerequisites, because the module creates nothing

- The observation package must be built: `pnpm --filter @acp/observation build`.
- The shadow roots must already exist. `observationRootPath` **refuses rather
  than creates** — `ROOT_ABSENT` is the difference between reading what an
  operator put somewhere and inventing a directory to read.
- The ledger name must be fresh. Re-using one is refused:
  `ALREADY_EXISTS: a shadow ledger of that name is already present`. A shadow
  chain is built once.
- The scratch root is cleaned at the end. It is a disposable fixture under the
  ignored `.acp-local/shadow`, and this command says so by removing it.

### The command

Run from the repository root. Every value in the chain is a fixed literal —
event ids, task ids, idempotency keys, instants, identities — so that **all four
digests below are re-derivable without an asterisk**, including the chain digest
that a randomised fixture would legitimately change on every build.

```sh
pnpm --filter @acp/observation build
node --input-type=module -e '
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  OBSERVATION_KINDS, buildShadowLedger, computeBaseline,
  observationRootPath, serializeBaseline, shadowLedgerDirectory,
} from "./packages/observation/dist/index.js";

for (const kind of OBSERVATION_KINDS) mkdirSync(observationRootPath(kind), { recursive: true, mode: 0o700 });
mkdirSync(shadowLedgerDirectory(), { recursive: true, mode: 0o700 });

const TASK_A = "00000000-0000-4000-8000-00000000000a";
const TASK_B = "00000000-0000-4000-8000-00000000000b";
const base = {
  contractVersion: "2.2.0", attempt: 1, emittedBy: "kimi/k3/coordinator/01",
  correlationId: null, causationId: null, fromState: null, payload: {},
};
const chain = [
  { ...base, eventId: "10000000-0000-4000-8000-000000000001", taskId: TASK_A, transitionId: "discover", idempotencyKey: TASK_A + "/1/discover", type: "TASK_DISCOVERED", toState: "DISCOVERED", occurredAt: "2026-08-27T12:00:00.000Z", recordedAt: "2026-08-27T12:00:00.000Z" },
  { ...base, eventId: "10000000-0000-4000-8000-000000000002", taskId: TASK_A, transitionId: "classify", idempotencyKey: TASK_A + "/1/classify", type: "TASK_CLASSIFIED", fromState: "DISCOVERED", toState: "DT_CLASSIFIED", occurredAt: "2026-08-27T12:00:10.000Z", recordedAt: "2026-08-27T12:00:10.000Z", payload: { reason: "routine" } },
  { ...base, eventId: "10000000-0000-4000-8000-000000000003", taskId: TASK_A, transitionId: "step", idempotencyKey: TASK_A + "/1/step", type: "ATOMIC_STEP_COMPLETED", fromState: "DT_CLASSIFIED", toState: "DT_CLASSIFIED", occurredAt: "2026-08-27T12:00:20.000Z", recordedAt: "2026-08-27T12:00:20.000Z", payload: { tokensUsed: 1200 } },
  { ...base, eventId: "10000000-0000-4000-8000-000000000004", taskId: TASK_A, transitionId: "audit", idempotencyKey: TASK_A + "/1/audit", type: "AUDIT_COMPLETED", fromState: "DT_CLASSIFIED", toState: "DT_CLASSIFIED", occurredAt: "2026-08-27T12:00:30.000Z", recordedAt: "2026-08-27T12:00:30.000Z", payload: { verdict: "ACCEPT" } },
  { ...base, eventId: "10000000-0000-4000-8000-000000000005", taskId: TASK_B, transitionId: "discover", idempotencyKey: TASK_B + "/1/discover", type: "TASK_DISCOVERED", toState: "DISCOVERED", occurredAt: "2026-08-27T12:01:00.000Z", recordedAt: "2026-08-27T12:01:00.000Z" },
  { ...base, eventId: "10000000-0000-4000-8000-000000000006", taskId: TASK_B, transitionId: "classify", idempotencyKey: TASK_B + "/1/classify", type: "TASK_CLASSIFIED", fromState: "DISCOVERED", toState: "DT_CLASSIFIED", occurredAt: "2026-08-27T12:01:10.000Z", recordedAt: "2026-08-27T12:01:10.000Z", payload: { reason: "escalated" } },
];

const receipt = buildShadowLedger("p810b-frozen.sqlite", chain);
console.log("chainSha256      " + receipt.snapshot.chainSha256);
console.log("headEventSha256  " + receipt.snapshot.headEventSha256);
console.log("baselineSha256   " + receipt.baselineSha256);
console.log("readModelSha256  " + receipt.snapshot.readModelSha256);
console.log("integrityOk      " + receipt.integrityOk);
console.log("rebuildIdentical " + receipt.rebuildIdentical);
console.log(serializeBaseline(receipt.baseline));
console.log("recomputed identical: " +
  (serializeBaseline(computeBaseline(chain)) === serializeBaseline(receipt.baseline)));

rmSync(join(observationRootPath("scenarios"), ".."), { recursive: true, force: true });
'
```

### The pinned digests

| digest | value |
| --- | --- |
| `chainSha256` | `337379df9ae684eefcdde5263b1536d92c00275e7f4dbbd8ae1e7d5fe898804f` |
| `headEventSha256` | `7219ab12198889ff2e5bfe696849f48cd6afabb466566a3795424c5a71549e69` |
| `baselineSha256` | `f31fb8ec4ca25670d0779c113afd24240aa10f64bd100774f395994a4b6bb40a` |
| `readModelSha256` | `80b3adc5f40f9f11e9926b7fd5080409e6c2ea9e8296c3b05f807df4640b8713` |

`eventCount` 6, `headSequence` 6, `integrityOk` true, `rebuildIdentical` true.

### The measurement itself, printed rather than described

This is `serializeBaseline(receipt.baseline)` verbatim — the exact 424-byte
string that `baselineSha256` hashes. Counting its values in prose would be a
second source of truth that could drift from the first:

```json
{"events":6,"tasks":2,"routing":{"total":2,"byReason":[["escalated",1],["routine",1]]},"tokens":{"events":1,"total":1200},"time":{"totalMs":40000,"byTask":[["00000000-0000-4000-8000-00000000000a",30000,4],["00000000-0000-4000-8000-00000000000b",10000,2]]},"rework":{"total":0,"byTask":[]},"acceptance":{"audits":1,"byVerdict":[["ACCEPT",1]],"terminalOutcomes":[["COMMIT_RECORDED",0],["TASK_CANCELLED",0],["TASK_FAILED",0]]}}
```

### Why the measurement is a property of the chain, already proved

`packages/observation/test/shadow-ledger/index.test.ts` (~152-160) builds the
same synthetic chain twice, in two fresh ledgers, and asserts
`second.baselineSha256 === first.baselineSha256`. Its own comment states the
reason: event ids differ per fixture build, so the *chain* digest legitimately
differs while the *measurement* must not. The serialization carries measures and
task ids, never event ids.

That test is why the frozen chain above is a stronger pin rather than a
different one: freezing the event ids makes `chainSha256` stable too, so all
four values can be pinned instead of three.

## 2. The process measurements that are real

Every figure below was computed at HEAD
**`bdf3f8e50b8ee6d3f52f9bb30f7f41f9c1987048`**, from this repository only. A
later HEAD will produce different counts, which is why each carries the one it
came from rather than being stated as a standing fact.

| measurement | value | how to recompute |
| --- | --- | --- |
| P8 commits (since the P7I close, `2503502`) | **36** | `git rev-list --count 2503502..HEAD` |
| of those, conventional-format subjects | **36 of 36** | `git log --pretty='%s' 2503502..HEAD \| grep -cE '^(feat\|fix\|docs\|test\|chore\|refactor)\('` |
| commits carrying AI attribution | **0** | `git log --pretty='%B' 2503502..HEAD \| grep -icE 'co-authored-by\|generated with'` |
| distinct commit authors | **1** (`davila23 <daniel.avila@rottay.com>`) | `git log --pretty='%an <%ae>' 2503502..HEAD \| sort -u` |
| P8 commit-authorization receipts on file | **31** | `ls .acp-local/p8-*commit-authorization*.md \| wc -l` |
| P8 pre-audit memos | **41** | `ls .acp-local/p8-*preaudit*.md \| wc -l` |
| P8 post-audit memos | **39** | `ls .acp-local/p8-*postaudit*.md \| wc -l` |
| P8 DT adjudications | **31** | `ls .acp-local/p8-*adjudication*.md \| wc -l` |
| P8 write-set arrays in the fence | **36** | parse `*_WRITE_SET` spreads matching `^P8` |
| P8 write-set entries / distinct paths | **374 / 147** | the fence's own fold, recomputed |
| remotes configured | **0** | `git remote \| wc -l` |
| worktrees / branches now | **1 / 1** | `git worktree list`, `git branch` |
| suite at this HEAD | **96 files / 2047 tests, all passing** | `pnpm exec vitest run` |

Two of these deserve a sentence rather than a row.

**Write-set conformance.** Every packet in P8 declared its paths in the fence
before writing them, and each was staged against that array by set equality.
Two deviations occurred and neither was silent: one out-of-set file modified and
self-reported before staging, and one adjudicated widening. Both are on the
record in `.acp-local/`, which is the point — the number that matters is not
"zero incidents" but "zero incidents that were not written down".

**Zero pushes during P8.** No push occurred while the phase ran, and at the
time nothing could: there was no remote and `.githooks/pre-push` refused
unconditionally. That fence was retired by a separate owner ruling on
2026-09-03, after this baseline closed, and replaced by a default-deny
publication hook — so the figure above is a closed historical measurement, not
a claim about the repository today. The fence still verifies the hook's content
digest and that `core.hooksPath` points at it, and now also drives the hook's
whole deny/permit matrix. Structural rather than behavioural, which is the
stronger form.

## 3. The four quantitative criteria — a decision the owner has not made

The acceptance list states them (roadmap, the P8 acceptance section):

> - routing coincide con DT en al menos 95%, sin desacuerdos de seguridad;
> - tokens de coordinación bajan al menos 30%; total no sube más de 10% a igual
>   o mejor calidad;
> - tiempo mediano no empeora más de 10%; objetivo posterior: mejora neta;
> - cero writers concurrentes por worktree y cero writes fuera de scope;
> - cada packet tiene checkpoint o receipt terminal;

The literal state of the first three:

- **The machinery to measure them is landed and proved.** `computeBaseline`
  produces routing totals by reason, token events and totals, per-task time, and
  acceptance by verdict — the four shapes those criteria need. Section 1 pins it
  by digest and the invariance test proves the measurement survives a rebuild.
- **The measurement over production does not exist**, because production does
  not exist. The shadow ledger is disposable by design and only tests append
  usage events today. That is not a gap that was left open; it is what
  pre-cutover means.

This memo does **not** decide whether "machinery landed, measurement absent by
design" satisfies the list. That is the owner's decision at P8-E, and it is
presented here as a decision to take, with three named outcomes:

1. **Accept as scoped** — the criteria are read as satisfied for P8 by landed,
   digest-pinned machinery, with the quantitative measurement deferred to the
   first production window and recorded as owed.
2. **Re-scope** — the four criteria are rewritten to say what is measurable
   before cutover, and the production thresholds move to the phase that has
   production.
3. **Hold P8-E** — certification waits until a real measurement exists, which
   means it waits for cutover, which is currently forbidden.

The last two criteria on that list — zero concurrent writers and out-of-scope
writes, and a checkpoint or receipt per packet — are the process ones, and
section 2 speaks to those directly.

## The digest of this file

A file cannot state its own digest: hashing it would change it, and there is no
fixed point. By standing convention the SHA-256 of this memo is computed after
it is written, reported in the chain (the implementer's report and the DT's
records), and pinned by the P8-10c certification matrix. It is never written
inside this file.
