import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ObservationError, refuse } from "../errors/index.js";
import type { ObservationRefused, ObservationVerdict } from "../errors/index.js";

/**
 * Where shadow mode may look, and nothing else.
 *
 * This is the third time this repository has needed an opaque, self-resolved
 * root — the toy scenario root and the daemon root are the first two — and the
 * shape is the same because the risk is: a caller that can name a directory can
 * name someone else's directory. So no public entry point accepts a path.
 *
 * One law here is deliberately stricter than P2's. This package creates
 * nothing. A collector that can create the directory it reads from can be
 * pointed at a fresh directory anywhere and will happily report that it found
 * nothing there; observation admits what already exists or refuses. That is
 * also why the module imports no mutating filesystem call at all — the
 * architecture fence asserts the absence, so the property is structural rather
 * than a promise.
 */

declare const observationRootBrand: unique symbol;
export type ObservationRoot = string & { readonly [observationRootBrand]: true };

declare const artifactBrand: unique symbol;
export type ArtifactHandle = string & { readonly [artifactBrand]: true };

/** The two kinds of thing P3 may observe, and their repo-relative roots. */
export type ObservationKind = "artifacts" | "scenarios";

export const OBSERVATION_ROOT_SEGMENTS: Readonly<Record<ObservationKind, readonly string[]>> =
  Object.freeze({
    artifacts: Object.freeze([".acp-local", "shadow", "artifacts"]),
    scenarios: Object.freeze([".acp-local", "shadow", "scenarios"]),
  });

export const OBSERVATION_KINDS: readonly ObservationKind[] = Object.freeze([
  "artifacts",
  "scenarios",
]);

/** An artifact is named, never pathed: no separator, no dot segment, no escape. */
const ARTIFACT_NAME = new RegExp("^[a-z0-9][a-z0-9._-]{0,127}$");

/** A passive artifact has no business being large. Checked on the stat. */
export const ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

/** Where a kind's root must live, as an absolute path. Does not create it. */
export function observationRootPath(kind: ObservationKind): string {
  return join(REPO_ROOT, ...OBSERVATION_ROOT_SEGMENTS[kind]);
}

/**
 * Resolve an existing allowlisted root.
 *
 * Refuses rather than creates. ROOT_ABSENT is not an inconvenience for a caller
 * to work around: it is the difference between reading what an operator put
 * somewhere and inventing a place to read from.
 */
export function resolveObservationRoot(kind: ObservationKind): ObservationRoot {
  const target = observationRootPath(kind);
  if (!existsSync(target)) {
    throw new ObservationError(
      "ROOT_ABSENT",
      "the " + kind + " root does not exist; observation creates nothing",
    );
  }

  // Containment is checked after realpath, because the string and the resolved
  // path diverge the moment a symlink is involved.
  const real = realpathSync(target);
  if (real !== target) {
    throw new ObservationError("PATH_NOT_CANONICAL", "the " + kind + " root traverses a symlink");
  }
  const expectedPrefix = realpathSync(REPO_ROOT) + sep;
  if (!real.startsWith(expectedPrefix)) {
    throw new ObservationError("OUTSIDE_ALLOWLIST", "the " + kind + " root left the repository");
  }
  const stats = statSync(real);
  if (!stats.isDirectory()) {
    throw new ObservationError("ROOT_ABSENT", "the " + kind + " root is not a directory");
  }
  if (stats.uid !== process.getuid?.()) {
    throw new ObservationError(
      "NOT_OWNED_FILE",
      "the " + kind + " root belongs to another account",
    );
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new ObservationError(
      "UNSAFE_PERMISSIONS",
      "the " + kind + " root is group- or world-writable",
    );
  }
  return real as ObservationRoot;
}

/** Is this a name, rather than a path wearing one? */
export function checkArtifactName(name: string): ObservationVerdict {
  if (name.includes("/") || name.includes(sep) || name.includes(" ")) {
    return refuse("PATH_SUPPLIED", "artifacts are named, not pathed");
  }
  if (name === "." || name === ".." || name.startsWith("..")) {
    return refuse("PATH_SUPPLIED", "a dot segment is not a name");
  }
  if (!ARTIFACT_NAME.test(name)) {
    return refuse("BAD_ARTIFACT_NAME", "the name is outside the admitted grammar");
  }
  return { ok: true };
}

export type ArtifactAdmission =
  | { readonly ok: true; readonly handle: ArtifactHandle }
  | ObservationRefused;

/**
 * Admit one artifact under a resolved root, or refuse with a reason.
 *
 * Every check is on the thing itself: it must be there, be a regular file, be
 * ours, be unwritable by anyone else, and be within a size bound taken from the
 * stat rather than after reading — a bound applied to something already in
 * memory is not a bound.
 */
export function admitArtifact(root: ObservationRoot, name: string): ArtifactAdmission {
  const named = checkArtifactName(name);
  if (!named.ok) return named;

  const candidate = join(root, name);
  if (!candidate.startsWith(root + sep)) {
    return refuse("OUTSIDE_ALLOWLIST", "the name resolved outside its root");
  }
  if (!existsSync(candidate)) {
    return refuse("NOT_OWNED_FILE", "no such artifact");
  }
  if (realpathSync(candidate) !== candidate) {
    return refuse("PATH_NOT_CANONICAL", "the artifact path traverses a symlink");
  }

  const stats = statSync(candidate);
  if (!stats.isFile()) return refuse("NOT_OWNED_FILE", "the artifact is not a regular file");
  if (stats.uid !== process.getuid?.()) {
    return refuse("NOT_OWNED_FILE", "the artifact belongs to another account");
  }
  if ((stats.mode & 0o022) !== 0) {
    return refuse("UNSAFE_PERMISSIONS", "the artifact is group- or world-writable");
  }
  if (stats.size > ARTIFACT_MAX_BYTES) {
    return refuse("TOO_LARGE", "the artifact exceeds its size bound");
  }

  return { ok: true, handle: candidate as ArtifactHandle };
}

/**
 * Render a path for a receipt or a log.
 *
 * Absolute paths name a home directory, a user account and a machine layout, so
 * nothing that leaves this package carries one.
 */
export function redactObservationPath(path: string): string {
  const root = realpathSync(REPO_ROOT);
  if (path === root) return ".";
  if (path.startsWith(root + sep)) return path.slice(root.length + 1);
  return "<outside-repository>";
}
