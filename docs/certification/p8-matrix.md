# P8 certification matrix

Every criterion in the P8 acceptance list, quoted verbatim from
`docs/ROADMAP.md`, mapped to the evidence that answers it — or marked **OWED**
with the reason. Nothing is filled in.

## What kind of evidence each reference is

Three classes appear below, and they are not equally strong:

- **Committed artefacts** — code, tests, docs, and commit hashes in this
  repository's history. Anyone can check these at any later HEAD.
- **The suite** — `pnpm exec vitest run`, 96 files / 2047 tests at the HEAD this
  matrix was written against.
- **Session records under `.acp-local/`** — briefs, adjudications, audits and
  receipts, each pinned by SHA-256. **These are not committed artefacts.**
  `.acp-local/` is git-ignored, so a reader cannot recover them from history;
  what the digest gives is *mutation detection*, not durability. A pinned digest
  that still matches proves the record has not changed since it was cited. If a
  record were deleted, the digest would prove nothing at all. The P8-E reader
  should know exactly which kind of reference they are holding, which is why
  this paragraph is here rather than in a footnote.

Written at HEAD `9fe72a330485889ccb174818b682481d21d47dec`. Counts and hashes
below are as of that commit.

---

## Block 0 — the three quantitative criteria

> - routing coincide con DT en al menos 95%, sin desacuerdos de seguridad;

| | |
|---|---|
| **Evidence** | The measurement machinery is landed and pinned by digest: `docs/certification/metrics-baseline.md`, SHA-256 `4896b5bbeaf921f5f382dd425c0ec5865246ee4073b0d9ed905ac27fce91b534`. `computeBaseline` produces routing totals by reason; the memo's frozen-chain command re-derives `baselineSha256` `f31fb8ec4ca25670d0779c113afd24240aa10f64bd100774f395994a4b6bb40a` byte for byte. |
| **Status** | **PENDING OWNER DECISION.** The machinery is proved; the production measurement does not exist, because production does not exist. See "What the owner decides". |

> - tokens de coordinación bajan al menos 30%; total no sube más de 10% a igual o
>   mejor calidad;

| | |
|---|---|
| **Evidence** | Same memo. `computeBaseline` emits `tokens: { events, total }`; the pinned baseline records it verbatim. |
| **Status** | **PENDING OWNER DECISION**, same reason. |

> - tiempo mediano no empeora más de 10%; objetivo posterior: mejora neta;

| | |
|---|---|
| **Evidence** | Same memo. `computeBaseline` emits per-task `time` totals; the pinned baseline records it verbatim. |
| **Status** | **PENDING OWNER DECISION**, same reason. |

These three are the *only* criteria in this state. Everything below is answered
or explicitly owed for a stated reason.

---

## Block 1 — process criteria

> - cero writers concurrentes por worktree y cero writes fuera de scope;

| | |
|---|---|
| **Evidence** | Single-writer worktrees enforced by protocol and observable in the record: every cohort worktree carried zero commits and was integrated by the canonical writer. Write-scope is enforced mechanically by `scripts/check-architecture.mjs`: each packet declares a `*_WRITE_SET` array and the staged set is proved equal to it by sorted `diff`. 38 P8 arrays over 378 entries / 149 distinct paths. |
| **Status** | **MET, with two recorded deviations.** One out-of-set file modification (P8-8G packet 2), self-reported before staging and adjudicated; one adjudicated widening (P8-9-3, one path). Both are in the record. The honest claim is not "zero deviations" but "zero deviations that went unrecorded". |

> - cada packet tiene checkpoint o receipt terminal;

| | |
|---|---|
| **Evidence** | 32 `p8-*commit-authorization*.md` receipts under `.acp-local/`; 37 P8 commits from `2503502` to HEAD, all conventional-format, none carrying AI attribution, one author. Every commit in the phase was made against a receipt whose staged-diff digest was verified byte-identical immediately before committing. |
| **Status** | **MET.** |

---

## Block 2 — the complete UI

> - UI completa: portfolio global y workspaces por iniciativa (objetivo,
>   roadmap versionado y editable, hitos y progreso, task graph, agentes
>   activos y acción actual, logs, tokens consumidos/reservados/restantes,
>   confianza de cuota y reset/renovación, errores/bloqueos e historia),
>   overview, task graph, timeline, workers/sessions, routing, cuentas,
>   cuotas, worktrees, leases, write-sets, logs, diffs, gates, auditorías,
>   checkpoints, commits, approvals, errores y recuperación;

