import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  LIFECYCLE_PLAN,
  LOOPBACK_HOST,
  RESTATE_ADMIN_PORT,
  RESTATE_INGRESS_PORT,
  RUNTIME_SERVICE_PORT,
  SqliteSupervisor,
  applyEffect,
  probeEffect,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "@acp/runtime";
import type { BeatContext, DurableInvocation, EffectPort, ScenarioRoot } from "@acp/runtime";

import { serverAvailability, startServer } from "../../../src/server-handle/index.js";
import { platformKey, readTrackedPin, receiptMatchesPin } from "../../../src/server-handle/index.js";
import type { ServerExit, ServerHandle } from "../../../src/server-handle/index.js";
import {
  attachAdvance,
  deriveInvocation,
  readCacheThroughHandler,
  registerDeployment,
  sendAdvance,
  submitAdvance,
} from "../../../src/submit/index.js";
import { reconcile } from "../../../src/drivers/restate-driver/index.js";
import { drillRoute, releasePath } from "../../../src/drivers/restate-child/index.js";



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
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..", "..");
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

/**
 * Register a spawned server for teardown, in the same act that records its pid
 * (P8-9-1).
 *
 * Wrap the spawn — `trackServer(await startServer(root))` — so registration
 * happens the instant the handle exists, before any `await` or assertion that
 * could throw between the two. The previous shape registered the pid at the
 * call site and pushed the handle separately, which meant a drill could hold a
 * live server that the teardown had never heard of: exactly the orphaned
 * `restate-server` the P8-8G incident recorded, left behind when a handshake
 * assertion failed before the explicit stop.
 *
 * Both registries are fed here and only here, so the leak assertion covers
 * precisely what the teardown covers — one act of registration, one
 * provenance, and forgetting is impossible by construction rather than by
 * memory.
 */
/**
 * The durable half of the provenance registry, registration side (V2-B6-3).
 *
 * `spawnedPids` dies with the worker, so a SIGKILL of the runner leaves this
 * file's servers and children alive and unrecorded. Appending the same fact to
 * ignored state under `.acp-local/` lets the next controlled run find them.
 *
 * **Registration only.** The reaper — the part that signals a process — lives
 * in exactly one place, `packages/entrypoints/daemon/test/drills/index.test.ts`,
 * and sweeps every suite's entries from this same file. Two homes for an
 * append are harmless; two homes for a kill would not be, so there is one.
 *
 * The identity digest is `ps` start-time plus argv, so a pid the kernel later
 * reissues to an unrelated process cannot be mistaken for one of ours. What is
 * stored is the digest, never the argv: an absolute path written to disk would
 * be provenance leaking somewhere nothing redacts it.
 */
const REGISTRY_DIR = join(REPO_ROOT, ".acp-local", "runner-death");
const REGISTRY_FILE = join(REGISTRY_DIR, "registry.jsonl");
const RUN_ID = randomUUID();

function recordDurable(pid: number, spawnSite: string): void {
  const probe = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "lstart=,command="], {
    encoding: "utf8",
  });
  const line = probe.status === 0 ? probe.stdout.trim() : "";
  if (line === "") return;
  const identity = createHash("sha256").update(line, "utf8").digest("hex");
  try {
    mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(
      REGISTRY_FILE,
      JSON.stringify({ runId: RUN_ID, pid, suite: "durability-drills", spawnSite, identity }) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Ignored ephemeral state; a drill's verdict never depends on it.
  }
}

/**
 * Drop this run's own registrations when the suite ends normally.
 *
 * Only this run's: another suite's rows may name processes that are still
 * alive, and deleting the file wholesale would throw away exactly the record a
 * later sweep needs in order to reap them.
 */
function releaseDurable(): void {
  let raw: string;
  try {
    raw = readFileSync(REGISTRY_FILE, "utf8");
  } catch {
    return;
  }
  const kept = raw
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.includes(RUN_ID));
  if (kept.length === 0) {
    rmSync(REGISTRY_FILE, { force: true });
    return;
  }
  writeFileSync(REGISTRY_FILE, kept.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
}

/** Register a pid in both registries in one act, so they cannot disagree. */
function trackSpawnedPid(pid: number, spawnSite: string): void {
  if (pid > 0 && !spawnedPids.includes(pid)) {
    spawnedPids.push(pid);
    recordDurable(pid, spawnSite);
  }
}

function trackServer(server: ServerHandle): ServerHandle {
  servers.push(server);
  if (server.pid > 0) trackSpawnedPid(server.pid, "trackServer");
  return server;
}

/** Handles already stopped, so the sweep never signals a corpse twice. */
const stoppedServers = new WeakSet<ServerHandle>();

/**
 * Stop a server once. A second stop is a no-op that returns `null`.
 *
 * A drill that kills its own server mid-test and a teardown that sweeps every
 * registered handle must compose without erroring and without a visible
 * double-kill, since every server now stays registered for the whole test. The
 * mark is set only after a stop resolves, so a stop that throws leaves the
 * handle registered and the sweep still responsible for it.
 */
async function stopServer(
  server: ServerHandle,
  signal?: NodeJS.Signals,
  deadlineMs?: number,
): Promise<ServerExit | null> {
  if (stoppedServers.has(server)) return null;
  const exit = await server.stop(signal, deadlineMs);
  stoppedServers.add(server);
  return exit;
}

function markers(root: string): number {
  const effects = join(root, "effects");
  return existsSync(effects)
    ? readdirSync(effects).filter((name) => name.endsWith(".marker")).length
    : 0;
}

