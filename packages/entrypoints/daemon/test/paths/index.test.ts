import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DIR_MODE } from "../../src/constants/index.js";
import { DaemonRootError } from "../../src/errors/index.js";
import {
  assertOwnerOnlyDirectory,
  daemonRootPath,
  existingDaemonRoot,
  logDirPath,
  logFilePath,
  pidfilePath,
  redactPath,
  resolveDaemonRoot,
  statusPath,
} from "../../src/paths/index.js";
import { readOwnStatus } from "../../src/index.js";

afterEach(() => {
  rmSync(daemonRootPath(), { recursive: true, force: true });
});

describe("the owned daemon root", () => {
  it("creates itself owner-only and proves it with a stat", () => {
    const root = resolveDaemonRoot();
    expect(existsSync(root)).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(DIR_MODE);
    expect(statSync(logDirPath(root)).mode & 0o777).toBe(DIR_MODE);
  });

  it("is idempotent", () => {
    const first = resolveDaemonRoot();
    const second = resolveDaemonRoot();
    expect(second).toBe(first);
  });

  it("refuses a directory whose mode is not owner-only", () => {
    // The mode argument to mkdir is masked by umask, so a directory asked for
    // as 0700 can arrive as 0755 and nothing complains. This is why the check
    // is a stat rather than the constant that was requested.
    const target = daemonRootPath();
    mkdirSync(target, { recursive: true, mode: DIR_MODE });
    chmodSync(target, 0o755);
    expect(() => { assertOwnerOnlyDirectory(target); }).toThrow(DaemonRootError);
    expect(() => resolveDaemonRoot()).toThrow(/not 700/);
  });

  it("refuses a path that is not a directory", () => {
    const root = resolveDaemonRoot();
    expect(() => { assertOwnerOnlyDirectory(join(root, "..", "daemon", "..", "..", "package.json")); }).toThrow(
      DaemonRootError,
    );
  });

  it("places every owned file inside the root", () => {
    const root = resolveDaemonRoot();
    for (const path of [pidfilePath(root), statusPath(root), logFilePath(root)]) {
      expect(path.startsWith(root)).toBe(true);
    }
  });
});

describe("observing without creating", () => {
  it("returns null for an absent root and leaves the checkout untouched", () => {
    rmSync(daemonRootPath(), { recursive: true, force: true });
    expect(existingDaemonRoot()).toBeNull();
    // The point of the test: asking the question did not answer it into
    // existence. An observation that has to create a directory before it can
    // report "nothing here" is making the thing it claims to observe.
    expect(existsSync(daemonRootPath())).toBe(false);

    expect(readOwnStatus()).toBeNull();
    expect(existsSync(daemonRootPath())).toBe(false);
  });

  it("finds the root once a daemon has created it", () => {
    const root = resolveDaemonRoot();
    expect(existingDaemonRoot()).toBe(root);
  });

  it("still refuses a root whose mode is wrong", () => {
    const target = daemonRootPath();
    mkdirSync(target, { recursive: true, mode: DIR_MODE });
    chmodSync(target, 0o755);
    expect(() => existingDaemonRoot()).toThrow(DaemonRootError);
  });
});

describe("path redaction", () => {
  it("renders repository paths relative and refuses to name anything else", () => {
    const root = resolveDaemonRoot();
    // An absolute path names a home directory, a user account and a machine
    // layout, so nothing that leaves this process may carry one.
    expect(redactPath(root)).toBe(".acp-local/daemon");
    expect(redactPath("/etc/passwd")).toBe("<outside-repository>");
    expect(redactPath("/Users/someone/secrets")).toBe("<outside-repository>");
  });
});
