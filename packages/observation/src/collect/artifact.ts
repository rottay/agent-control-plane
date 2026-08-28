import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

import { ControlPlaneEvent } from "@acp/contracts";
import type { ControlPlaneEvent as ControlPlaneEventShape } from "@acp/contracts";

import { ObservationError } from "../errors.js";
import type { ObservationRefusal } from "../errors.js";
import { ARTIFACT_MAX_BYTES, admitArtifact, resolveObservationRoot } from "../roots.js";
import type { ArtifactHandle } from "../roots.js";

/**
 * The passive artifact collector.
 *
 * P3A drew the boundary: an admitted artifact is a named, owned, unwritable,
 * size-bounded regular file under an allowlisted root. P3B reads the bytes it
 * admits and turns them into exactly one thing this repository already knows
 * how to hold an opinion about: a `ControlPlaneEvent` that parses against the
 * frozen 21-type vocabulary in `@acp/contracts`. Nothing here builds a
 * baseline, opens a ledger or interprets a chain of events; that is P3C's
 * mapping, over shapes this module has already refused to pass through.
 *
 * The reading itself stays read-only, and it is descriptor-bound. The module
 * opens exactly one file, read-only and refusing to follow symlinks, and
 * re-applies admission's law to that opened inode before allocating anything.
 * That is the only `openSync` the observation package permits, and the
 * architecture fence and `roots.test.ts` both pin it to this file, to the
 * read-only flags, and to nothing else; every write-capable flag and every
 * other open stays forbidden. The admission rules themselves are still
 * `../roots.js`'s, which this module calls rather than reimplements.
 */

/**
 * Refusal codes this module can add on top of the nine admission refusals
 * `../errors.js` already classifies. Admission refusals are forwarded
 * verbatim — this module widens no code that boundary already owns. These
 * three exist only because admission cannot know them: they are true only
 * once the admitted bytes have actually been read and parsed.
 */
export type CollectRefusal =
  | ObservationRefusal
  | "MALFORMED_JSON"
  | "WRONG_SHAPE"
  | "CONTRACT_INVALID"
  // Raised only by the descriptor read below. Admission cannot know these:
  // they describe what the *opened inode* turned out to be, after the path
  // that named it stopped being the only thing under discussion.
  | "PATH_MISSING"
  | "PATH_NOT_REGULAR_FILE"
  | "PATH_NOT_OWNED"
  | "READ_FAILED";

export interface CollectRefused {
  readonly ok: false;
  readonly reason: CollectRefusal;
  readonly detail: string;
}

/**
 * `ObservationRefused` is structurally a `CollectRefused` with a narrower
 * `reason`, so an admission refusal can be returned from a collector function
 * without being rebuilt. This helper only ever constructs the wider cases.
 */
export function collectRefuse(reason: CollectRefusal, detail: string): CollectRefused {
  return { ok: false, reason, detail };
}

/** How many validation issues a refusal detail may quote. Never the payload. */
const MAX_QUOTED_ISSUES = 5;

export type BoundedJson =
  | { readonly ok: true; readonly value: unknown }
  | CollectRefused;

/** The errno of a Node system error, without asserting the value's shape. */
function errnoOf(error: unknown): string {
  return isPlainRecord(error) && typeof error["code"] === "string" ? error["code"] : "";
}

/**
 * Classify a failure of the descriptor read, without echoing content.
 *
 * The detail carries the errno name and nothing else. An artifact that fails
 * to be read is still an artifact whose bytes this module has no license to
 * quote, and an errno is a fact about the filesystem rather than about the
 * content.
 */
function classifyReadFailure(error: unknown, stage: string): CollectRefused {
  const errno = errnoOf(error);
  if (errno === "ENOENT" || errno === "ENOTDIR") {
    return collectRefuse("PATH_MISSING", "the admitted artifact was gone by " + stage);
  }
  if (errno === "ELOOP") {
    return collectRefuse(
      "PATH_NOT_CANONICAL",
      "the admitted artifact was a symlink by " + stage + "; the open refused to follow it",
    );
  }
  return collectRefuse(
    "READ_FAILED",
    "the admitted artifact could not be read at " + stage + " (" + (errno === "" ? "unknown" : errno) + ")",
  );
}

