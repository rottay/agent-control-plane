import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Local development server configuration.
 *
 * The dev and preview servers bind loopback explicitly and refuse to fall back
 * to another port. Both are deliberate: the observation UI shows task and
 * worker state with no authentication in front of it, so it must never be
 * reachable from the local network, and a silent port fallback is how a
 * developer ends up looking at a stale build on the port they expected.
 *
 * Both servers also proxy `/api` to the observation server on loopback. The
 * client fetches same-origin relative paths and holds no base URL, so without
 * this a developer would have to point it at an absolute origin and reintroduce
 * exactly the cross-origin surface the same-origin rule exists to avoid. The
 * target is the loopback constant and the default port from `@acp/server`,
 * restated here rather than imported: the UI may depend on
 * `@acp/api-contracts` only, and a proxy target is dev tooling configuration
 * that never reaches the browser bundle.
 *
 * The Vite build output goes under `dist/web` so it cannot collide with the
 * TypeScript project output under `dist/app`.
 */

/** Loopback only. Never a hostname, never an interface address. */
export const API_PROXY_TARGET = "http://127.0.0.1:7517";

/** The one prefix the observation contract serves. */
export const API_PROXY_PREFIX = "/api";

const apiProxy = {
  [API_PROXY_PREFIX]: {
    target: API_PROXY_TARGET,
    changeOrigin: false,
  },
} as const;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5178,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    host: "127.0.0.1",
    port: 5178,
    strictPort: true,
    proxy: apiProxy,
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    sourcemap: true,
  },
});
