/**
 * Process exit conventions — `@acp/contracts` (P8-T G7, D1).
 *
 * The two codes every entrypoint agrees on. `acp`, `acp-server` and
 * `acp-daemon` each declared their own `EXIT_OK = 0` / `EXIT_USAGE = 2`,
 * byte-identical and independently maintained, which is the shape a shared
 * convention takes right before one of the three drifts.
 *
 * They live in `contracts` rather than in `protocol` deliberately: an exit code
 * is a **process** convention, not a wire shape. Nothing serializes it, no route
 * carries it, and a reader looking for the HTTP vocabulary should not find shell
 * semantics there. What makes them belong together at all is that a script
 * calling any of the three binaries branches on the same two numbers.
 *
 * Codes beyond these two stay with the entrypoint that defines them: `acp`'s
 * `EXIT_INTEGRITY`, the daemon's `EXIT_CONFIG_PATH`, the gateway's `EXIT_PATH`
 * are each one process's own vocabulary, and hoisting them here would invent a
 * shared convention that does not exist.
 */

/** The process did what was asked. */
export const EXIT_OK = 0;

/** The caller asked wrongly — a flag, an argument, a missing required value. */
export const EXIT_USAGE = 2;