/**
 * Read an admitted file and parse it as JSON, fail-closed.
 *
 * Descriptor-bound, not path-bound, and that distinction is the whole point.
 * `admitArtifact` validated a *path*; between that validation and this read
 * the name can be unlinked, replaced by a symlink pointing anywhere, or grown
 * past the bound. Re-checking the path would only re-ask a question about
 * whatever now answers to that name.
 *
 * So the file is opened once with `O_NOFOLLOW` — a symlink swap fails the open
 * rather than escaping the allowlist — and every subsequent check is made
 * against that one descriptor: `fstatSync` revalidates regular-file, owner,
 * mode and size on the opened inode, before a byte is allocated. The read is
 * then bounded at `ARTIFACT_MAX_BYTES + 1`, so a file that grows after the
 * `fstat` is refused by the one extra byte rather than by an unbounded read
 * that has already loaded it. A bound applied to something already in memory
 * is not a bound.
 */
export function readBoundedJson(handle: ArtifactHandle): BoundedJson {
  let descriptor: number;
  try {
    descriptor = openSync(handle, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    return classifyReadFailure(error, "open");
  }

  // Everything between the open and the close is decided here, and this never
  // throws: an unexpected error becomes a classified refusal like any other.
  // That is what lets the close below be an ordinary step rather than a
  // `finally` — and a `finally` is exactly where a close failure would have to
  // be swallowed or allowed to mask the real answer.
  let primary: BoundedJson | { readonly ok: true; readonly content: string };
  try {
    primary = readOpenedDescriptor(descriptor);
  } catch (error: unknown) {
    primary = classifyReadFailure(error, "read");
  }

  // One close, always attempted, never silent. A failed close means the
  // descriptor's state is not what this module believes it to be, so it
  // replaces the primary answer instead of being discarded next to it.
  try {
    closeSync(descriptor);
  } catch (error: unknown) {
    return classifyReadFailure(error, "close");
  }

  if (!("content" in primary)) return primary;

  try {
    return { ok: true, value: JSON.parse(primary.content) as unknown };
  } catch {
    return collectRefuse("MALFORMED_JSON", "the admitted content is not valid JSON");
  }
}

/**
 * Revalidate and read one already-open descriptor.
 *
 * Split out so the descriptor's lifetime is visible in one place above: this
 * function never closes and never throws a filesystem error, and its caller
 * closes exactly once.
 */
function readOpenedDescriptor(
  descriptor: number,
): BoundedJson | { readonly ok: true; readonly content: string } {
  let stats;
  try {
    stats = fstatSync(descriptor);
  } catch (error: unknown) {
    return classifyReadFailure(error, "fstat");
  }

  // The same law admission applied, re-asked of the opened inode.
  if (!stats.isFile()) {
    return collectRefuse("PATH_NOT_REGULAR_FILE", "the opened artifact is not a regular file");
  }
  if (stats.uid !== process.getuid?.()) {
    return collectRefuse("PATH_NOT_OWNED", "the opened artifact belongs to another account");
  }
  if ((stats.mode & 0o022) !== 0) {
    return collectRefuse("UNSAFE_PERMISSIONS", "the opened artifact is group- or world-writable");
  }
  if (stats.size > ARTIFACT_MAX_BYTES) {
    return collectRefuse("TOO_LARGE", "the opened artifact exceeds its size bound");
  }

  // One byte past the bound: enough to notice growth, never enough to be
  // unbounded. Nothing beyond this buffer is ever allocated or decoded.
  const buffer = Buffer.alloc(ARTIFACT_MAX_BYTES + 1);
  let read = 0;
  try {
    for (;;) {
      const taken = readSync(descriptor, buffer, read, buffer.length - read, null);
      if (taken === 0) break;
      read += taken;
      if (read === buffer.length) break;
    }
  } catch (error: unknown) {
    return classifyReadFailure(error, "read");
  }

  if (read > ARTIFACT_MAX_BYTES) {
    return collectRefuse(
      "TOO_LARGE",
      "the admitted content grew past its size bound between admission and read",
    );
  }
  return { ok: true, content: buffer.toString("utf8", 0, read) };
}

/** Is this a JSON object, rather than an array, a scalar, or null? */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Is this a JSON array?
 *
 * A dedicated guard rather than an inline `Array.isArray` call at the call
 * site: the built-in narrows to `any[]`, and every element pulled from that
 * would carry `any` into the scenario collector's loop. Declaring the
 * predicate here as `readonly unknown[]` keeps every element `unknown` until
 * `parseEvent` validates it.
 */
export function isJsonArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

type EventParseFailure = Extract<ReturnType<typeof ControlPlaneEvent.safeParse>, { success: false }>;

/**
 * Summarize a failed parse without echoing the content that failed.
 *
 * Every zod issue this contract can raise names a path and a fixed reason —
 * `attachGuards` phrases its own issues as "key X is forbidden" or "value
 * matches a known credential material shape", never as the key's or value's
 * content — so quoting the issue list here stays as safe as the contract that
 * produced it. The quote is additionally bounded, because a payload crafted to
 * fail in as many places as possible should not make the refusal itself
 * unbounded.
 */
export function summarizeIssues(failure: EventParseFailure): string {
  const issues = failure.error.issues;
  const quoted = issues
    .slice(0, MAX_QUOTED_ISSUES)
    .map((issue) => (issue.path.length > 0 ? issue.path.join(".") : "<root>") + ": " + issue.message);
  const remaining = issues.length - quoted.length;
  const suffix = remaining > 0 ? "; " + String(remaining) + " more issue(s)" : "";
  return "does not satisfy the frozen ControlPlaneEvent contract (" + quoted.join("; ") + suffix + ")";
}

export interface CollectedArtifact {
  readonly handle: ArtifactHandle;
  readonly name: string;
  readonly event: ControlPlaneEventShape;
}

export type ArtifactCollection =
  | { readonly ok: true; readonly artifact: CollectedArtifact }
  | CollectRefused;

/**
 * Parse and validate the JSON at an already-admitted handle as one event.
 *
 * Shared with the scenario collector's per-element validation, so the two
 * collectors classify a malformed event identically rather than drifting into
 * two similar but not-quite-matching sets of refusals.
 */
export function parseEvent(json: unknown): { readonly ok: true; readonly event: ControlPlaneEventShape } | CollectRefused {
  if (!isPlainRecord(json)) {
    return collectRefuse("WRONG_SHAPE", "an event must decode to a JSON object, not an array or a scalar");
  }
  const parsed = ControlPlaneEvent.safeParse(json);
  if (!parsed.success) {
    return collectRefuse("CONTRACT_INVALID", summarizeIssues(parsed));
  }
  return { ok: true, event: parsed.data };
}

/**
 * Collect one passive artifact by name.
 *
 * The only entry point this module exposes. It resolves the artifacts root
 * itself, admits the named file, reads it, and validates it as one
 * `ControlPlaneEvent`. A caller never supplies a path, and never sees a
 * filesystem error that was not first classified.
 */
export function collectArtifact(name: string): ArtifactCollection {
  let root;
  try {
    root = resolveObservationRoot("artifacts");
  } catch (error: unknown) {
    if (error instanceof ObservationError) return collectRefuse(error.code, error.message);
    throw error;
  }

  const admitted = admitArtifact(root, name);
  if (!admitted.ok) return admitted;

  const json = readBoundedJson(admitted.handle);
  if (!json.ok) return json;

  const parsed = parseEvent(json.value);
  if (!parsed.ok) return parsed;

  return { ok: true, artifact: { handle: admitted.handle, name, event: parsed.event } };
}
