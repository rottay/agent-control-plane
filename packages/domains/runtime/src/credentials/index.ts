import { basename, dirname, isAbsolute, join } from "node:path";

import { ACCOUNTS_REFUSALS, admitOwnerFile, loadAccountsFile } from "@acp/accounts";
import { CONTRACT_VERSION } from "@acp/contracts";

import type { CredentialRefusal, CredentialRequest, CredentialResolution } from "./types/index.js";

export type { CredentialOwnRefusal, CredentialRefusal, CredentialRequest, CredentialResolution } from "./types/index.js";

/**
 * The one credential resolver (P-15 escalón E, ADR 0108; owner authorization C4
 * and decision E-ND-1).
 *
 * **What it reads, and nothing else.** The accounts file, through the accounts
 * loader — so the account's record, its `credentialRef` included, is admitted by
 * the account contract (an `env://` or inline reference never gets this far) — and
 * the one entry that reference names, `file://<name>`, in the owner's credentials
 * file. That file is not configured anywhere: it is the sibling
 * `credentials.local.json` beside the accounts file, derived from that path and
 * never from a second one. Both files climb the owner-file ladder of
 * `@acp/accounts` — absolute, canonical (no symlink), a regular file, owned by this
 * uid, mode exactly `0600`, size-bounded, JSON — and the credentials document is
 * strict: `{ "contractVersion", "credentials" }` and no other key. The resolver
 * reads no environment variable, takes no path but the accounts file's, and writes
 * nothing.
 *
 * **What it answers.** A closure over the admitted value, for the one HTTP client the
 * composition hands it to. The secret necessarily exists as a string in memory to
 * authenticate; the guarantee is that it stays inside this closure and that client's
 * fetch site, and never propagates to the domain, events, persistence, errors or
 * logs (the owner's precision, C4). A refusal carries a closed word and a path that
 * names a file or an entry — never a byte of either file.
 *
 * **The value grammar** (C-E7.1): 1..4096 code units, each in 0x21-0x7E — visible
 * ASCII, no whitespace. Anything else is refused here, before any `Headers` object
 * exists, because a validating library quotes the value it refuses and trims the
 * whitespace it does not.
 *
 * **Not here, by the authorization's boundary:** `keychain://` (unsupported), rotation,
 * several credentials per account, caching, revocation and reservations are P-19's.
 */

/** The only accounts-file name the credentials file may be derived beside (C-E6). */
const ACCOUNTS_FILE_NAME = "accounts.local.json";

/** The credentials file's name: the one sibling, never configured. */
const CREDENTIALS_FILE_NAME = "credentials.local.json";

/** The two keys the credentials document carries, and nothing else. */
const CREDENTIALS_FILE_KEYS: ReadonlySet<string> = new Set(["contractVersion", "credentials"]);

/** An entry name: one path segment of `LocalAuthReference`'s class, bounded, and never `.`/`..`. */
const ENTRY_NAME = /^[A-Za-z0-9._~@-]{1,128}$/;

/** A credential value: visible ASCII only, bounded. */
const CREDENTIAL_VALUE = /^[\x21-\x7E]{1,4096}$/;

/** Every word {@link resolveCredential} may answer with, sorted: its own and the ladder's. */
export const CREDENTIAL_REFUSALS: readonly CredentialRefusal[] = Object.freeze(
  [
    "ACCOUNT_ABSENT",
    "ACCOUNTS_PATH_INVALID",
    "CREDENTIAL_ENTRY_ABSENT",
    "CREDENTIAL_ENTRY_INVALID",
    "CREDENTIAL_NOT_A_SECRET",
    "CREDENTIAL_NOT_DECLARED",
    "CREDENTIAL_REF_INVALID",
    "CREDENTIAL_SCHEME_UNSUPPORTED",
    ...ACCOUNTS_REFUSALS,
  ].sort() as CredentialRefusal[],
);