/** The toy port, passed explicitly to the supervisor (V2-B1b, stage 2): the drills' subject stays the toy. */
function toyEffects(root: ScenarioRoot): EffectPort {
  return {
    apply: (operation) => {
      applyEffect(root, operation);
      return Promise.resolve();
    },
    probe: (operation) => Promise.resolve(probeEffect(root, operation)),
  };
}

function beatFactory(root: ScenarioRoot, ledger: Ledger) {
  return (invocation: DurableInvocation): Omit<BeatContext, "plan" | "initiativeId"> => ({
    ledger,
    effects: {
      apply: (operation) => {
        applyEffect(root, operation);
        return Promise.resolve();
      },
      probe: (operation) => Promise.resolve(probeEffect(root, operation)),
    },
    invocation,
    emittedBy: EMITTED_BY,
    route: drillRoute(invocation),
  });
}

function ensureChildBuilt(): void {
  const result = spawnSync(
    process.execPath,
    [join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "--build", join(PACKAGE_ROOT, "tsconfig.json")],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  if (result.status !== 0 || !existsSync(CHILD_ENTRY)) {
    throw new Error("could not build the durability package for the drills: " + result.stdout + result.stderr);
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
  effect: "TOY" | "EXECUTION" = "TOY",
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
    effect,
  });
  return new Promise<ChildProcess>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CHILD_ENTRY, config], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    });
    children.push(child);
    if (child.pid !== undefined) trackSpawnedPid(child.pid, "startChild");
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
 * Start an ATTACH-role child and wait until it says it is attaching (V2-B2-4a).
 *
 * A separate spawner rather than a flag on `startChild`, because the two roles
 * do not share a handshake: the endpoint announces `ready`, and this one
 * announces the address it rebuilt. Waiting for the wrong line would make a
 * client-death drill kill a process that had not yet asked for anything.
 *
 * The config carries the invocation, but the child does not use its id: it
 * recomputes one from `(taskId, attempt)`. The drill asserts the two agree,
 * which is what makes "a fresh process can rejoin" mean the address is
 * derivable rather than inherited.
 */
function startAttachClient(
  scenarioId: string,
  invocation: DurableInvocation,
): Promise<ChildProcess> {
  const config = JSON.stringify({
    scenarioId,
    invocation,
    emittedBy: EMITTED_BY,
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    initiativeId: TEST_INITIATIVE_ID,
    faultPoint: null,
    pauseAt: null,
    port: RUNTIME_SERVICE_PORT,
    effect: "TOY",
    role: "ATTACH",
  });
  return new Promise<ChildProcess>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CHILD_ENTRY, config], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    });
    children.push(child);
    if (child.pid !== undefined) trackSpawnedPid(child.pid, "startAttachClient");
    const sink = { text: "" };
    childOutput.set(child, sink);
    child.stdout.on("data", (chunk: Buffer) => {
      sink.text += chunk.toString("utf8");
      if (sink.text.includes('"attaching":true')) resolvePromise(child);
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (!sink.text.includes('"attaching":true')) {
        rejectPromise(
          new Error("attach client exited before asking: code " + String(code) + " signal " + String(signal)),
        );
      }
    });
  });
}

/** The line an ATTACH child prints once it has an answer, parsed. */
function attachAnswer(
  child: ChildProcess,
): { attached: boolean; status?: number; body?: string } | null {
  const text = childOutput.get(child)?.text ?? "";
  for (const line of text.split("\n")) {
    if (line.includes('"attached"')) {
      return JSON.parse(line) as { attached: boolean; status?: number; body?: string };
    }
  }
  return null;
}

