/**
 * The value types of the deterministic local auditor (P-16/D1, ADR 0124; decision 239).
 *
 * Its input, the rule vocabulary it reads through contracts' `AuditEvidence`, its
 * refusal union and its outcome: the declarations this concept owns, in the concept's
 * own leaf. A pure type leaf: it declares data, imports only types, and `../index.ts`
 * re-exports every one.
 */

import type { AuditEvidence, ResolvedRoute } from "@acp/contracts";
import type { ArtifactPlane, Ledger } from "@acp/ledger";
import type { AuditOutcome } from "@acp/runtime";

import type { AUDITOR_REFUSALS } from "../index.js";

export type AuditorRefusal = (typeof AUDITOR_REFUSALS)[number];

/** One rule of the closed vocabulary, as contracts' evidence grammar names it. */
export type AuditRule = AuditEvidence["rules"][number]["rule"];

/** The auditor's one construction: the ledger it reads and appends to, and the plane. */
export interface LocalAuditorInput {
  /** The operator ledger: the receipt and verdict rows are read here, and the verdict appended. */
  readonly ledger: Ledger;
  /** The private plane: the receipt and the envelope are read, and the evidence published, through it. */
  readonly plane: ArtifactPlane;
  /** The route the composition elected, held to the intake's resolution by the task reader. */
  readonly route: ResolvedRoute;
  /** The instant source, in the canonical form. Defaults to the wall clock. */
  readonly now?: () => string;
  /** The id source for the artifact and the event. Defaults to a random v4. */
  readonly mintId?: () => string;
}

/** What one audit answered: the phase's outcome, or a refusal by the auditor's own word. */
export type LocalAuditOutcome =
  | Extract<AuditOutcome, { readonly ok: true }>
  | { readonly ok: false; readonly refusal: AuditorRefusal; readonly at: string; readonly word: string | null };
