import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { DATA_ROOT_DRILLS } from "../constants.js";
import type { OperationCoordinate, PostconditionVerdict } from "../contracts.js";
import { operationDigest } from "../core/coordinates.js";
import { ToyBoundaryError } from "../errors.js";

/**
 * The disposable toy repository the drills act on.
 *
 * The runtime does NOT accept a target directory. It accepts a scenario
 * identifier and resolves it, itself, under one fixed root inside this
 * repository. That is the whole boundary: a caller cannot name a path, so a
 * caller cannot name someone else's path, and no amount of confusion upstream
 * can point an effect at a real repository.
 *
 * Everything under the root is disposable and git-ignored. Nothing here is
 * evidence, and nothing here is read by anything but the drills.
 */

/**
 * Ignored root for every drill artefact, derived from the frozen constant so
 * the two can never disagree about where this plane is allowed to write.
 */
export const DRILL_ROOT_SEGMENTS: readonly string[] = Object.freeze(
  DATA_ROOT_DRILLS.split("/"),
);

/**
 * A scenario identifier.
 *
 * Deliberately narrower than a filename: lowercase, digits and single hyphens.
 * No dot, so no extension and no traversal segment can be spelled at all; no
 * separator, so no nesting; bounded, so no pathological length.
 */
const SCENARIO_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

declare const scenarioRootBrand: unique symbol;

/**
 * A scenario directory that this module resolved and validated itself.
 *
 * Opaque on purpose. Every function below that touches the filesystem takes
 * this type rather than a string, so a caller cannot hand the runtime a path it
 * chose. The brand makes that a compile error; the registry below makes it a
 * runtime refusal as well, because a brand is erased at build time and a
 * JavaScript consumer, or a cast, would otherwise walk straight through it.
 */
export type ScenarioRoot = string & { readonly [scenarioRootBrand]: true };

/**
 * The roots this process actually validated.
 *
 * Membership is the runtime half of the boundary. It is deliberately not a
 * prefix test: a string that merely looks like it is under the drill root is
 * not evidence that anyone checked its ancestry for symlinks.
 */
const validatedRoots = new Map<string, string>();

/**
 * Re-verify a root that was validated earlier.
 *
 * Validation at resolve time is not enough. Between the resolve and the write,
 * the scenario directory itself can be renamed away and replaced by a symlink
 * at the same name: the descent check starts BELOW the root, and comparing
 * parents against the root's current realpath would then bless the outside
 * target. So the root's own identity is checked again on every use, against the
 * realpath recorded when it was first validated.
 */
function assertRootIntact(root: string): asserts root is ScenarioRoot {
  const recorded = validatedRoots.get(root);
  if (recorded === undefined) {
    throw new ToyBoundaryError(
      "refusing a scenario root this module did not resolve; obtain one from" +
        " resolveScenarioRoot rather than constructing a path",
    );
  }

  assertDrillRootIntact();

  let stats;
  try {
    stats = lstatSync(root);
  } catch (error: unknown) {
    throw new ToyBoundaryError(
      "the validated scenario root can no longer be inspected (" +
        (errorCode(error) ?? "unknown") +
        ")",
    );
  }
  if (stats.isSymbolicLink()) {
    throw new ToyBoundaryError(
      "the scenario root was replaced by a symbolic link after it was validated",
    );
  }
  if (!stats.isDirectory()) {
    throw new ToyBoundaryError("the scenario root is no longer a directory");
  }
  if (realpathSync(root) !== recorded) {
    throw new ToyBoundaryError(
      "the scenario root no longer resolves to the path that was validated",
    );
  }
  assertContained(recorded, drillRoot());
}

/**
 * Verify the fixed drill root's own ancestry, from the real repository root.
 *
 * Without this the boundary starts one level too late: a symlink at
 * `.acp-local` or `.acp-local/drills` means every scenario is created outside
 * the repository, and each one then compares an outside path against an outside
 * root, which passes. Every segment is checked with `lstat`, and the drill root
 * must resolve to exactly the repository-relative path it is supposed to be.
 */
