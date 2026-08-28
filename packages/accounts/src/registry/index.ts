import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { AccountRecord, CONTRACT_VERSION, findCredentialViolations } from "@acp/contracts";

import { ROOT_PATH, refuse } from "../errors.js";
import type { AccountsRefused } from "../errors.js";

/**
 * The owner-file loader and the account registry.
 *
 * The owner file lives outside every repository, is written by the owner, and
 * names where credentials live. This module reads it, admits or refuses it, and
 * builds an in-memory registry. It resolves nothing: `authProfileRef` and
 * `credentialRef` are opaque strings that travel exactly as written and are
 * never dereferenced, in P5 or by this module ever.
 *
 * **No default path, and no environment.** Every entry point takes the path
 * explicitly. This module reads no environment variable — not `HOME`, not
 * anything — and the architecture fence asserts the absence rather than
 * trusting the claim. The owner file's conventional location is written down in
 * the README and in ADR 0011, in prose, where a reader can see it and no code
 * can reach it. A loader that knew a default path would be a loader that could
 * be invoked with no arguments and would then read somebody's real accounts,
 * which is precisely what the tests must never be able to do by accident.
 *
 * **Read-only.** Nothing here writes, creates or removes anything, and the
 * module imports no mutating filesystem call at all.
 */

/**
 * The two keys an accounts file may carry, and nothing else.
 *
 * This is the `AccountsFile` envelope, defined here rather than in
 * `@acp/contracts` because the owner file is this package's concern and P5
 * changes no contract. It is enforced strictly: a third key is a refusal, not a
 * field to ignore. A loader that ignores keys it does not recognize will
 * happily accept a file written for a newer, incompatible shape and then act on
 * half of it.
 *
 * Strictness is implemented here rather than delegated to a schema library
 * because this package's dependency surface is pinned to `@acp/contracts` and
 * `@acp/ledger`; the individual records are validated by the exported
 * `AccountRecord` contract, which is where the shared shape actually lives.
 */
export const ACCOUNTS_FILE_KEYS: readonly string[] = Object.freeze([
  "accounts",
  "contractVersion",
]);

/**
 * An owner file has no business being large.
 *
 * Checked twice: against the stat before the file is opened, and against the
 * bytes actually read. The second check is not redundant — a file can grow
 * between the two — and a size bound that only ever consulted metadata would be
 * a bound on what the filesystem claimed rather than on what was read.
 */
export const ACCOUNTS_FILE_MAX_BYTES = 256 * 1024;

/** The shape of the owner file: the envelope, and the records it carries. */
export interface AccountsFile {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly accounts: readonly AccountRecord[];
}

/** Read-only lookup over the admitted records. */
export interface AccountsRegistry {
  readonly accounts: readonly AccountRecord[];
  readonly accountIds: readonly string[];
  /** The record, or `null`. Never a partial and never a thrown lookup. */
  get(accountId: string): AccountRecord | null;
  byProvider(provider: string): readonly AccountRecord[];
}

export type LoadOutcome =
  | { readonly ok: true; readonly registry: AccountsRegistry }
  | AccountsRefused;

/**
 * The prefixes `@acp/contracts` uses when its guards refuse something.
 *
 * Read to classify, never forwarded. The guard's own message names a reason
 * token rather than a value, but this module still declines to pass it on: the
 * only thing that leaves here is a path this module constructed. Matching on a
 * prefix is what lets a credential violation keep its own refusal code instead
 * of collapsing into a generic invalid-shape answer.
 */
const CREDENTIAL_GUARD_PREFIX = "credential material is forbidden";
const TRANSCRIPT_GUARD_PREFIX = "provider transcript continuity is forbidden";

/**
 * A path segment safe to put in a refusal.
 *
 * Key names come from the file, so a key name is attacker-controlled text: an
 * unexpected key is reported by name because the name *is* the JSON path a
 * reader needs, but a "key" that is really a paragraph of secret material is
 * not going to be echoed on the strength of appearing in the key position.
 *
 * Two filters, and the second is the one that matters. The grammar rejects a
 * key that is long or punctuated enough to be smuggling prose. It does **not**
 * reject a bare provider-key shape, which is a perfectly ordinary-looking
 * identifier and also a credential — so the contract's own credential
 * vocabulary is consulted on the segment as well. That vocabulary is used
 * rather than a local pattern list on purpose: a second privacy vocabulary in
 * this package would be one more thing to keep in agreement with the first.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]{1,64}$/;

function safeSegment(segment: string): string {
  if (!SAFE_SEGMENT.test(segment)) return "<key>";
  return findCredentialViolations(segment).length === 0 ? segment : "<key>";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build a JSON path from a base and a validator's path array. */
