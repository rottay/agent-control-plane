import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CONTRACT_VERSION, buildIdempotencyKey } from "@acp/contracts";

import { OBSERVATION_KINDS, observationRootPath } from "../../../src/roots/index.js";
import type { ArtifactHandle } from "../../../src/roots/index.js";
import { collectArtifact, isPlainRecord, readBoundedJson } from "../../../src/collect/artifact/index.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..", "..");
const OBSERVATION_COLLECT_SRC = join(PACKAGE_ROOT, "src", "collect");

/**
 * Every production `.ts` file under `src/collect/`, named by its path
 * relative to that directory — e.g. `"artifact/index.ts"`.
 *
 * Mirrors the same recursive walk `test/roots/index.test.ts` needs, scoped
 * to this module's own subdomain: `src/collect/` now nests `artifact/` and
 * `scenario/` rather than holding them as flat siblings, so a flat
 * `readdirSync` would silently stop seeing either of them.
 */
function collectSources(directory: string, prefix = ""): { readonly name: string; readonly source: string }[] {
  const found: { readonly name: string; readonly source: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...collectSources(join(directory, entry.name), prefix + entry.name + "/"));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    found.push({ name: prefix + entry.name, source: readFileSync(join(directory, entry.name), "utf8") });
  }
  return found;
}

function makeRoots(): void {
  for (const kind of OBSERVATION_KINDS) {
    mkdirSync(observationRootPath(kind), { recursive: true, mode: 0o700 });
  }
}

function removeRoots(): void {
  rmSync(join(REPO_ROOT, ".acp-local", "shadow"), { recursive: true, force: true });
}

afterEach(() => {
  removeRoots();
});

/** A minimal, contract-valid event. Every field a real one carries. */
function makeEventRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const taskId = randomUUID();
  const attempt = 1;
  const transitionId = "discover";
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: randomUUID(),
    taskId,
    attempt,
    transitionId,
    idempotencyKey: buildIdempotencyKey({ taskId, attempt, transitionId }),
    type: "TASK_DISCOVERED",
    fromState: null,
    toState: "DISCOVERED",
    emittedBy: "kimi/k3/coordinator/01",
    occurredAt: "2026-08-27T12:00:00.000Z",
    recordedAt: "2026-08-27T12:00:00.000Z",
    correlationId: null,
    causationId: null,
    payload: {},
    ...overrides,
  };
}

function writeArtifact(name: string, content: string): void {
  const path = join(observationRootPath("artifacts"), name);
  writeFileSync(path, content);
  chmodSync(path, 0o600);
}

