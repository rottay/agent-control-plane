import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { ROADMAP_CONTENT_MAX_BYTES } from "@acp/contracts";

/**
 * The content-addressed artifact store.
 *
 * The Checkpoint law says a record carries **digests and references**, never
 * content: an event's payload budget could not hold a roadmap document even if
 * the law allowed it. So the ledger records the digest and the bytes live here,
 * beside it, in the package that already owns the data root. That placement is
 * the point — a second package owning the bytes would be a second authority
 * over what a digest in the ledger means, and the CLI would have to learn two
 * ways to resolve one reference.
 *
 * Two laws, and they are the whole of the durability contract:
 *
 * 1. **Publication is atomic.** Bytes are written to a temporary name in the
 *    same directory and then `rename`d into place. A reader therefore sees a
 *    complete object or no object, never a half-written one — and `rename`
 *    within a directory is the only filesystem operation that promises it. A
 *    plain `writeFileSync` at the final path would leave a torn file behind
 *    any crash, and a torn file whose name is a digest is worse than a missing
 *    one, because its name is a claim about content it does not have.
 *
 * 2. **An existing object is verified, never trusted.** Publishing content
 *    whose digest already exists re-reads the stored bytes and compares them.
 *    Equal bytes are a no-op — publication is idempotent, which is what lets a
 *    retried write be safe. **Unequal** bytes are a collision or a corruption,
 *    and the store refuses rather than overwriting: silently replacing them
 *    would destroy the evidence that something went wrong at the exact moment
 *    it mattered.
 *
 * **There is no delete.** Not "deletion is discouraged" — no function here
 * removes an object, and the store exposes no path that could. An append-only
 * ledger whose referenced bytes could be removed would be append-only in name.
 * Removing an artifact is an operator act against the filesystem, deliberate
 * and outside this API.
 *
 * Hermeticity, as everywhere else in this repository: the root is an explicit
 * absolute path the caller supplies. No default, no discovery, no environment
 * read.
 */

/** Why the store refused. Closed, so a caller can exhaust it. */
export type ArtifactRefusal =
  | "PATH_NOT_ABSOLUTE"
  | "ROOT_NOT_DIRECTORY"
  | "CONTENT_TOO_LARGE"
  | "DIGEST_MISMATCH"
  | "ARTIFACT_ABSENT"
  | "ARTIFACT_CORRUPT";

export const ARTIFACT_REFUSALS: readonly ArtifactRefusal[] = Object.freeze([
  "ARTIFACT_ABSENT",
  "ARTIFACT_CORRUPT",
  "CONTENT_TOO_LARGE",
  "DIGEST_MISMATCH",
  "PATH_NOT_ABSOLUTE",
  "ROOT_NOT_DIRECTORY",
]);

export interface ArtifactRefused {
  readonly ok: false;
  readonly reason: ArtifactRefusal;
  /** A shape observation or a digest. Never stored content. */
  readonly at: string;
}

export interface ArtifactPublished {
  readonly ok: true;
  readonly digest: string;
  readonly byteLength: number;
  /** false when the digest already held these exact bytes. */
  readonly written: boolean;
}

export interface ArtifactRead {
  readonly ok: true;
  readonly digest: string;
  readonly content: string;
}

export type PublishOutcome = ArtifactPublished | ArtifactRefused;
export type ReadOutcome = ArtifactRead | ArtifactRefused;

/**
 * The largest artifact this store will hold, re-exported (P8-8G R2).
 *
 * A roadmap is a document, not a dataset. The number now has a single
 * declaration in `@acp/contracts` — with the unit law, since this store has
 * always weighed **bytes** and the API schema used to count code units. The
 * store's own name is kept so this package's public surface is byte-stable:
 * `ARTIFACT_MAX_BYTES` is what a store's callers say, and aliasing it here is
 * cheaper than making every one of them learn a document's name.
 */
export { ROADMAP_CONTENT_MAX_BYTES as ARTIFACT_MAX_BYTES } from "@acp/contracts";

/** The digest of some content, as the store names it. */
export function artifactDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function deny(reason: ArtifactRefusal, at: string): ArtifactRefused {
  return Object.freeze({ ok: false as const, reason, at });
}

/**
 * The object's path under the root, sharded by the digest's first two bytes.
 *
 * Sharding is not premature: a flat directory of content-addressed files is a
 * directory that eventually holds every artifact the system ever recorded, and
 * some filesystems degrade badly there. Two hex characters is the smallest
 * shard that helps and the least that has to be explained.
 */
function objectPath(root: string, digest: string): { readonly dir: string; readonly file: string } {
  const dir = join(root, digest.slice(0, 2));
  return { dir, file: join(dir, digest) };
}

function readyRoot(root: string): ArtifactRefused | null {
  if (typeof root !== "string" || root === "" || !isAbsolute(root)) {
    return deny("PATH_NOT_ABSOLUTE", "<root>");
  }
  if (existsSync(root) && !statSync(root).isDirectory()) {
    return deny("ROOT_NOT_DIRECTORY", "<root>");
  }
  return null;
}

/**
 * Publish content, returning the digest that names it.
 *
 * Idempotent by construction: the same content publishes to the same digest,
 * and the second call verifies rather than rewrites.
 */
export function publishArtifact(root: string, content: string): PublishOutcome {
  const rootRefusal = readyRoot(root);
  if (rootRefusal !== null) return rootRefusal;

  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > ROADMAP_CONTENT_MAX_BYTES) return deny("CONTENT_TOO_LARGE", "content");

  const digest = artifactDigest(content);
  const { dir, file } = objectPath(root, digest);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (existsSync(file)) {
    // Law 2: verify, never trust. Equal bytes are a no-op; unequal bytes are
    // evidence of a problem and are preserved rather than overwritten.
    const existing = readFileSync(file, "utf8");
    if (artifactDigest(existing) !== digest) return deny("ARTIFACT_CORRUPT", digest);
    if (existing !== content) return deny("DIGEST_MISMATCH", digest);
    return Object.freeze({ ok: true as const, digest, byteLength, written: false });
  }

  // Law 1: publication is atomic. The temporary name is derived from the
  // digest rather than from a clock or a random source, so a retry after a
  // crash reuses and overwrites its own partial file instead of leaving a new
  // one behind on every attempt.
  const temporary = file + ".tmp";
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
  } catch {
    // A failed publication leaves nothing half-named. The temporary path is
    // the only thing removed here, and it is one this call created.
    rmSync(temporary, { force: true });
    return deny("ARTIFACT_CORRUPT", digest);
  }

  return Object.freeze({ ok: true as const, digest, byteLength, written: true });
}

/**
 * Read the content a digest names, verifying it on the way out.
 *
 * The stored bytes are re-digested before they are returned. A store that
 * handed back whatever was at the path would let a corrupted object travel
 * under a name that says it is something else.
 */
export function readArtifact(root: string, digest: string): ReadOutcome {
  const rootRefusal = readyRoot(root);
  if (rootRefusal !== null) return rootRefusal;

  const { file } = objectPath(root, digest);
  if (!existsSync(file)) return deny("ARTIFACT_ABSENT", digest);

  const content = readFileSync(file, "utf8");
  if (artifactDigest(content) !== digest) return deny("ARTIFACT_CORRUPT", digest);
  return Object.freeze({ ok: true as const, digest, content });
}

/** Does the store hold this digest? Read-only, and it verifies nothing. */
export function hasArtifact(root: string, digest: string): boolean {
  if (typeof root !== "string" || !isAbsolute(root)) return false;
  return existsSync(objectPath(root, digest).file);
}
