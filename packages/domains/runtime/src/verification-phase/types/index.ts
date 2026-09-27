/**
 * The value types of the verification phase (P-16/D1, ADR 0124; decision 238).
 *
 * The coordinate a recorded walk is verified and audited under, the two ports the
 * phase asks, and what each port answers: the declarations this concept owns, in the
 * concept's own leaf (owner law `docs/audit/architecture/index.md` §7). A pure type
 * leaf: it declares data and imports nothing; `../index.ts` re-exports every one.
 *
 * The ports are structural and read the rows themselves: `LedgerPort` is not widened,
 * so the step executor still names four ledger reads and no verification table. The
 * daemon implements both over the operator ledger (the runner and the local auditor);
 * the tests implement them over fakes.
 */

/**
 * The V2 coordinate one phase runs under: the task, its revision and per-revision
 * attempt, and the flat attempt the supervised ids are derived over.
 */
export interface VerificationCoordinate {
  readonly taskId: string;
  readonly revisionNumber: number;
  readonly attemptNumber: number;
  /** The flat attempt (`task_attempt_read_model.legacy_attempt_number`), never the per-revision one. */
  readonly attempt: number;
}

/** A receipt row as the phase needs it: its name and how the run ended. */
export interface RecordedReceipt {
  readonly receiptSha256: string;
  readonly runStatus: "PASS" | "FAIL";
}

/** A verdict row as the phase needs it: its id (the event's) and the verdict. */
export interface RecordedVerdict {
  readonly auditId: string;
  readonly verdict: "ACCEPT" | "ACCEPT_WITH_CORRECTIONS" | "REJECT";
}

/**
 * What one verification run answered: a receipt recorded (`PASS` or `FAIL`), or a
 * refusal by the runner's own word, with nothing recorded.
 */
export type VerifyOutcome =
  | { readonly ok: true; readonly runStatus: "PASS" | "FAIL"; readonly receiptSha256: string }
  | { readonly ok: false; readonly refusal: string; readonly at: string };

/**
 * What one audit answered: a verdict recorded, or a refusal by the auditor's own word,
 * with nothing recorded.
 */
export type AuditOutcome =
  | { readonly ok: true; readonly verdict: RecordedVerdict["verdict"]; readonly auditId: string }
  | { readonly ok: false; readonly refusal: string; readonly at: string };

/**
 * The verifier as the phase asks it: the coordinate's receipts, read from the rows the
 * ledger's door admitted, and one more run.
 */
export interface VerifierPort {
  /** The largest-`verifier_run_id` `PASS` receipt of the coordinate, or null. */
  recordedPass(coordinate: VerificationCoordinate): string | null;
  /** The coordinate's largest-`verifier_run_id` receipt, whatever its status, or null. */
  latest(coordinate: VerificationCoordinate): RecordedReceipt | null;
  /** Run the recorded task's declared checks and record the receipt, or refuse by name. */
  verify(coordinate: VerificationCoordinate): Promise<VerifyOutcome>;
}

/**
 * The auditor as the phase asks it: the verdicts on one receipt, read from the rows
 * the ledger's door admitted, and one more audit.
 */
export interface AuditorPort {
  /** The largest-`auditor_run_id` `ACCEPT` verdict on the receipt, as its audit id, or null. */
  recordedAccept(coordinate: VerificationCoordinate, receiptSha256: string): string | null;
  /** The largest-`auditor_run_id` verdict on the receipt, whatever it says, or null. */
  latest(coordinate: VerificationCoordinate, receiptSha256: string): RecordedVerdict | null;
  /** Audit the receipt and record the verdict, or refuse by name. */
  audit(coordinate: VerificationCoordinate, receiptSha256: string): Promise<AuditOutcome>;
}

/** Both ports, bound together: a recorded walk verifies and audits, or neither. */
export interface VerificationPorts {
  readonly verifier: VerifierPort;
  readonly auditor: AuditorPort;
}
