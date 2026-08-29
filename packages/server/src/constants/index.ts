/**
 * Loopback. Not configurable, by design.
 *
 * The observation surface shows every task, worker and transition with no
 * authentication in front of it. A bind address is not a deployment
 * preference here: `0.0.0.0` would publish the whole control plane to the
 * local network. See `docs/architecture/0003-read-only-observation-plane.md`.
 */
export const SERVER_BIND_HOST = "127.0.0.1";

/** Default local port. The port is not a law; a caller may choose another. */
export const SERVER_DEFAULT_PORT = 7517;
