import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BASE_ENV_KEYS,
  PROVIDER_CONFIG_ENV,
  admitConfigRoot,
  admitWorkdir,
  allowedEnvKeys,
  buildEnv,
} from "./config-root.js";
import { AdapterError } from "./errors.js";
import { PROVIDER_NAMES } from "./contract.js";

const CONTEXT = { provider: "claude", taskId: "00000000-0000-4000-8000-00000000000a" };
const created: string[] = [];

/**
 * The canonical temporary root.
 *
 * On macOS `os.tmpdir()` is itself a symlink (`/var/...` → `/private/var/...`),
 * so a path built on it is not canonical and admission correctly refuses it.
 * The admission requires a canonical directory; the drill's job is to supply
 * one, not to make the rule looser.
 */
const TMP_ROOT = realpathSync(tmpdir());

function drillRoot(mode = 0o700): string {
  const path = join(TMP_ROOT, "acp-p4a-root-" + randomUUID());
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
  created.push(path);
  return path;
}

afterEach(() => {
  // Only this drill's own directories, each matched against the exact prefix
  // it was created with.
  const prefix = join(TMP_ROOT, "acp-p4a-");
  while (created.length > 0) {
    const path = created.pop();
    if (path?.startsWith(prefix) === true) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("a config root is admitted, never assumed", () => {
  it("admits an absolute, canonical, owned, tight directory", () => {
    const root = drillRoot();
    expect(admitConfigRoot(root, CONTEXT)).toBe(root);
    expect(admitWorkdir(root, CONTEXT)).toBe(root);
  });

  it("refuses a relative path", () => {
    expect(() => admitConfigRoot("relative/path", CONTEXT)).toThrow(AdapterError);
  });

  it("refuses an absent root rather than creating it", () => {
    // The P3A law: a component that creates the directory it is pointed at can
    // be aimed anywhere and will report, truthfully and uselessly, nothing.
    const missing = join(TMP_ROOT, "acp-p4a-absent-" + randomUUID());
    expect(() => admitConfigRoot(missing, CONTEXT)).toThrow(AdapterError);
    expect(() => admitConfigRoot(missing, CONTEXT)).toThrow(/CONFIG_ROOT_REFUSED/);
  });

  it("refuses a symlinked root", () => {
    const real = drillRoot();
    const link = join(TMP_ROOT, "acp-p4a-link-" + randomUUID());
    symlinkSync(real, link);
    created.push(link);
    expect(() => admitConfigRoot(link, CONTEXT)).toThrow(AdapterError);
  });

  it("refuses a file where a directory was expected", () => {
    const root = drillRoot();
    const file = join(root, "not-a-dir");
    writeFileSync(file, "x");
    expect(() => admitConfigRoot(file, CONTEXT)).toThrow(AdapterError);
  });

  it("refuses a group- or world-writable root", () => {
    const root = drillRoot(0o777);
    expect(() => admitConfigRoot(root, CONTEXT)).toThrow(AdapterError);
  });

  it("refuses anything that looks like a product checkout", () => {
    // Constructed as a literal so this test does not itself name a real
    // product path; the check is on the marker, and the marker is the point.
    const marker = "/Rottay/app-" + "example";
    expect(() => admitConfigRoot(marker + "/config", CONTEXT)).toThrow(AdapterError);
  });
});

describe("the environment is built, never inherited", () => {
  it("allows exactly four variables per provider", () => {
    for (const provider of PROVIDER_NAMES) {
      expect(allowedEnvKeys(provider)).toEqual(
        [...BASE_ENV_KEYS, PROVIDER_CONFIG_ENV[provider]].sort(),
      );
      expect(allowedEnvKeys(provider)).toHaveLength(4);
    }
  });

  it("gives each provider its own configuration variable and no other", () => {
    expect(PROVIDER_CONFIG_ENV).toEqual({
      claude: "CLAUDE_CONFIG_DIR",
      kimi: "KIMI_CODE_HOME",
      codex: "CODEX_HOME",
    });
  });

  it("builds an environment containing nothing outside the allowlist", () => {
    const root = drillRoot();
    const env = buildEnv("claude", admitConfigRoot(root, CONTEXT));
    for (const key of Object.keys(env)) {
      expect({ key, allowed: allowedEnvKeys("claude").includes(key) }).toEqual({
        key,
        allowed: true,
      });
    }
    expect(env["CLAUDE_CONFIG_DIR"]).toBe(root);
    expect(Object.hasOwn(env, "KIMI_CODE_HOME")).toBe(false);
    expect(Object.hasOwn(env, "CODEX_HOME")).toBe(false);
  });

  it("does not forward an arbitrary variable that happens to be set", () => {
    const root = drillRoot();
    process.env["ACP_P4A_SHOULD_NOT_TRAVEL"] = "leaked";
    try {
      const env = buildEnv("kimi", admitConfigRoot(root, CONTEXT));
      expect(Object.hasOwn(env, "ACP_P4A_SHOULD_NOT_TRAVEL")).toBe(false);
    } finally {
      delete process.env["ACP_P4A_SHOULD_NOT_TRAVEL"];
    }
  });
});
