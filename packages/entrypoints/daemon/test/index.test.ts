import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { daemonRootPath } from "../src/paths/index.js";

/**
 * Importing this package must do nothing at all.
 *
 * Deliberately a **fresh process**, not a snapshot taken in this one. A
 * same-process check cannot tell an effect that never happened from one that
 * happened before the test started: the directory another suite created, the
 * handler Vitest installed, the socket something else opened. Only a process
 * that has done nothing else can answer the question.
 */

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const PACKAGE_ROOT = dirname(HERE);
const ENTRY = join(PACKAGE_ROOT, "dist", "index.js");

beforeAll(() => {
  const built = spawnSync(process.execPath, [
    join(PACKAGE_ROOT, "..", "..", "..", "node_modules", "typescript", "bin", "tsc"),
    "--build",
    join(PACKAGE_ROOT, "tsconfig.json"),
  ]);
  if (built.status !== 0 || !existsSync(ENTRY)) {
    throw new Error("could not build the daemon package for the purity drill");
  }
}, 120_000);

describe("importing the daemon package", () => {
  it("creates nothing, binds nothing, spawns nothing and handles no signal", () => {
    // The owned root must not exist beforehand, or "it was not created" would
    // be unfalsifiable.
    rmSync(daemonRootPath(), { recursive: true, force: true });

    const probe = [
      "const fs = require('node:fs');",
      "const root = " + JSON.stringify(daemonRootPath()) + ";",
      "const before = fs.existsSync(root);",
      "import(" + JSON.stringify("file://" + ENTRY) + ").then((module) => {",
      "  console.log(JSON.stringify({",
      "    before,",
      "    rootExists: fs.existsSync(root),",
      "    sigterm: process.listenerCount('SIGTERM'),",
      "    sigint: process.listenerCount('SIGINT'),",
      "    resources: process.getActiveResourcesInfo(),",
      "    exportsStartDaemon: typeof module.startDaemon === 'function',",
      "  }));",
      "});",
    ].join("\n");

    // A bogus argv tail, after `--` so Node passes it through rather than
    // trying to parse it as an option of its own. If anything in the package
    // parsed argv on import, this is what it would choke on.
    const result = spawnSync(process.execPath, ["-e", probe, "--", "--not-a-real-flag", "{}"], {
      encoding: "utf8",
      cwd: PACKAGE_ROOT,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const observed = JSON.parse(result.stdout.trim()) as {
      before: boolean;
      rootExists: boolean;
      sigterm: number;
      sigint: number;
      resources: string[];
      exportsStartDaemon: boolean;
    };

    // The module really did load, so the absences below mean something.
    expect(observed.exportsStartDaemon).toBe(true);
    expect(observed.before).toBe(false);
    expect(observed.rootExists).toBe(false);
    expect(observed.sigterm).toBe(0);
    expect(observed.sigint).toBe(0);
    expect(observed.resources).not.toContain("ChildProcess");
    expect(observed.resources).not.toContain("TCPServerWrap");
    expect(observed.resources).not.toContain("TCPWrap");
  });

  it("does nothing when the child entry is imported rather than executed", () => {
    rmSync(daemonRootPath(), { recursive: true, force: true });
    const childEntry = join(PACKAGE_ROOT, "dist", "daemon-child", "index.js");
    const probe = [
      "const fs = require('node:fs');",
      "const root = " + JSON.stringify(daemonRootPath()) + ";",
      "import(" + JSON.stringify("file://" + childEntry) + ").then(() => {",
      "  console.log(JSON.stringify({ rootExists: fs.existsSync(root), code: process.exitCode ?? 0 }));",
      "});",
    ].join("\n");

    const result = spawnSync(process.execPath, ["-e", probe], {
      encoding: "utf8",
      cwd: PACKAGE_ROOT,
    });
    expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout.trim()) as { rootExists: boolean; code: number };
    // The entry-point guard compares argv[1] to its own path, so importing it
    // is inert while executing it is not.
    expect(observed.rootExists).toBe(false);
    expect(observed.code).toBe(0);
  });
});
