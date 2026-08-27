import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

/**
 * Browser entry point.
 *
 * The mount node is looked up and checked. A missing root is a broken build,
 * and a broken build should fail loudly at start rather than render a blank
 * page that looks like an empty control plane.
 */
const container = document.getElementById("root");

if (container === null) {
  throw new Error("the #root mount node is missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
