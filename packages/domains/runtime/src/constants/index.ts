/**
 * Frozen runtime constants for the durability and supervisor plane.
 *
 * Everything here is a value that P2A can state truthfully today. There is no
 * driver, no listener and no process behind any of it: these are the addresses
 * a later phase must bind, the versions it must pin, and the directories it may
 * write into, fixed now so three later phases cannot each invent their own.
 */

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * The only address anything in this plane may bind.
 *
 * Not a default and not a preference. The control plane exposes task, worker
 * and transition state with no authentication in front of it, and the Restate
 * admin API can mutate service registration. Binding anything else publishes
 * both to the local network. Every port below is paired with this host, and the
 * drills assert that no non-loopback listener exists.
 */
export const LOOPBACK_HOST = "127.0.0.1";

/** Restate ingress. Where invocations are submitted. */
export const RESTATE_INGRESS_PORT = 8080;

/** Restate admin. Service registration and introspection. */
export const RESTATE_ADMIN_PORT = 9070;

/** This package's SDK endpoint, once it exists. Restate calls in on this. */
export const RUNTIME_SERVICE_PORT = 9080;

/** The P1 observation API. Restated here only so collisions are provable. */
export const OBSERVATION_API_PORT = 7517;

/** The P1 UI dev and preview server. Same reason. */
export const UI_PORT = 5178;

export const RESTATE_INGRESS_URL = "http://" + LOOPBACK_HOST + ":" + String(RESTATE_INGRESS_PORT);
export const RESTATE_ADMIN_URL = "http://" + LOOPBACK_HOST + ":" + String(RESTATE_ADMIN_PORT);
export const RUNTIME_SERVICE_URL = "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT);

/**
 * Every port this repository claims on loopback, in one list.
 *
 * A later phase that adds a port adds it here, where a duplicate is visible,
 * rather than discovering the clash when two processes fight for a socket.
 */
export const RESERVED_LOOPBACK_PORTS: readonly number[] = Object.freeze([
  OBSERVATION_API_PORT,
  UI_PORT,
  RESTATE_INGRESS_PORT,
  RESTATE_ADMIN_PORT,
  RUNTIME_SERVICE_PORT,
]);

// ---------------------------------------------------------------------------
// Pinned tool versions
// ---------------------------------------------------------------------------

/** The SDK version this package is compiled against. A dependency. */
export const RESTATE_SDK_VERSION = "1.16.9";

/**
 * The Restate server version the drills run against.
 *
 * Deliberately NOT a dependency. The `@restatedev/restate-server` npm package
 * pulls `@scarf/scarf`, whose postinstall is a network beacon, and this
 * repository's install policy exists precisely so no package phones home while
 * being installed. The server is an external binary, acquired into
 * `.acp-local/tools/` by an explicit operator command that verifies platform
 * and SHA-256, and never by an install hook.
 */
export const RESTATE_SERVER_VERSION = "1.7.7";

// ---------------------------------------------------------------------------
// Data roots
// ---------------------------------------------------------------------------

/**
 * Repository-relative, git-ignored directory segments.
 *
 * These are segments, never captured absolute paths. An absolute path names a
 * home directory, a user account and a machine layout, and the observation
 * plane already went to some trouble to keep exactly that out of anything a
 * reader can see. A constant that hard-coded one would put it back.
 */
export const DATA_ROOT_RESTATE = "restate-data";

/** Local-only working root: tools, drill scratch, pid and log files. */
export const DATA_ROOT_LOCAL = ".acp-local";

/** External pinned binaries, checksum-verified on acquisition. */
export const DATA_ROOT_TOOLS = ".acp-local/tools";

/** Disposable toy repositories and databases the drills create and own. */
export const DATA_ROOT_DRILLS = ".acp-local/drills";

export const DATA_ROOTS: readonly string[] = Object.freeze([
  DATA_ROOT_RESTATE,
  DATA_ROOT_LOCAL,
  DATA_ROOT_TOOLS,
  DATA_ROOT_DRILLS,
]);

// ---------------------------------------------------------------------------
// Restate object and cache
// ---------------------------------------------------------------------------

/**
 * The one Virtual Object, keyed by task id.
 *
 * One object per task is what gives the plane a single writer per task without
 * a lease: Restate serialises handler invocations for one key, so two
 * submissions for the same task cannot interleave.
 */
export const RESTATE_OBJECT_NAME = "AcpTask";

/** The handler the ingress submits to. */
export const RESTATE_HANDLER_ADVANCE = "advance";

/** The read-only handler that exposes the cache for reconciliation. */
export const RESTATE_HANDLER_READ_CACHE = "readCache";

/**
 * The ONE state key the object is allowed to hold.
 *
 * `ctx.stateKeys()` returning anything else is itself a finding: the object's
 * state is a cache of ledger-derived values, and a second key would be a second
 * account of what happened.
 */
export const RESTATE_STATE_KEY_CACHE = "acpCache";

/** Repository-relative path of the tracked server pin. Never a URL at runtime. */
export const RESTATE_SERVER_SHA256_PIN_PATH = "scripts/restate-server.pin.json";

/** The pinned server version the drills run against. */
export const RESTATE_SERVER_INSTALL_DIR = ".acp-local/tools/restate-server-" + RESTATE_SERVER_VERSION;
