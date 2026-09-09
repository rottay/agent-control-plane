<!-- Canonical operational authority: docs/ROADMAP.md. This is not the public product roadmap. -->
<h1 align="center">
  <img src="docs/readme/header/index.png" width="1200" alt="Rottay Agent Control Plane — One mission. Many minds. Coordinate the work, choose the right agents, and keep the freedom to change your tools." />
</h1>

<p align="center">
  <strong>Configurable agent teams. Durable work. Technology without lock-in.</strong>
</p>

<p align="center">
  <a href="#the-operating-layer-for-agent-work">Overview</a> ·
  <a href="#your-team-your-rules">Workflows</a> ·
  <a href="#reliability-beyond-the-prompt">Reliability</a> ·
  <a href="#subscriptions-as-a-first-class-resource">Subscriptions</a> ·
  <a href="#an-open-ecosystem-with-clear-boundaries">Ecosystem</a> ·
  <a href="#built-around-real-use-cases">Use cases</a> ·
  <a href="#engineering-behind-the-experience">Engineering</a>
</p>

> **Product vision.** This page describes the system we are building. Named
> alternatives are extension targets, not a claim of universal support; an option
> becomes selectable only with an implemented adapter and a verified compatibility
> profile. The [specification](docs/audit/README.md) defines the contracts and
> acceptance criteria; operational authority remains in canonical repository documentation.

<sub>01 / THE IDEA</sub>

## The operating layer for agent work

### Design the team. Define the rules. Choose the intelligence.

**Agent Control Plane is a local-first, extensible framework for coordinating AI
work across providers, models, accounts and tools.** It connects a goal to a
structured plan, assigns responsibilities, governs execution, collects evidence
and decides when the work is allowed to move forward.

Not just “send this prompt to a model.” **Decide who should do the work, what they
can access, what they must deliver, who verifies it, and what happens next.**

![Work as a team: clear roles, shared context and verified handoffs. Spend with intent: usage, quotas and reset windows. Keep your freedom: stable contracts and replaceable implementations.](docs/readme/benefits/index.png)

The motivation comes from everyday agent-assisted development: several useful
subscriptions, different model strengths, changing quotas, long-running tasks,
and too much coordination spread across terminals and conversations.

The answer is **a backend organized around enduring needs, not vendor names**.
Models and frameworks change. Planning, permissions, context, recovery, budgets
and verification still need an owner. Your workflow should survive those choices.

---

<sub>02 / CONFIGURABLE TEAMS</sub>

## Your team, your rules

### A role is a responsibility — not a permanent model assignment.

