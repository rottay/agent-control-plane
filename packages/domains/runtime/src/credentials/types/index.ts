import type { AccountsRefusal } from "@acp/accounts";

/**
 * The value types of the credential resolver (P-15 escalón E, ADR 0108).
 *
 * A pure type leaf (owner law §7). The admitted answer is a closure, not a field
 * holding the value: the value exists as a string in the resolver's closure and,
 * when called, in the HTTP client's fetch site, and nowhere a caller could
 * serialize, log or persist by holding the resolution itself.
 */

/** The resolver's own refusal words, beside the owner-file ladder's. */
export type CredentialOwnRefusal =
  | "ACCOUNT_ABSENT"
  | "ACCOUNTS_PATH_INVALID"
  | "CREDENTIAL_ENTRY_ABSENT"
  | "CREDENTIAL_ENTRY_INVALID"
  | "CREDENTIAL_NOT_A_SECRET"
  | "CREDENTIAL_NOT_DECLARED"
  | "CREDENTIAL_REF_INVALID"
  | "CREDENTIAL_SCHEME_UNSUPPORTED";

/** Every word the resolver may answer with: its own, and the ladder's for either owner file. */
export type CredentialRefusal = CredentialOwnRefusal | AccountsRefusal;

/**
 * What the resolver is asked: the owner's accounts file, and one account in it.
 *
 * The account's `credentialRef` is read from its record, never supplied beside it,
 * so the reference the resolver follows is the one the owner wrote and the account
 * contract admitted.
 */
export interface CredentialRequest {
  /** The accounts file; the credentials file is derived from its path. */
  readonly accountsFile: unknown;
  /** The account whose `credentialRef` is resolved. */
  readonly accountId: unknown;
}

/**
 * The resolver's answer.
 *
 * Admitted: a closure that returns the credential, for the one HTTP client it is
 * handed to. Refused: a closed word and a path that names a file or an entry,
 * never a byte of either.
 */
export type CredentialResolution =
  | { readonly ok: true; readonly credential: () => string }
  | { readonly ok: false; readonly refusal: CredentialRefusal; readonly at: string };
