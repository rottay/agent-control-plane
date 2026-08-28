/**
 * Classified refusals for the accounts boundary.
 *
 * Every refusal carries a code, because a boundary that fails with free text
 * gives a caller nothing to branch on and a test nothing to assert. The codes
 * are the contract.
 *
 * The `detail` is a **JSON path or a file-shape observation, and never a
 * value**. That is the whole discipline of this file. The owner file is the one
 * document in this system that legitimately names where credentials live, so a
 * refusal that quoted what it choked on would be the single most likely place
 * for material to escape — into a log, a test snapshot, a bug report. The
 * constructor below cannot be handed a value to interpolate, and the loader
 * never passes a validator's message through: it reads a message to classify
 * it, then emits a path it built itself.
 */

export type AccountsRefusal =
  // the caller did not supply what it must
  | "PATH_NOT_SUPPLIED"
  // the path is not what it appears to be
  | "PATH_NOT_ABSOLUTE"
  | "PATH_NOT_CANONICAL"
  // the thing found there is not admissible
  | "OWNER_FILE_ABSENT"
  | "OWNER_FILE_NOT_REGULAR"
  | "OWNER_FILE_NOT_OWNED"
  | "OWNER_FILE_UNSAFE_PERMISSIONS"
  | "OWNER_FILE_TOO_LARGE"
  // the bytes are not an accounts file
  | "OWNER_FILE_NOT_JSON"
  | "OWNER_FILE_UNEXPECTED_KEY"
  | "OWNER_FILE_INVALID"
  | "OWNER_FILE_CREDENTIAL_MATERIAL"
  | "OWNER_FILE_TRANSCRIPT_MATERIAL"
  | "DUPLICATE_ACCOUNT_ID";

/** Every refusal, for the closed-set assertions the tests and fence make. */
export const ACCOUNTS_REFUSALS: readonly AccountsRefusal[] = Object.freeze([
  "DUPLICATE_ACCOUNT_ID",
  "OWNER_FILE_ABSENT",
  "OWNER_FILE_CREDENTIAL_MATERIAL",
  "OWNER_FILE_INVALID",
  "OWNER_FILE_NOT_JSON",
  "OWNER_FILE_NOT_OWNED",
  "OWNER_FILE_NOT_REGULAR",
  "OWNER_FILE_TOO_LARGE",
  "OWNER_FILE_TRANSCRIPT_MATERIAL",
  "OWNER_FILE_UNEXPECTED_KEY",
  "OWNER_FILE_UNSAFE_PERMISSIONS",
  "PATH_NOT_ABSOLUTE",
  "PATH_NOT_CANONICAL",
  "PATH_NOT_SUPPLIED",
]);

export interface AccountsRefused {
  readonly ok: false;
  readonly reason: AccountsRefusal;
  /** A JSON path or a shape observation. Never a value from the file. */
  readonly at: string;
}

/** The JSON path used when a refusal is about the document rather than a field. */
export const ROOT_PATH = "<root>";

export function refuse(reason: AccountsRefusal, at: string): AccountsRefused {
  return Object.freeze({ ok: false as const, reason, at });
}
