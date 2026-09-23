import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { PRODUCT_PATH_MARKERS } from "@acp/contracts";

import type { ScenarioRoot } from "../index.js";
import type { EvidenceRootOutcome, EvidenceRootRefusal } from "./types/index.js";

/**
 * The value types of this concept live in their own leaf, `./types/index.ts`, and
 * are re-exported here unchanged so every importer reads them from this module
 * (owner law §7).
 */
export type { EvidenceRootOutcome, EvidenceRootRefusal } from "./types/index.js";

/**
 * The non-toy evidence root — P-15 escalón D3, ADR 0105 (decision 139; adjudication
 * v2 C6, C-D1).
 *
 * A recorded walk runs against an operator's ledger, not a scenario's, so its
 * execution markers need a home that is not the drill root. It is derived from the
 * ledger's own path, in `artifactRootFor`'s mould — `dirname(ledgerPath)/executions`
 * beside `dirname(ledgerPath)/artifacts` — so there is no configurable root and no
 * second path a caller could name.
 *
 * **Admitted, never created.** The directory must already exist; the daemon's
 * recorded-form startup is its one creator, with mode 0700 and only when absent.
 * Here it is held to the providers' admission, restated as a declared second copy
 * because the runtime may not import the providers: absolute, present, canonical, a
 * directory, owned by this process's user, neither group- nor world-writable, and
 * under no product checkout (`PRODUCT_PATH_MARKERS`, one vocabulary in
 * `@acp/contracts`). A shared vector table holds the two copies to one answer. A
 * directory with the wrong mode or owner is refused, never repaired.
 *
 * **Minted as the scenario-root brand.** `createExecutionEffects` takes only a
 * `ScenarioRoot`, so a plain string still cannot reach it; this is the one other
 * place that brand is minted, and only for a directory that passed every check.
 */

/** Every way the evidence root is refused, sorted. The refusal names a fact, never the path. */
export const EVIDENCE_ROOT_REFUSALS = [
  "ABSENT",
  "NOT_ABSOLUTE",
  "NOT_A_DIRECTORY",
  "NOT_CANONICAL",
  "NOT_OWNED",
  "PERMISSIONS_TOO_OPEN",
  "PRODUCT_PATH",
] as const;

/** The evidence directory's name, beside the ledger. */
const EVIDENCE_DIRECTORY = "executions";

function refuse(refusal: EvidenceRootRefusal, at: string): EvidenceRootOutcome {
  return Object.freeze({ ok: false as const, refusal, at });
}

/** Admit the evidence root a ledger path implies, or refuse it by name. */
export function evidenceRootFor(ledgerPath: string): EvidenceRootOutcome {
  const candidate = join(dirname(ledgerPath), EVIDENCE_DIRECTORY);
  if (!isAbsolute(candidate)) return refuse("NOT_ABSOLUTE", "evidenceRoot");
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    return refuse("ABSENT", "evidenceRoot");
  }
  // Canonical, so a symlinked root cannot point somewhere the checks below never looked.
  if (resolved !== candidate) return refuse("NOT_CANONICAL", "evidenceRoot");
  const stats = statSync(candidate);
  if (!stats.isDirectory()) return refuse("NOT_A_DIRECTORY", "evidenceRoot");
  if (stats.uid !== process.getuid?.()) return refuse("NOT_OWNED", "evidenceRoot");
  if ((stats.mode & 0o022) !== 0) return refuse("PERMISSIONS_TOO_OPEN", "evidenceRoot.mode");
  // Case-insensitive (P-15 escalón D3 v2): macOS filesystems are, so a lowercase
  // spelling of a product checkout is the same checkout.
  const folded = candidate.toLowerCase();
  for (const marker of PRODUCT_PATH_MARKERS) {
    if (folded.includes(marker.toLowerCase())) return refuse("PRODUCT_PATH", "evidenceRoot");
  }
  return Object.freeze({ ok: true as const, root: candidate as ScenarioRoot });
}
