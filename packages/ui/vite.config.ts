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
 * The Vite build output goes under `dist/web` so it cannot collide with the
 * TypeScript project output under `dist/app`.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5178,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 5178,
    strictPort: true,
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    sourcemap: true,
  },
});
