/**
 * The declared type of the effect outcome vocabulary (P-15 escalón F, ADR 0107).
 *
 * The union, derived from the closed set in `../index.ts` rather than restated, so
 * a word added to the set is a word of its type. `usage-measure/types/` is the
 * precedent (owner law `docs/audit/architecture/index.md` §7.1).
 *
 * No runtime cycle: this leaf imports only types, and `../index.ts` imports no value
 * from it.
 */

import type { EFFECT_OUTCOME_STATUSES } from "../index.js";

/** How one logical effect turned out. */
export type EffectOutcomeStatus = (typeof EFFECT_OUTCOME_STATUSES)[number];
