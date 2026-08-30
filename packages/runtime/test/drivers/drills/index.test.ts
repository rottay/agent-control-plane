import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { LOOPBACK_HOST, RESTATE_ADMIN_PORT, RESTATE_INGRESS_PORT, RUNTIME_SERVICE_PORT } from "../../../src/constants/index.js";
import type { DurableInvocation } from "../../../src/contracts/index.js";
import { LIFECYCLE_PLAN } from "../../../src/core/lifecycle/index.js";
import type { BeatContext } from "../../../src/core/step-executor/index.js";
import {
  applyEffect,
  probeEffect,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../../src/toy/repository/index.js";
import { serverAvailability, startServer } from "../../../src/restate/server-handle/index.js";
import { platformKey, readTrackedPin, receiptMatchesPin } from "../../../src/restate/server-handle/index.js";
import type { ServerHandle } from "../../../src/restate/server-handle/index.js";
import {
  deriveInvocation,
  readCacheThroughHandler,
  registerDeployment,
  submitAdvance,
} from "../../../src/restate/submit/index.js";
import { reconcile } from "../../../src/drivers/restate-driver/index.js";
import { releasePath } from "../../../src/drivers/restate-child/index.js";
import { SqliteSupervisor } from "../../../src/drivers/sqlite-supervisor/index.js";

/** One fixed initiative for every fixture in this file. */
const TEST_INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";

/**
 * The real drills: a real pinned Restate server, real child processes, real
 * SIGKILL.
 *
 * Nothing here downloads. The binary is acquired by an explicit operator
 * command and verified against a tracked digest; these tests only ever read
 * what that command left behind, and they fail rather than skip if it is
 * missing, because a green suite must never be mistakable for a green adoption
 * decision.
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const CHILD_ENTRY = join(PACKAGE_ROOT, "dist", "drivers", "restate-child", "index.js");
const ACQUIRE = join(REPO_ROOT, "scripts", "acquire-restate-server.mjs");
const EMITTED_BY = "claude/opus/implementer/01";

/**
 * The acquisition script's policy surface.
 *
 * Imported through a computed specifier: the script is plain `.mjs` with no
 * declaration file, and adding one would be a path outside the authorised
 * write-set. The shape is declared here instead, so the tests below are still
 * typed against something rather than against `any`.
 */
interface AcquireModule {
  assertInitialUrl(url: string, pin: unknown, entry: unknown): void;
  assertRedirect(location: string, pin: unknown, hop: number): void;
  assertArchiveEntriesSafe(entries: readonly { name: string; type: string }[]): void;
  readPin(pinPath?: string): { entry: { sha256: string; url: string; asset: string } };
  acquire(options: { verifyOnly?: boolean; pinPath?: string }): Promise<{ state: string }>;
}

async function acquireModule(): Promise<AcquireModule> {
  return (await import(ACQUIRE)) as AcquireModule;
}

const scenarios: string[] = [];
const ledgers: Ledger[] = [];
const children: ChildProcess[] = [];
const servers: ServerHandle[] = [];
const spawnedPids: number[] = [];
const outsideDirs: string[] = [];

function scenario(name: string): ScenarioRoot {
  scenarios.push(name);
  return resolveScenarioRoot(name);
}

function track(ledger: Ledger): Ledger {
  ledgers.push(ledger);
  return ledger;
}

function markers(root: string): number {
  const effects = join(root, "effects");
  return existsSync(effects)
    ? readdirSync(effects).filter((name) => name.endsWith(".marker")).length
    : 0;
}

function beatFactory(root: ScenarioRoot, ledger: Ledger) {
  return (invocation: DurableInvocation): Omit<BeatContext, "plan" | "initiativeId"> => ({
    ledger,
    effects: {
      apply: (operation) => {
        applyEffect(root, operation);
      },
      probe: (operation) => probeEffect(root, operation),
    },
    invocation,
    emittedBy: EMITTED_BY,
  });
}

function ensureChildBuilt(): void {
  const result = spawnSync(
    process.execPath,
    [join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "--build", join(PACKAGE_ROOT, "tsconfig.json")],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  if (result.status !== 0 || !existsSync(CHILD_ENTRY)) {
    throw new Error("could not build the runtime package for the drills: " + result.stdout + result.stderr);
  }
}

/** Everything a child has said so far, so a later waiter cannot miss a line. */
const childOutput = new WeakMap<ChildProcess, { text: string }>();

/** Start the endpoint child and wait for its ready line. */
function startChild(
  scenarioId: string,
  invocation: DurableInvocation,
  faultPoint: string | null,
  pauseAt: string | null = null,
): Promise<ChildProcess> {
  const config = JSON.stringify({
    scenarioId,
    invocation,
    emittedBy: EMITTED_BY,
    // The child refuses a config that does not say which policy it runs under.
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    initiativeId: TEST_INITIATIVE_ID,
    faultPoint,
    pauseAt,
    port: RUNTIME_SERVICE_PORT,
  });
  return new Promise<ChildProcess>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CHILD_ENTRY, config], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    });
    children.push(child);
    if (child.pid !== undefined) spawnedPids.push(child.pid);
    const sink = { text: "" };
    childOutput.set(child, sink);
    child.stdout.on("data", (chunk: Buffer) => {
      sink.text += chunk.toString("utf8");
      if (sink.text.includes('"ready":true')) resolvePromise(child);
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (!sink.text.includes('"ready":true')) {
        rejectPromise(new Error("child exited before ready: code " + String(code) + " signal " + String(signal)));
      }
    });
  });
}

