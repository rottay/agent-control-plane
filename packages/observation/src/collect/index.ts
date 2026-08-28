/**
 * Public surface of the passive collectors.
 *
 * This is P3B: parsers over what P3A already admits, and nothing above it.
 * The baseline that turns these events into a measurement is P3C. Importing
 * this module has no side effects, for the same reason importing the package
 * itself does not: nothing behind it opens, mutates, signals or reaches
 * anywhere.
 *
 * Not yet re-exported from the package's own `../index.ts` — that file is
 * outside this packet's write-set, and wiring a new export surface into it is
 * a decision for the packet authorized to touch it.
 */

export type {
  ArtifactCollection,
  CollectRefusal,
  CollectRefused,
  CollectedArtifact,
} from "./artifact/index.js";
export { collectArtifact } from "./artifact/index.js";

export type { CollectedScenario, ScenarioCollection } from "./scenario/index.js";
export { SCENARIO_MAX_EVENTS, collectScenario } from "./scenario/index.js";