describe("collecting one passive artifact", () => {
  it("admits, reads and validates a well-formed event", () => {
    makeRoots();
    const record = makeEventRecord();
    writeArtifact("run.json", JSON.stringify(record));

    const collected = collectArtifact("run.json");
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    expect(collected.artifact.name).toBe("run.json");
    expect(collected.artifact.event).toMatchObject({ taskId: record["taskId"], type: "TASK_DISCOVERED" });
  });

  it("refuses malformed JSON", () => {
    makeRoots();
    writeArtifact("broken.json", "{ not json");

    const collected = collectArtifact("broken.json");
    expect(collected).toMatchObject({ ok: false, reason: "MALFORMED_JSON" });
  });

  it("propagates admission refusals unchanged", () => {
    // No root at all: ROOT_ABSENT, the admission-layer refusal, not a
    // collector-invented one.
    removeRoots();
    expect(collectArtifact("run.json")).toMatchObject({ ok: false, reason: "ROOT_ABSENT" });

    // A name that is a path: PATH_SUPPLIED, refused before any root lookup.
    makeRoots();
    expect(collectArtifact("../escape.json")).toMatchObject({ ok: false, reason: "PATH_SUPPLIED" });

    // An absent artifact under an existing root: NOT_OWNED_FILE.
    expect(collectArtifact("missing.json")).toMatchObject({ ok: false, reason: "NOT_OWNED_FILE" });
  });

  it("refuses an oversized artifact on admission, before any parse is attempted", () => {
    makeRoots();
    // ARTIFACT_MAX_BYTES is 4 MiB; comfortably exceeding it without allocating
    // that much twice is enough to prove the TOO_LARGE path is admission's,
    // not a JSON parse failure.
    writeArtifact("big.json", "[" + "1,".repeat(3_000_000) + "1]");

    expect(collectArtifact("big.json")).toMatchObject({ ok: false, reason: "TOO_LARGE" });
  });

  it("re-checks the byte bound on read, in case the file grew after admission", () => {
    makeRoots();
    const path = join(observationRootPath("artifacts"), "grown.json");
    writeFileSync(path, "{}");
    chmodSync(path, 0o600);

    // admitArtifact would admit this; readBoundedJson is exercised directly so
    // the second, later bound can be proven without racing a real write.
    writeFileSync(path, "x".repeat(5 * 1024 * 1024));
    const result = readBoundedJson(path as ArtifactHandle);
    expect(result).toMatchObject({ ok: false, reason: "TOO_LARGE" });
  });

  it("classifies a deletion between admission and read, rather than leaking ENOENT", () => {
    // F1's first face. The admitted handle is a path, and a path can stop
    // naming anything at all before the read happens. What must never escape
    // is a raw filesystem exception: every caller of this module is entitled
    // to a classified refusal.
    makeRoots();
    const path = join(observationRootPath("artifacts"), "vanishing.json");
    writeFileSync(path, "{}");
    chmodSync(path, 0o600);
    unlinkSync(path);

    let result;
    expect(() => {
      result = readBoundedJson(path as ArtifactHandle);
    }).not.toThrow();
    expect(result).toMatchObject({ ok: false, reason: "PATH_MISSING" });
  });

  it("refuses a symlink swapped in after admission, and never reads its target", () => {
    // F1's second and worst face. If the read followed the link, an artifact
    // name inside the allowlisted root would read a file outside it — the
    // allowlist defeated by a rename. `O_NOFOLLOW` makes the open itself fail,
    // so the target is never opened, let alone read.
    makeRoots();
    const outside = join(tmpdir(), "acp-f1-outside-" + randomUUID() + ".json");
    const sentinel = JSON.stringify({ sentinel: "outside the allowlist" });
    writeFileSync(outside, sentinel);

    const path = join(observationRootPath("artifacts"), "swapped.json");
    writeFileSync(path, "{}");
    chmodSync(path, 0o600);
    unlinkSync(path);
    symlinkSync(outside, path);

    try {
      const result = readBoundedJson(path as ArtifactHandle);
      expect(result).toMatchObject({ ok: false, reason: "PATH_NOT_CANONICAL" });
      if (!result.ok) expect(result.detail).not.toContain("sentinel");
      // The external file is untouched and still says what it said.
      expect(readFileSync(outside, "utf8")).toBe(sentinel);
    } finally {
      unlinkSync(outside);
    }
  });

  it("opens read-only and never follows a symlink", () => {
    // Exact source evidence for the one descriptor site the package permits:
    // one open, the exact permitted call, no write-capable flag. Equality
    // against the whole normalized call, not a token search: a token search
    // would admit a different handle or a numeric flag it cannot read.
    const source = readFileSync(join(OBSERVATION_COLLECT_SRC, "artifact", "index.ts"), "utf8");
    expect(source.split("openSync(").length - 1).toBe(1);
    const calls = [...source.matchAll(/openSync\([^()]*\)/g)].map((match) =>
      match[0].replace(/\s+/g, " ").trim(),
    );
    expect(calls).toEqual(["openSync(handle, constants.O_RDONLY | constants.O_NOFOLLOW)"]);
    for (const flag of ["O_WRONLY", "O_RDWR", "O_CREAT", "O_TRUNC", "O_APPEND", "O_EXCL"]) {
      expect({ flag, present: source.includes(flag) }).toEqual({ flag, present: false });
    }
  });

  it("classifies a failed close rather than discarding it", () => {
    // The close used to sit in a `finally` with an empty catch, so a failed
    // close was silently dropped next to whatever the read had already
    // decided. The ruling says unknown is never swallowed, and that includes
    // this branch: a descriptor that will not close means the module's belief
    // about it is wrong, which is a refusal, not a footnote.
    const source = readFileSync(join(OBSERVATION_COLLECT_SRC, "artifact", "index.ts"), "utf8");
    expect(source.split("closeSync(").length - 1).toBe(1);
    expect(source).toContain("closeSync(descriptor)");
    expect(source).toContain('return classifyReadFailure(error, "close");');
    // The close is not inside a `finally`, which is where it would have to be
    // swallowed, and no catch in this module is empty.
    expect(source).not.toMatch(/finally\s*\{[^}]*closeSync/);
    expect(source).not.toMatch(/catch[^{]*\{\s*\}/);
  });

  it("refuses a payload that carries credential or transcript material", () => {
    makeRoots();
    writeArtifact(
      "credential.json",
      JSON.stringify(makeEventRecord({ payload: { password: "placeholder" } })),
    );
    const credentialResult = collectArtifact("credential.json");
    expect(credentialResult).toMatchObject({ ok: false, reason: "CONTRACT_INVALID" });
    if (!credentialResult.ok) expect(credentialResult.detail).toContain("credential material is forbidden");

    writeArtifact(
      "transcript.json",
      JSON.stringify(makeEventRecord({ payload: { transcript: ["turn one"] } })),
    );
    const transcriptResult = collectArtifact("transcript.json");
    expect(transcriptResult).toMatchObject({ ok: false, reason: "CONTRACT_INVALID" });
    if (!transcriptResult.ok) {
      expect(transcriptResult.detail).toContain("provider transcript continuity is forbidden");
    }
  });

  it("refuses valid JSON that is not a single object", () => {
    makeRoots();
    writeArtifact("array.json", "[1, 2, 3]");
    expect(collectArtifact("array.json")).toMatchObject({ ok: false, reason: "WRONG_SHAPE" });

    writeArtifact("scalar.json", "42");
    expect(collectArtifact("scalar.json")).toMatchObject({ ok: false, reason: "WRONG_SHAPE" });

    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord({})).toBe(true);
  });

  it("refuses an event type outside the frozen vocabulary", () => {
    makeRoots();
    writeArtifact(
      "unknown-type.json",
      JSON.stringify(makeEventRecord({ type: "SOMETHING_NOT_IN_THE_TWENTY_ONE" })),
    );
    const result = collectArtifact("unknown-type.json");
    expect(result).toMatchObject({ ok: false, reason: "CONTRACT_INVALID" });
    if (!result.ok) expect(result.detail).toContain("does not satisfy the frozen ControlPlaneEvent contract");
  });
});

