import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { AdmittedBinary, AdmittedWorkdir, SessionDescriptor, SessionLimits } from "../../../src/contract/index.js";
import { AdapterError } from "../../../src/errors/index.js";
import { admitBinary, spawnAdmitted } from "../../../src/process/spawn/index.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");
const ADAPTERS_SRC = join(PACKAGE_ROOT, "src");
const CONTEXT = { provider: "claude", taskId: "00000000-0000-4000-8000-00000000000a" };
const TMP_ROOT = realpathSync(tmpdir());
const created: string[] = [];
const spawnedPids: number[] = [];

const LIMITS: SessionLimits = {
  timeoutMs: 5_000,
  outputBudgetBytes: 64 * 1024,
  interruptGraceMs: 100,
  termGraceMs: 100,
};

function drillDir(): string {
  const path = join(TMP_ROOT, "acp-p4a-spawn-" + randomUUID());
  mkdirSync(path, { recursive: true, mode: 0o700 });
  created.push(path);
  return path;
}

afterEach(() => {
  const prefix = join(TMP_ROOT, "acp-p4a-");
  while (created.length > 0) {
    const path = created.pop();
    if (path?.startsWith(prefix) === true) rmSync(path, { recursive: true, force: true });
  }
});

describe("a binary is admitted before it is executed", () => {
  it("admits the running Node binary, which is absolute, canonical and owned", () => {
    const node = realpathSync(process.execPath);
    expect(admitBinary(node, CONTEXT)).toBe(node);
  });

  it("refuses a relative path", () => {
    expect(() => admitBinary("node", CONTEXT)).toThrow(AdapterError);
    try {
      admitBinary("node", CONTEXT);
    } catch (error) {
      expect((error as AdapterError).code).toBe("BINARY_NOT_ADMITTED");
    }
  });

  it("refuses an absent binary", () => {
    expect(() => admitBinary(join(TMP_ROOT, "acp-p4a-missing-" + randomUUID()), CONTEXT)).toThrow(
      AdapterError,
    );
  });

  it("refuses a symlink rather than following it", () => {
    const dir = drillDir();
    const link = join(dir, "node-link");
    symlinkSync(realpathSync(process.execPath), link);
    expect(() => admitBinary(link, CONTEXT)).toThrow(AdapterError);
  });

  it("refuses a directory", () => {
    expect(() => admitBinary(drillDir(), CONTEXT)).toThrow(AdapterError);
  });

  it("refuses a group- or world-writable executable", () => {
    // An executable others can rewrite is not the binary anyone reviewed: the
    // admission would otherwise pass a file whose contents can change between
    // the check and the exec.
    const dir = drillDir();
    const copy = join(dir, "loose-binary");
    writeFileSync(copy, "#!/bin/sh\nexit 0\n");
    chmodSync(copy, 0o777);
    expect(() => admitBinary(copy, CONTEXT)).toThrow(AdapterError);
    try {
      admitBinary(copy, CONTEXT);
    } catch (error) {
      expect((error as AdapterError).code).toBe("BINARY_NOT_ADMITTED");
    }
    // The same file with owner-only permissions is admitted, so the refusal is
    // about the mode rather than about the file.
    chmodSync(copy, 0o700);
    expect(admitBinary(copy, CONTEXT)).toBe(copy);
  });
});

describe("the spawner is shell-free and pinned", () => {
  it("spawns with an array argv and an environment it was given", async () => {
    const dir = drillDir();
    const descriptor: SessionDescriptor = {
      provider: "claude",
      argv: ["-e", "process.stdout.write(process.env.MARKER ?? 'none'); process.exit(0);"],
      env: { MARKER: "pinned", PATH: "/usr/bin:/bin" },
      cwd: dir as AdmittedWorkdir,
    };
    const spawned = spawnAdmitted(
      realpathSync(process.execPath) as AdmittedBinary,
      descriptor,
      LIMITS,
      CONTEXT,
    );
    spawnedPids.push(spawned.pid);

    const seen = await new Promise<string>((resolveText) => {
      let text = "";
      spawned.child.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      spawned.child.on("close", () => {
        resolveText(text);
      });
    });
    expect(seen).toBe("pinned");
  });

  it("does not inherit an ambient variable the descriptor did not name", async () => {
    const dir = drillDir();
    process.env["ACP_P4A_AMBIENT"] = "leaked";
    try {
      const spawned = spawnAdmitted(
        realpathSync(process.execPath) as AdmittedBinary,
        {
          provider: "claude",
          argv: ["-e", "process.stdout.write(process.env.ACP_P4A_AMBIENT ?? 'absent');"],
          env: { PATH: "/usr/bin:/bin" },
          cwd: dir as AdmittedWorkdir,
        },
        LIMITS,
        CONTEXT,
      );
      spawnedPids.push(spawned.pid);
      const seen = await new Promise<string>((resolveText) => {
        let text = "";
        spawned.child.stdout.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
        });
        spawned.child.on("close", () => {
          resolveText(text);
        });
      });
      expect(seen).toBe("absent");
    } finally {
      delete process.env["ACP_P4A_AMBIENT"];
    }
  });

  it("re-asserts admission immediately before exec", () => {
    // The path was admitted at some earlier moment; a check done only early is
    // a memory, not a check.
    expect(() =>
      spawnAdmitted(
        "relative-binary" as AdmittedBinary,
        {
          provider: "claude",
          argv: [],
          env: {},
          cwd: drillDir() as AdmittedWorkdir,
        },
        LIMITS,
        CONTEXT,
      ),
    ).toThrow(AdapterError);
  });
});

describe("the spawner's own source obeys the laws the fence asserts", () => {
  const source = readFileSync(join(ADAPTERS_SRC, "process", "spawn", "index.ts"), "utf8");
  /** Comments explain why a thing is absent; only code is under assertion. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("never enables a shell", () => {
    expect(code).not.toContain("shell:");
  });

  it("never spreads the ambient environment", () => {
    expect(code).not.toContain("...process.env");
  });

  it("passes stdio, timeout and killSignal explicitly, and no dead maxBuffer", () => {
    expect(code).toContain("stdio:");
    expect(code).toContain("timeout:");
    expect(code).toContain("killSignal:");
    // `maxBuffer` is an exec/execFile option that `spawn` silently ignores.
    // Mandating it would enforce a dead argument while the real output bound
    // went unimplemented; the bound is a manual byte count in session/index.ts. The
    // assertion is on code, because the comment above says the word too.
    expect(code).not.toContain("maxBuffer");
  });

  it("is the only file in the package importing node:child_process", () => {
    const packageSrc = ADAPTERS_SRC;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
        if (entry.name.endsWith(".test.ts")) continue;
        if (/from\s*["']node:child_process["']/.test(readFileSync(full, "utf8"))) {
          offenders.push(full.slice(packageSrc.length + 1));
        }
      }
    };
    walk(packageSrc);
    expect(offenders).toEqual(["process/spawn/index.ts"]);
  });
});
