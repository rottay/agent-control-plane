# acp-accounts — audit report (snapshot 4569478)

## Score + justification

**3 / 10** for "gestión multi-cuenta/cuota, readiness for the owner's goal".

The domain layer is the best-engineered code in this repository: pure, clock-free,
bounded, every absence classified as a named refusal. Judged as a *library*,
`@acp/accounts` is an 8. Judged against the owner's goal — three or four Claude
accounts coordinated, an agent stopped by quota recovering systematically, state
preserved across a switch — it scores a 3, and only because the owner-file loader,
the account-action stream and the isolated-`HOME` credential model are real.

The three load-bearing facts:

1. A daemon binds **exactly one** account for its whole lifetime (F1). There is no
   pool, so there is nowhere for a switch to land.
2. The production quota estimate is **always 100 % remaining** (F2), and it
   overrides the owner's own declared ratio with the more optimistic number.
3. Nothing anywhere converts a provider error into a quota trigger (F4), so
   `decideSwitch` — a correct function — is unreachable in production.

Every switching artefact at HEAD is a value passed between two test files.

## Findings

### F1 — The daemon binds one account; a switch has nowhere to land

**Class 1 (real, blocking).**

`packages/entrypoints/daemon/src/daemon-child/index.ts:68-71` declares
`DaemonExecutionConfig` as one `route` plus one `binding` (singular). The comment
at `:64-66` states the law: "The route arrives RESOLVED: the daemon does not
resolve (D5)." `executionPortFor` at `packages/entrypoints/daemon/src/index.ts:1179-1190`
builds a `Map` with a single entry keyed on `route.accountId`. The execution port
then looks up `bindings.get(admitted.accountId)` at
`packages/edges/providers/src/execution-port/index.ts:617` and answers
`TRANSPORT_UNAVAILABLE` for any other account.

A daemon cannot start a session on account B, because account B has no binary, no
config root and no workdir in scope. `WALK_CONCURRENCY_MAX = 4`
(`packages/entrypoints/daemon/src/scheduler/index.ts:54`) is a plane-wide cap, so
four concurrent walks all consume one subscription with no per-account limit.

**Impact.** The owner's primary economic mechanism is structurally absent, not
merely unwired. Route election happens once, at CLI submission time, before the
process that would need to switch exists.

**Minimal fix.** Widen `DaemonExecutionConfig` to `bindings: readonly {route,
binding}[]` keyed by `accountId`. Election stays outside; the daemon gains only
the *ability* to be handed a second account. **Phase: next.**

### F2 — The production quota estimate is always 100 %, and it overrides the owner

**Class 1 (real, blocking).**

All three production call sites pass an empty observation set:
`packages/entrypoints/cli/src/cli/index.ts:968`,
`packages/entrypoints/gateway/src/accounts/index.ts:168`, and the routing test
fixture. `estimateQuota` sums what it is given
(`packages/domains/accounts/src/quota/index.ts:408-457`), so `used` is zero and
`remainingRatio` is `remaining / limitTokens` = 1.

Executed against the snapshot's own `dist`, with a record declaring
`quotaEstimate.remainingRatio: 0.05`:

```
{ "ok": true, "estimate": { "observedTokensUsed": 0, "observationCount": 0,
  "remainingRatio": 1, "estimatedTokensRemaining": 1000000,
  "confidence": "LOW" } }
```

The gateway then publishes that 1 and discards the owner's 0.05, because line 181
of `gateway/src/accounts/index.ts` prefers the estimate whenever it succeeds. The
comment directly above, at `:163-165`, claims "An estimate over an empty
observation set is refused by the domain rather than returning zero." It is not
refused. The comment describes behaviour the code does not have.

Two consequences follow. The router's `quotaHeadroom`, `reserveMargin` and
`INSUFFICIENT_TOKEN_MARGIN` gate
(`packages/domains/accounts/src/routing/index.ts:858-882`) all measure against a
constant, so the margin rule the roadmap states can never fire. And the console
shows a full account for one the owner marked nearly empty.

**Minimal fix.** Fold `TOKEN_USAGE_RECORDED` per account into `QuotaObservation[]`
and pass it. Until that lands, make the gateway prefer
`record.quotaEstimate.remainingRatio` whenever `observationCount === 0`, and
correct the comment. **Phase: now** for the gateway half.

### F3 — `executeSwitchPlan` records a completed switch that never happened

**Class 1 (real, blocking).**

`decideSwitch` returns eleven ordered `SWITCH_STEPS`
(`packages/domains/accounts/src/switching/index.ts:341-353`) and five candidate
events including `ACCOUNT_SWITCH_COMPLETED` at `:363-366`. The executor
(`packages/domains/runtime/src/switch-executor/index.ts:87-161`) iterates
`plan.events` and appends each one. It never reads `plan.steps` — a repository-wide
grep for `.steps` in production source returns nothing.

So `OPEN_FRESH_SESSION`, `REVALIDATE_AUTHORITY_AND_PRESTATE`, `REHYDRATE_CHECKPOINT`
and `CONTINUE` are strings in a frozen array with no executor, while
`ACCOUNT_SWITCH_COMPLETED` becomes a durable, integrity-verified ledger fact. The
ledger is an append-only record, so a false completion cannot be retracted, only
contradicted.