describe("the collect module cannot mutate or reach out", () => {
  it("imports no process, network, signal or write API in production modules", () => {
    // Structural, not behavioural, and the same law `test/roots/index.test.ts`
    // already proves for the boundary this module builds on.
    const forbidden = [
      "node:child_process",
      "node:net",
      "node:http",
      "node:https",
      "node:tls",
      "node:dgram",
      "node:dns",
      "node:worker_threads",
    ];
    const mutators = [
      "writeFileSync",
      "appendFileSync",
      "mkdirSync",
      "rmSync",
      "unlinkSync",
      "renameSync",
      "chmodSync",
    ];
    for (const { source } of collectSources(OBSERVATION_COLLECT_SRC)) {
      for (const name of forbidden) expect(source).not.toContain(name);
      for (const name of mutators) expect(source).not.toContain(name);
      expect(source).not.toContain("process.env");
      expect(source).not.toContain("process.kill");
    }
  });

  it("names no product repository or session tool", () => {
    const forbidden = [
      ["Modern", "Rescue"].join(" "),
      ["ui-design", "system"].join("-"),
      ["tm", "ux"].join(""),
    ];
    for (const { source } of collectSources(OBSERVATION_COLLECT_SRC)) {
      for (const token of forbidden) expect(source).not.toContain(token);
    }
  });
});
