/**
 * The value types of the evidence root (P-15 escalón D3, ADR 0105; decision 139).
 *
 * The refusal vocabulary's derived union and the outcome: the declarations this
 * concept owns, in the concept's own leaf (owner law
 * `docs/audit/architecture/index.md` §7). A pure type leaf: it declares data and
 * nothing else, and imports only types.
 */

import type { ScenarioRoot } from "../../index.js";
import type { EVIDENCE_ROOT_REFUSALS } from "../index.js";

export type EvidenceRootRefusal = (typeof EVIDENCE_ROOT_REFUSALS)[number];

export type EvidenceRootOutcome =
  | { readonly ok: true; readonly root: ScenarioRoot }
  | {
      readonly ok: false;
      readonly refusal: EvidenceRootRefusal;
      /** The fact the refusal is about. Never the path. */
      readonly at: string;
    };