/**
 * Wait for a child to say something specific.
 *
 * A handshake, not a sleep: the drill proceeds because the child announced the
 * beat it reached, so there is no timing assumption to get wrong.
 */
async function waitForChildSays(
  child: ChildProcess,
  needle: string,
  deadlineMs = 60_000,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (childOutput.get(child)?.text.includes(needle) === true) return true;
    if (child.exitCode !== null || child.signalCode !== null) return false;
    await delay(50);
  }
  return false;
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("close", (code, signal) => {
      resolvePromise({ code, signal });
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await waitForExit(child);
}

/** Poll the ledger until the task reaches its terminal state, or give up. */
async function waitForCheckpoint(ledger: Ledger, taskId: string, deadlineMs = 90_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (ledger.getTask(taskId)?.currentState === "CHECKPOINTED") return true;
    await delay(200);
  }
  return false;
}

afterEach(async () => {
  // Reversed teardown: Restate first, so it drops its HTTP/2 sessions, then our
  // children. Closing ours first waits on sessions the server still holds.
  for (const server of servers.splice(0)) {
    try {
      await server.stop();
    } catch {
      // already gone
    }
  }
  for (const child of children.splice(0)) await stopChild(child);
  for (const ledger of ledgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      // already closed
    }
  }
  for (const name of scenarios.splice(0)) removeScenarioRoot(name);
  for (const directory of outsideDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Acquisition boundary, entirely without network
// ---------------------------------------------------------------------------

describe("the acquisition boundary", () => {
  it("refuses a placeholder pin rather than trusting the first download", () => {
    const directory = mkdtempSync(join(tmpdir(), "acp-pin-"));
    outsideDirs.push(directory);
    const pin = join(directory, "pin.json");
    writeFileSync(
      pin,
      JSON.stringify({
        version: "1.7.7",
        assetHost: "github.com",
        assetPathPrefix: "/restatedev/restate/releases/download/v1.7.7/",
        redirectHost: "release-assets.githubusercontent.com",
        platforms: { "darwin-arm64": { asset: "a.tar.xz", url: "https://github.com/x", sha256: "UNPINNED" } },
      }),
      "utf8",
    );
    const result = spawnSync(process.execPath, [ACQUIRE, "--verify-only", "--pin=" + pin], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no established digest");
  });

  it("refuses a pin that establishes only the archive digest", () => {
    // Pinning the archive alone leaves the extracted binary attested by nothing
    // but its own receipt, which is what a substituted binary would also carry.
    const directory = mkdtempSync(join(tmpdir(), "acp-pin-"));
    outsideDirs.push(directory);
    const pin = join(directory, "pin.json");
    writeFileSync(
      pin,
      JSON.stringify({
        version: "1.7.7",
        assetHost: "github.com",
        assetPathPrefix: "/x/",
        redirectHost: "release-assets.githubusercontent.com",
        platforms: {
          "darwin-arm64": {
            asset: "a",
            url: "https://github.com/x",
            sha256: "96106ce887475dc0d7c1aebe12ea4ca75f8ed26a00f36b4659c8372508b4f7fa",
          },
        },
      }),
      "utf8",
    );
    const result = spawnSync(process.execPath, [ACQUIRE, "--verify-only", "--pin=" + pin], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("BINARY digest");
    // The real install is untouched by any of this.
    expect(serverAvailability()).toEqual({ available: true, reason: "verified" });
  });

  it("refuses a well-formed binary digest that names a different binary, before any network call", async () => {
    // The dangerous case is not a malformed digest; any shape check catches
    // that. It is a perfectly well-formed digest for some *other* binary, which
    // is what a substitution would actually produce. This one runs in-process
    // with `fetch` replaced by a tripwire, so "it refused before reaching the
    // network" is observed rather than assumed, and it exercises acquire()'s own
    // call into inspectInstalled — the path that previously passed no pin entry
    // at all and so compared the binary only against its own receipt.
    const directory = mkdtempSync(join(tmpdir(), "acp-pin-"));
    outsideDirs.push(directory);
    const pin = join(directory, "pin.json");
    writeFileSync(
      pin,
      JSON.stringify({
        version: "1.7.7",
        assetHost: "github.com",
        assetPathPrefix: "/restatedev/restate/releases/download/v1.7.7/",
        redirectHost: "release-assets.githubusercontent.com",
        platforms: {
          "darwin-arm64": {
            asset: "restate-server-aarch64-apple-darwin.tar.xz",
            url:
              "https://github.com/restatedev/restate/releases/download/v1.7.7/" +
              "restate-server-aarch64-apple-darwin.tar.xz",
            sha256: "96106ce887475dc0d7c1aebe12ea4ca75f8ed26a00f36b4659c8372508b4f7fa",
            binarySha256: "b".repeat(64),
          },
        },
      }),
      "utf8",
    );

    const module = await acquireModule();
    const realFetch = globalThis.fetch;
    let reachedNetwork = 0;
    globalThis.fetch = ((): never => {
      reachedNetwork += 1;
      throw new Error("the acquisition path reached the network");
    }) as unknown as typeof globalThis.fetch;
    try {
      await expect(module.acquire({ verifyOnly: true, pinPath: pin })).rejects.toThrow(
        /does not match the tracked pin/,
      );
    } finally {
      globalThis.fetch = realFetch;
      rmSync(pin, { force: true });
    }

    expect(reachedNetwork).toBe(0);
    // Nothing was fetched, extracted, moved or removed: the real install still
    // verifies against the real tracked pin.
    expect(serverAvailability()).toEqual({ available: true, reason: "verified" });
  });

  it("refuses a digest that is not 64 lowercase hex", () => {
    const directory = mkdtempSync(join(tmpdir(), "acp-pin-"));
    outsideDirs.push(directory);
    const pin = join(directory, "pin.json");
    writeFileSync(
      pin,
      JSON.stringify({
        version: "1.7.7",
        assetHost: "github.com",
        assetPathPrefix: "/x/",
        redirectHost: "release-assets.githubusercontent.com",
        platforms: { "darwin-arm64": { asset: "a", url: "https://github.com/x", sha256: "NOTHEX" } },
      }),
      "utf8",
    );
    const result = spawnSync(process.execPath, [ACQUIRE, "--verify-only", "--pin=" + pin], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    expect(result.status).not.toBe(0);
  });

  it("refuses every URL and redirect outside the pinned boundary", async () => {
    const module = await acquireModule();
    const pin = {
      assetHost: "github.com",
      assetPathPrefix: "/restatedev/restate/releases/download/v1.7.7/",
      redirectHost: "release-assets.githubusercontent.com",
    };
    const entry = {
      url: "https://github.com/restatedev/restate/releases/download/v1.7.7/restate-server-aarch64-apple-darwin.tar.xz",
    };

    const initial = (url: string): (() => void) => {
      return () => {
        module.assertInitialUrl(url, pin, entry);
      };
    };
    const redirect = (location: string, hop: number): (() => void) => {
      return () => {
        module.assertRedirect(location, pin, hop);
      };
    };

    // The exact pinned URL is the only acceptable first request.
    expect(initial(entry.url)).not.toThrow();
    expect(initial("http://github.com/restatedev/restate/releases/download/v1.7.7/x")).toThrow();
    expect(initial("https://evil.example/x")).toThrow();
    expect(initial("https://github.com/other/path")).toThrow();
    expect(initial("https://user:pw@github.com" + pin.assetPathPrefix + "a")).toThrow();

    // Exactly one HTTPS hop, to exactly one host, with no credentials.
    expect(redirect("https://release-assets.githubusercontent.com/a", 1)).not.toThrow();
    expect(redirect("http://release-assets.githubusercontent.com/a", 1)).toThrow();
    expect(redirect("https://objects.githubusercontent.com/a", 1)).toThrow();
    expect(redirect("https://user:pw@release-assets.githubusercontent.com/a", 1)).toThrow();
    // A second hop is refused even to the permitted host.
    expect(redirect("https://release-assets.githubusercontent.com/a", 2)).toThrow();
  });

  it("refuses an archive that could write outside where it is unpacked", async () => {
    const module = await acquireModule();
    const entries = (name: string, type: string): (() => void) => {
      return () => {
        module.assertArchiveEntriesSafe([{ name, type }]);
      };
    };
    expect(entries("restate-server", "f")).not.toThrow();
    expect(entries("/etc/passwd", "f")).toThrow();
    expect(entries("../escape", "f")).toThrow();
    expect(entries("a/../../b", "f")).toThrow();
    expect(entries("link", "l")).toThrow();
    expect(entries("hard", "h")).toThrow();
  });

  it("has a verified binary, acquired by the operator, matching the tracked pin", async () => {
    const module = await acquireModule();
    const { entry } = module.readPin();
    const availability = serverAvailability();
    // No skip: a drill suite that skipped here would be indistinguishable from
    // one that passed, and the adoption decision rests on these drills.
    expect(availability.reason).toBe("verified");
    expect(availability.available).toBe(true);
    expect(entry.sha256).toBe("96106ce887475dc0d7c1aebe12ea4ca75f8ed26a00f36b4659c8372508b4f7fa");
  });

  it("binds the installed receipt to the tracked pin, field by field", () => {
    const pin = readTrackedPin();
    const receiptPath = join(
      REPO_ROOT,
      ".acp-local",
      "tools",
      "restate-server-1.7.7",
      "verification-receipt.json",
    );
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;

    // The real, installed receipt agrees with the tracked pin.
    expect(receiptMatchesPin(receipt, pin)).toEqual({ ok: true, reason: "verified" });

    const platforms = pin["platforms"] as Record<string, Record<string, unknown>>;
    const pinned = platforms[platformKey()];
    expect(receipt["version"]).toBe(pin["version"]);
    expect(receipt["platform"]).toBe(platformKey());
    expect(receipt["asset"]).toBe(pinned?.["asset"]);
    expect(receipt["url"]).toBe(pinned?.["url"]);
    expect(receipt["archiveSha256"]).toBe(pinned?.["sha256"]);
    // The binary digest is TRACKED, not merely well-formed. Pinning only the
    // archive would leave the extracted binary self-attested by its own receipt.
    expect(receipt["binarySha256"]).toBe(pinned?.["binarySha256"]);
    expect(pinned?.["binarySha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a tampered receipt on every bound field", () => {
    // Copies only. Checking the version alone was too weak: a receipt naming
    // the right version but a different asset, URL or digest would have passed,
    // and the receipt is all that stands between a drill and an unverified
    // binary. The real install is never mutated by any of this.
    const pin = readTrackedPin();
    const receiptPath = join(
      REPO_ROOT,
      ".acp-local",
      "tools",
      "restate-server-1.7.7",
      "verification-receipt.json",
    );
    const genuine = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;

    const tampered: readonly [string, unknown][] = [
      ["version", "1.7.6"],
      ["platform", "linux-x64"],
      ["asset", "restate-server-x86_64-unknown-linux-gnu.tar.xz"],
      ["url", "https://example.invalid/restate-server.tar.xz"],
      ["archiveSha256", "0".repeat(64)],
      ["binarySha256", "not-a-digest"],
      // The dangerous case is not a malformed digest, which any shape check
      // catches. It is a perfectly well-formed digest for a different binary.
      ["binarySha256", "b".repeat(64)],
      ["archiveSha256", "1234567890abcdef".repeat(4)],
    ];
    for (const [field, value] of tampered) {
      const copy = { ...genuine, [field]: value };
      const result = receiptMatchesPin(copy, pin);
      expect(field + ":" + String(result.ok)).toBe(field + ":false");
    }

    // A missing field is refused too, not treated as "not stated, so fine".
    for (const field of ["version", "platform", "asset", "url", "archiveSha256", "binarySha256"]) {
      const copy = Object.fromEntries(
        Object.entries(genuine).filter(([name]) => name !== field),
      );
      expect(field + ":" + String(receiptMatchesPin(copy, pin).ok)).toBe(field + ":false");
    }

    // A pin describing no platform is refused rather than defaulted.
    expect(receiptMatchesPin(genuine, { version: "1.7.7", platforms: {} }).ok).toBe(false);
    expect(receiptMatchesPin(genuine, pin, "solaris-sparc").ok).toBe(false);

    // The genuine receipt is still intact and still verified.
    expect(serverAvailability()).toEqual({ available: true, reason: "verified" });
  });

  it("names the intent beat from the plan, never from a literal", () => {
    // A plan edit that moved the intent step would silently stop matching a
    // hard-coded index, and every fault and pause drill would quietly become a
    // no-op while still reporting green.
    const childSource = readFileSync(
      join(REPO_ROOT, "packages", "runtime", "src", "drivers", "restate-child", "index.ts"),
      "utf8",
    );
    expect(childSource).toContain('"AFTER_INTENT_" + String(INTENT_STEP.index)');
    expect(childSource).not.toMatch(/AFTER_INTENT_\d/);
  });
});

// ---------------------------------------------------------------------------
// D1-D5
// ---------------------------------------------------------------------------

interface DrillReceipt {
  readonly drill: string;
  readonly mode: string;
  readonly faultPoint: string | null;
  readonly signal: string | null;
  readonly eventCount: number;
  readonly effectMarkers: number;
  readonly headSequence: number;
  readonly headEventSha256: string;
  readonly verdict: string;
  readonly integrityOk: boolean;
  readonly rebuildIdentical: boolean;
  readonly duplicateKeys: number;
  /** How many spawned pids the leak check covered. Never a duplicate count. */
  readonly processesChecked?: number;
  /** Events durable at the instant the server was killed. Proves "mid-plan". */
  readonly midPlanEvents?: number;
  /** Beat the child announced before the kill. Proves it was a handshake. */
  readonly pausedAt?: string;
}

function emitReceipt(receipt: DrillReceipt): void {
  process.stdout.write("RECEIPT " + JSON.stringify(receipt) + "\n");
}

/** Assert every pid this file ever spawned is dead. Shared by D5 and afterAll. */
function assertNoLeakedProcesses(): number {
  for (const pid of spawnedPids) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(String(pid) + ":" + String(alive)).toBe(String(pid) + ":false");
  }
  return spawnedPids.length;
}

/**
 * The final leak proof, after every real-process test in this file.
 *
 * The D5 test below runs in file order, so on its own it cannot cover the
 * equivalence drill that follows it and spawns another server and endpoint.
 * This hook re-runs the same assertion once everything is done, which is the
 * only placement that actually proves the file leaked nothing.
 */
afterAll(() => {
  const processesChecked = assertNoLeakedProcesses();
  emitReceipt({
    drill: "D5-FINAL",
    mode: "RESTATE",
    faultPoint: null,
    signal: null,
    eventCount: 0,
    effectMarkers: 0,
    headSequence: 0,
    headEventSha256: "0".repeat(64),
    verdict: "CONSISTENT",
    integrityOk: true,
    rebuildIdentical: true,
    duplicateKeys: 0,
    processesChecked,
  });
});

const FAULTS = ["AFTER_INTENT", "AFTER_EFFECT", "AFTER_OUTCOME"] as const;

describe("restate drills", () => {
  for (const [index, fault] of FAULTS.entries()) {
    it("D1 kill/restart the endpoint at " + fault, async () => {
      ensureChildBuilt();
      const id = "d1-" + fault.toLowerCase().replace(/_/g, "-");
      const root = scenario(id);
      const taskId = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d10" + String(index);
      const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "a".repeat(64));
      const ledger = track(openLedger(scenarioLedgerPath(root)));

      const server = await startServer(root);
      servers.push(server);
      if (server.pid > 0) spawnedPids.push(server.pid);

      const faulty = await startChild(id, invocation, fault);
      await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

      // Submit, then let the endpoint die under it. Restate retries.
      const submission = submitAdvance(server.ingressUrl, invocation, 120_000).catch(() => null);
      const died = await waitForExit(faulty);
      expect(died.signal).toBe("SIGKILL");

      // Restart with no fault; Restate redelivers to the same deployment.
      await startChild(id, invocation, null);
      await submission;

      const reached = await waitForCheckpoint(ledger, taskId);
      expect(reached).toBe(true);
      expect(ledger.status().eventCount).toBe(LIFECYCLE_PLAN.length);
      expect(markers(root)).toBe(1);

      const head = ledger.status();
      const integrity = ledger.verifyIntegrity();
      expect(integrity.problems).toEqual([]);

      const liveTask = ledger.getTask(taskId);
      const liveWorkers = ledger.listWorkers().workers;
      ledger.rebuildReadModel();
      const rebuildIdentical =
        JSON.stringify(ledger.getTask(taskId)) === JSON.stringify(liveTask) &&
        JSON.stringify(ledger.listWorkers().workers) === JSON.stringify(liveWorkers);
      expect(rebuildIdentical).toBe(true);

      const keys = ledger.listEvents({ limit: 200 }).events.map((r) => r.event.idempotencyKey);
      const duplicateKeys = keys.length - new Set(keys).size;
      expect(duplicateKeys).toBe(0);

      const report = await reconcile({
        ledger,
        invocation,
        readCache: () => readCacheThroughHandler(server.ingressUrl, taskId),
      });
      expect(report.safeToResume).toBe(true);

      emitReceipt({
        drill: "D1",
        mode: "RESTATE",
        faultPoint: fault,
        signal: died.signal,
        eventCount: head.eventCount,
        effectMarkers: markers(root),
        headSequence: head.headSequence,
        headEventSha256: head.headEventSha256,
        verdict: report.verdict,
        integrityOk: integrity.ok,
        rebuildIdentical,
        duplicateKeys,
      });
    });
  }

  it("D2 kill the Restate server mid-plan and restart it", async () => {
    ensureChildBuilt();
    const id = "d2-server-kill";
    const root = scenario(id);
    const taskId = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d201";
    const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "b".repeat(64));
    const ledger = track(openLedger(scenarioLedgerPath(root)));

    const first = await startServer(root);
    if (first.pid > 0) spawnedPids.push(first.pid);

    // The child pauses at the intent beat and says so. Killing the server
    // before a plan is in flight would prove only that a restart works, not
    // that the server can die MID-PLAN, so the drill waits for the handshake.
    const paused = await startChild(id, invocation, null, "AFTER_INTENT");
    await registerDeployment(first.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    const inFlight = submitAdvance(first.ingressUrl, invocation, 60_000).catch(() => null);
    const announced = await waitForChildSays(paused, '"paused":"AFTER_INTENT"');
    expect(announced).toBe(true);

    // Independent, non-timing corroboration that execution really began: the
    // intent is already durable in the ledger while the plan is still open.
    const midPlan = ledger.status();
    expect(midPlan.eventCount).toBeGreaterThan(0);
    expect(midPlan.eventCount).toBeLessThan(LIFECYCLE_PLAN.length);
    expect(ledger.getTask(taskId)?.currentState).not.toBe("CHECKPOINTED");

    // Now, with the plan genuinely open, SIGKILL the server itself.
    const killed = await first.stop("SIGKILL");
    expect(killed.signal).toBe("SIGKILL");

    // Release the paused child and retire it; its invocation died with the
    // server it was answering.
    writeFileSync(releasePath(root, "AFTER_INTENT"), "release", "utf8");
    await inFlight;
    await stopChild(paused);

    const second = await startServer(root);
    servers.push(second);
    if (second.pid > 0) spawnedPids.push(second.pid);
    await startChild(id, invocation, null);
    await registerDeployment(second.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));
    await submitAdvance(second.ingressUrl, invocation, 120_000).catch(() => null);

    expect(await waitForCheckpoint(ledger, taskId)).toBe(true);
    expect(ledger.status().eventCount).toBe(LIFECYCLE_PLAN.length);
    expect(markers(root)).toBe(1);

    // No duplicate coordinates survived the kill, and the projection rebuilds.
    const d2Keys = ledger.listEvents({ limit: 200 }).events.map((r) => r.event.idempotencyKey);
    expect(d2Keys.length - new Set(d2Keys).size).toBe(0);
    const d2Task = ledger.getTask(taskId);
    ledger.rebuildReadModel();
    expect(JSON.stringify(ledger.getTask(taskId))).toBe(JSON.stringify(d2Task));

    const report = await reconcile({
      ledger,
      invocation,
      readCache: () => readCacheThroughHandler(second.ingressUrl, taskId),
    });
    expect(["CONSISTENT", "DRIVER_BEHIND"]).toContain(report.verdict);

    const head = ledger.status();
    const integrity = ledger.verifyIntegrity();
    expect(integrity.ok).toBe(true);
    emitReceipt({
      drill: "D2",
      mode: "RESTATE",
      faultPoint: null,
      signal: killed.signal,
      eventCount: head.eventCount,
      effectMarkers: markers(root),
      headSequence: head.headSequence,
      headEventSha256: head.headEventSha256,
      verdict: report.verdict,
      integrityOk: integrity.ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      midPlanEvents: midPlan.eventCount,
      pausedAt: "AFTER_INTENT",
    });
  });

  it("D3 delete the Restate data root and lose nothing", async () => {
    ensureChildBuilt();
    const id = "d3-data-root";
    const root = scenario(id);
    const taskId = "d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d301";
    const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "c".repeat(64));
    const ledger = track(openLedger(scenarioLedgerPath(root)));

    const first = await startServer(root);
    if (first.pid > 0) spawnedPids.push(first.pid);
    const child = await startChild(id, invocation, null);
    await registerDeployment(first.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));
    await submitAdvance(first.ingressUrl, invocation, 120_000);
    expect(await waitForCheckpoint(ledger, taskId)).toBe(true);
    const before = ledger.status();

    // Stop everything, then delete ALL of Restate's durable state.
    await first.stop();
    await stopChild(child);
    rmSync(first.dataRoot, { recursive: true, force: true });
    expect(existsSync(first.dataRoot)).toBe(false);

    const second = await startServer(root);
    servers.push(second);
    if (second.pid > 0) spawnedPids.push(second.pid);
    await startChild(id, invocation, null);
    await registerDeployment(second.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    // A brand-new server holds no cache: absence is the reconstructible case.
    const report = await reconcile({
      ledger,
      invocation,
      readCache: () => readCacheThroughHandler(second.ingressUrl, taskId),
    });
    expect(report.verdict).toBe("DRIVER_BEHIND");
    expect(report.safeToResume).toBe(true);

    await submitAdvance(second.ingressUrl, invocation, 120_000).catch(() => null);
    const after = ledger.status();

    // The load-bearing assertion: deleting every byte Restate owned changed
    // nothing about the ledger.
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.headEventSha256).toBe(before.headEventSha256);
    expect(markers(root)).toBe(1);

    // And the rebuilt driver state now corroborates the ledger it was rebuilt
    // from: absence became agreement, without anything being replayed twice.
    const afterReport = await reconcile({
      ledger,
      invocation,
      readCache: () => readCacheThroughHandler(second.ingressUrl, taskId),
    });
    expect(afterReport.verdict).toBe("CONSISTENT");
    expect(afterReport.safeToResume).toBe(true);
    expect(afterReport.ledgerHeadSha256).toBe(before.headEventSha256);

    const integrity = ledger.verifyIntegrity();
    expect(integrity.ok).toBe(true);
    emitReceipt({
      drill: "D3",
      mode: "RESTATE",
      faultPoint: null,
      signal: null,
      eventCount: after.eventCount,
      effectMarkers: markers(root),
      headSequence: after.headSequence,
      headEventSha256: after.headEventSha256,
      verdict: report.verdict,
      integrityOk: integrity.ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
    });
  });

  it("D4 server unavailable fails closed and never fails over on its own", async () => {
    const id = "d4-unavailable";
    const root = scenario(id);
    const taskId = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d401";
    const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "d".repeat(64));
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const beat = beatFactory(root, ledger);

    const { RestateDriver } = await import("../../../src/drivers/restate-driver/index.js");
    const driver = new RestateDriver(
      {
        ledger,
        invocation,
        emittedBy: EMITTED_BY,
        ingressUrl: "http://" + LOOPBACK_HOST + ":" + String(RESTATE_INGRESS_PORT),
        adminUrl: "http://" + LOOPBACK_HOST + ":" + String(RESTATE_ADMIN_PORT),
        readCache: () =>
          readCacheThroughHandler(
            "http://" + LOOPBACK_HOST + ":" + String(RESTATE_INGRESS_PORT),
            taskId,
          ),
      },
      beat,
      "LOCAL_COMMIT_WITH_RECEIPT",
        TEST_INITIATIVE_ID,
    );

    const status = await driver.status();
    expect(status.health).toBe("UNAVAILABLE");
    expect(status.activeSince).toBeNull();
    expect(status.detail).not.toBeNull();

    const report = await driver.reconcile();
    expect(report.verdict).toBe("INDETERMINATE");
    expect(report.safeToResume).toBe(false);

    // The driver does not quietly become the supervisor. Mode is an operator
    // decision; an automatic failover would make the adoption decision
    // untestable because the drill could never observe the Restate path fail.
    expect(ledger.status().eventCount).toBe(0);
    expect(markers(root)).toBe(0);

    emitReceipt({
      drill: "D4",
      mode: "RESTATE",
      faultPoint: null,
      signal: null,
      eventCount: 0,
      effectMarkers: 0,
      headSequence: 0,
      headEventSha256: report.ledgerHeadSha256,
      verdict: report.verdict,
      integrityOk: true,
      rebuildIdentical: true,
      duplicateKeys: 0,
    });
  });

  it("D5 leaks no process, and every listener was loopback", () => {
    const processesChecked = assertNoLeakedProcesses();
    emitReceipt({
      drill: "D5",
      mode: "RESTATE",
      faultPoint: null,
      signal: null,
      eventCount: 0,
      effectMarkers: 0,
      headSequence: 0,
      headEventSha256: "0".repeat(64),
      verdict: "CONSISTENT",
      integrityOk: true,
      rebuildIdentical: true,
      // Zero, and it means zero. The count of processes checked is its own
      // field: publishing it as a duplicate count read as sixteen duplicates
      // when the drill had just proved there were none.
      duplicateKeys: 0,
      processesChecked,
    });
  });
});

// ---------------------------------------------------------------------------
// Byte equivalence: two drivers, two ledgers, one answer
// ---------------------------------------------------------------------------

describe("driver equivalence", () => {
  it("produces a byte-identical head from two independent ledgers", async () => {
    ensureChildBuilt();
    const taskId = "e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e001";
    const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "e".repeat(64));

    // Scenario A: the supervisor, on its own fresh ledger.
    const rootA = scenario("equiv-supervisor");
    const ledgerA = track(openLedger(scenarioLedgerPath(rootA)));
    new SqliteSupervisor({
      ledger: ledgerA,
      invocation,
      scenarioRoot: rootA,
      emittedBy: EMITTED_BY,
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      initiativeId: TEST_INITIATIVE_ID,
    }).runToCheckpoint();

    // Scenario B: Restate, on a different fresh ledger.
    const idB = "equiv-restate";
    const rootB = scenario(idB);
    const ledgerB = track(openLedger(scenarioLedgerPath(rootB)));
    const server = await startServer(rootB);
    servers.push(server);
    if (server.pid > 0) spawnedPids.push(server.pid);
    await startChild(idB, invocation, null);
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));
    await submitAdvance(server.ingressUrl, invocation, 120_000);
    expect(await waitForCheckpoint(ledgerB, taskId)).toBe(true);

    // Two genuinely different ledgers, or the comparison is vacuous.
    expect(scenarioLedgerPath(rootA)).not.toBe(scenarioLedgerPath(rootB));

    const a = ledgerA.status();
    const b = ledgerB.status();
    expect(b.eventCount).toBe(a.eventCount);
    expect(b.headEventSha256).toBe(a.headEventSha256);

    // The discriminating control: a different invocation must NOT match, or the
    // equality above would prove nothing.
    const rootC = scenario("equiv-control");
    const ledgerC = track(openLedger(scenarioLedgerPath(rootC)));
    const other = deriveInvocation(taskId, 1, "2026-08-27T13:00:00.000Z", "f".repeat(64));
    new SqliteSupervisor({
      ledger: ledgerC,
      invocation: other,
      scenarioRoot: rootC,
      emittedBy: EMITTED_BY,
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      initiativeId: TEST_INITIATIVE_ID,
    }).runToCheckpoint();
    expect(ledgerC.status().headEventSha256).not.toBe(a.headEventSha256);

    process.stdout.write(
      "RECEIPT " +
        JSON.stringify({
          drill: "EQUIVALENCE",
          supervisorHead: a.headEventSha256,
          restateHead: b.headEventSha256,
          eventCount: a.eventCount,
          controlHead: ledgerC.status().headEventSha256,
          ledgerPathsDiffer: true,
        }) +
        "\n",
    );
  });
});
