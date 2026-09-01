/**
 * The one place that knows how a package path is shaped (P8-T G0, L1; G1').
 *
 * Before this module the fence answered "is this file in package X's source?"
 * twenty-three times, at seventeen distinct literal prefixes, each written out
 * by hand. That is not a style problem: a tranche that moves packages has to
 * change every one of those literals, and the ones it misses keep passing while
 * silently scoping to nothing — a law that selects zero files reports no
 * violations. Routing every question through one resolver makes the move a
 * single edit and makes "scoped to nothing" a thing the fence can notice.
 *
 * G1' is that move, and it is what the resolver was built for. A package no
 * longer sits at `packages/<name>/` but at `packages/<stratum>/<name>/`, so
 * every question here now needs to know which stratum owns a name. **The table
 * is passed in by the caller, never held here.** That is the same boundary L1
 * drew and N1 confirmed: this module resolves paths, and the fence owns the
 * inventory it resolves them against. A resolver that carried its own copy of
 * the strata would be a second table to disagree with the first.
 *
 * This module is pure. It performs no IO, reads no environment beyond what a
 * caller hands it, and holds no state, so the probes can exercise it by direct
 * import without a subprocess and without touching any tree.
 */

/** The directory every workspace package lives under. Named once. */
export const PACKAGES_DIR = "packages";

/**
 * Which stratum owns this package name, per the table the caller supplies.
 *
 * Returns `null` for a name the table does not classify rather than guessing.
 * The fence's classification law is what turns that `null` into a failure; the
 * resolver's job is only to report it honestly.
 */
export function stratumOf(name, strata) {
  for (const [stratum, members] of Object.entries(strata)) {
    if (members.includes(name)) return stratum;
  }
  return null;
}

/**
 * The prefix of one package's tree, with its trailing separator.
 *
 * The separator is not decoration: without it `packages/entrypoints/ui` also
 * matches `packages/entrypoints/ui-extras`, which is exactly the class of quiet
 * mis-scoping this module exists to end.
 *
 * An unclassified name throws rather than returning a prefix built from
 * `undefined`. A fence that cannot resolve a path must say so loudly; a prefix
 * that matches nothing is the silent failure L4 exists to prevent.
 */
export function packagePrefix(name, strata) {
  const stratum = stratumOf(name, strata);
  if (stratum === null) {
    throw new Error("no stratum classifies package " + name + "; the strata table is incomplete");
  }
  return PACKAGES_DIR + "/" + stratum + "/" + name + "/";
}

/** Is this repository-relative path inside the named package? */
export function inPackage(path, name, strata) {
  return path.startsWith(packagePrefix(name, strata));
}

/**
 * Is this path inside one area of a package — `src`, `test`, or a nested area
 * such as `src/launchd`?
 */
export function inArea(path, name, area, strata) {
  return path.startsWith(packagePrefix(name, strata) + area + "/");
}

/** Is this path inside any of the named areas of a package? */
export function inAnyArea(path, name, areas, strata) {
  for (const area of areas) {
    if (inArea(path, name, area, strata)) return true;
  }
  return false;
}

/**
 * The stratum and package a path sits in, if it sits in one at all.
 *
 * The shape is exactly two levels under `packages/`, and both have to be real:
 * the first segment must be a stratum the table names, and the second must be a
 * member of that stratum. Everything else returns `null` — a path under an
 * old single-level prefix, a path that names a stratum directory but no package
 * beneath it, a package the table does not classify, and anything outside
 * `packages/`.
 *
 * Returning `null` rather than guessing is what lets G1's two laws be written
 * as laws: the old-prefix path and the single-level package directory are both
 * *unresolvable*, and the fence fails on them by name instead of quietly
 * scoping to nothing.
 */
export function packageLocation(path, strata) {
  if (!path.startsWith(PACKAGES_DIR + "/")) return null;
  const rest = path.slice(PACKAGES_DIR.length + 1);
  const segments = rest.split("/");
  if (segments.length < 3) return null;
  const stratum = segments[0];
  const name = segments[1];
  if (stratum === undefined || name === undefined || name === "") return null;
  const members = Object.prototype.hasOwnProperty.call(strata, stratum) ? strata[stratum] : null;
  if (members === null || members === undefined) return null;
  if (!members.includes(name)) return null;
  return { stratum, name };
}

/**
 * Which package does this path belong to, if any.
 *
 * The two-level form of the question `packageOf` has always answered. See
 * `packageLocation` for exactly what "if any" excludes.
 */
export function packageOf(path, strata) {
  return packageLocation(path, strata)?.name ?? null;
}

/**
 * Every package name present in a listing, sorted.
 *
 * Takes the listing rather than reading a directory, so the same function
 * answers for the real tree and for a synthetic one in a temporary directory
 * with no branch between them.
 */
export function packagesIn(paths, strata) {
  const found = new Set();
  for (const path of paths) {
    const name = packageOf(path, strata);
    if (name !== null) found.add(name);
  }
  return [...found].sort();
}

/**
 * The first segment under `packages/`, whatever it is.
 *
 * Deliberately ignorant of the strata table: the shape law needs to name what
 * it actually found — including the single-level package directory and the
 * unclassified stratum that `packageLocation` refuses — and a resolver that
 * only reported conforming answers could not describe a violation.
 */
export function topSegmentOf(path) {
  if (!path.startsWith(PACKAGES_DIR + "/")) return null;
  const rest = path.slice(PACKAGES_DIR.length + 1);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return rest.slice(0, slash);
}

/**
 * The fence's root, with the injectable seam (L7).
 *
 * The default is the caller's own computed root, returned unchanged — so a run
 * with nothing set behaves byte-identically to the hardcoded constant this
 * replaced, which is L10's obligation. `ACP_FENCE_ROOT` exists so the probes can
 * point a subprocess at a synthetic tree; it is never set in ordinary use, and
 * an empty or whitespace-only value is treated as unset rather than as a request
 * to run against the filesystem root.
 */
export function fenceRoot(env, fallback) {
  const supplied = env?.ACP_FENCE_ROOT;
  if (typeof supplied !== "string") return fallback;
  const trimmed = supplied.trim();
  return trimmed === "" ? fallback : trimmed;
}