**Impact.** The most load-bearing event in the multi-account story is the one
least connected to reality. Any consumer folding switch history will conclude
switches succeed 100 % of the time.

**Minimal fix.** Split the plan's events at `SELECT_ACCOUNT`. `executeSwitchPlan`
appends only the prefix through `ACCOUNT_SWITCH_STARTED`; `ACCOUNT_SWITCH_COMPLETED`
is appended by whatever actually opens the session on B, or never.
**Phase: now** — a one-function change that stops writing a false record.

### F4 — No provider signal is classified as quota pressure

**Class 1 (real, blocking).**

All three adapters parse token counts: Claude reads `usage.output_tokens`
(`packages/edges/providers/src/claude/index.ts:109-114`), Codex reads
`thread/tokenUsage/updated` → `last.totalTokens` (`codex/index.ts:316-326`), Kimi
reads `meta.tokensUsed` (`kimi/index.ts:218`). All three classify authentication:
Claude on subtype `auth_required` (`claude/index.ts:177-179`), Kimi on its
JSON-RPC auth code (`kimi/index.ts:307`), Codex on
`account/chatgptAuthTokens/refresh` (`codex/index.ts:137`).

**None classifies quota.** Codex comes closest — `usageLimitExceeded` is in its
variant list at `codex/index.ts:209` — but it becomes the flat state token
`"ERROR_usageLimitExceeded"` (`:373`) and nothing consumes it. Claude turns every
non-auth result subtype into `subtype.toUpperCase()` (`claude/index.ts:213`); its
five-hour rolling window and weekly cap are not parsed at all. Kimi maps every
non-auth error to `"ERROR_" + code`.

A grep for `QUOTA_EXHAUSTED` and `QUOTA_WARNING` across the tree returns only
test files. **Nothing in production can construct a `SwitchTrigger`.** The
fail-closed taxonomy (`switching/index.ts:238-240`, unclassified → no switch) is
correct and is currently a taxonomy over an empty input set.

**Minimal fix.** Add a `quotaPressure` signal kind to the provider contract; map
Codex `usageLimitExceeded` to it first, since that one is already parsed.
**Phase: next.**

### F5 — An operator's DRAIN is invisible to route election

**Class 1 (real, blocking).**

`foldEffectiveState` (`packages/entrypoints/gateway/src/account-actions/index.ts:105-122`)
correctly implements the authority law, and `account_events` is a real append-only
table with UPDATE and DELETE triggers
(`packages/persistence/ledger/src/migrations/index.ts:269-297`). But
`foldEffectiveState` has exactly two consumers, both in the gateway read model
(`gateway/src/accounts/index.ts:11,216`).

The only production election path, `runSubmission`
(`packages/entrypoints/cli/src/cli/index.ts:945-975`), goes
`loadAccountsFile` → `buildRegistry` → `registry.accounts` and never opens the
ledger. `rankAccounts` gates on `record.status` — the owner *file's* value
(`routing/index.ts:798`).

**Impact.** An operator drains an exhausted account through the documented UI,
gets a receipt, sees it marked operator-set in the console, and the next
submission elects that account anyway. This is the systematic-recovery requirement
failing at its one manual escape hatch.

**Minimal fix.** Have the CLI accept `--database`, fold each record's effective
state before building the routing request, and pass the folded status.
**Phase: now.**

### F6 — No cost class, no per-account concurrency, `isolatedConfigRoot` inert

**Class 2 (improvement).**

Three related absences.

`costPerMillionTokens` is validated on every policy entry
(`packages/domains/accounts/src/policy/index.ts:265,293`) but is `null` for all
five shipped models (`policy/capability-policy.json`) and is never read:
`eligible()` at `:435-437` consults only role and transport. There is no cost
class and no "prefer subscription, fall back to API". All five entries declare
`transports: ["CLI_SUBSCRIPTION"]`, so an `API_KEY` request yields
`POLICY_NO_ELIGIBLE_MODEL` even though the kernel knows three transport kinds
(`contracts/src/schemas/execution-boundary/index.ts:29`).

`TaskEnvelope.budget` carries `maxTokens`, `maxWallClockSeconds` and
`reserveTokensForCheckpoint` (`contracts/src/schemas/task-envelope/index.ts:74-79`).
Grepped across the tree, those three fields appear **only in test fixtures**.

`AccountRecord.isolatedConfigRoot` is documented as "Isolated provider
configuration root, so sessions never cross accounts"
(`contracts/src/schemas/account-record/index.ts:91-92`) and has zero non-test
consumers. The daemon uses `execution.binding.configRoot` from a separate
document, so nothing checks the session uses the account's own declared root.
`.claude-home/`, `.codex-home/` and `.kimi-home/` sit in `.gitignore:47-52` and
are named by no code at all.

**Minimal fix.** Cross-check `binding.configRoot === record.isolatedConfigRoot` at
port construction. **Phase: next.**

## Exists / shadow-only / missing

