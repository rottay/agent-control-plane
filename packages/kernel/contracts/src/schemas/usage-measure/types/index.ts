/**
 * The declared types of the usage measurement vocabularies (P-15 escalón D2, ADR 0105).
 *
 * The two unions, derived from the closed sets in `../index.ts` rather than
 * restated, so a word added to a set is a word of its type (C-D4). Owner law
 * `docs/audit/architecture/index.md` §7.1 puts a resource's type aliases in its type
 * leaf; `result/types/` is the precedent.
 *
 * No runtime cycle: this leaf imports only types, and `../index.ts` imports no value
 * from it.
 */

import type { USAGE_REPORT_KINDS, USAGE_SOURCE_CLASSES } from "../index.js";

/** A measurement source's registered class. */
export type UsageSourceClass = (typeof USAGE_SOURCE_CLASSES)[number];

/** The kind of one usage report. */
export type UsageReportKind = (typeof USAGE_REPORT_KINDS)[number];
