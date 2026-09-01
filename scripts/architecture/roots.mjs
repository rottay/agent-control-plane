/**
 * The one place that knows how a package path is shaped (P8-T G0, L1).
 *
 * Before this module the fence answered "is this file in package X's source?"
 * twenty-three times, at seventeen distinct literal prefixes, each written out
 * by hand. That is not a style problem: a tranche that moves packages has to
 * change every one of those literals, and the ones it misses keep passing while
 * silently scoping to nothing — a law that selects zero files reports no
 * violations. Routing every question through one resolver makes the move a
 * single edit and makes "scoped to nothing" a thing the fence can notice.
 *
 * This module is pure. It performs no IO, reads no environment beyond what a
 * caller hands it, and holds no state, so the probes can exercise it by direct
 * import without a subprocess and without touching any tree.
 *
 * It deliberately does **not** hold the fence's path-shaped inventory (N1):
 * that structure is computed beside the laws it indexes and lives in the fence
 * itself. The resolver stays a resolver.
 */

/** The directory every workspace package lives under. Named once. */
export const PACKAGES_DIR = "packages";

/**
 * The prefix of one package's tree, with its trailing separator.
 *
 * The separator is not decoration: without it `packages/ui` also matches
 * `packages/ui-extras`, which is exactly the class of quiet mis-scoping this
 * module exists to end.
 */
export function packagePrefix(name) {
  return PACKAGES_DIR + "/" + name + "/";
}

/** Is this repository-relative path inside the named package? */
export function inPackage(path, name) {
  return path.startsWith(packagePrefix(name));
}

/**
 * Is this path inside one area of a package — `src`, `test`, or a nested area
 * such as `src/launchd`?
 */
export function inArea(path, name, area) {
  return path.startsWith(packagePrefix(name) + area + "/");
}

/** Is this path inside any of the named areas of a package? */
export function inAnyArea(path, name, areas) {
  for (const area of areas) {
    if (inArea(path, name, area)) return true;
  }
  return false;
}

/**
 * Which package does this path belong to, if any.
 *
 * Returns `null` rather than guessing for anything outside `packages/`, and for
 * a path that names the directory but no package beneath it.
 */
export function packageOf(path) {
  if (!path.startsWith(PACKAGES_DIR + "/")) return null;
  const rest = path.slice(PACKAGES_DIR.length + 1);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return rest.slice(0, slash);
}

/**
 * Every package name present in a listing, sorted.
 *
 * Takes the listing rather than reading a directory, so the same function
 * answers for the real tree and for a synthetic one in a temporary directory
 * with no branch between them.
 */
export function packagesIn(paths) {
  const found = new Set();
  for (const path of paths) {
    const name = packageOf(path);
    if (name !== null) found.add(name);
  }
  return [...found].sort();
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