function assertDrillRootIntact(): void {
  const base = realRepositoryRoot();
  let current = base;
  for (const part of DRILL_ROOT_SEGMENTS) {
    current = join(current, part);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error: unknown) {
      // Not created yet. Nothing can exist below it either, and the caller
      // creates real directories.
      if (errorCode(error) === "ENOENT") return;
      throw new ToyBoundaryError(
        "the drill root ancestry could not be inspected (" +
          (errorCode(error) ?? "unknown") +
          ")",
      );
    }
    if (stats.isSymbolicLink()) {
      throw new ToyBoundaryError(
        "the drill root ancestry passes through a symbolic link; every scenario" +
          " under it would be created outside the repository",
      );
    }
    if (!stats.isDirectory()) {
      throw new ToyBoundaryError("the drill root ancestry is not a directory");
    }
  }

  const intended = join(base, ...DRILL_ROOT_SEGMENTS);
  if (realpathSync(intended) !== intended) {
    throw new ToyBoundaryError("the drill root does not resolve to its own path");
  }
}

/**
 * The repository root, derived from this module's own location.
 *
 * Four levels up from `<pkg>/{src,dist}/toy/` is the repository. Derived rather
 * than configured: a configurable root is a root an attacker or a confused
 * caller can move.
 */
function realRepositoryRoot(): string {
  return realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".."));
}

/** The fixed drill root. Created on demand, never accepted from a caller. */
export function drillRoot(): string {
  return join(realRepositoryRoot(), ...DRILL_ROOT_SEGMENTS);
}

function assertContained(candidate: string, root: string): void {
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(prefix)) {
    throw new ToyBoundaryError(
      "resolved path escapes the drill boundary; the runtime writes only under " +
        DRILL_ROOT_SEGMENTS.join("/"),
    );
  }
}

/**
 * Resolve one scenario's own directory, creating it if needed.
 *
 * Validates the identifier, resolves, checks containment, and then checks
 * containment AGAIN through `realpathSync`. The second check is the one that
 * matters: the first proves the string is inside the sandbox, the second proves
 * the directory is, which differs the moment a symlink is involved.
 */
export function resolveScenarioRoot(scenarioId: string): ScenarioRoot {
  if (!SCENARIO_ID.test(scenarioId)) {
    throw new ToyBoundaryError(
      "scenario id must be lowercase alphanumeric with hyphens and at most 64 characters",
    );
  }

  assertDrillRootIntact();
  const root = drillRoot();
  const scenario = resolve(root, scenarioId);
  assertContained(scenario, root);

  mkdirSync(scenario, { recursive: true, mode: 0o700 });

  const realRoot = realpathSync(root);
  const realScenario = realpathSync(scenario);
  assertContained(realScenario, realRoot);

  validatedRoots.set(realScenario, realScenario);
  return realScenario as ScenarioRoot;
}

/** Remove one scenario's directory. Bounded to the sandbox by the same rules. */
export function removeScenarioRoot(scenarioId: string): void {
  if (!SCENARIO_ID.test(scenarioId)) {
    throw new ToyBoundaryError("refusing to remove a path from an invalid scenario id");
  }
  const root = drillRoot();
  const scenario = resolve(root, scenarioId);
  assertContained(scenario, root);
  rmSync(scenario, { recursive: true, force: true });
  validatedRoots.delete(scenario);
  try {
    validatedRoots.delete(realpathSync(root) + sep + scenarioId);
  } catch {
    // The root is gone; nothing left to forget.
  }
}

/**
 * Where a scenario's ledger lives.
 *
 * Guarded by the same boundary as the effect marker. The ledger is the one file
 * in this plane whose loss is unrecoverable, so the path that names it gets the
 * same treatment as the path that names a throwaway marker, not less.
 */
export function scenarioLedgerPath(scenarioRoot: ScenarioRoot): string {
  assertRootIntact(scenarioRoot);
  const ledger = join(scenarioRoot, "ledger.sqlite");
  assertSafeDescent(scenarioRoot, ledger);
  return ledger;
}

function markerPath(scenarioRoot: ScenarioRoot, operation: OperationCoordinate): string {
  assertRootIntact(scenarioRoot);
  const marker = join(scenarioRoot, "effects", operation.operationId + ".marker");
  assertSafeDescent(scenarioRoot, marker);
  return marker;
}

