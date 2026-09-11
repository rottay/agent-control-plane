/**
 * Public surface of the Agent Control Plane daemon package.
 *
 * This is P2D: the supervised process lifecycle around the runtime durability
 * plane. The launchd template, the observation route and any product adoption
 * are not here.
 *
 * Importing this module has no side effects. It parses no argv, creates no
 * directory, opens no database, binds no socket, spawns no child, installs no
 * signal handler and writes no file. Effects begin only inside `startDaemon` or
 * the internal child entry, and a fresh-process drill proves it rather than a
 * comment claiming it.
 *
 * The daemon adds no authority. The ledger remains the only one: the status
 * document and the lock file are observations, and no daemon authority exists
 * that could disagree with the ledger.
 *
 * P2D is not P2 completion, and it is no product adoption.
 *
 * The composition root itself lives in `./composition/index.ts` (P-13): this
 * file is the closed surface only, and everything it re-exports is a name,
 * never a declaration.
 */

/**
 * The closed public surface: start, stop, terminate, and the types.
 *
 * Everything else is an implementation detail and stays behind the package
 * boundary. The first version of this file re-exported the root brand and its
 * resolver, the logger, signal installation, the identity inspector, the unwind
 * stack, the lock primitives and every constant — a second wide surface around
 * precisely the boundaries this package exists to draw. A consumer given
 * `resolveDaemonRoot` and `installSignalHandlers` can assemble its own daemon
 * beside this one, and then the singleton means nothing.
 *
 * P-13 narrowed it further, to exactly what structure §2 reserves for this
 * barrel: the three lifecycle functions and the public types. The observation
 * and recovery helpers (`readOwnStatus`, `recoverOwnStaleLock`) and the
 * launchd rendering/validation surface moved with the composition root into
 * `./composition/index.ts`. There are no external importers of this package,
 * so nothing needs a compatibility re-export, and the fence pins the closed
 * set by membership: a withdrawn name returning to this file fails rather
 * than silently widening the surface.
 *
 * Tests import the relative modules directly. That is deliberate: they are
 * inside the boundary, and narrowing the public surface is not meant to make
 * the package harder to prove.
 */
export { startDaemon, stopDaemon, terminateDaemon } from "./composition/index.js";
export type { DaemonOptions, DaemonRun, StopResult } from "./composition/index.js";
export type { DaemonMode } from "./lifecycle/index.js";
export type { DaemonErrorCode } from "./errors/index.js";
export {
  DaemonError,
  DaemonRootError,
  IdentityProbeError,
  ModeError,
  ShutdownError,
  SingletonError,
  StaleLockError,
  StartupError,
  SupervisionError,
} from "./errors/index.js";
export type { IdentityVerdict } from "./identity-probe/index.js";
export type { RecoveryResult } from "./singleton/index.js";
export type { DaemonPhase, DaemonStatusDocument } from "./status/index.js";
