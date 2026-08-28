/**
 * Public surface of the Agent Control Plane observation package.
 *
 * This is P3A: the shadow-mode boundary and nothing above it. Collectors are
 * P3B, the baseline is P3C, and the ledger-to-client parity contract is P3D.
 *
 * Importing this module has no side effects. It creates no directory, opens no
 * database, spawns no process, binds no socket and writes no file — and it
 * cannot, because the modules behind it import no API that would let them. The
 * architecture fence asserts the absence rather than trusting this paragraph.
 *
 * Shadow mode observes only passive artifacts already emitted, or synthetic
 * scenarios, under allowlisted ignored roots. It never attaches to, inspects,
 * signals or writes into any live session.
 *
 * P3A is not P3 completion, and it is no product adoption.
 */

export type { ObservationRefusal, ObservationRefused, ObservationVerdict } from "./errors.js";
export { ObservationError } from "./errors.js";
export type {
  ArtifactAdmission,
  ArtifactHandle,
  ObservationKind,
  ObservationRoot,
} from "./roots.js";
export {
  ARTIFACT_MAX_BYTES,
  OBSERVATION_KINDS,
  OBSERVATION_ROOT_SEGMENTS,
  admitArtifact,
  checkArtifactName,
  observationRootPath,
  redactObservationPath,
  resolveObservationRoot,
} from "./roots.js";