function refuse(refusal: CredentialRefusal, at: string): CredentialResolution {
  return Object.freeze({ ok: false as const, refusal, at });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A refusal's path under the accounts file: the loader's JSON path, never a value. */
function accountsAt(at: string): string {
  return at === "<root>" ? "accountsFile" : "accountsFile." + at;
}

/**
 * Resolve one account's credential, or refuse it.
 *
 * The accounts file is loaded and the account found; it must declare
 * `LOCAL_CREDENTIAL_FALLBACK`, the stored-credential mode; its reference is judged
 * before the credentials file is touched, so a reference that escapes
 * (`file://../x`, `file://a/b`) is refused without reading the sibling. Then the
 * sibling climbs the ladder, its entry is looked up as an own property
 * (`file://constructor` is absent, not a function) and the value is held to the
 * grammar.
 */
export function resolveCredential(request: CredentialRequest): CredentialResolution {
  const accountsFile = request.accountsFile;
  if (typeof accountsFile !== "string" || !isAbsolute(accountsFile) || basename(accountsFile) !== ACCOUNTS_FILE_NAME) {
    return refuse("ACCOUNTS_PATH_INVALID", "accountsFile");
  }
  const loaded = loadAccountsFile(accountsFile);
  if (!loaded.ok) return refuse(loaded.reason, accountsAt(loaded.at));
  const record = typeof request.accountId === "string" ? loaded.registry.get(request.accountId) : null;
  if (record === null) return refuse("ACCOUNT_ABSENT", "accountId");

  // The account must declare the stored-credential mode (Fable C2): a
  // preauthenticated profile or a device authorization is not a credential this
  // resolver may read, whatever reference its record also carries. The contract
  // makes that mode's reference non-null.
  if (record.authMode !== "LOCAL_CREDENTIAL_FALLBACK") return refuse("CREDENTIAL_NOT_DECLARED", "authMode");
  const ref = record.credentialRef;
  if (ref === null) return refuse("CREDENTIAL_NOT_DECLARED", "credentialRef");
  if (ref.startsWith("keychain://")) return refuse("CREDENTIAL_SCHEME_UNSUPPORTED", "credentialRef");
  if (ref.startsWith("profile://")) return refuse("CREDENTIAL_NOT_A_SECRET", "credentialRef");
  const name = ref.startsWith("file://") ? ref.slice("file://".length) : "";
  if (!ENTRY_NAME.test(name) || name === "." || name === "..") {
    return refuse("CREDENTIAL_REF_INVALID", "credentialRef");
  }

  // Derived, never configured: the admitted accounts file is canonical, so its
  // directory is, and the sibling's own rung refuses a symlinked sibling.
  const credentialsFile = join(dirname(accountsFile), CREDENTIALS_FILE_NAME);
  const admitted = admitOwnerFile(credentialsFile);
  if (!admitted.ok) return refuse(admitted.reason, CREDENTIALS_FILE_NAME);

  const document = admitted.document;
  if (!isRecord(document)) return refuse("OWNER_FILE_INVALID", CREDENTIALS_FILE_NAME);
  for (const key of Object.keys(document)) {
    // A key is file content: it is refused by position, never echoed.
    if (!CREDENTIALS_FILE_KEYS.has(key)) return refuse("OWNER_FILE_UNEXPECTED_KEY", CREDENTIALS_FILE_NAME);
  }
  // The version is compared, never reported (E-ND-11).
  if (!Object.hasOwn(document, "contractVersion") || document["contractVersion"] !== CONTRACT_VERSION) {
    return refuse("OWNER_FILE_INVALID", CREDENTIALS_FILE_NAME + ".contractVersion");
  }
  const section = document["credentials"];
  if (!isRecord(section)) return refuse("OWNER_FILE_INVALID", CREDENTIALS_FILE_NAME + ".credentials");

  const at = "credentials." + name;
  if (!Object.hasOwn(section, name)) return refuse("CREDENTIAL_ENTRY_ABSENT", at);
  const value = section[name];
  if (typeof value !== "string" || !CREDENTIAL_VALUE.test(value)) return refuse("CREDENTIAL_ENTRY_INVALID", at);

  return Object.freeze({ ok: true as const, credential: () => value });
}
