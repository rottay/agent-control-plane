/**
 * Classified refusals for the observation boundary.
 *
 * Every refusal carries a code, because a boundary that fails with free text
 * gives a caller nothing to branch on and a test nothing to assert. The codes
 * are the contract; the messages are for humans, and neither ever echoes the
 * content of an admitted artifact.
 */

export type ObservationRefusal =
  // the caller asked for something it may not ask for
  | "PATH_SUPPLIED"
  | "BAD_ARTIFACT_NAME"
  // the path is not what it appears to be
  | "PATH_NOT_ABSOLUTE"
  | "PATH_NOT_CANONICAL"
  | "OUTSIDE_ALLOWLIST"
  // the thing found there is not admissible
  | "ROOT_ABSENT"
  | "NOT_OWNED_FILE"
  | "UNSAFE_PERMISSIONS"
  | "TOO_LARGE";

export class ObservationError extends Error {
  readonly code: ObservationRefusal;

  constructor(code: ObservationRefusal, message: string) {
    super(message);
    this.code = code;
    this.name = "ObservationError";
  }
}

export interface ObservationRefused {
  readonly ok: false;
  readonly reason: ObservationRefusal;
  readonly detail: string;
}

export type ObservationVerdict = { readonly ok: true } | ObservationRefused;

/**
 * Returns the refusal branch precisely, not the union.
 *
 * A helper typed as the whole verdict cannot be returned from a function whose
 * success branch carries more than `ok`, which is every admission in this
 * package. Narrowing here keeps the call sites honest instead of casting.
 */
export function refuse(reason: ObservationRefusal, detail: string): ObservationRefused {
  return { ok: false, reason, detail };
}

export const ADMITTED: ObservationVerdict = { ok: true };