function jsonPath(base: string, path: readonly PropertyKey[]): string {
  let out = base;
  for (const piece of path) {
    if (typeof piece === "number") {
      out += "[" + String(piece) + "]";
    } else {
      out += (out === "" ? "" : ".") + safeSegment(String(piece));
    }
  }
  return out === "" ? ROOT_PATH : out;
}

interface ValidatorIssue {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly path?: unknown;
  readonly keys?: unknown;
}

/** How seriously a mapped issue should be reported, highest first. */
const SEVERITY: readonly string[] = Object.freeze([
  "OWNER_FILE_CREDENTIAL_MATERIAL",
  "OWNER_FILE_TRANSCRIPT_MATERIAL",
  "OWNER_FILE_UNEXPECTED_KEY",
  "OWNER_FILE_INVALID",
]);

/**
 * Turn one validator issue into a classified refusal.
 *
 * The issue's message is inspected and discarded; the issue's `path` supplies
 * structure and never content. There is no branch in this function that can
 * place a value in the result.
 */
function mapIssue(issue: ValidatorIssue, base: string): AccountsRefused {
  const path = Array.isArray(issue.path) ? (issue.path as readonly PropertyKey[]) : [];
  const at = jsonPath(base, path);

  if (issue.code === "unrecognized_keys") {
    const keys = Array.isArray(issue.keys) ? issue.keys : [];
    const first = keys.length > 0 ? safeSegment(String(keys[0])) : "<key>";
    return refuse("OWNER_FILE_UNEXPECTED_KEY", (at === ROOT_PATH ? "" : at + ".") + first);
  }
  if (typeof issue.message === "string") {
    if (issue.message.startsWith(CREDENTIAL_GUARD_PREFIX)) {
      return refuse("OWNER_FILE_CREDENTIAL_MATERIAL", at);
    }
    if (issue.message.startsWith(TRANSCRIPT_GUARD_PREFIX)) {
      return refuse("OWNER_FILE_TRANSCRIPT_MATERIAL", at);
    }
  }
  return refuse("OWNER_FILE_INVALID", at);
}

/**
 * Report the most serious issue rather than the first one.
 *
 * Validators emit issues in their own order, and a credential violation that
 * happened to sit behind a missing-field complaint would otherwise be reported
 * as a shape problem. The ranking is fixed, so the answer is deterministic for
 * a given file.
 */
function worstIssue(issues: readonly ValidatorIssue[], base: string): AccountsRefused {
  let worst: AccountsRefused | null = null;
  let worstRank = SEVERITY.length;
  for (const issue of issues) {
    const mapped = mapIssue(issue, base);
    const rank = SEVERITY.indexOf(mapped.reason);
    const effective = rank === -1 ? SEVERITY.length : rank;
    if (worst === null || effective < worstRank) {
      worst = mapped;
      worstRank = effective;
    }
  }
  return worst ?? refuse("OWNER_FILE_INVALID", base === "" ? ROOT_PATH : base);
}

/** Validate the envelope and every record it carries. */
function validateAccountsFile(parsed: unknown): LoadOutcome {
  if (!isRecord(parsed)) {
    return refuse("OWNER_FILE_INVALID", ROOT_PATH);
  }

  for (const key of Object.keys(parsed)) {
    if (!ACCOUNTS_FILE_KEYS.includes(key)) {
      return refuse("OWNER_FILE_UNEXPECTED_KEY", safeSegment(key));
    }
  }
  if (!Object.hasOwn(parsed, "contractVersion")) {
    return refuse("OWNER_FILE_INVALID", "contractVersion");
  }
  if (parsed["contractVersion"] !== CONTRACT_VERSION) {
    // The version is compared, never reported: a mismatched value is still a
    // value out of the file.
    return refuse("OWNER_FILE_INVALID", "contractVersion");
  }
  const accounts = parsed["accounts"];
  if (!Array.isArray(accounts)) {
    return refuse("OWNER_FILE_INVALID", "accounts");
  }

  const admitted: AccountRecord[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < accounts.length; index += 1) {
    const base = "accounts[" + String(index) + "]";
    const outcome = AccountRecord.safeParse(accounts[index]);
    if (!outcome.success) {
      return worstIssue(outcome.error.issues as readonly ValidatorIssue[], base);
    }
    const record = outcome.data;

    // The contract's vocabulary, applied to open-map key names — because the
    // contract's own traversal does not.
    //
    // `findCredentialViolations` runs its value patterns over every string
    // *value* and a stem match over every *key*. It never runs the value
    // patterns over a key name, so a key that is itself live-credential-shaped
    // passes the record's own guard. `knownLimits` is the only `z.record` in
    // `AccountRecord` and therefore the only place a caller chooses the key, so
    // it is the only place that gap is reachable.
    //
    // This is the same function on the same class of input the refusal path
    // already hands it — `safeSegment` has always called it on key names — so
    // no second privacy vocabulary appears here. The admission path was simply
    // missing the call its own refusal path was already making, and an admitted
    // record flows onward into SQLite, the read model and eventually the UI.
    //
    // The traversal fix belongs in `@acp/contracts`, once, for every consumer.
    // P5 changes no contract, so it is deferred to a contracts packet and this
    // call site closes the hole meanwhile.
    for (const key of Object.keys(record.knownLimits)) {
      if (findCredentialViolations(key).length > 0) {
        return refuse(
          "OWNER_FILE_CREDENTIAL_MATERIAL",
          base + ".knownLimits." + safeSegment(key),
        );
      }
    }

    if (seen.has(record.accountId)) {
      // The id is structure, not content: it is the key the registry is
      // addressed by, and it is bounded by the contract.
      return refuse("DUPLICATE_ACCOUNT_ID", base + ".accountId");
    }
    seen.add(record.accountId);
    admitted.push(record);
  }

  return { ok: true, registry: buildRegistry(admitted) };
}