| sub-claim | evidence | status |
|---|---|---|
| portfolio + initiative switcher | `87db5de` | MET |
| workspace: objective, versioned editable roadmap | `f9fda2c`, `1cc1fe2`, `f583a7a` | MET |
| task graph, timeline, active agents | `ef085d9`, `94e0ddb` | MET |
| logs, accounts, roadmap document view | `fcd9579` | MET |
| tokens consumed/reserved/remaining, quota confidence, reset | `b203579` | MET |
| errors / blocks / recovery | the views' UNAVAILABLE-first arms and named refusal states | MET |
| loading / empty / degraded / error states | audited live: `graph-view/empty`, `logs-view/empty`, `timeline-view/empty`, `agents-view/stale-degraded`, `workspace-view/confidence-LOW`, `workspace-view/skippedMalformed>0`, `accounts/UNAVAILABLE`, `logs-view/truncated` | MET |
| search / filters | `logs-view` pure filters with URL round-trip; `roadmap-document-view` version select and `?version=` deep link | MET |
| **desktop/mobile visual evidence** | — | **OWED** — see Block 4 |

Live-DOM evidence: 23 AXE-EVIDENCE receipts across 23 distinct surfaces, **zero
violations summed**, from `pnpm exec vitest run --project ui` (`60e1738`).

---

## Block 3 — the binding visual stack

> - stack visual vinculante: React+Vite se mantiene; se adoptan Radix UI
>   primitives, TanStack Query, TanStack Table, TanStack Virtual,
>   `@xyflow/react`, Recharts, Lucide y dnd-kit para el ordenamiento del
>   roadmap; lenguaje visual bespoke tokenizado con CSS custom properties; sin
>   Next.js, sin shadcn copy-paste, sin tema monolítico estilo MUI;

| | |
|---|---|
| **Evidence** | `7e5f3b1` adopts the stack. Present and pinned exactly in `pnpm-workspace.yaml`'s catalog and `packages/ui/package.json`: React 19.2.8 + Vite, `@radix-ui/react-dialog`/`-dropdown-menu`/`-navigation-menu`, `@tanstack/react-query`, `@xyflow/react`. Bespoke tokenised CSS custom properties in `packages/ui/src/styles/components.css`. No Next.js, no shadcn copy-paste, no monolithic theme — the fence's dependency-surface law asserts the UI package's exact dependency set. |
| **Status** | **MET for what is adopted.** TanStack Table, TanStack Virtual, Recharts, Lucide and dnd-kit are **not adopted** — no surface in P8 needed them, and adopting a dependency to satisfy a list rather than a need would be the wrong trade. Recorded as deferred adoption, not as met. |

---

## Block 4 — responsive, keyboard, WCAG AA

> - experiencia responsive desktop/mobile, navegación por teclado, WCAG AA,
>   estados loading/empty/degraded/error, búsqueda/filtros y evidencia visual
>   desktop/mobile;

| sub-claim | evidence | status |
|---|---|---|
| responsive desktop/mobile | This UI's responsive layer is **CSS-only** — zero `matchMedia`/`innerWidth`/`useMediaQuery`/`ResizeObserver` under `packages/ui/src`. In-repo evidence is the selector-join: each surface renders the hooks its media queries select (`data-priority` under 48rem/34rem), asserted in the live-DOM battery, plus the breakpoint declarations themselves. | MET as scoped |
| keyboard navigation | Tab-cycle containment asserted at both edges (Tab on last wraps to first, Shift+Tab on first wraps to last), Escape closes, focus returns to the control that opened each dialog (`756f6da`), live region announces without stealing focus | MET |
| WCAG AA | axe-core pinned to `wcag2a, wcag2aa, wcag21a, wcag21aa`, 23 surfaces, zero violations | MET, minus the named exclusion below |
| loading/empty/degraded/error, search/filters | Block 2 | MET |
| **`color-contrast`** | — | **OWED.** Excluded from the ruleset by name: jsdom applies no external stylesheet and does no compositing, so a verdict would be about the harness, not the interface. |
| **evidencia visual desktop/mobile** | — | **OWED.** The browser bridge does not connect in this environment — a standing result of the phase. Pixel-level sighted evidence at both widths is not obtainable in-repo and is not simulated. |

---

## Block 5 — tests and QA

> - tests unitarios, integración, contratos, E2E y sighted QA sobre los
>   workflows principales — incluyendo portfolio, cambio de iniciativa,
>   edición de roadmap, logs, cuotas y recuperación — sin defectos críticos o
>   mayores abiertos;

