import { ObservationError } from "../errors.js";
import { admitArtifact, resolveObservationRoot } from "../roots.js";
import type { ArtifactHandle } from "../roots.js";
import type { CollectRefused, CollectedArtifact } from "./artifact.js";
import { collectRefuse, isJsonArray, parseEvent, readBoundedJson } from "./artifact.js";

/**
 * The synthetic scenario collector.
 *
 * ADR 0009 §3: the shadow ledger P3C builds is fed synthetic task-lifecycle
 * chains, never anything observed from a live session. A scenario is that
 * chain before it has been fed to anything: a named, admitted JSON array of
 * `ControlPlaneEvent`-shaped objects under the `scenarios` root, read and
 * validated here and handed to P3C as already-typed events. This module opens
 * no ledger and writes nothing; feeding a shadow ledger from these events is
 * P3C's law, not this one's.
 *
 * Admission, the byte bound, and per-event contract validation are the same
 * machinery `artifact.ts` already built; this module adds only what a
 * *sequence* of events needs on top of one: an array shape, and a count
 * bound so a scenario cannot be crafted to spend unbounded validation work
 * inside a byte budget sized for one artifact.
 */

/** Ceiling on how many events one scenario may declare. */
export const SCENARIO_MAX_EVENTS = 500;

export interface CollectedScenario {
  readonly handle: ArtifactHandle;
  readonly name: string;
  readonly events: readonly CollectedArtifact["event"][];
}

export type ScenarioCollection =
  | { readonly ok: true; readonly scenario: CollectedScenario }
  | CollectRefused;

/**
 * Collect one synthetic scenario by name.
 *
 * The only entry point this module exposes. It resolves the scenarios root
 * itself, admits the named file, reads it, and validates it as a bounded
 * array of `ControlPlaneEvent`s. Validation fails closed on the first invalid
 * element: a scenario is one chain, and a chain with one broken link is not
 * partially usable.
 */
export function collectScenario(name: string): ScenarioCollection {
  let root;
  try {
    root = resolveObservationRoot("scenarios");
  } catch (error: unknown) {
    if (error instanceof ObservationError) return collectRefuse(error.code, error.message);
    throw error;
  }

  const admitted = admitArtifact(root, name);
  if (!admitted.ok) return admitted;

  const json = readBoundedJson(admitted.handle);
  if (!json.ok) return json;

  if (!isJsonArray(json.value)) {
    return collectRefuse("WRONG_SHAPE", "a scenario must decode to a JSON array of events");
  }
  if (json.value.length === 0) {
    return collectRefuse("WRONG_SHAPE", "a scenario must declare at least one event");
  }
  if (json.value.length > SCENARIO_MAX_EVENTS) {
    return collectRefuse(
      "TOO_LARGE",
      "the scenario exceeds its event count bound of " + String(SCENARIO_MAX_EVENTS),
    );
  }

  const events: CollectedArtifact["event"][] = [];
  for (const [index, candidate] of json.value.entries()) {
    const parsed = parseEvent(candidate);
    if (!parsed.ok) {
      return collectRefuse(parsed.reason, "scenario event at index " + String(index) + " " + parsed.detail);
    }
    events.push(parsed.event);
  }

  return { ok: true, scenario: { handle: admitted.handle, name, events } };
}
