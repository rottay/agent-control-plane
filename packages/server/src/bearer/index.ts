import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * The write door's bearer token (P8-8G).
 *
 * **Reads are never guarded, and that is a design statement rather than an
 * omission.** This plane's whole point is that observation is free: a local
 * operator, the CLI and the browser all read without ceremony, and adding a
 * credential to that would buy nothing — the data is already on the operator's
 * own machine behind loopback. What changed in P8-8D is that the plane grew a
 * door that *writes*, and a write reachable by anything that can reach the
 * port is a different risk from a read.
 *
 * So the guard is armed inside the **write registrar**, not sprinkled over
 * handlers. Structural rather than remembered: a future write route registered
 * through the same registrar is guarded because of where it is registered, and
 * a contributor who forgets the guard cannot forget it — there is nowhere to
 * forget it from.
 *
 * **Fail-closed.** With no token file configured, every write answers 403
 * rather than proceeding. An unconfigured door is shut, never open: the
 * alternative — treat "no token" as "no check" — is the failure mode where a
 * deployment that forgot the flag is wide open and looks fine.
 *
 * **The comparison is constant-time over digests.** The token is hashed and
 * the hashes compared with `timingSafeEqual`, so neither the token's bytes nor
 * its *length* leaks through timing — hashing first is what makes the operands
 * equal-length, which `timingSafeEqual` requires and which a naive
 * `===` on raw strings would have leaked before the first byte.
 */

/** Why a token file was refused. The loader's own vocabulary, coarsened. */
export type BearerLoadRefusal =
  | "PATH_NOT_SUPPLIED"
  | "PATH_NOT_ABSOLUTE"
  | "PATH_NOT_CANONICAL"
  | "TOKEN_FILE_ABSENT"
  | "TOKEN_FILE_NOT_REGULAR"
  | "TOKEN_FILE_NOT_OWNED"
  | "TOKEN_FILE_UNSAFE_PERMISSIONS"
  | "TOKEN_FILE_EMPTY"
  | "TOKEN_FILE_TOO_LARGE";

export type BearerLoadOutcome =
  | { readonly ok: true; readonly guard: BearerGuard }
  | { readonly ok: false; readonly reason: BearerLoadRefusal };

/** A token file is a line, not a document. */
export const BEARER_TOKEN_MAX_BYTES = 4096;

/**
 * The armed guard: it holds a digest, never the token.
 *
 * Nothing on this object can print the secret, because the secret is not on
 * it. That is deliberate — a guard that carried the token would eventually be
 * logged by something, and "we are careful never to log it" is a weaker
 * property than "there is nothing to log".
 */
export interface BearerGuard {
  /** Constant-time over digests. False for a missing or malformed header. */
  accepts(authorizationHeader: string | undefined): boolean;
}

function refuse(reason: BearerLoadRefusal): BearerLoadOutcome {
  return { ok: false, reason };
}

/**
 * Load the token file, on the accounts loader's own ladder.
 *
 * Supplied → absolute → canonical → regular file → owned by this uid → mode
 * exactly 0600 → non-empty → within bounds. The same rungs as the owner file,
 * for the same reason: a credential readable by anyone on the machine has
 * already failed at the only thing it is for.
 *
 * The path is typed `unknown` so "there is no default path" is a runtime
 * refusal a caller cannot cast away, exactly as the accounts loader does it.
 */
export function loadBearerGuard(path?: unknown): BearerLoadOutcome {
  if (typeof path !== "string" || path === "") return refuse("PATH_NOT_SUPPLIED");
  if (!isAbsolute(path)) return refuse("PATH_NOT_ABSOLUTE");

  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return refuse("TOKEN_FILE_ABSENT");
  }
  if (real !== path) return refuse("PATH_NOT_CANONICAL");

  let stats;
  try {
    stats = statSync(real);
  } catch {
    return refuse("TOKEN_FILE_ABSENT");
  }
  if (!stats.isFile()) return refuse("TOKEN_FILE_NOT_REGULAR");
  if (stats.uid !== process.getuid?.()) return refuse("TOKEN_FILE_NOT_OWNED");
  if ((stats.mode & 0o777) !== 0o600) return refuse("TOKEN_FILE_UNSAFE_PERMISSIONS");
  if (stats.size > BEARER_TOKEN_MAX_BYTES) return refuse("TOKEN_FILE_TOO_LARGE");

  let text: string;
  try {
    text = readFileSync(real, "utf8");
  } catch {
    return refuse("TOKEN_FILE_ABSENT");
  }

  // Trailing newlines are what a text editor adds and an operator does not
  // mean; the token is the line, not the file.
  const token = text.trim();
  if (token === "") return refuse("TOKEN_FILE_EMPTY");
  if (Buffer.byteLength(token, "utf8") > BEARER_TOKEN_MAX_BYTES) {
    return refuse("TOKEN_FILE_TOO_LARGE");
  }

  return { ok: true, guard: makeGuard(token) };
}

/** The scheme name, matched case-insensitively as RFC 7235 requires. */
const SCHEME = /^bearer[ \t]+(.+)$/i;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function makeGuard(token: string): BearerGuard {
  // Hashed once, at load. The token string goes out of scope here and only the
  // digest is captured, so the guard cannot surface the secret even to a
  // debugger walking its closure.
  const expected = digest(token);

  return Object.freeze({
    accepts(authorizationHeader: string | undefined): boolean {
      if (authorizationHeader === undefined) return false;
      const matched = SCHEME.exec(authorizationHeader.trim());
      if (matched === null) return false;
      const presented = matched[1];
      if (presented === undefined) return false;
      // Both operands are 32-byte digests, so the comparison is defined and
      // its duration says nothing about the presented value's length.
      return timingSafeEqual(digest(presented.trim()), expected);
    },
  });
}