/** Read an errno from an unknown thrown value without trusting its shape. */
function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code: unknown = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Refuse any path whose ancestry below the scenario root is not a real directory.
 *
 * String containment proves the NAME is inside the sandbox. It says nothing
 * about where the directories actually lead: replace `effects` with a symlink
 * and a name inside the sandbox resolves to a file outside it. So every segment
 * between the validated root and the target is checked with `lstat`, which does
 * not follow links, and the parent's realpath is checked for containment too.
 *
 * A segment that does not exist yet is safe: nothing below it can exist either,
 * and the caller creates real directories.
 */
function assertSafeDescent(scenarioRoot: string, target: string): void {
  assertContained(target, scenarioRoot);

  const parts = relative(scenarioRoot, target).split(sep).filter(Boolean);
  let current = scenarioRoot;
  for (const part of parts) {
    current = join(current, part);
    let isLink = false;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return;
      throw new ToyBoundaryError(
        "refusing a drill path whose ancestry could not be inspected (" +
          (errorCode(error) ?? "unknown") +
          ")",
      );
    }
    if (isLink) {
      throw new ToyBoundaryError(
        "refusing a drill path that descends through a symbolic link; a name inside" +
          " the sandbox may still resolve outside it",
      );
    }
  }

  const parent = dirname(target);
  try {
    assertContained(realpathSync(parent), realpathSync(scenarioRoot));
  } catch (error: unknown) {
    if (error instanceof ToyBoundaryError) throw error;
    if (errorCode(error) === "ENOENT") return;
    throw new ToyBoundaryError(
      "refusing a drill path whose parent could not be resolved (" +
        (errorCode(error) ?? "unknown") +
        ")",
    );
  }
}

/**
 * Perform the toy effect, once.
 *
 * Idempotent by content: the marker holds a digest derived from the operation
 * coordinate, so a re-run writes exactly the same bytes. The write is atomic —
 * a temporary file in the same directory, then a rename — so a crash mid-write
 * leaves either the previous state or the complete new one, never a torn file
 * that the probe would have to interpret.
 *
 * An existing marker with different content is NOT overwritten. That is somebody
 * else's write, and quietly replacing it would destroy the one piece of evidence
 * that something unexpected happened.
 */
export function applyEffect(scenarioRoot: ScenarioRoot, operation: OperationCoordinate): void {
  const expected = operationDigest(operation);
  const target = markerPath(scenarioRoot, operation);

  const existing = readMarker(target);
  if (existing === expected) return;
  if (existing !== null) {
    throw new ToyBoundaryError(
      "refusing to overwrite an effect marker whose content this operation did not write",
    );
  }

  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  // The directory was created, or may have been replaced, since the first
  // check. Re-verify the descent before anything is written through it.
  assertSafeDescent(scenarioRoot, target);
  const temporary = target + ".partial";
  assertSafeDescent(scenarioRoot, temporary);
  writeFileSync(temporary, expected, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
}

/**
 * Read a marker, treating ONLY absence as absence.
 *
 * A blanket catch here was a real defect: a directory where the marker should
 * be, a permission error, or any other malformed state all became "no marker",
 * which the probe reported as `NOT_DONE`, which invites the caller to perform
 * the effect a second time. Everything except `ENOENT` is now a typed refusal.
 */
function readMarker(target: string): string | null {
  try {
    return readFileSync(target, "utf8");
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "ENOENT") return null;
    throw new ToyBoundaryError(
      "the effect marker exists but could not be read (" +
        (code ?? "unknown") +
        "); refusing to treat an unreadable marker as absent",
    );
  }
}

/**
 * Ask whether the effect happened.
 *
 * Three answers, and the third is the important one:
 *
 * - `DONE`: the marker exists with exactly the content this operation writes;
 * - `NOT_DONE`: no marker, so the effect has not been applied;
 * - `UNKNOWN`: a marker exists with different content. Something else wrote
 *   here, and this probe cannot say whether the operation completed. The caller
 *   must fail closed rather than guess in either direction.
 */
export function probeEffect(
  scenarioRoot: ScenarioRoot,
  operation: OperationCoordinate,
): PostconditionVerdict {
  const target = markerPath(scenarioRoot, operation);
  const existing = readMarker(target);
  if (existing === null) return "NOT_DONE";
  return existing === operationDigest(operation) ? "DONE" : "UNKNOWN";
}