/** The invocation id an ATTACH child rebuilt for itself. */
function attachClientDerivedId(child: ChildProcess): string | null {
  const text = childOutput.get(child)?.text ?? "";
  const match = /"attaching":true,"invocationId":"([0-9a-f-]+)"/.exec(text);
  return match?.[1] ?? null;
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

/**
 * Wait until the child has announced a pause `count` times (V2-B2-3).
 *
 * Counting rather than matching once is what turns the pause into a
 * discriminator: each held invocation announces, so two announcements while
 * nothing has been released means two invocations are held at the same moment.
 * The wait ends on the condition and the deadline only bounds failure, so
 * nothing here depends on how long anything takes.
 */
async function waitForHeldTasks(
  child: ChildProcess,
  count: number,
  deadlineMs = 60_000,
): Promise<number> {
  const started = Date.now();
  let seen = 0;
  while (Date.now() - started < deadlineMs) {
    seen = heldTasks(child).size;
    if (seen >= count) return seen;
    if (child.exitCode !== null || child.signalCode !== null) return seen;
    await delay(25);
  }
  return seen;
}

/**
 * The DISTINCT tasks the child has announced as held.
 *
 * Distinct, not a count of lines, and that distinction is the drill. Restate
 * redelivers an invocation whose handler stopped responding, so a bare
 * announcement count reaches two for one task that was retried — which is
 * indistinguishable from two tasks held at once unless the announcement says
 * which task it belongs to. It does.
 */
function heldTasks(child: ChildProcess): ReadonlySet<string> {
  const text = childOutput.get(child)?.text ?? "";
  const tasks = new Set<string>();
  for (const match of text.matchAll(/"paused":"[A-Z_]+","taskId":"([0-9a-f-]+)"/g)) {
    const task = match[1];
    if (task !== undefined) tasks.add(task);
  }
  return tasks;
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
      await stopServer(server);
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
      join(REPO_ROOT, "packages", "edges", "durability", "src", "drivers", "restate-child", "index.ts"),
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
  /** Digest-keyed markers the execution effect left. Toy runs leave none (V2-B2-2). */
  readonly executionEvidence?: number;
  /** How many times the port was started, across every process. One, or the effect replayed. */
  readonly executionStarts?: number;
  /** Invocations held at one moment. Two for different keys, one for the same (V2-B2-3). */
  readonly concurrentPauses?: number;
  // --- V2-B2-4a: the derived key addresses the invocation -------------------
  /** What the nonblocking send answered. 202 Accepted, never a result. */
  readonly sendStatus?: number;
  /** What an attach on the derived key answered. */
  readonly attachStatus?: number | null;
  /** The ledger head the attach reported. Equal to the ledger's own, or the drill failed. */
  readonly attachFinalSequence?: number | null;
  /** Did a blocking submission on the same key answer identically? */
  readonly blockingMatchesAttach?: boolean;
  /** Neighbouring path shapes the router refused by name. */
  readonly badPathRefusals?: number;
  /** What an attach on a key that was never issued answered. */
  readonly neverIssuedStatus?: number;
  /** Did a client that was never told the id rebuild the same one? */
  readonly derivedByFreshClient?: boolean;
  /** Observers of one invocation, at one moment. */
  readonly concurrentAttaches?: number;
  /** Did every concurrent observer see the same answer? */
  readonly attachBodiesAgree?: boolean;
  /** How an attach ended when the server died under it. Rejected, never resolved. */
  readonly attachSettledAs?: string;
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
  // This run's processes are gone, so its durable rows are noise. Released
  // before the leak receipt so the registry ends a green run empty (V2-B6-3).
  releaseDurable();
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

      const server = trackServer(await startServer(root));

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

    const first = trackServer(await startServer(root));

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
    const killed = await stopServer(first, "SIGKILL");
    // The drill's own stop must be the first one: a null here would mean the
    // handle had already been stopped, and the kill this drill is about never
    // happened.
    if (killed === null) throw new Error("D2's SIGKILL was not the first stop of this handle");
    expect(killed.signal).toBe("SIGKILL");

    // Release the paused child and retire it; its invocation died with the
    // server it was answering.
    writeFileSync(releasePath(root, "AFTER_INTENT"), "release", "utf8");
    await inFlight;
    await stopChild(paused);

    const second = trackServer(await startServer(root));
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

    const first = trackServer(await startServer(root));
    const child = await startChild(id, invocation, null);
    await registerDeployment(first.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));
    await submitAdvance(first.ingressUrl, invocation, 120_000);
    expect(await waitForCheckpoint(ledger, taskId)).toBe(true);
    const before = ledger.status();

    // Stop everything, then delete ALL of Restate's durable state.
    await stopServer(first);
    await stopChild(child);
    rmSync(first.dataRoot, { recursive: true, force: true });
    expect(existsSync(first.dataRoot)).toBe(false);

    const second = trackServer(await startServer(root));
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
    await new SqliteSupervisor({
      ledger: ledgerA,
      invocation,
      effects: toyEffects(rootA),
      emittedBy: EMITTED_BY,
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      initiativeId: TEST_INITIATIVE_ID,
      // Exactly what the child binds, imported from the child rather than
      // restated here: the two legs of the equivalence drill must declare the
      // same route or their canonical bytes cannot match, and a second copy of
      // the literal is precisely how they would come to disagree.
      route: drillRoute(invocation),
    }).runToCheckpoint();

    // Scenario B: Restate, on a different fresh ledger.
    const idB = "equiv-restate";
    const rootB = scenario(idB);
    const ledgerB = track(openLedger(scenarioLedgerPath(rootB)));
    const server = trackServer(await startServer(rootB));
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
    await new SqliteSupervisor({
      ledger: ledgerC,
      invocation: other,
      effects: toyEffects(rootC),
      emittedBy: EMITTED_BY,
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      initiativeId: TEST_INITIATIVE_ID,
      route: drillRoute(other),
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

/**
 * The teardown's own drill (P8-9-1).
 *
 * Every drill above stops its servers explicitly, so on a green run the sweep
 * has nothing left to do and the registration discipline is never exercised.
 * The orphan the P8-8G incident recorded appeared on a *red* run: an assertion
 * threw between a spawn and its explicit stop, and a `restate-server` nobody
 * had registered outlived the file. These two tests walk that path deliberately
 * — the first spawns through the same helper the real drills use and simply
 * never stops it, the second checks the pid afterwards — so the claim "a
 * mid-test failure leaks nothing" is proved by the teardown actually running,
 * not by reading the hook.
 *
 * Scope, stated so nobody reads more into it: this covers a failure *inside*
 * the run, where hooks still execute. It does not cover the death of the
 * runner itself — in a hard kill of the vitest process no hook runs at all.
 * That path is covered separately (V2-B6-3): every pid this file registers is
 * also appended to the durable registry above, and the daemon drills' sweep
 * reaps whatever a dead run left behind, by provenance, on the next run.
 *
 * It used to say that path "belongs to the pool/provenance law in the
 * roadmap". That was a dangling referent: both halves of that law had landed —
 * the serialized pool in `vitest.config.ts`, the single-act provenance
 * registration here — and neither absorbed runner death, so the deferral
 * pointed at a closed destination with nothing queued behind it.
 */
describe("the teardown sweeps what no drill stopped", () => {
  let sweptPid: number | null = null;

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("leaves a spawned server registered and running when nothing stops it", async () => {
    const root = scenario("p89-1-teardown-probe");
    // The same helper every real drill spawns through: if registration only
    // worked at the call sites above, it would have to fail here too.
    const server = trackServer(await startServer(root));
    sweptPid = server.pid;

    expect(server.pid).toBeGreaterThan(0);
    expect(alive(server.pid)).toBe(true);
    // Deliberately no stop. This is the shape of a drill whose assertion threw
    // before its explicit stop could run.
  });

  it("has killed that server by the next test, without anyone stopping it", () => {
    if (sweptPid === null) throw new Error("the probe above did not record a pid");
    expect(String(sweptPid) + ":" + String(alive(sweptPid))).toBe(String(sweptPid) + ":false");
  });
});


/**
 * D1, re-proved over the ASSEMBLED effect (V2-B2-2).
 *
 * The D1 matrix above earned its certificate against the toy. Restate's own
 * guarantees were never in doubt; what was untested is the pair — a journalled
 * beat whose effect is awaited, drained to a terminal event and evidenced by
 * digest. `AFTER_EFFECT` is the load-bearing point: the endpoint dies with the
 * effect done and no outcome journalled, and the redelivered beat must close
 * the intent from probe evidence rather than from the assumption that a beat
 * which got that far must have finished.
 *
 * Only D1 is re-run here. D2 (mid-plan server kill), D3 (driver-behind) and D4
 * (empty ledger) are about the handshake, reconciliation and cold start; none
 * of them turns on what the effect is, so re-running each over the execution
 * port would cost three more server starts and prove nothing this does not.
 * Said here rather than left as an unexplained gap.
 */
describe("D1 over the assembled execution path", () => {
  function executionStarts(scenarioRoot: string): number {
    const log = join(scenarioRoot, "execution-starts.log");
    if (!existsSync(log)) return 0;
    return readFileSync(log, "utf8").split("\n").filter((line) => line.trim() !== "").length;
  }

  function executionEvidence(scenarioRoot: string): readonly string[] {
    const home = join(scenarioRoot, "executions");
    if (!existsSync(home)) return [];
    return readdirSync(home).filter((name) => name.endsWith(".json")).sort();
  }

  for (const fault of ["AFTER_INTENT", "AFTER_EFFECT", "AFTER_OUTCOME"] as const) {
    it("recovers from a SIGKILL " + fault.toLowerCase().replace("_", " "), async () => {
      // Hyphenated: the toy's scenario-id boundary admits lowercase
      // alphanumerics and hyphens only, and the fault names carry underscores.
      const id = "d1-execution-" + fault.toLowerCase().replaceAll("_", "-");
      const taskId = randomUUID();
      const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "a".repeat(64));
      const root = scenario(id);
      const ledger = track(openLedger(scenarioLedgerPath(root)));
      const server = trackServer(await startServer(root));

      const faulty = await startChild(id, invocation, fault, null, "EXECUTION");
      await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));
      const submission = submitAdvance(server.ingressUrl, invocation, 120_000).catch(() => null);
      const died = await waitForExit(faulty);
      expect(died.signal).toBe("SIGKILL");

      await startChild(id, invocation, null, null, "EXECUTION");
      await submission;

      expect(await waitForCheckpoint(ledger, taskId)).toBe(true);
      expect(ledger.status().eventCount).toBe(LIFECYCLE_PLAN.length);

      // The discriminator against the toy: evidence under `executions/`,
      // digest-keyed, and no toy marker anywhere. Run this with the toy bound
      // and these three assertions fail.
      expect(markers(root)).toBe(0);
      expect(executionEvidence(root)).toHaveLength(1);
      expect(executionStarts(root)).toBe(1);

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
      expect(keys.length - new Set(keys).size).toBe(0);

      const report = await reconcile({
        ledger,
        invocation,
        readCache: () => readCacheThroughHandler(server.ingressUrl, taskId),
      });
      expect(report.safeToResume).toBe(true);

      // The recorded route says what actually ran.
      expect(ledger.getExecutionRoute(taskId, 1)).toMatchObject({
        provider: "drill",
        model: "scripted-execution",
      });

      emitReceipt({
        drill: "D1-EXECUTION",
        mode: "RESTATE",
        faultPoint: fault,
        signal: died.signal,
        eventCount: head.eventCount,
        effectMarkers: markers(root),
        executionEvidence: executionEvidence(root).length,
        executionStarts: executionStarts(root),
        headSequence: head.headSequence,
        headEventSha256: head.headEventSha256,
        verdict: report.verdict,
        integrityOk: integrity.ok,
        rebuildIdentical,
        duplicateKeys: 0,
      });
    }, 240_000);
  }
});


