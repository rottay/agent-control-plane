import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PRODUCT_PATH_MARKERS } from "@acp/contracts";

import { afterEach, describe, expect, it } from "vitest";

import {
  BASE_ENV_KEYS,
  PROVIDER_CONFIG_ENV,
  PROVIDER_EXTRA_ENV,
  admitConfigRoot,
  admitWorkdir,
  allowedEnvKeys,
  buildEnv,
} from "../../src/config-root/index.js";
import { AdapterError } from "../../src/errors/index.js";
import { PROVIDER_NAMES } from "../../src/contract/index.js";

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
  it("allows four variables per provider, and five for claude (USER, ADR 0101)", () => {
    for (const provider of PROVIDER_NAMES) {
      expect(allowedEnvKeys(provider)).toEqual(
        [...BASE_ENV_KEYS, PROVIDER_CONFIG_ENV[provider], ...PROVIDER_EXTRA_ENV[provider]].sort(),
      );
    }
    expect(allowedEnvKeys("claude")).toEqual(["CLAUDE_CONFIG_DIR", "HOME", "LC_ALL", "PATH", "USER"]);
    expect(allowedEnvKeys("kimi")).toHaveLength(4);
    expect(allowedEnvKeys("codex")).toHaveLength(4);
    expect(PROVIDER_EXTRA_ENV).toEqual({ claude: ["USER"], kimi: [], codex: [] });
  });

  it("gives claude the USER of the parent, and kimi and codex never", () => {
    const root = drillRoot();
    const prior = process.env["USER"];
    process.env["USER"] = "acp-" + "fixture-login";
    try {
      expect(buildEnv("claude", admitConfigRoot(root, CONTEXT))["USER"]).toBe("acp-fixture-login");
      for (const provider of ["kimi", "codex"] as const) {
        expect(Object.hasOwn(buildEnv(provider, admitConfigRoot(root, CONTEXT)), "USER")).toBe(false);
      }
    } finally {
      if (prior === undefined) delete process.env["USER"];
      else process.env["USER"] = prior;
    }
  });

  it("leaves USER absent when the parent has none: never an empty string, never invented", () => {
    const root = drillRoot();
    const prior = process.env["USER"];
    delete process.env["USER"];
    try {
      const env = buildEnv("claude", admitConfigRoot(root, CONTEXT));
      expect(Object.hasOwn(env, "USER")).toBe(false);
      expect(Object.keys(env).every((key) => allowedEnvKeys("claude").includes(key))).toBe(true);
    } finally {
      if (prior !== undefined) process.env["USER"] = prior;
    }
  });

  it("copies an extra only when the parent's value is a string, so an empty string travels as itself", () => {
    const root = drillRoot();
    const prior = process.env["USER"];
    process.env["USER"] = "";
    try {
      expect(buildEnv("claude", admitConfigRoot(root, CONTEXT))["USER"]).toBe("");
    } finally {
      if (prior === undefined) delete process.env["USER"];
      else process.env["USER"] = prior;
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
      // The extras path copies its own keys and no other.
      const claude = buildEnv("claude", admitConfigRoot(root, CONTEXT));
      expect(Object.hasOwn(claude, "ACP_P4A_SHOULD_NOT_TRAVEL")).toBe(false);
    } finally {
      delete process.env["ACP_P4A_SHOULD_NOT_TRAVEL"];
    }
  });
});

// ---------------------------------------------------------------------------
// P-15 escalón D3: the shared product-path vector table (ADR 0105, decision 139)
// ---------------------------------------------------------------------------

/** The table `@acp/contracts` holds for both admissions: data, read from disk. */
const VECTOR_TABLE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../kernel/contracts/test/testing/product-path-vectors/index.json",
);

interface PathVector {
  readonly condition: string;
  readonly marker: string | null;
  readonly verdict: "ADMITTED" | "REFUSED";
}

/** Read the table, or fail loudly: an absent or malformed table is a broken fixture, never an empty one. */
function readVectors(path: string): readonly PathVector[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const vectors = (parsed as { readonly vectors?: unknown }).vectors;
  if (!Array.isArray(vectors) || vectors.length === 0) throw new Error("the vector table carries no vectors");
  return vectors.map((entry: unknown, index) => {
    const vector = entry as Record<string, unknown>;
    const { condition, marker, verdict } = vector;
    if (
      typeof condition !== "string" ||
      (marker !== null && typeof marker !== "string") ||
      (verdict !== "ADMITTED" && verdict !== "REFUSED")
    ) {
      throw new Error("the vector table's row " + String(index) + " is malformed");
    }
    return { condition, marker, verdict };
  });
}

/** The candidate one condition names, built in a fresh owned root. */
function candidateFor(vector: PathVector): string {
  switch (vector.condition) {
    case "ADMITTED":
      return drillRoot();
    case "RELATIVE":
      return "relative/config-root";
    case "ABSENT":
      return join(TMP_ROOT, "acp-p4a-absent-" + randomUUID());
    case "SYMLINK": {
      const link = join(TMP_ROOT, "acp-p4a-link-" + randomUUID());
      symlinkSync(drillRoot(), link);
      created.push(link);
      return link;
    }
    case "FILE": {
      const file = join(drillRoot(), "not-a-dir");
      writeFileSync(file, "x");
      return file;
    }
    case "GROUP_WRITABLE":
      return drillRoot(0o770);
    case "WORLD_WRITABLE":
      return drillRoot(0o707);
    case "PRODUCT_PATH": {
      const path = drillRoot() + (vector.marker ?? "") + "x";
      mkdirSync(path, { recursive: true, mode: 0o700 });
      return path;
    }
    case "NEAR_MISS": {
      const path = drillRoot() + (vector.marker ?? "");
      mkdirSync(path, { recursive: true, mode: 0o700 });
      return path;
    }
    default:
      throw new Error("the vector table names a condition this suite cannot build: " + vector.condition);
  }
}

describe("the shared vector table holds the providers' admission to one answer (P-15/D3)", () => {
  it("admits and refuses every row as the table says, and names every contracts marker", () => {
    const vectors = readVectors(VECTOR_TABLE);
    for (const vector of vectors) {
      const candidate = candidateFor(vector);
      const label = vector.condition + (vector.marker ?? "");
      if (vector.verdict === "ADMITTED") {
        expect(admitConfigRoot(candidate, CONTEXT), label).toBe(candidate);
      } else {
        expect(() => admitConfigRoot(candidate, CONTEXT), label).toThrow(/CONFIG_ROOT_REFUSED/);
      }
    }
    // Every declared marker is exercised in its own spelling; the case variants and the
    // near miss ride beside them (P-15/D3 v2).
    const exercised = vectors.flatMap((vector) => (vector.marker === null ? [] : [vector.marker]));
    expect(exercised.filter((marker) => PRODUCT_PATH_MARKERS.includes(marker))).toEqual([...PRODUCT_PATH_MARKERS]);
    expect(exercised.length).toBeGreaterThan(PRODUCT_PATH_MARKERS.length);
  });

  it("fails loudly on a malformed copy of the table, and on an absent one", () => {
    const root = drillRoot();
    const copy = join(root, "index.json");
    writeFileSync(copy, JSON.stringify({ vectors: [{ condition: "ADMITTED", marker: null, verdict: "MAYBE" }] }));
    expect(() => readVectors(copy)).toThrow("the vector table's row 0 is malformed");
    expect(() => readVectors(join(root, "absent.json"))).toThrow(/ENOENT/);
  });
});