| Capability | Status | Evidence |
| --- | --- | --- |
| Owner-file loader, 9-rung admission, 0600, 256 KiB | **Real** | `accounts/src/registry/index.ts:309-369` |
| Account-action stream (drain/ready/reauth/override) | **Real** | `gateway/src/account-actions/index.ts:140-207` |
| Isolated `HOME` per provider; no credential deref | **Real** | `providers/src/config-root/index.ts:37-41,105-116` |
| `TOKEN_USAGE_RECORDED` production emission | **Real** | `daemon/src/index.ts:599-608` |
| Router (6 terms, margin rule, refusals) | **Shadow** | pure; input is constant (F2) |
| `decideSwitch` (drain / switch / escalate) | **Shadow** | unreachable trigger (F4) |
| Switch executor | **Partial, unsound** | appends only; false completion (F3) |
| Health probe for CLI routes | **Shadow** | returns `UNKNOWN`, `execution-port/index.ts:717-728` |
| Effective state → routing | **Missing** | F5 |
| Per-account quota fold | **Missing** | rollups are byTask/byInitiative only |
| Account pool / reservation / lease on accounts | **Missing** | F1 |
| Cost class, budget enforcement, per-account concurrency | **Missing** | F6 |

## What to build (prioritized)

1. **Per-account usage fold** → `QuotaObservation[]` for `estimateQuota`. Owner:
   `@acp/observation` (add `byAccount` to `computeTokenRollups`; the `accountId`
   is already on the payload and read at `rollups/index.ts:131`).
2. **Account pool in the daemon**: `bindings` plural, keyed by `accountId`. Owner:
   `@acp/daemon`.
3. **Quota-pressure signal** in the provider contract; wire Codex
   `usageLimitExceeded` first. Owner: `@acp/providers`.
4. **Split the switch events**: `ACCOUNT_SWITCH_COMPLETED` only after a session on
   B exists. Owner: `@acp/runtime`.
5. **Fold effective state into election** so DRAIN binds. Owner: `@acp/cli`.
6. **Real switch executor** for `OPEN_FRESH_SESSION` → `REHYDRATE_CHECKPOINT` →
   `CONTINUE`. Owner: `@acp/runtime`.
7. **Reservation / lease on an account** (`ACCOUNT_LEASE_ACQUIRED`,
   `ACCOUNT_LEASE_RELEASED`) so two walks cannot both elect the last of a quota.
   Owner: `@acp/contracts` + `@acp/ledger`.
8. **Cost class** (`SUBSCRIPTION | METERED`) on the policy entry, plus a
   prefer-subscription rule in `eligible()`. Owner: `@acp/accounts`.
9. **Recurrence in the reset calendar** (period + rule), so Claude's five-hour
   window rolls over instead of refusing `RESET_ALREADY_PASSED`. Owner:
   `@acp/contracts`.
10. **Per-account concurrency ceiling** on the record, honoured by the scheduler.
    Owner: `@acp/contracts` + `@acp/daemon`.

## Verified claims that hold

- **"Routing recommends; it does not act."** True and enforced. `rankAccounts` is
  pure, reserves nothing, and the module names neither `Date.now` nor
  `Math.random`.
- **Credentials are never dereferenced.** `buildEnv`
  (`providers/src/config-root/index.ts:105-116`) constructs the environment key by
  key from a three-name allowlist plus one `*_CONFIG_DIR`, and never spreads
  `process.env`. Account B authenticates through its own CLI home. This is the
  right design and it is implemented.
- **The loader has no default path.** `loadAccountsFile(undefined)` returns
  `PATH_NOT_SUPPLIED` at runtime, not a type error (`registry/index.ts:309-312`).
- **An `AUTH_REQUIRED` account cannot publish a quota estimate.** Enforced in the
  contract itself (`account-record/index.ts:109-117`).
- **P7B's drill claim, read precisely.** `accounts/test/pilots/index.test.ts`
  proves seven events append to a real SQLite ledger in order, survive close and
  reopen, pass `verifyIntegrity`, and accept a `CONTINUE` transition. Its own
  header at `:29-33` says the quiet part: "The executor that would append its
  events does not exist yet, so this drill plays that role itself." No session,
  no config root for B, no checkpoint written or hydrated, no provider error.
  The claim "account switch executed as values over a real ledger" is exactly
  true and exactly that narrow.

## Open questions

1. Is the single-account daemon binding a deliberate V2 scope fence, or was the
   pool assumed to arrive with `resolveRoute`? `check-architecture.mjs:3677` says
   "`resolveRoute` is still unwired (B3 owns that)", but it *is* wired through the
   CLI at `cli/index.ts:997`. Which document is stale?
2. The roadmap requires each provider to pass an account-switch drill before
   receiving write permission (`docs/ROADMAP.md:283-285`). Only Claude has an
   execution drill. Do Codex and Kimi currently hold write permission?
3. `limitKey: Object.keys(record.knownLimits)[0] ?? ""` (`cli/index.ts:969`) makes
   the measured limit depend on JSON key order in the owner file, and an empty
   `knownLimits` silently rejects the account with `LIMIT_UNKNOWN`. Is the first
   key intended to be canonical, or should the limit be named per request?