Ask [Kimi](https://www.kimi.com/) to clarify requirements,
[Claude Code](https://code.claude.com/docs/en/overview) to implement,
another worker to add tests, and [Codex](https://openai.com/codex/) to review.
Or assign the same responsibilities differently. **The provider, model and account
are configurable for each step**, within the permissions and budget of the plan.

![Example workflow: requirements, implementation, tests and independent review use configurable agents. Review can request clarification, code changes or more tests, or allow the authorized next step. The backend validates transitions.](docs/readme/architecture/index.png)

| Configure each step | What the configuration controls |
|---|---|
| **Responsibility** | Coordinate, investigate, implement, verify, audit or consult |
| **Assignment** | Provider, model/version, transport, eligible account and capability requirements |
| **Instructions and context** | The objective, scoped inputs, reference artifacts and relevant prior decisions |
| **Authority** | Read/write scope, allowed tools, execution environment and required human approvals |
| **Deliverable** | Code, tests, findings, a proposal or another artifact with explicit acceptance criteria |
| **Exit conditions** | Required checks, independent verification, evidence and approval before advancing |
| **Next action** | Continue, request clarification, return for corrections, wait, escalate or stop |
| **Resource policy** | Budget, timeout, retry limits, concurrency and permitted handoff destinations |

**Transitions depend on results, not just sequence.** A failed review might send
work back to implementation; missing coverage might open a testing task; an
ambiguous requirement might return to planning. A passed review advances only
when the configured checks and approvals also pass. Correction loops have limits
and an escalation path.

**Parallel where safe.** Independent investigations or disjoint tasks can run
together. Dependencies, account reservations, write ownership and join conditions
determine when branches may start and when their results can be combined.

**Change the plan without losing its history.** Version assignments and approvals,
compare revisions, and simulate capabilities and estimated consumption before
spending quota. Changing a preference does not silently reassign work already in flight.

> **Agents produce results. The backend validates transitions.**
> A model saying “done” is not proof that tests ran, a reviewer accepted, or a
> commit was authorized.

[Planning and team use cases →](docs/audit/requirements/index.md#2-a--iniciativas-y-planificación) ·
[Execution contracts →](docs/audit/architecture/contracts/index.md)

---

<sub>03 / OPERATIONAL DEPTH</sub>

## Reliability beyond the prompt

### Keep the work coherent when the happy path ends.

The control plane's scope includes the operational machinery around an agent —
not only its reasoning loop.

| Need | Designed behavior | Why it matters |
|---|---|---|
| **Durable execution** | Persist task identity, decisions, checkpoints and outcomes | Long-running work is not tied to one terminal or process |
| **Retries and recovery** | Bounded retries, backoff, timeouts and explicit handling of uncertain side effects | A crash is not permission to repeat a costly or destructive action |
| **Lifecycle control** | Queues, cancellation, signals, timers, reattachment and concurrency within the driver's declared capabilities | Waiting and resuming become governed states, not manual workarounds |
| **Verified handoffs** | Transfer bounded context and artifact references; revalidate destination, permissions and prestate | Continue useful work without treating a provider transcript as the source of truth |
| **Independent quality gates** | Separate implementation from verification; record actual checks, findings and approvals | Advancement follows evidence rather than self-reported success |
| **Context and tools** | Scoped artifacts, tool schemas, allowlists and controlled access to private content | Each worker gets the information and authority its task needs |
| **Live visibility** | Correlated execution events, logs, progress and reconnectable streams | Distinguish active work, waiting, failure and disconnection |
| **Operational control** | Diagnostics, bounded notifications, backup/restore and explicit degraded modes | Failures are actionable, and optional services do not become hidden dependencies |

### Observability that answers useful questions.

Who acted? Which instruction and policy did they receive? What changed? Which
attempt consumed quota? Why was a task retried? Who accepted the result?

The design connects **instruction → routing decision → attempt → effect → result
→ verification**, using stable identifiers and a durable event ledger. Metrics
cover latency, throughput, failures, resource use and consumption. Usage that is
missing or estimated is labeled, not silently counted as zero.

Telemetry is an export of operational evidence, not another authority over the
task. Sensitive prompts and responses belong in access-controlled artifacts;
they do not belong in ordinary browser streams or traces. A telemetry outage
must not stop execution or recovery.

[Observability requirements →](docs/audit/requirements/index.md#7-f--trazabilidad-y-observabilidad) ·
[Recovery and data integrity →](docs/audit/architecture/database/index.md)

---

<sub>04 / SUBSCRIPTION-AWARE BY DESIGN</sub>

## Subscriptions as a first-class resource

### Coordinate the capacity you already pay for.

**Subscription-based coding tools are a primary use case, not an afterthought.**
The aim is to manage permitted subscription interfaces alongside API-key clients
and local models through a common execution contract — without pretending their
authentication, quotas or economics are identical.

![Conceptual capacity policy: an exhausted account waits, an eligible account can receive work, and unknown quota remains unknown. A compatible handoff checkpoints, revalidates and continues. This is not a live usage dashboard.](docs/readme/capacity/index.png)

| Decision | Information the control plane should consider |
|---|---|
| **Which worker fits?** | Role, model capabilities, measured task performance and execution constraints |
| **Which account is eligible?** | Authorized identity, reported quota, existing reservations, account state and data freshness |
| **Wait or hand off?** | Reset windows, deadlines, checkpoint compatibility and permitted alternatives |
| **What did the result cost?** | Input/output/cache usage where reported, retries, failed attempts and reviewers |
| **Is the policy improving?** | Quality, latency and cost per accepted result, with sample size and uncertainty |

Account selection must be explainable. Waiting for renewal, switching to another
authorized account and changing transport are **different actions with different
rules**. A handoff carries the task's identity and verified context; it does not
assume native conversation history transfers between providers.

Subscription allocation, API charges and estimated equivalent cost remain
separate. There is **no silent fallback to a paid API bill**, no invented remaining
quota and no fixed savings claim without a measured workload comparison.

<details>
<summary><strong>Provider permissions and billing boundaries</strong></summary>

A shared contract does not turn a subscription into an unrestricted API key.
Supported use must follow each provider's permitted interfaces and account terms;
authentication can require the operator. Switching accounts is not a mechanism
for bypassing provider limits or restrictions.

For example, [Claude Code's provider policy](https://code.claude.com/docs/en/legal-and-compliance)
distinguishes individual subscription use from third-party products offering
Claude.ai login or routing subscription credentials on users' behalf. Commercial
integrations must use the permitted authentication and billing path. An adapter
must declare those constraints, not hide them behind the common interface.

</details>

[Accounts, quotas and economics →](docs/audit/requirements/index.md#5-d--cuentas-y-economía)

---

<sub>05 / OPEN BY CONTRACT</sub>

## An open ecosystem with clear boundaries

### Use the ecosystem. Keep ownership of your workflow.

<p align="center">
  <a href="https://docs.restate.dev/"><img src="https://img.shields.io/badge/Restate-Durable%20execution-213B38?style=flat-square" alt="Restate — durable execution" /></a>
  <a href="https://docs.temporal.io/"><img src="https://img.shields.io/badge/Temporal-Durable%20execution-213B38?style=flat-square" alt="Temporal — durable execution" /></a><br>
  <a href="https://docs.langchain.com/oss/python/langgraph/overview"><img src="https://img.shields.io/badge/LangGraph-Agent%20graphs-314656?style=flat-square&amp;logo=langgraph&amp;logoColor=white" alt="LangGraph — agent graphs" /></a>
  <a href="https://docs.langchain.com/oss/python/langchain/overview"><img src="https://img.shields.io/badge/LangChain-Agent%20components-314656?style=flat-square&amp;logo=langchain&amp;logoColor=white" alt="LangChain — agent components" /></a><br>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-Tool%20protocol-5A4C45?style=flat-square&amp;logo=modelcontextprotocol&amp;logoColor=white" alt="MCP — tool protocol" /></a>
  <a href="https://opentelemetry.io/"><img src="https://img.shields.io/badge/OpenTelemetry-Observability-5A4C45?style=flat-square&amp;logo=opentelemetry&amp;logoColor=white" alt="OpenTelemetry — observability" /></a>
</p>

These technologies address different parts of the problem. Agent Control Plane
provides the **governance, composition and operational contracts around them**;
it does not attempt to rebuild every workflow engine, retrieval framework or
telemetry platform.

**The table maps needs to integration directions and alternatives. It is not an
installed-plugin or current-support list.**

| Need | Technology choices | Boundary owned by the control plane |
|---|---|---|
| **🧠 Model execution** | [Claude Code](https://code.claude.com/docs/en/overview), [Codex](https://openai.com/codex/), [Kimi](https://www.kimi.com/); API-key and local/self-hosted adapters | Instructions, role, model identity, account eligibility, results, cancellation and usage |
| **↻ Durable orchestration** | [Restate](https://docs.restate.dev/) as the principal integration direction; [Temporal](https://docs.temporal.io/) as an alternative driver target; local [SQLite](https://sqlite.org/) supervisor | Lifecycle, recovery, checkpoints and capability negotiation; no presumed feature parity |
| **⑂ Agent workflows** | Native harness; optional [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview) and [LangChain](https://docs.langchain.com/oss/python/langchain/overview) adapters | Bounded task execution, input/output contracts, authority and budget |
| **🔌 Tools and delegation** | [MCP](https://modelcontextprotocol.io/), native tools; [A2A](https://a2a-protocol.org/latest/) as an external-agent extension | Discovery, schemas, allowlists, delegated scope, receipts and cancellation |
| **📚 Context and retrieval** | Scoped artifacts; optional [LlamaIndex](https://github.com/run-llama/llama_index), retrieval and vector-store adapters | Authorized sources, provenance, context limits, retention and task isolation |
| **◎ Tracing and diagnostics** | [OpenTelemetry](https://opentelemetry.io/) / [OpenInference](https://github.com/Arize-ai/openinference); [Phoenix](https://arize.com/docs/phoenix) as the initial optional backend | Correlated, redacted evidence exported independently of execution |
| **✓ Evaluations and routing** | [Promptfoo](https://www.promptfoo.dev/docs/intro/) and compatible evaluation runners | Versioned datasets, measured results and usage feeding one capability registry and explicit policy revisions |
| **▤ Storage and credentials** | [SQLite](https://sqlite.org/), local artifacts; transactional database, object-store and keychain adapters | Consistency, migrations, identity and opaque credential references |
| **◉ Operator interaction** | CLI and API; console, notifications and optional voice/realtime adapters | The same task semantics, permissions and state across interfaces |

### Complementary tools, not competing control loops.

**Restate or Temporal can own durable orchestration; LangGraph can execute a
bounded agent subtask inside it.** MCP supplies tools. OpenTelemetry and Phoenix
observe. These are compatible responsibilities when their ownership is explicit,
not interchangeable names for the same layer.

The composition contract distinguishes alternatives, delegated work, pipelines
and observers. Preflight must reject competing owners for the same responsibility,
duplicate retry loops, unsupported capabilities or a hidden model fallback that
would bypass routing policy. Two engines may serve separate scopes; they do not
both control recovery for the same run.

**Install only what the use case needs.** A native path remains meaningful without
an external harness or telemetry backend. Unsupported operations fail explicitly;
a simpler local driver must not pretend to provide an advanced engine's guarantees.

> **Replaceable does not mean magically hot-swappable.**
> Selecting an adapter, continuing from a compatible checkpoint and migrating a
> live execution are distinct capabilities. Each requires its own tested contract.

[Integration families →](docs/audit/architecture/integrations/index.md) ·
[Composition and conflict rules →](docs/audit/architecture/integrations/composition/index.md) ·
[Ecosystem comparison →](docs/audit/architecture/integrations/market/index.md)

---

<sub>06 / PRACTICAL OUTCOMES</sub>

## Built around real use cases

### One operating model. Different kinds of work.

| Scenario | What the team is designed to coordinate |
|---|---|
| **Feature delivery** | Clarify the brief, implement a bounded change, assign tests and independent review, then request the authorized next action |
| **Codebase audit or refactor** | Explore read-only, gather evidence, propose changes, and verify them against the original objective |
| **Several initiatives at once** | Separate plans, context and results while sharing eligible capacity; run only compatible work in parallel |
| **Long-running development** | Wait for quota, recover after interruption, or hand off to a compatible worker without rebuilding the project from chat history |
| **Model and policy evaluation** | Compare accepted results, quality, latency and total consumption; propose an explainable routing change with rollback |

The [use-case catalog](docs/audit/requirements/index.md) goes deeper: planning,
execution, recovery, accounts, evaluations, observability, interfaces, security,
installation and extensibility. Each requirement has an owner, a contract and a
falsifiable acceptance criterion. That is the source of product scope, not an
ever-growing collection of integrations.

---

<sub>07 / BUILT TO BE UNDERSTOOD</sub>

## Engineering behind the experience

### Stable contracts at the center. Replaceable implementations at the edges.

| Engineering choice | Purpose |
|---|---|
| **Domain-owned ports and types** | Keep vendor SDKs out of shared contracts; centralize interfaces and enums with their owning concept rather than duplicating them |
| **Declarative boundaries** | Organize modules by responsibility with folder/index entry points; make dependencies visible and prevent circular ownership |
| **Normalized operational data** | Give initiatives, steps, attempts, accounts, reservations and artifacts explicit identities and consistent naming |
| **Ledger and projections** | Preserve authoritative recorded history; distinguish business state from engine journals, telemetry and rebuildable read models |
| **Versioned policy and evidence** | Explain which instruction, capability profile, decision and approval governed each result |
| **Behavioral conformance tests** | Verify real inputs, outputs, failures and side effects, not merely that an adapter implements an interface |
| **Mirror-structured tests** | Keep tests outside production folders while preserving the module structure and clear ownership |

Certification includes instruction delivery, independent verification, crash
recovery, quota exhaustion, concurrent reservations, interrupted streams and tool
failures. It also tests optional integrations **enabled, absent and unavailable**.
An adapter is only as interchangeable as the behavior it proves.

<details>
<summary><strong>Technology foundation</strong></summary>

| Layer | Current implementation technologies |
|---|---|
| Language and contracts | [TypeScript](https://www.typescriptlang.org/), [Node.js](https://nodejs.org/), [Zod](https://zod.dev/) |
| Workspace and local API | [pnpm](https://pnpm.io/), [Fastify](https://fastify.dev/) |
| Persistence and execution | [SQLite](https://sqlite.org/) with WAL, [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), [Restate TypeScript SDK](https://docs.restate.dev/) |
| Console foundation | [React](https://react.dev/), [Vite](https://vite.dev/), [TanStack Query](https://tanstack.com/query), [Radix](https://www.radix-ui.com/), [XYFlow](https://xyflow.com/) |
| Verification | [Vitest](https://vitest.dev/), [ESLint](https://eslint.org/), TypeScript checks, [axe-core](https://github.com/dequelabs/axe-core), [GitHub Actions](https://github.com/features/actions) |

The console is a separate product-design effort. Shared contracts are intended
to give CLI, API and console equivalent semantics; this is not a claim that a
finished dashboard exists. Architectural replaceability applies to deliberate
ports, not to every library in the dependency tree.

</details>

<details>
<summary><strong>Developer setup and operational boundaries</strong></summary>

Requires Node.js 22.17.0 and pnpm 10.26.2.

```sh
pnpm install
git config core.hooksPath .githooks
node scripts/acquire-restate-server.mjs
pnpm check
```

The current Restate server pin supports macOS on Apple Silicon. Check the
[runbook](docs/operations/runbook.md) and [CI workflow](.github/workflows/ci.yml)
for platform-specific coverage. Scripted test fixtures do not consume provider
subscriptions or API calls.

The current surfaces are local-only and have **no product cutover authority**.
Adoption and wider exposure require separate validation and authorization.
Account configuration stays outside repositories at
`~/.rottay-agent-control-plane/accounts.local.json` (mode `0600`); protected
history carries credential references, not secrets. See [Security](SECURITY.md).

</details>

---

## Explore the project

| Understand the product | Inspect the design | Run or contribute |
|---|---|---|
| [Use-case catalog](docs/audit/requirements/index.md) | [Architecture](docs/audit/architecture/index.md) | [Developer runbook](docs/operations/runbook.md) |
| [Product specification](docs/audit/README.md) | [Data model](docs/audit/architecture/database/index.md) | [API reference](docs/api-reference.md) |
| [Ecosystem comparison](docs/audit/architecture/integrations/market/index.md) | [Integration contracts](docs/audit/architecture/integrations/index.md) | [Contributing](CONTRIBUTING.md) |
| [Interaction model](docs/audit/architecture/contracts/interaction/index.md) | [Testing strategy](docs/audit/quality/testing/index.md) | [Security](SECURITY.md) · [License](LICENSE) |

<p align="center">
  <strong>Build around the work. Keep the freedom to change the tools.</strong><br>
  A project by <a href="https://github.com/rottay">Rottay</a>
</p>