/**
 * Build a registry over already-validated records.
 *
 * A `Map` rather than an object, deliberately: an object index lookup reaches
 * inherited members, so an account asking for `toString` or `constructor` would
 * be answered with a function. A lookup that can be walked off the end of is
 * not a lookup.
 */
export function buildRegistry(accounts: readonly AccountRecord[]): AccountsRegistry {
  const frozen = Object.freeze([...accounts]);
  const byId = new Map<string, AccountRecord>();
  for (const record of frozen) byId.set(record.accountId, record);

  return Object.freeze({
    accounts: frozen,
    accountIds: Object.freeze(frozen.map((record) => record.accountId)),
    get(accountId: string): AccountRecord | null {
      return byId.get(accountId) ?? null;
    },
    byProvider(provider: string): readonly AccountRecord[] {
      return Object.freeze(frozen.filter((record) => record.provider === provider));
    },
  });
}

/**
 * Admit and load an owner file, or refuse it with a classified reason.
 *
 * The admission ladder, in this order and with a distinct refusal at every
 * rung: supplied → absolute → canonical → regular file → owned by this uid →
 * mode exactly `0600` → within the size bound → parseable JSON → a valid
 * accounts file.
 *
 * The parameter is typed `unknown` on purpose. "The loader has no default path"
 * is only true if calling it with nothing is a *refusal at runtime* rather than
 * a type error a caller can cast away, so the no-argument call is a tested
 * behaviour rather than a compiler opinion.
 */
export function loadAccountsFile(path?: unknown): LoadOutcome {
  if (typeof path !== "string" || path === "") {
    return refuse("PATH_NOT_SUPPLIED", ROOT_PATH);
  }
  if (!isAbsolute(path)) {
    return refuse("PATH_NOT_ABSOLUTE", ROOT_PATH);
  }

  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return refuse("OWNER_FILE_ABSENT", ROOT_PATH);
  }
  // Canonical, so a symlinked owner file cannot point somewhere none of the
  // checks below ever looked at.
  if (real !== path) {
    return refuse("PATH_NOT_CANONICAL", ROOT_PATH);
  }

  let stats;
  try {
    stats = statSync(real);
  } catch {
    return refuse("OWNER_FILE_ABSENT", ROOT_PATH);
  }
  if (!stats.isFile()) {
    return refuse("OWNER_FILE_NOT_REGULAR", ROOT_PATH);
  }
  if (stats.uid !== process.getuid?.()) {
    return refuse("OWNER_FILE_NOT_OWNED", ROOT_PATH);
  }
  // Exactly 0600. Not "no group or world write" — an owner file that anyone can
  // *read* has already failed at the only thing it is for.
  if ((stats.mode & 0o777) !== 0o600) {
    return refuse("OWNER_FILE_UNSAFE_PERMISSIONS", ROOT_PATH);
  }
  if (stats.size > ACCOUNTS_FILE_MAX_BYTES) {
    return refuse("OWNER_FILE_TOO_LARGE", ROOT_PATH);
  }

  let text: string;
  try {
    text = readFileSync(real, "utf8");
  } catch {
    return refuse("OWNER_FILE_ABSENT", ROOT_PATH);
  }
  // The bytes actually read, not the size the stat promised.
  if (Buffer.byteLength(text, "utf8") > ACCOUNTS_FILE_MAX_BYTES) {
    return refuse("OWNER_FILE_TOO_LARGE", ROOT_PATH);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // The parser's own message quotes the input. It does not travel.
    return refuse("OWNER_FILE_NOT_JSON", ROOT_PATH);
  }

  return validateAccountsFile(parsed);
}