/**
 * Per-task serialization, drilled (V2-B2-3).
 *
 * The Virtual Object is keyed by `taskId`, so Restate serializes invocations
 * per key by construction. That has been an architectural claim since ADR 0004;
 * these two drills turn it into evidence, and the pair is what makes the
 * evidence mean something.
 *
 * The handshake is the child's pause, now asynchronous: a held invocation stops
 * itself and leaves the endpoint live. Each held invocation announces, so the
 * NUMBER of announcements outstanding while nothing has been released says how
 * many invocations are running at that moment. Two for different keys, one for
 * the same key. Nothing here sleeps and nothing infers from duration — while
 * the pause blocked the whole process, both cases looked identical, which is
 * exactly why this packet had to change the seam before it could measure.
 */
describe("per-task serialization", () => {
  it("same key: two concurrent submissions produce one effect and one append set", async () => {
    // The child runs from `dist`; build it, or the drill measures a stale one.
    ensureChildBuilt();
    const id = "serialize-same-key";
    const taskId = randomUUID();
    const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const child = await startChild(id, invocation, null, "AFTER_INTENT");
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    // Two submissions of the SAME key, in flight together.
    const first = submitAdvance(server.ingressUrl, invocation, 120_000).catch(() => null);
    const second = submitAdvance(server.ingressUrl, invocation, 120_000).catch(() => null);

    // Exactly one reaches the beat. The second cannot, because the object is
    // keyed by this task and the first holds the key.
    expect(await waitForHeldTasks(child, 1)).toBe(1);
    // Give a second invocation every chance to arrive, then confirm none did.
    // The wait is bounded and its purpose is to make the negative honest: the
    // claim is that nothing else got through, so something must have had the
    // opportunity to.
    await delay(1_000);
    expect(heldTasks(child).size).toBe(1);
    expect([...heldTasks(child)]).toEqual([taskId]);

    writeFileSync(releasePath(root, "AFTER_INTENT"), "release", "utf8");
    await Promise.all([first, second]);
    expect(await waitForCheckpoint(ledger, taskId)).toBe(true);

    // One effect, one append set, no duplicate keys, and a head both callers
    // agree on because there is only one.
    const head = ledger.status();
    expect(head.eventCount).toBe(LIFECYCLE_PLAN.length);
    expect(markers(root)).toBe(1);
    const keys = ledger.listEvents({ limit: 200 }).events.map((r) => r.event.idempotencyKey);
    expect(keys.length - new Set(keys).size).toBe(0);
    expect(ledger.verifyIntegrity().ok).toBe(true);

    emitReceipt({
      drill: "SERIALIZE-SAME-KEY",
      mode: "RESTATE",
      faultPoint: null,
      signal: null,
      eventCount: head.eventCount,
      effectMarkers: markers(root),
      headSequence: head.headSequence,
      headEventSha256: head.headEventSha256,
      verdict: "CONSISTENT",
      integrityOk: true,
      rebuildIdentical: true,
      duplicateKeys: 0,
      concurrentPauses: heldTasks(child).size,
    });

    await stopChild(child);
  }, 240_000);

  it("different keys: two concurrent submissions are held at once, so it is per key and not global", async () => {
    // The discriminator. If serialization were global — or if the harness were
    // simply stopping the world — this would show one held invocation, exactly
    // as the same-key case does. Two means the object serializes by key and
    // leaves everything else running.
    // The child runs from `dist`; build it, or the drill measures a stale one.
    ensureChildBuilt();
    const id = "serialize-different-keys";
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const taskA = randomUUID();
    const taskB = randomUUID();
    const invocationA = deriveInvocation(taskA, 1, "2026-08-27T12:00:00.000Z", "a".repeat(64));
    const invocationB = deriveInvocation(taskB, 1, "2026-08-27T12:00:00.000Z", "b".repeat(64));

    const child = await startChild(id, invocationA, null, "AFTER_INTENT");
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    const runA = submitAdvance(server.ingressUrl, invocationA, 120_000).catch(() => null);
    const runB = submitAdvance(server.ingressUrl, invocationB, 120_000).catch(() => null);

    // Both held, at the same moment, with nothing released.
    expect(await waitForHeldTasks(child, 2)).toBe(2);
    // Both keys, held at the same moment -- and named, so this cannot be one
    // invocation redelivered.
    expect([...heldTasks(child)].sort()).toEqual([taskA, taskB].sort());

    writeFileSync(releasePath(root, "AFTER_INTENT"), "release", "utf8");
    await Promise.all([runA, runB]);
    expect(await waitForCheckpoint(ledger, taskA)).toBe(true);
    expect(await waitForCheckpoint(ledger, taskB)).toBe(true);

    // Each key got its own full plan and its own effect.
    const head = ledger.status();
    expect(head.eventCount).toBe(LIFECYCLE_PLAN.length * 2);
    expect(markers(root)).toBe(2);
    const keys = ledger.listEvents({ limit: 200 }).events.map((r) => r.event.idempotencyKey);
    expect(keys.length - new Set(keys).size).toBe(0);
    expect(ledger.verifyIntegrity().ok).toBe(true);

    emitReceipt({
      drill: "SERIALIZE-DIFFERENT-KEYS",
      mode: "RESTATE",
      faultPoint: null,
      signal: null,
      eventCount: head.eventCount,
      effectMarkers: markers(root),
      headSequence: head.headSequence,
      headEventSha256: head.headEventSha256,
      verdict: "CONSISTENT",
      integrityOk: true,
      rebuildIdentical: true,
      duplicateKeys: 0,
      // Measured, not asserted twice: the receipt carries what the drill saw.
      concurrentPauses: heldTasks(child).size,
    });

    await stopChild(child);
  }, 240_000);
});