Split by word, because these are different claims with different evidence:

| word | evidence | status |
|---|---|---|
| **unitarios** | 96 files / 2047 tests, all passing | MET |
| **integración** | server route suites against real Fastify injection and real ledgers; runtime drills against a real Restate binary; daemon drills spawning real processes | MET |
| **contratos** | the contracts/api-contracts parity suites and the schema round-trip tests; contract version 2.2.0 / API 0.8.0 | MET |
| **E2E** | **In-repo reading, named as such**: the account action end-to-end in live DOM — deliberate confirm → POST → granted receipt announced with its sequence → row refresh from the read endpoint → explicit close — under a fake fetch, not a live server; plus the five operational documents executed verbatim end to end by a genuinely fresh session. This is not browser-driven E2E against a running stack, and is not claimed as such. | MET as scoped |
| **sighted QA** | — | **OWED.** Requires the browser bridge, which does not connect. Not simulated, not approximated. |
| **workflows: portfolio, initiative switch, roadmap edit, logs, quotas, recovery** | each has live-DOM coverage in the battery and an audited surface receipt | MET |
| **sin defectos críticos o mayores abiertos** | Two defects were found *by* this phase's own evidence and closed *within* it: the granted receipt never painted because the dialog closed in the same batch (`60e1738`), and keyboard focus was stranded at the document body when a triggerless controlled dialog closed (`756f6da`). Both were found by writing the assertion first, both were falsified before being trusted. No defect of either class is open. | MET |

---

## Block 6 — operational documentation

> - documentación operativa, troubleshooting, backup/restore, cambio de cuenta,
>   actualización y rollback reproducibles por una sesión fresca;

| | |
|---|---|
| **Evidence** | `bdf3f8e` — `docs/operations/{runbook,troubleshooting,backup-restore,account-switch,update-rollback}.md`. |
| **Status** | **MET, and the "fresh session" clause was tested rather than assumed.** A genuinely fresh session ran the pages verbatim and returned **NOT_REPRODUCIBLE** on five divergences: an undocumented `core.hooksPath` prerequisite, an unframed CLI refusal, an acquisition command that could not acquire, the suite failures those two caused, and three angle-bracket placeholders that the shell parses as redirection. All five were corrected. A second fresh session returned REPRODUCIBLE with one cosmetic overstatement, also corrected. The pages now state their own prerequisites and run from a cold checkout. |

---

## Block 7 — owner acceptance

> - owner acepta explícitamente el producto completo. Esta aceptación certifica el
>   candidato, pero todavía no toca Modern Rescue.

| | |
|---|---|
| **Evidence** | This matrix is the transmittal's source. |
| **Status** | **PENDING BY DESIGN.** It is the P8-E decision and cannot be self-certified. |

---

## Block 8 — the transport-agnostic ruling

> - ruling del owner sobre ejecución y UI transport-agnostic:
> `.acp-local/p8-transport-agnostic-owner-ruling.md`
> (`11c7a81a759034405e652eb8af11cf9aa9bca567cbca64ac16de8c4b0cab1ab4`),
> incorporado a la planificación de P8; su incorporación completa es su
> propio packet de diseño, no este cierre.

| | |
|---|---|
| **Evidence** | The ruling memo's digest **re-verified at this HEAD**: `11c7a81a759034405e652eb8af11cf9aa9bca567cbca64ac16de8c4b0cab1ab4`, matching the roadmap's own pin. Incorporation into planning: `a7be754`. Landed implementation: the owned execution port and resolved-route contract (`de750e4`), initiative scoping and the switch executor (`fd33e6c`), the CLI-subscription binding (`975d238`), the API_KEY surface (`fd3a5c0`), the local/self-hosted surface (`e91460d`). |
| **Status** | **MET as the criterion states it** — incorporated into planning, with the full incorporation explicitly reserved to its own design packet by the criterion's own words. |

---

## Block 9 — the six added acceptance criteria

> - El mismo fixture de conformidad ejecuta a través de al menos un adapter
> `CLI_SUBSCRIPTION` y un adapter `API_KEY` (fake o real), produciendo el
> mismo contrato de eventos/lifecycle normalizado.

| | |
|---|---|
| **Evidence** | `975d238` (CLI subscription providers bound to the execution port) and `fd3a5c0` (API_KEY execution surface), both against the one owned `ModelExecutionPort` with the normalized `ExecutionEvent` superset from `de750e4`. The conformance fixture runs across both. |
| **Status** | **MET.** |

