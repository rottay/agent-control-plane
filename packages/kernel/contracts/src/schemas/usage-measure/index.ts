/**
 * The usage measurement vocabularies — `@acp/contracts` (P-15 escalón D2, ADR 0105).
 *
 * Two closed sets the usage settlement fold has always held (economy §1.1–§1.3.3):
 * the classes a measurement source is registered under, highest precedence first,
 * and the kinds of report a source makes. They were the ledger's, which was their
 * only reader (decision 45). The execution port now names a report's kind — the
 * widened `usage` member of `ExecutionEvent` — and a port shape lives here, while
 * contracts and the providers may not import the ledger. So the sets move down to
 * the one package every consumer can reach, and the ledger re-exports them under the
 * same names: one declaration, and no second authority (decision 137, C-D4).
 *
 * Data only. The derived unions live in the leaf, `./types/index.ts`.
 */

export type { UsageReportKind, UsageSourceClass } from "./types/index.js";

/** Source classes, highest precedence first (economy §1.1, §1.3.3). */
export const USAGE_SOURCE_CLASSES = ["PROVIDER_AUTHORITATIVE", "WRAPPER_MEASURED", "ESTIMATE"] as const;

/** Report kinds (economy §1.2). */
export const USAGE_REPORT_KINDS = ["DELTA", "CUMULATIVE", "CORRECTION"] as const;