/**
 * The invocation is addressable by the id derived before ingress (V2-B2-4a).
 *
 * Everything here rests on one fact that is measured rather than assumed: the
 * attach address needs nothing Restate minted. `deriveInvocation` computes the
 * idempotency key from `(taskId, attempt)` alone, and the ingress will resolve
 * an invocation from `(target, idempotency key)`, so the address is
 * RECONSTRUCTIBLE by anyone holding the coordinates. That is why a killed
 * client can be replaced by a fresh one, and why nothing in this packet
 * persists or returns an engine identity.
 *
 * The positives and the negatives are a pair. A passing attach on its own
 * shows that some URL worked; it does not show that the derived-key form is
 * what made it work. The wrong-segmentation drill supplies the other half —
 * the router refuses the neighbouring shapes by name — so the two together say
 * the derived key resolved it.
 */
describe("the derived key addresses the invocation", () => {
  /** The head an attach reply names, or null if it did not name one. */
  function finalSequenceIn(body: string): number | null {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = (parsed as Record<string, unknown>)["finalSequence"];
    return typeof value === "number" ? value : null;
  }

  it("send returns while the invocation is still held, and attach answers what a blocking submit answers", async () => {
    // The child runs from `dist`; build it, or the drill measures a stale one.
    ensureChildBuilt();
    const id = "attach-send-then-attach";
    const taskId = randomUUID();
    const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const child = await startChild(id, invocation, null, "AFTER_INTENT");
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    // P1. The discriminator against `submitAdvance`, in two independent forms.
    // The status is the engine's own word for it — 202 Accepted, with no
    // result — and the hold is the behavioural half: the walk has not
    // completed, and cannot, because only this drill can release it.
    const sent = await sendAdvance(server.ingressUrl, invocation);
    expect({ ok: sent.ok, status: sent.status }).toEqual({ ok: true, status: 202 });
    expect(await waitForHeldTasks(child, 1)).toBe(1);
    expect([...heldTasks(child)]).toEqual([taskId]);
    expect(ledger.getTask(taskId)?.currentState).not.toBe("CHECKPOINTED");

    // The result type cannot carry an engine identity, so no caller can
    // persist one. Asserted on the value, not only in the type.
    expect(Object.keys(sent).sort()).toEqual(["ok", "status"]);

    // P2. Attach on the DERIVED id, while the invocation is genuinely in
    // flight, and release only afterwards.
    const attaching = attachAdvance(server.ingressUrl, invocation, 120_000);
    writeFileSync(releasePath(root, "AFTER_INTENT"), "release", "utf8");
    const attached = await attaching;
    expect(attached.status).toBe(200);

    expect(await waitForCheckpoint(ledger, taskId)).toBe(true);
    const head = ledger.status();
    expect(finalSequenceIn(attached.body)).toBe(head.headSequence);

    // The same key, submitted blocking after completion, answers identically.
    // This is what "attach is a convenience over the authority" means when it
    // is measured rather than asserted: the two paths agree on the value, and
    // the ledger agrees with both.
    const blocking = await submitAdvance(server.ingressUrl, invocation, 30_000);
    expect(blocking.status).toBe(200);
    expect(blocking.body).toBe(attached.body);

    // One invocation, one effect, one append set, whoever was listening.
    expect(head.eventCount).toBe(LIFECYCLE_PLAN.length);
    expect(markers(root)).toBe(1);
    const keys = ledger.listEvents({ limit: 200 }).events.map((r) => r.event.idempotencyKey);
    expect(keys.length - new Set(keys).size).toBe(0);
    const integrity = ledger.verifyIntegrity();
    expect(integrity.problems).toEqual([]);

    emitReceipt({
      drill: "ATTACH-SEND-THEN-ATTACH",
      mode: "RESTATE",
      faultPoint: null,
      signal: null,
      eventCount: head.eventCount,
      effectMarkers: markers(root),
      headSequence: head.headSequence,
      headEventSha256: head.headEventSha256,
      verdict: "CONSISTENT",
      integrityOk: integrity.ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      sendStatus: sent.status,
      attachStatus: attached.status,
      attachFinalSequence: finalSequenceIn(attached.body),
      blockingMatchesAttach: blocking.body === attached.body,
    });

    await stopChild(child);
  }, 240_000);

  it("refuses a wrong target segmentation and a never-issued key, without touching the ledger", async () => {
    // Deliberately measured in the environment where the POSITIVE holds: the
    // object is deployed and the key is one the engine really issued, so the
    // only thing wrong with the neighbouring shapes is their segmentation.
    // Measured against a bare server instead, the same paths answer 404 for an
    // unknown service — a refusal that would have been about the deployment
    // and would have proved nothing about the address.
    ensureChildBuilt();
    const id = "attach-refusals";
    const taskId = randomUUID();
    const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const child = await startChild(id, invocation, null);
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));
    expect((await submitAdvance(server.ingressUrl, invocation, 120_000)).status).toBe(200);
    expect(await waitForCheckpoint(ledger, taskId)).toBe(true);

    const before = ledger.status().eventCount;
    expect(before).toBe(LIFECYCLE_PLAN.length);

    // N1. The falsifier for the segmentation. `:invocation_target` for a
    // Virtual Object handler is three segments; drop the handler, or drop the
    // object key, and the router answers with its own grammar rather than
    // resolving anything. Raw fetches on purpose: `attachAdvance` can only
    // build the correct shape, so the wrong ones have to be spelled here.
    const wrong: readonly [string, string][] = [
      [
        "no handler segment",
        "/restate/invocation/AcpTask/" + taskId + "/" + invocation.invocationId + "/attach",
      ],
      [
        "no object key segment",
        "/restate/invocation/AcpTask/advance/" + invocation.invocationId + "/attach",
      ],
    ];
    for (const [name, path] of wrong) {
      const response = await fetch(new URL(path, server.ingressUrl), {
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.text();
      expect({ name, status: response.status }).toEqual({ name, status: 400 });
      expect(body).toContain("bad path");
      // And it names the shape that WOULD have worked, which is the shape
      // `attachAdvance` builds.
      expect(body).toContain("/restate/invocation/:invocation_target/:idempotency_key/attach");
    }

    // N2. A key that was never issued. Refused, and — the half that matters —
    // refused without starting anything: the authority is unchanged, so the
    // refusal is observable where it counts and not only in an HTTP status.
    const neverIssued = deriveInvocation(randomUUID(), 9, "2026-08-27T12:00:00.000Z", "b".repeat(64));
    const missing = await attachAdvance(server.ingressUrl, neverIssued, 10_000);
    expect({ ok: missing.ok, status: missing.status }).toEqual({ ok: false, status: 404 });
    expect(ledger.status().eventCount).toBe(before);
    expect(ledger.getTask(neverIssued.taskId) ?? null).toBeNull();

    emitReceipt({
      drill: "ATTACH-REFUSALS",
      mode: "RESTATE",
      faultPoint: null,
      signal: null,
      eventCount: ledger.status().eventCount,
      effectMarkers: markers(root),
      headSequence: ledger.status().headSequence,
      headEventSha256: ledger.status().headEventSha256,
      verdict: "CONSISTENT",
      integrityOk: ledger.verifyIntegrity().ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      badPathRefusals: wrong.length,
      neverIssuedStatus: missing.status,
    });

    await stopChild(child);
  }, 240_000);

  it("survives the death of the attaching client: a fresh process rejoins from coordinates alone", async () => {
    ensureChildBuilt();
    const id = "attach-client-death";
    const taskId = randomUUID();
    const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const endpoint = await startChild(id, invocation, null, "AFTER_INTENT");
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    const sent = await sendAdvance(server.ingressUrl, invocation);
    expect(sent.status).toBe(202);
    expect(await waitForHeldTasks(endpoint, 1)).toBe(1);

    // A real client process, holding a real attach.
    const firstClient = await startAttachClient(id, invocation);
    // It rebuilt the address itself rather than using the one in its config.
    expect(attachClientDerivedId(firstClient)).toBe(invocation.invocationId);

    // Kill the CLIENT. Not the endpoint, not the server: the invocation is
    // untouched and simply has nobody listening to it.
    firstClient.kill("SIGKILL");
    const died = await waitForExit(firstClient);
    expect(died.signal).toBe("SIGKILL");
    expect(attachAnswer(firstClient)).toBeNull();
    // The work is still held, so the death cannot have completed it.
    expect(heldTasks(endpoint).size).toBe(1);
    expect(ledger.getTask(taskId)?.currentState).not.toBe("CHECKPOINTED");

    // A second client, handed a DECOY id, which it must ignore. This is the
    // drill: the handle needs no client state, so a fresh process rebuilds the
    // address from `(taskId, attempt)` rather than from anything it was told —
    // and a client that trusted its config would attach to the decoy and be
    // told the invocation does not exist.
    const decoy = randomUUID();
    expect(decoy).not.toBe(invocation.invocationId);
    const secondClient = await startAttachClient(id, { ...invocation, invocationId: decoy });
    expect(attachClientDerivedId(secondClient)).toBe(invocation.invocationId);

    writeFileSync(releasePath(root, "AFTER_INTENT"), "release", "utf8");
    expect(await waitForChildSays(secondClient, '"attached":true')).toBe(true);
    const answer = attachAnswer(secondClient);
    expect(answer?.attached).toBe(true);
    expect(answer?.status).toBe(200);

    expect(await waitForCheckpoint(ledger, taskId)).toBe(true);
    const head = ledger.status();
    expect(finalSequenceIn(answer?.body ?? "null")).toBe(head.headSequence);

    // One invocation, whatever happened to the listeners.
    expect(head.eventCount).toBe(LIFECYCLE_PLAN.length);
    expect(markers(root)).toBe(1);
    const keys = ledger.listEvents({ limit: 200 }).events.map((r) => r.event.idempotencyKey);
    expect(keys.length - new Set(keys).size).toBe(0);
    const integrity = ledger.verifyIntegrity();
    expect(integrity.problems).toEqual([]);

    emitReceipt({
      drill: "ATTACH-CLIENT-DEATH",
      mode: "RESTATE",
      faultPoint: null,
      signal: died.signal,
      eventCount: head.eventCount,
      effectMarkers: markers(root),
      headSequence: head.headSequence,
      headEventSha256: head.headEventSha256,
      verdict: "CONSISTENT",
      integrityOk: integrity.ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      attachStatus: answer?.status ?? null,
      attachFinalSequence: finalSequenceIn(answer?.body ?? "null"),
      derivedByFreshClient:
        attachClientDerivedId(secondClient) === invocation.invocationId &&
        attachClientDerivedId(secondClient) !== decoy,
    });

    await stopChild(endpoint);
  }, 240_000);

  it("concurrent attaches observe one invocation, one effect and one append set", async () => {
    ensureChildBuilt();
    const id = "attach-concurrent";
    const taskId = randomUUID();
    const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const child = await startChild(id, invocation, null, "AFTER_INTENT");
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    const sent = await sendAdvance(server.ingressUrl, invocation);
    expect(sent.status).toBe(202);
    expect(await waitForHeldTasks(child, 1)).toBe(1);

    // Two observers of one invocation, in flight together. This is the
    // durability-layer form of "closing and reopening the UI neither cancels
    // nor duplicates a run": watching is not running.
    const first = attachAdvance(server.ingressUrl, invocation, 120_000);
    const second = attachAdvance(server.ingressUrl, invocation, 120_000);

    // Give a second invocation every chance to appear before denying that one
    // did — the same discipline the same-key serialization drill uses.
    await delay(1_000);
    expect(heldTasks(child).size).toBe(1);

    writeFileSync(releasePath(root, "AFTER_INTENT"), "release", "utf8");
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toBe(b.body);

    expect(await waitForCheckpoint(ledger, taskId)).toBe(true);
    const head = ledger.status();
    expect(finalSequenceIn(a.body)).toBe(head.headSequence);

    // Counted, never inferred from duration: one held task, one effect, one
    // plan's worth of events, no duplicate keys.
    expect(heldTasks(child).size).toBe(1);
    expect(head.eventCount).toBe(LIFECYCLE_PLAN.length);
    expect(markers(root)).toBe(1);
    const keys = ledger.listEvents({ limit: 200 }).events.map((r) => r.event.idempotencyKey);
    expect(keys.length - new Set(keys).size).toBe(0);
    const integrity = ledger.verifyIntegrity();
    expect(integrity.problems).toEqual([]);

    emitReceipt({
      drill: "ATTACH-CONCURRENT",
      mode: "RESTATE",
      faultPoint: null,
      signal: null,
      eventCount: head.eventCount,
      effectMarkers: markers(root),
      headSequence: head.headSequence,
      headEventSha256: head.headEventSha256,
      verdict: "CONSISTENT",
      integrityOk: integrity.ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      concurrentAttaches: 2,
      concurrentPauses: heldTasks(child).size,
      attachBodiesAgree: a.body === b.body,
    });

    await stopChild(child);
  }, 240_000);

  it("an endpoint may die while nobody is attached, and a later attach still answers", async () => {
    ensureChildBuilt();
    const id = "attach-detached-endpoint-death";
    const taskId = randomUUID();
    const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    // The endpoint kills itself mid-plan while NOBODY holds an attach: the
    // send returned long before, and no observer exists. Nothing about the
    // work depends on someone watching it.
    const faulty = await startChild(id, invocation, "AFTER_INTENT");
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    const sent = await sendAdvance(server.ingressUrl, invocation);
    expect(sent.status).toBe(202);
    const died = await waitForExit(faulty);
    expect(died.signal).toBe("SIGKILL");

    // A replacement endpoint, and only then an observer — arriving after the
    // crash it never saw, at an address it computed rather than kept.
    await startChild(id, invocation, null);
    const attached = await attachAdvance(server.ingressUrl, invocation, 120_000);
    expect(attached.status).toBe(200);

    expect(await waitForCheckpoint(ledger, taskId)).toBe(true);
    const head = ledger.status();
    expect(finalSequenceIn(attached.body)).toBe(head.headSequence);
    expect(head.eventCount).toBe(LIFECYCLE_PLAN.length);
    expect(markers(root)).toBe(1);
    const keys = ledger.listEvents({ limit: 200 }).events.map((r) => r.event.idempotencyKey);
    expect(keys.length - new Set(keys).size).toBe(0);
    const integrity = ledger.verifyIntegrity();
    expect(integrity.problems).toEqual([]);

    emitReceipt({
      drill: "ATTACH-DETACHED-ENDPOINT-DEATH",
      mode: "RESTATE",
      faultPoint: "AFTER_INTENT",
      signal: died.signal,
      eventCount: head.eventCount,
      effectMarkers: markers(root),
      headSequence: head.headSequence,
      headEventSha256: head.headEventSha256,
      verdict: "CONSISTENT",
      integrityOk: integrity.ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      attachStatus: attached.status,
      attachFinalSequence: finalSequenceIn(attached.body),
    });
  }, 240_000);

  it("a server killed mid-attach fails closed rather than answering with a guess", async () => {
    ensureChildBuilt();
    const id = "attach-server-death";
    const taskId = randomUUID();
    const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const child = await startChild(id, invocation, null, "AFTER_INTENT");
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    const sent = await sendAdvance(server.ingressUrl, invocation);
    expect(sent.status).toBe(202);
    expect(await waitForHeldTasks(child, 1)).toBe(1);

    const before = ledger.status();
    // The verdict is bound to the promise at the moment it is created, before
    // the kill. Awaiting it later would leave a window in which the rejection
    // has no handler, and Node reports that as an unhandled rejection — a
    // failure of the drill's bookkeeping that would look like a failure of the
    // thing under test.
    const attaching = attachAdvance(server.ingressUrl, invocation, 120_000).then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    // Kill the observation channel underneath a live attach.
    await stopServer(server, "SIGKILL", 30_000);

    // It rejects. It does not resolve with a fabricated result, and it does
    // not resolve with a zero: an attach that could not complete says nothing
    // about whether the task advanced, and saying nothing is the correct
    // answer.
    const settled = await attaching;
    expect(settled).toBe("rejected");

    // And it appended nothing on its way out. The authority is exactly where
    // the walk left it.
    const after = ledger.status();
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.headEventSha256).toBe(before.headEventSha256);
    const integrity = ledger.verifyIntegrity();
    expect(integrity.problems).toEqual([]);

    emitReceipt({
      drill: "ATTACH-SERVER-DEATH",
      mode: "RESTATE",
      faultPoint: null,
      signal: "SIGKILL",
      eventCount: after.eventCount,
      effectMarkers: markers(root),
      headSequence: after.headSequence,
      headEventSha256: after.headEventSha256,
      verdict: "INDETERMINATE",
      integrityOk: integrity.ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      attachSettledAs: settled,
    });

    await stopChild(child);
  }, 240_000);
});