> - Retirar o deshabilitar AI SDK, Restate y el exportador de
> observabilidad, independientemente, deja operativos los caminos de
> fallback documentados.

| | |
|---|---|
| **Evidence** | `bcb3487` (SQLite fallback certification gate for the daemon) and `7730780` (neutral telemetry with the Langfuse boundary optional). The runtime drills prove the Restate path fails closed without failing over on its own — mode is an operator decision, asserted by D4. |
| **Status** | **MET.** |

> - Una actualización de la política de routing cambia el modelo elegible
> elegido sin cambios de código fuente y registra la versión de política
> usada.

| | |
|---|---|
| **Evidence** | `3b54382` — the versioned capability-policy registry in `@acp/accounts`. |
| **Status** | **MET.** |

> - La reconexión de la UI prueba que no hay invocación duplicada y que la
> recuperación tras un reinicio del frontend es correcta.

| | |
|---|---|
| **Evidence** | The live-DOM battery's reconnect drills: unmount + remount with a counting fake fetch shows **zero** re-fires, because no mutation is dispatched on mount; a fresh QueryClient re-reads state from the read endpoint; and `WRITE_CONFLICT` renders as a named state against that exact envelope. The design truth is recorded rather than overclaimed: each confirmed click is deliberately a *new* action in an append-only stream, the in-flight disable is the only same-click dedupe, and a re-confirm after a timeout is two actions by design. |
| **Status** | **MET as scoped, with the design truth stated.** |

> - Las credenciales API y de suscripción aparecen redactadas en eventos,
> checkpoints, logs, trazas y UI.

**The five surfaces, joined in one row:**

| surface | evidence |
|---|---|
| events | the redaction pass over the event producers; the ledger's own credential scanning |
| checkpoints | same pass; checkpoints carry opaque references, never material |
| logs | the scoped logs view renders redacted content; the truncation notice is explicit |
| traces | `7730780` — neutral telemetry; the Langfuse boundary carries no material |
| UI | the bearer token is session-only, module-scoped, never persisted to `localStorage`/`sessionStorage`/URL/cookie (asserted by a call-site-shaped sweep returning zero), never rendered back — the field is `type="password"`, the draft is discarded on arm, and the armed posture says so in words |

Contracts carry `keychain://`, `profile://` or `file://` locators, never material.
The action note rides the same content guards: a credential-shaped note is
refused and never echoed.

| | |
|---|---|
| **Status** | **MET across all five.** |

> - No hay cutover ni participación de Modern Rescue antes de que pasen
> todos los criterios P8 originales más estas adiciones y el owner
> autorice P9 explícitamente.

| | |
|---|---|
| **Evidence** | Structural, not behavioural: **zero remotes configured**, `.githooks/pre-push` refuses unconditionally and the fence verifies both its content digest and that `core.hooksPath` actually points at it. The fence's product-authority scan asserts that no tracked file names a product repository outside a narrow, named exemption list. P9 is recorded as deferred without priority or ETA. |
| **Status** | **MET.** |

---

## What the owner decides at P8-E

Two decisions, and nothing else is held back.

**1. The three quantitative criteria (Block 0).** The machinery is landed and
digest-pinned; the production measurement does not exist because production does
not exist. Whether that satisfies the criteria is not the DT's call, the
auditor's, or this document's. Three outcomes, as framed by the metrics memo:

1. **Accept as scoped** — landed, digest-pinned machinery satisfies P8, with the
   quantitative measurement deferred to the first production window and recorded
   as owed.
2. **Re-scope** — rewrite the three criteria to what is measurable before
   cutover, and move the production thresholds to the phase that has production.
3. **Hold P8-E** — wait for a real measurement, which means waiting for cutover,
   which is currently forbidden.

**2. Explicit acceptance of the complete product** (Block 7), which the criterion
itself says certifies the candidate and still does not touch the product
repository.

### Carried forward, owed and named

- Pixel-level sighted evidence at desktop and mobile widths, and `color-contrast`
  — blocked on the browser bridge, a standing result of the phase.
- Sighted QA over the main workflows — same blocker.
- Runner death: the drill teardowns cover a failure *inside* a run, where hooks
  execute. A hard kill of the test runner runs no hook at all; that path belongs
  to the roadmap's pool/provenance law, not to the teardown packets.
- Deferred stack adoption: TanStack Table, TanStack Virtual, Recharts, Lucide,
  dnd-kit — listed in the criterion, not adopted, because no surface needed them.
