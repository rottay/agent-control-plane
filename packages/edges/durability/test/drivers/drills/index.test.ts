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
  CANCELLATION_TRANSITION_ID,
  INTENT_STEP,
  LIFECYCLE_PLAN,
  LOOPBACK_HOST,
  OUTCOME_STEP,
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
import type {
  BeatContext,
  DurableInvocation,
  EffectPort,
  PostconditionVerdict,
  ScenarioRoot,
} from "@acp/runtime";

import { serverAvailability, startServer } from "../../../src/server-handle/index.js";
import { platformKey, readTrackedPin, receiptMatchesPin } from "../../../src/server-handle/index.js";
import type { ServerExit, ServerHandle } from "../../../src/server-handle/index.js";
import {
  attachAdvance,
  deriveInvocation,
  readCacheThroughHandler,
  registerDeployment,
  resolveGate,
  sendAdvance,
  sendAdvanceDelayed,
  submitAdvance,
} from "../../../src/submit/index.js";
import { RestateDriver, reconcile } from "../../../src/drivers/restate-driver/index.js";
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

/**
 * Start a CANCEL-role child and wait until it says it is cancelling (V2-B2-4b).
 *
 * A separate spawner for the same reason `startAttachClient` is one: the roles
 * do not share a handshake, and waiting for the wrong line would kill a
 * process before it had asked the engine for anything.
 */
function startCancelClient(
  scenarioId: string,
  invocation: DurableInvocation,
  faultPoint: string | null,
): Promise<ChildProcess> {
  const config = JSON.stringify({
    scenarioId,
    invocation,
    emittedBy: EMITTED_BY,
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    initiativeId: TEST_INITIATIVE_ID,
    faultPoint,
    pauseAt: null,
    port: RUNTIME_SERVICE_PORT,
    effect: "TOY",
    role: "CANCEL",
  });
  return new Promise<ChildProcess>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CHILD_ENTRY, config], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    });
    children.push(child);
    if (child.pid !== undefined) trackSpawnedPid(child.pid, "startCancelClient");
    const sink = { text: "" };
    childOutput.set(child, sink);
    child.stdout.on("data", (chunk: Buffer) => {
      sink.text += chunk.toString("utf8");
      if (sink.text.includes('"cancelling":true')) resolvePromise(child);
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (!sink.text.includes('"cancelling":true')) {
        rejectPromise(
          new Error("cancel client exited before asking: code " + String(code) + " signal " + String(signal)),
        );
      }
    });
  });
}

/**
 * A driver that cancels, built in the drill's own process (V2-B2-4b).
 *
 * It is the REAL `RestateDriver`, over the same ledger and the same scenario
 * root the endpoint child walks, so the probe it takes sees the effect that
 * child did or did not perform. `probe` overrides the toy verdict for the one
 * drill that needs an unestablished postcondition, which is a state the toy
 * effect cannot produce on its own — the marker either exists or it does not.
 */
function cancelDriverFor(
  root: ScenarioRoot,
  ledger: Ledger,
  invocation: DurableInvocation,
  server: ServerHandle,
  probe?: () => Promise<PostconditionVerdict>,
): RestateDriver {
  const base = beatFactory(root, ledger);
  const beat = (candidate: DurableInvocation): Omit<BeatContext, "plan" | "initiativeId"> => {
    const context = base(candidate);
    return probe === undefined
      ? context
      : {
          ...context,
          // Delegated rather than lifted out: the port's `apply` is a method,
          // and only its verdict is being overridden here.
          effects: { apply: (operation) => context.effects.apply(operation), probe },
        };
  };
  return new RestateDriver(
    {
      ledger,
      invocation,
      emittedBy: EMITTED_BY,
      ingressUrl: server.ingressUrl,
      adminUrl: server.adminUrl,
    },
    beat,
    "LOCAL_COMMIT_WITH_RECEIPT",
    TEST_INITIATIVE_ID,
  );
}

/** The URL one fetch argument names, whichever of its three forms it took. */
function describeTarget(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

/**
 * Count what the driver asked the engine, while still really asking it.
 *
 * The refusal drills need "zero engine calls" to be observed rather than
 * argued. A spy that replaced the call would have measured a different
 * program; this one records and forwards, so the drill is still running
 * against the pinned server.
 */
async function countingEngineCalls<T>(
  run: () => Promise<T>,
): Promise<{ readonly result: T; readonly calls: readonly string[] }> {
  const original = globalThis.fetch;
  // Bound for calling and kept unbound for restoring, which are two different
  // needs: the spy must forward to the real implementation, and the teardown
  // must put back exactly the value it found.
  const forward = original.bind(globalThis);
  const calls: string[] = [];
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    calls.push((init?.method ?? "GET") + " " + describeTarget(input));
    return forward(input, init);
  }) as typeof globalThis.fetch;
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

/** Every event of one task, in ledger order. */
function taskTrail(ledger: Ledger, taskId: string): readonly { type: string; transitionId: string }[] {
  return ledger
    .listEvents({ taskId, limit: 200 })
    .events.map((record) => ({ type: record.event.type, transitionId: record.event.transitionId }));
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
  // --- V2-B2-4b: cancellation settles the ledger truth ----------------------
  /** What the probe found at settlement time. Never inferred from the state. */
  readonly cancelEffect?: string;
  /** Cancellations appended for the cancelled task. One, or the law failed. */
  readonly cancellations?: number;
  /** Engine calls the driver made. Zero for a refusal act 1 reached first. */
  readonly engineCalls?: number;
  /** The refusal a cancellation returned, when it returned one. */
  readonly cancelRefusal?: string;
  /** Was the OUTCOME appended immediately before the cancellation? */
  readonly outcomeBeforeCancellation?: boolean;
  /** Events appended to the cancelled task after its cancellation. Zero. */
  readonly beatsAfterCancellation?: number;
  /** Was the intent still open after a refused settlement? */
  readonly intentStillOpen?: boolean;
  /** The verdict `reconcile` reached over a crashed cancellation. */
  readonly recoveryVerdict?: string;
  // --- V2-B2-5: durable timers and the durable gate -------------------------
  /** What the delayed send answered. 202, or nothing was scheduled. */
  readonly timerStatus?: number;
  /** The ISO8601 duration scheduled. A caller value, never a clock read. */
  readonly timerDelay?: string;
  /** Beats the DELAYED task had while another task ran to completion beside it. */
  readonly beatsWhileScheduled?: number;
  /** Effect markers the delayed walk left. One, or it fired more than once. */
  readonly timerFirings?: number;
  /** What the engine answered a second, identical schedule. Recorded, not assumed. */
  readonly secondTimerStatus?: number;
  /** Distinct gates held at one moment. Two is what makes "the intended one" mean something. */
  readonly gatesHeld?: number;
  /** Distinct gates released. */
  readonly gatesReleased?: number;
  /** What the gate answered a SECOND resolve. Recorded verbatim, never assumed. */
  readonly secondResolveStatus?: number;
  /** Was the gate released before its run had ever been submitted? */
  readonly releasedBeforePark?: boolean;
  /** Surfaces swept for an engine identity. The count, never the identity. */
  readonly surfacesSwept?: number;
}

/**
 * Every receipt this file emitted, kept so the leak sweep can read them back.
 *
 * A receipt is a durable artifact in the same sense a ledger row is -- it is
 * what a reader is handed afterwards -- so "no engine-minted identity is
 * persisted" has to cover receipts too, and covering them by inspection would
 * mean trusting whoever wrote the next one (V2-B2-4b).
 */
const emittedReceipts: DrillReceipt[] = [];

/** Restate names its own invocations `inv_` plus a base62 blob. */
const ENGINE_INVOCATION_ID_SHAPE = /inv_[A-Za-z0-9]{10,}/;

function emitReceipt(receipt: DrillReceipt): void {
  emittedReceipts.push(receipt);
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
  // No receipt this file emitted names an engine-minted invocation id
  // (V2-B2-4b). Swept here rather than per drill so a receipt added later is
  // covered without anyone having to remember to cover it.
  for (const receipt of emittedReceipts) {
    expect(JSON.stringify(receipt)).not.toMatch(ENGINE_INVOCATION_ID_SHAPE);
  }
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

// ---------------------------------------------------------------------------
// V2-B2-4b: cancellation, against the pinned server
// ---------------------------------------------------------------------------

/**
 * Cancellation is an ORDER, so these drills measure order.
 *
 * Every one of them holds a real invocation at a real beat on a real engine
 * and then cancels it, because the properties worth proving only exist while
 * something is genuinely in flight: a cancellation of a finished task proves
 * nothing about interrupting one.
 *
 * The negatives carry the weight. Nothing at the previous HEAD can pass any of
 * them, because nothing cancelled — and each is written so that the obvious
 * wrong implementation fails it: a settlement that ran before the engine call
 * fails the ordering drill, one that appended over an unestablished effect
 * fails the UNKNOWN drill, and one that trusted the ledger's own lifecycle
 * rules fails the terminal drill.
 */
describe("cancellation settles the ledger truth", () => {
  /** How many cancellations this task carries. Never more than one. */
  function cancellations(ledger: Ledger, taskId: string): number {
    return taskTrail(ledger, taskId).filter((e) => e.type === "TASK_CANCELLED").length;
  }

  it("NOT_DONE: one cancellation, no effect performed, and no beat after it", async () => {
    ensureChildBuilt();
    const id = "cancel-not-done";
    const taskId = randomUUID();
    const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    // Held at the intent beat: the INTENT is durable, the effect has not run.
    const child = await startChild(id, invocation, null, "AFTER_INTENT");
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));
    expect((await sendAdvance(server.ingressUrl, invocation)).status).toBe(202);
    expect(await waitForHeldTasks(child, 1)).toBe(1);

    const before = ledger.status();
    const driver = cancelDriverFor(root, ledger, invocation, server);
    const { result, calls } = await countingEngineCalls(() => driver.cancel(invocation));

    // The engine was reached twice: resolve the address, then cancel at it.
    expect(calls).toEqual([
      "POST " + server.ingressUrl + "/restate/lookup",
      calls[1] ?? "",
    ]);
    expect(calls[1]).toMatch(new RegExp("^PATCH " + server.adminUrl + "/invocations/inv_[A-Za-z0-9]+/cancel$"));

    // Exactly one cancellation, and the effect was never performed: a
    // cancellation that repaired the missing effect would be doing the work it
    // was asked to abandon, and `closeIntent` would have done exactly that.
    expect(result).toEqual({ ok: true, finalSequence: ledger.status().headSequence });
    expect(cancellations(ledger, taskId)).toBe(1);
    expect(ledger.status().eventCount).toBe(before.eventCount + 1);
    expect(ledger.getTask(taskId)?.currentState).toBe("CANCELLED");
    expect(markers(root)).toBe(0);

    const cancelled = taskTrail(ledger, taskId).at(-1);
    expect(cancelled).toEqual({ type: "TASK_CANCELLED", transitionId: CANCELLATION_TRANSITION_ID });

    const liveTask = JSON.stringify(ledger.getTask(taskId));
    ledger.rebuildReadModel();
    expect(JSON.stringify(ledger.getTask(taskId))).toBe(liveTask);
    const integrity = ledger.verifyIntegrity();
    expect(integrity.problems).toEqual([]);
    const keys = ledger.listEvents({ limit: 200 }).events.map((r) => r.event.idempotencyKey);
    expect(keys.length - new Set(keys).size).toBe(0);

    // No beat after the cancellation, and NOT because nothing was running.
    // The hold is released and a second task is driven to completion on the
    // same endpoint, so the window in which the cancelled invocation could
    // have appended is a window in which another one demonstrably did. A bare
    // wait could not tell "stopped" from "slow".
    const afterCancel = taskTrail(ledger, taskId).length;
    writeFileSync(releasePath(root, "AFTER_INTENT"), "release", "utf8");
    const second = deriveInvocation(randomUUID(), 1, "2026-08-27T12:00:00.000Z", "b".repeat(64));
    expect((await submitAdvance(server.ingressUrl, second, 120_000)).status).toBe(200);
    expect(await waitForCheckpoint(ledger, second.taskId)).toBe(true);

    const beatsAfterCancellation = taskTrail(ledger, taskId).length - afterCancel;
    expect(beatsAfterCancellation).toBe(0);
    expect(taskTrail(ledger, taskId).at(-1)?.type).toBe("TASK_CANCELLED");

    emitReceipt({
      drill: "CANCEL-NOT-DONE",
      mode: "RESTATE",
      faultPoint: null,
      signal: null,
      eventCount: ledger.status().eventCount,
      effectMarkers: markers(root),
      headSequence: ledger.status().headSequence,
      headEventSha256: ledger.status().headEventSha256,
      verdict: "CONSISTENT",
      integrityOk: integrity.ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      cancelEffect: "NOT_DONE",
      cancellations: cancellations(ledger, taskId),
      engineCalls: calls.length,
      beatsAfterCancellation,
    });

    await stopChild(child);
  }, 240_000);

  it("DONE: the outcome is appended BEFORE the cancellation, in that order", async () => {
    ensureChildBuilt();
    const id = "cancel-done";
    const taskId = randomUUID();
    const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    // Held AFTER the effect and before the outcome: the exact interval the
    // three-beat law exists for, and the only one where a cancellation has to
    // decide what to do about an effect that happened but was never recorded.
    const child = await startChild(id, invocation, null, "AFTER_EFFECT");
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));
    expect((await sendAdvance(server.ingressUrl, invocation)).status).toBe(202);
    expect(await waitForChildSays(child, '"paused":"AFTER_EFFECT"')).toBe(true);
    expect(markers(root)).toBe(1);

    const before = ledger.status().eventCount;
    const driver = cancelDriverFor(root, ledger, invocation, server);
    const result = await driver.cancel(invocation);

    expect(result).toEqual({ ok: true, finalSequence: ledger.status().headSequence });
    // Two appends: the OUTCOME that records the effect, then the cancellation.
    expect(ledger.status().eventCount).toBe(before + 2);

    // The ORDER, not the membership. A set assertion would pass on a log whose
    // cancellation came first, which is the three-beat law read backwards.
    const trail = taskTrail(ledger, taskId);
    const outcomeAt = trail.findIndex((e) => e.transitionId === OUTCOME_STEP.transitionId);
    const cancelAt = trail.findIndex((e) => e.transitionId === CANCELLATION_TRANSITION_ID);
    expect(outcomeAt).toBeGreaterThanOrEqual(0);
    expect(cancelAt).toBe(outcomeAt + 1);
    expect(cancellations(ledger, taskId)).toBe(1);
    expect(ledger.getTask(taskId)?.currentState).toBe("CANCELLED");
    // The effect was performed once, by the walk, and not again by the cancel.
    expect(markers(root)).toBe(1);

    const integrity = ledger.verifyIntegrity();
    expect(integrity.problems).toEqual([]);
    const keys = ledger.listEvents({ limit: 200 }).events.map((r) => r.event.idempotencyKey);
    expect(keys.length - new Set(keys).size).toBe(0);

    emitReceipt({
      drill: "CANCEL-DONE",
      mode: "RESTATE",
      faultPoint: null,
      signal: null,
      eventCount: ledger.status().eventCount,
      effectMarkers: markers(root),
      headSequence: ledger.status().headSequence,
      headEventSha256: ledger.status().headEventSha256,
      verdict: "CONSISTENT",
      integrityOk: integrity.ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      pausedAt: "AFTER_EFFECT",
      cancelEffect: "DONE",
      cancellations: cancellations(ledger, taskId),
      outcomeBeforeCancellation: cancelAt === outcomeAt + 1,
    });

    writeFileSync(releasePath(root, "AFTER_EFFECT"), "release", "utf8");
    await stopChild(child);
  }, 240_000);

  it("UNKNOWN: appends nothing, refuses, and leaves the intent open", async () => {
    ensureChildBuilt();
    const id = "cancel-unknown";
    const taskId = randomUUID();
    const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const child = await startChild(id, invocation, null, "AFTER_INTENT");
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));
    expect((await sendAdvance(server.ingressUrl, invocation)).status).toBe(202);
    expect(await waitForHeldTasks(child, 1)).toBe(1);

    const before = ledger.status();
    // The one verdict the toy effect cannot produce: its marker either exists
    // or it does not. An effect whose completion cannot be established is the
    // real case this refusal exists for, so it is injected rather than faked
    // by breaking the ledger.
    const driver = cancelDriverFor(root, ledger, invocation, server, () =>
      Promise.resolve("UNKNOWN"),
    );
    const { result, calls } = await countingEngineCalls(() => driver.cancel(invocation));

    expect(result).toEqual({ ok: false, refusal: "POSTCONDITION_UNKNOWN", at: "cancel" });
    // The engine WAS stopped. Refusing to write is not refusing to act: leaving
    // the invocation retrying while declining to record anything would be the
    // worst of both.
    expect(calls.length).toBe(2);

    // Zero delta, asserted on the authority rather than on the return value.
    const after = ledger.status();
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.headEventSha256).toBe(before.headEventSha256);
    expect(cancellations(ledger, taskId)).toBe(0);

    // And the intent is still open, which is what makes this recoverable: an
    // operator finds exactly the state `PostconditionUnknownError` leaves.
    const trail = taskTrail(ledger, taskId);
    expect(ledger.getTask(taskId)?.currentState).toBe("RUNNING");
    const intentStillOpen =
      trail.some((e) => e.transitionId === INTENT_STEP.transitionId) &&
      !trail.some((e) => e.transitionId === OUTCOME_STEP.transitionId);
    expect(intentStillOpen).toBe(true);

    emitReceipt({
      drill: "CANCEL-UNKNOWN",
      mode: "RESTATE",
      faultPoint: null,
      signal: null,
      eventCount: after.eventCount,
      effectMarkers: markers(root),
      headSequence: after.headSequence,
      headEventSha256: after.headEventSha256,
      verdict: "CONSISTENT",
      integrityOk: ledger.verifyIntegrity().ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      cancelRefusal: "POSTCONDITION_UNKNOWN",
      cancellations: 0,
      engineCalls: calls.length,
      intentStillOpen,
    });

    writeFileSync(releasePath(root, "AFTER_INTENT"), "release", "utf8");
    await stopChild(child);
  }, 240_000);

  it("CHECKPOINTED: refused with no engine call and no append", async () => {
    ensureChildBuilt();
    const id = "cancel-terminal";
    const taskId = randomUUID();
    const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const child = await startChild(id, invocation, null);
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));
    expect((await submitAdvance(server.ingressUrl, invocation, 120_000)).status).toBe(200);
    expect(await waitForCheckpoint(ledger, taskId)).toBe(true);

    const before = ledger.status();
    expect(before.eventCount).toBe(LIFECYCLE_PLAN.length);

    const driver = cancelDriverFor(root, ledger, invocation, server);
    const { result, calls } = await countingEngineCalls(() => driver.cancel(invocation));

    expect(result).toEqual({ ok: false, refusal: "TASK_TERMINAL", at: "cancel" });
    // Act 1 runs before act 2, so a completed run is never interfered with.
    // Observed, not argued: the driver made no request of any kind.
    expect(calls).toEqual([]);
    expect(ledger.status().eventCount).toBe(before.eventCount);
    expect(ledger.status().headEventSha256).toBe(before.headEventSha256);
    expect(cancellations(ledger, taskId)).toBe(0);
    expect(ledger.getTask(taskId)?.currentState).toBe("CHECKPOINTED");

    emitReceipt({
      drill: "CANCEL-TERMINAL",
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
      cancelRefusal: "TASK_TERMINAL",
      cancellations: 0,
      engineCalls: 0,
    });

    await stopChild(child);
  }, 240_000);

  it("SIGKILL between the engine call and the settlement leaves a recoverable open intent", async () => {
    ensureChildBuilt();
    const id = "cancel-kill-window";
    const taskId = randomUUID();
    const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const endpoint = await startChild(id, invocation, null, "AFTER_INTENT");
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));
    expect((await sendAdvance(server.ingressUrl, invocation)).status).toBe(202);
    expect(await waitForHeldTasks(endpoint, 1)).toBe(1);

    const before = ledger.status();

    // A real process, running the real driver, dying in the real window: the
    // settlement's first probe kills it, which is after the engine call
    // returned and before anything has been appended.
    const canceller = await startCancelClient(id, invocation, "BEFORE_SETTLEMENT");
    const died = await waitForExit(canceller);
    expect(died.signal).toBe("SIGKILL");
    expect(childOutput.get(canceller)?.text.includes('"cancelled"')).toBe(false);

    // What the crash left: nothing claimed, and an intent still open. This is
    // the state the plane already knows how to recover from, which is why the
    // residual window is safe rather than merely narrow.
    const after = ledger.status();
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.headEventSha256).toBe(before.headEventSha256);
    expect(cancellations(ledger, taskId)).toBe(0);
    expect(ledger.getTask(taskId)?.currentState).toBe("RUNNING");
    const trail = taskTrail(ledger, taskId);
    expect(trail.some((e) => e.transitionId === INTENT_STEP.transitionId)).toBe(true);
    expect(trail.some((e) => e.transitionId === OUTCOME_STEP.transitionId)).toBe(false);

    // And it is classified rather than guessed at: the reconciler answers with
    // a verdict computed against the ledger head it names.
    const report = await reconcile({
      ledger,
      invocation,
      readCache: () => readCacheThroughHandler(server.ingressUrl, taskId),
    });
    expect(report.resolvedByLedger).toBe(true);
    expect(["CONSISTENT", "DRIVER_BEHIND"]).toContain(report.verdict);

    // The operator path, which is the one that already exists: cancel again.
    // The engine is already stopped, so this second attempt gets `404`/`409`
    // from it -- an engine that is not running this invocation -- and settles
    // the ledger exactly once.
    const driver = cancelDriverFor(root, ledger, invocation, server);
    const result = await driver.cancel(invocation);
    expect(result).toEqual({ ok: true, finalSequence: ledger.status().headSequence });
    expect(cancellations(ledger, taskId)).toBe(1);
    expect(ledger.status().eventCount).toBe(before.eventCount + 1);
    expect(ledger.getTask(taskId)?.currentState).toBe("CANCELLED");

    const integrity = ledger.verifyIntegrity();
    expect(integrity.problems).toEqual([]);
    const keys = ledger.listEvents({ limit: 200 }).events.map((r) => r.event.idempotencyKey);
    expect(keys.length - new Set(keys).size).toBe(0);

    emitReceipt({
      drill: "CANCEL-KILL-WINDOW",
      mode: "RESTATE",
      faultPoint: "BEFORE_SETTLEMENT",
      signal: died.signal,
      eventCount: ledger.status().eventCount,
      effectMarkers: markers(root),
      headSequence: ledger.status().headSequence,
      headEventSha256: ledger.status().headEventSha256,
      verdict: report.verdict,
      integrityOk: integrity.ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      cancellations: cancellations(ledger, taskId),
      recoveryVerdict: report.verdict,
      intentStillOpen: true,
    });

    writeFileSync(releasePath(root, "AFTER_INTENT"), "release", "utf8");
    await stopChild(endpoint);
  }, 240_000);

  it("the engine's own identity reaches no event, read model, report or receipt", async () => {
    ensureChildBuilt();
    const id = "cancel-no-engine-identity";
    const taskId = randomUUID();
    const invocation = deriveInvocation(taskId, 1, "2026-08-27T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const child = await startChild(id, invocation, null, "AFTER_INTENT");
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));
    expect((await sendAdvance(server.ingressUrl, invocation)).status).toBe(202);
    expect(await waitForHeldTasks(child, 1)).toBe(1);

    // The discriminating control, and without it this drill would pass on a
    // system where no engine id existed at all. The drill resolves the id
    // ITSELF, the same way and from the same four values the driver uses, and
    // asserts it is a real one of the recognisable shape. Only then does
    // "it appears nowhere" mean anything.
    const lookup = await fetch(new URL("/restate/lookup", server.ingressUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: "idempotentInvocation",
        service: "AcpTask",
        key: taskId,
        handler: "advance",
        idempotencyKey: invocation.invocationId,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(lookup.status).toBe(200);
    const engineId = (JSON.parse(await lookup.text()) as { invocationId: string }).invocationId;
    expect(engineId).toMatch(ENGINE_INVOCATION_ID_SHAPE);
    // It is not the id this side derived, which is the whole reason it must
    // not be kept: two addresses for one invocation, and only one of them
    // belongs to the ledger.
    expect(engineId).not.toBe(invocation.invocationId);

    const driver = cancelDriverFor(root, ledger, invocation, server);
    const outcome = await driver.cancel(invocation);
    expect(outcome).toEqual({ ok: true, finalSequence: ledger.status().headSequence });

    // The sweep, over everything a reader is ever handed.
    const report = await reconcile({
      ledger,
      invocation,
      readCache: () => readCacheThroughHandler(server.ingressUrl, taskId),
    });
    const surfaces: readonly [string, unknown][] = [
      ["outcome", outcome],
      ["events", ledger.listEvents({ limit: 200 }).events.map((r) => r.event)],
      ["task read model", ledger.getTask(taskId)],
      ["task list", ledger.listTasks().tasks],
      ["reconciliation report", report],
      ["driver status", await driver.status()],
    ];
    for (const [name, surface] of surfaces) {
      const serialized = JSON.stringify(surface);
      expect({ name, leaked: ENGINE_INVOCATION_ID_SHAPE.test(serialized) }).toEqual({
        name,
        leaked: false,
      });
      expect({ name, leaked: serialized.includes(engineId) }).toEqual({ name, leaked: false });
    }

    // And what IS there is the derived address, which the ledger owns.
    expect(JSON.stringify(ledger.listEvents({ taskId, limit: 200 }).events.map((r) => r.event))).toContain(
      invocation.invocationId,
    );

    emitReceipt({
      drill: "CANCEL-NO-ENGINE-IDENTITY",
      mode: "RESTATE",
      faultPoint: null,
      signal: null,
      eventCount: ledger.status().eventCount,
      effectMarkers: markers(root),
      headSequence: ledger.status().headSequence,
      headEventSha256: ledger.status().headEventSha256,
      verdict: report.verdict,
      integrityOk: ledger.verifyIntegrity().ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      cancellations: cancellations(ledger, taskId),
      // The count of surfaces swept, never the id itself: a receipt that
      // named what it was looking for would be the leak it exists to deny.
      engineCalls: surfaces.length,
    });

    writeFileSync(releasePath(root, "AFTER_INTENT"), "release", "utf8");
    await stopChild(child);
  }, 240_000);

  it("the two drivers now disagree about CANCEL, and the SQLite one still refuses field-exactly", async () => {
    // A regression assertion on an existing behaviour, and the packet says so
    // rather than presenting it as new evidence: the supervisor source is
    // untouched and its own suite asserts these four refusals. What IS new is
    // the DIVERGENCE -- one driver cancels and the other does not -- which is
    // exactly what a capability declaration exists to let a caller discover
    // without trying it.
    const root = scenario("cancel-sqlite-refusal");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const invocation = deriveInvocation(randomUUID(), 1, "2026-08-27T12:00:00.000Z", "c".repeat(64));
    const supervisor = new SqliteSupervisor({
      ledger,
      invocation,
      effects: toyEffects(root),
      emittedBy: EMITTED_BY,
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      initiativeId: TEST_INITIATIVE_ID,
      route: drillRoute(invocation),
    });

    // Field by field, never a throw and never a silent no-op, and explicitly
    // not delegating to the Restate driver: a supervisor that quietly handed
    // cancellation over would make the mode flag a lie.
    expect(await supervisor.cancel()).toEqual({
      ok: false,
      refusal: "CAPABILITY_UNSUPPORTED",
      at: "cancel",
    });
    expect(supervisor.capabilities().verbs.CANCEL).toBe("UNSUPPORTED");
    // Nothing was appended by asking.
    expect(ledger.status().eventCount).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// V2-B2-5: durable timers, against the pinned server
// ---------------------------------------------------------------------------

/**
 * The same driver the cancellation drills build, named for what these ask of
 * it. A second factory would be a second thing to keep in step.
 */
const timerDriverFor = cancelDriverFor;

/**
 * Timers are about WHEN, so these drills never measure time with a clock.
 *
 * A bare wait cannot tell "scheduled" from "slow", which is the whole
 * difficulty: a drill that slept and then found no beats would pass just as
 * happily against a driver that dropped the timer on the floor. So the
 * discriminator is another task — a second, undelayed submission driven all the
 * way to `CHECKPOINTED` on the same endpoint. That establishes the window was
 * genuinely long enough for work to happen, and the delayed task's trail being
 * empty in the same window is then evidence rather than an absence of evidence.
 */
describe("durable timers are held by the engine", () => {
  it("T1 fires exactly once, and the walk it schedules lands in the ledger", async () => {
    ensureChildBuilt();
    const id = "timer-fires-once";
    const taskId = randomUUID();
    const invocation = deriveInvocation(taskId, 1, "2026-09-03T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const child = await startChild(id, invocation, null);
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    const driver = timerDriverFor(root, ledger, invocation, server);
    // The verb answers `{ ok: true }` and nothing else: it observes no ledger
    // position, because at this instant there is not one to observe.
    expect(await driver.timer(invocation, 2_000)).toEqual({ ok: true });

    expect(await waitForCheckpoint(ledger, taskId)).toBe(true);
    const head = ledger.status();
    expect(head.eventCount).toBe(LIFECYCLE_PLAN.length);
    // One marker: the delayed walk ran once, not once per retry.
    expect(markers(root)).toBe(1);
    const keys = ledger.listEvents({ limit: 200 }).events.map((r) => r.event.idempotencyKey);
    expect(keys.length - new Set(keys).size).toBe(0);
    const integrity = ledger.verifyIntegrity();
    expect(integrity.problems).toEqual([]);
    const live = JSON.stringify(ledger.getTask(taskId));
    ledger.rebuildReadModel();
    expect(JSON.stringify(ledger.getTask(taskId))).toBe(live);

    emitReceipt({
      drill: "TIMER-FIRES-ONCE",
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
      timerDelay: "PT2S",
      timerFirings: markers(root),
    });

    await stopChild(child);
  }, 240_000);

  it("T2 holds the beat: a second task completes beside it while its trail stays empty", async () => {
    ensureChildBuilt();
    const id = "timer-holds-the-beat";
    const delayedTask = randomUUID();
    const delayed = deriveInvocation(delayedTask, 1, "2026-09-03T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const child = await startChild(id, delayed, null);
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    const driver = timerDriverFor(root, ledger, delayed, server);
    expect(await driver.timer(delayed, 30_000)).toEqual({ ok: true });

    // The discriminator: a DIFFERENT task, undelayed, driven to completion on
    // the same endpoint. The window is now demonstrably wide enough for a whole
    // plan to run, so an empty trail is a held timer and not a slow one.
    const beside = deriveInvocation(randomUUID(), 1, "2026-09-03T12:00:00.000Z", "b".repeat(64));
    expect((await submitAdvance(server.ingressUrl, beside, 120_000)).status).toBe(200);
    expect(await waitForCheckpoint(ledger, beside.taskId)).toBe(true);

    const beatsWhileScheduled = taskTrail(ledger, delayedTask).length;
    expect(beatsWhileScheduled).toBe(0);
    expect(ledger.getTask(delayedTask)).toBeNull();
    // And the effect the delayed walk would perform has not been performed.
    expect(markers(root)).toBe(1);

    const integrity = ledger.verifyIntegrity();
    expect(integrity.problems).toEqual([]);

    emitReceipt({
      drill: "TIMER-HOLDS-THE-BEAT",
      mode: "RESTATE",
      faultPoint: null,
      signal: null,
      eventCount: ledger.status().eventCount,
      effectMarkers: markers(root),
      headSequence: ledger.status().headSequence,
      headEventSha256: ledger.status().headEventSha256,
      verdict: "CONSISTENT",
      integrityOk: integrity.ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      timerDelay: "PT30S",
      beatsWhileScheduled,
    });

    await stopChild(child);
  }, 240_000);

  it("T3 survives the death of the endpoint that would run it", async () => {
    ensureChildBuilt();
    const id = "timer-endpoint-death";
    const taskId = randomUUID();
    const invocation = deriveInvocation(taskId, 1, "2026-09-03T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const doomed = await startChild(id, invocation, null);
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    const driver = timerDriverFor(root, ledger, invocation, server);
    expect(await driver.timer(invocation, 5_000)).toEqual({ ok: true });

    // The process that would have served the scheduled invocation dies before
    // it fires. The schedule is the ENGINE's, so this must not lose it.
    doomed.kill("SIGKILL");
    const died = await waitForExit(doomed);
    expect(died.signal).toBe("SIGKILL");

    await startChild(id, invocation, null);
    expect(await waitForCheckpoint(ledger, taskId)).toBe(true);
    const head = ledger.status();
    expect(head.eventCount).toBe(LIFECYCLE_PLAN.length);
    expect(markers(root)).toBe(1);
    const keys = ledger.listEvents({ limit: 200 }).events.map((r) => r.event.idempotencyKey);
    expect(keys.length - new Set(keys).size).toBe(0);
    const integrity = ledger.verifyIntegrity();
    expect(integrity.problems).toEqual([]);

    emitReceipt({
      drill: "TIMER-ENDPOINT-DEATH",
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
      timerDelay: "PT5S",
      timerFirings: markers(root),
    });
  }, 240_000);

  it("T4 survives the death of the server that holds it", async () => {
    ensureChildBuilt();
    const id = "timer-server-death";
    const taskId = randomUUID();
    const invocation = deriveInvocation(taskId, 1, "2026-09-03T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const first = trackServer(await startServer(root));

    const child = await startChild(id, invocation, null);
    await registerDeployment(first.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    const driver = timerDriverFor(root, ledger, invocation, first);
    expect(await driver.timer(invocation, 8_000)).toEqual({ ok: true });
    expect(taskTrail(ledger, taskId)).toEqual([]);

    // This is the drill that separates an ENGINE-held timer from a
    // client-held one: the process that accepted the schedule is destroyed.
    const killed = await stopServer(first, "SIGKILL");
    if (killed === null) throw new Error("T4's SIGKILL was not the first stop of this handle");
    expect(killed.signal).toBe("SIGKILL");
    await stopChild(child);

    // Same data root, so the schedule is whatever the engine durably kept.
    const second = trackServer(await startServer(root));
    await startChild(id, invocation, null);
    await registerDeployment(second.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    expect(await waitForCheckpoint(ledger, taskId)).toBe(true);
    const head = ledger.status();
    expect(head.eventCount).toBe(LIFECYCLE_PLAN.length);
    expect(markers(root)).toBe(1);
    const keys = ledger.listEvents({ limit: 200 }).events.map((r) => r.event.idempotencyKey);
    expect(keys.length - new Set(keys).size).toBe(0);
    const integrity = ledger.verifyIntegrity();
    expect(integrity.problems).toEqual([]);

    emitReceipt({
      drill: "TIMER-SERVER-DEATH",
      mode: "RESTATE",
      faultPoint: null,
      signal: "SIGKILL",
      eventCount: head.eventCount,
      effectMarkers: markers(root),
      headSequence: head.headSequence,
      headEventSha256: head.headEventSha256,
      verdict: "CONSISTENT",
      integrityOk: integrity.ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      timerDelay: "PT8S",
      timerFirings: markers(root),
    });
  }, 240_000);

  it("T5 scheduling twice is the same schedule, not a second one", async () => {
    ensureChildBuilt();
    const id = "timer-idempotent";
    const taskId = randomUUID();
    const invocation = deriveInvocation(taskId, 1, "2026-09-03T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const child = await startChild(id, invocation, null);
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    // Through the submit helper rather than the driver, so the engine's own
    // answer to each call is recorded rather than flattened into `{ok:true}`.
    const firstSchedule = await sendAdvanceDelayed(server.ingressUrl, invocation, 3_000);
    const secondSchedule = await sendAdvanceDelayed(server.ingressUrl, invocation, 3_000);
    expect(firstSchedule.status).toBe(202);
    // Recorded, never assumed: the derived idempotency key is what makes the
    // second call the same call.
    expect(secondSchedule.status).toBe(202);

    expect(await waitForCheckpoint(ledger, taskId)).toBe(true);
    const head = ledger.status();
    // One walk, one append set, one effect -- not two of anything.
    expect(head.eventCount).toBe(LIFECYCLE_PLAN.length);
    expect(markers(root)).toBe(1);
    const keys = ledger.listEvents({ limit: 200 }).events.map((r) => r.event.idempotencyKey);
    expect(keys.length - new Set(keys).size).toBe(0);
    const integrity = ledger.verifyIntegrity();
    expect(integrity.problems).toEqual([]);

    emitReceipt({
      drill: "TIMER-IDEMPOTENT",
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
      timerStatus: firstSchedule.status,
      secondTimerStatus: secondSchedule.status,
      timerFirings: markers(root),
    });

    await stopChild(child);
  }, 240_000);

  it("T6 refuses a malformed duration with zero engine calls, and the server would not have", async () => {
    ensureChildBuilt();
    const id = "timer-malformed";
    const taskId = randomUUID();
    const invocation = deriveInvocation(taskId, 1, "2026-09-03T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const child = await startChild(id, invocation, null);
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    const driver = timerDriverFor(root, ledger, invocation, server);
    const { calls } = await countingEngineCalls(async () => {
      for (const bad of [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(driver.timer(invocation, bad)).rejects.toThrow(/durable timer/);
      }
    });
    // Observed through the spy, not argued: nothing reached the engine.
    expect(calls).toEqual([]);
    expect(ledger.status().eventCount).toBe(0);

    // Why the client-side refusal is load-bearing rather than defensive: the
    // server ACCEPTS a malformed duration and silently ignores it. Asserted
    // here against the real engine so the claim is measured, not remembered.
    const ignored = await fetch(
      server.ingressUrl + "/AcpTask/" + randomUUID() + "/advance/send?delay=3s",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(30_000),
      },
    );
    await ignored.text();
    expect(ignored.status).toBe(202);

    // Whereas the parameter IS understood: on a blocking call it is refused by
    // name. Understood on sends, unvalidated on sends, therefore validated by
    // this repository.
    const onCall = await fetch(
      server.ingressUrl + "/AcpTask/" + randomUUID() + "/advance?delay=PT1S",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(30_000),
      },
    );
    const onCallBody = await onCall.text();
    expect(onCall.status).toBe(400);
    expect(onCallBody).toContain("delay query parameter");

    emitReceipt({
      drill: "TIMER-MALFORMED-REFUSED",
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
      engineCalls: calls.length,
      secondTimerStatus: ignored.status,
    });

    await stopChild(child);
  }, 240_000);
});

// ---------------------------------------------------------------------------
// V2-B2-5: the durable gate, against the pinned server
// ---------------------------------------------------------------------------

/**
 * SIGNAL is a named durable promise on a dedicated workflow, so these drills
 * measure delivery rather than discovery.
 *
 * The design they exercise is deliberately not the one first proposed. An
 * awakeable inside `AcpTask` would have had an identifier that does not exist
 * until the handler reaches it, which makes a signal arriving first
 * permanently lost — and S0 below is exactly that case, passing. It would also
 * have held the task key for the whole wait, so `advance` would have queued
 * behind an unresolved gate. Keeping the gate in its own service is what lets
 * the serialization and cancellation drills stand unedited as preservation
 * assertions.
 */
describe("the durable gate delivers signals", () => {
  /** Distinct gates the child has announced at a point. */
  function gatesAt(child: ChildProcess, point: "PARKED" | "RELEASED"): ReadonlySet<string> {
    const text = childOutput.get(child)?.text ?? "";
    const ids = new Set<string>();
    const pattern = new RegExp('"gate":"' + point + '","invocationId":"([0-9a-f-]+)"', "g");
    for (const match of text.matchAll(pattern)) {
      const id = match[1];
      if (id !== undefined) ids.add(id);
    }
    return ids;
  }

  /** Wait on a CONDITION -- the announcement -- never on elapsed time. */
  async function waitForGates(
    child: ChildProcess,
    point: "PARKED" | "RELEASED",
    count: number,
    deadlineMs = 60_000,
  ): Promise<number> {
    const started = Date.now();
    let seen = 0;
    while (Date.now() - started < deadlineMs) {
      seen = gatesAt(child, point).size;
      if (seen >= count) return seen;
      if (child.exitCode !== null || child.signalCode !== null) return seen;
      await delay(25);
    }
    return seen;
  }

  /**
   * Park a gate: submit its `run` without waiting for it.
   *
   * No `idempotency-key` header, and that is the engine's rule rather than a
   * choice — a workflow handler is already idempotent by its key, and the
   * pinned server refuses an explicit one. The derived id is still the
   * authority here; it is simply carried as the workflow KEY rather than as a
   * header.
   */
  async function parkGate(ingressUrl: string, invocation: DurableInvocation): Promise<number> {
    const response = await fetch(
      ingressUrl + "/AcpGate/" + invocation.invocationId + "/run/send",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invocation),
        signal: AbortSignal.timeout(30_000),
      },
    );
    await response.text();
    return response.status;
  }

  it("S0 releases a gate whose run was never submitted, and the later run returns at once", async () => {
    // The case the rejected awakeable design structurally cannot pass. There,
    // the identifier does not exist until the handler runs, so a signal that
    // arrives first has nowhere to land and is lost. Here the promise is engine
    // state keyed by the workflow key, so it is simply already complete.
    ensureChildBuilt();
    const id = "gate-before-park";
    const invocation = deriveInvocation(randomUUID(), 1, "2026-09-03T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const child = await startChild(id, invocation, null);
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    const before = ledger.status();
    const driver = cancelDriverFor(root, ledger, invocation, server);

    // Signal FIRST. Nothing is waiting, and nothing ever has been.
    expect(await driver.signal(invocation)).toEqual({ ok: true });
    expect(gatesAt(child, "PARKED").size).toBe(0);

    // Only now is the gate submitted -- and it does not wait.
    expect(await parkGate(server.ingressUrl, invocation)).toBe(202);
    expect(await waitForGates(child, "RELEASED", 1)).toBe(1);
    expect(gatesAt(child, "RELEASED").has(invocation.invocationId)).toBe(true);

    // Waiting is not a lifecycle transition, so the log did not move.
    const after = ledger.status();
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.headEventSha256).toBe(before.headEventSha256);

    emitReceipt({
      drill: "GATE-RELEASED-BEFORE-PARK",
      mode: "RESTATE",
      faultPoint: null,
      signal: null,
      eventCount: after.eventCount,
      effectMarkers: markers(root),
      headSequence: after.headSequence,
      headEventSha256: after.headEventSha256,
      verdict: "CONSISTENT",
      integrityOk: ledger.verifyIntegrity().ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      releasedBeforePark: true,
      gatesReleased: gatesAt(child, "RELEASED").size,
    });

    await stopChild(child);
  }, 240_000);

  it("S1 releases a held gate, exactly once, and the ledger does not move", async () => {
    ensureChildBuilt();
    const id = "gate-releases-held";
    const invocation = deriveInvocation(randomUUID(), 1, "2026-09-03T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const child = await startChild(id, invocation, null);
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    expect(await parkGate(server.ingressUrl, invocation)).toBe(202);
    // A handshake, not a sleep: the gate announced that it is holding.
    expect(await waitForGates(child, "PARKED", 1)).toBe(1);
    expect(gatesAt(child, "RELEASED").size).toBe(0);

    const before = ledger.status();
    const driver = cancelDriverFor(root, ledger, invocation, server);
    const { result, calls } = await countingEngineCalls(() => driver.signal(invocation));

    expect(result).toEqual({ ok: true });
    // ONE engine call, to an address built from the derived id alone. No
    // lookup, no admin: the whole reason this verb never sees an engine id.
    expect(calls).toEqual([
      "POST " + server.ingressUrl + "/AcpGate/" + invocation.invocationId + "/resolve",
    ]);

    expect(await waitForGates(child, "RELEASED", 1)).toBe(1);
    expect(gatesAt(child, "RELEASED")).toEqual(new Set([invocation.invocationId]));

    const after = ledger.status();
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.headEventSha256).toBe(before.headEventSha256);
    const integrity = ledger.verifyIntegrity();
    expect(integrity.problems).toEqual([]);

    emitReceipt({
      drill: "GATE-RELEASES-HELD",
      mode: "RESTATE",
      faultPoint: null,
      signal: null,
      eventCount: after.eventCount,
      effectMarkers: markers(root),
      headSequence: after.headSequence,
      headEventSha256: after.headEventSha256,
      verdict: "CONSISTENT",
      integrityOk: integrity.ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      gatesHeld: 1,
      gatesReleased: gatesAt(child, "RELEASED").size,
      engineCalls: calls.length,
    });

    await stopChild(child);
  }, 240_000);

  it("S2 releases the INTENDED gate: a second one is still held afterwards", async () => {
    // Without this, S1 would pass just as happily on a system that released
    // everything. Two gates, one signal, and the other must still be waiting.
    ensureChildBuilt();
    const id = "gate-intended-only";
    const gateA = deriveInvocation(randomUUID(), 1, "2026-09-03T12:00:00.000Z", "a".repeat(64));
    const gateB = deriveInvocation(randomUUID(), 1, "2026-09-03T12:00:00.000Z", "b".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const child = await startChild(id, gateA, null);
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    expect(await parkGate(server.ingressUrl, gateA)).toBe(202);
    expect(await parkGate(server.ingressUrl, gateB)).toBe(202);
    // Two DISTINCT gates held at one moment -- the same discriminator the
    // different-keys serialization drill uses.
    expect(await waitForGates(child, "PARKED", 2)).toBe(2);
    expect(gatesAt(child, "PARKED")).toEqual(new Set([gateA.invocationId, gateB.invocationId]));

    const driver = cancelDriverFor(root, ledger, gateA, server);
    expect(await driver.signal(gateA)).toEqual({ ok: true });
    expect(await waitForGates(child, "RELEASED", 1)).toBe(1);

    // Exactly A, and B is untouched.
    expect(gatesAt(child, "RELEASED")).toEqual(new Set([gateA.invocationId]));
    expect(gatesAt(child, "RELEASED").has(gateB.invocationId)).toBe(false);
    expect(gatesAt(child, "PARKED").has(gateB.invocationId)).toBe(true);

    // Releasing B now proves B really was still waiting rather than gone.
    expect(await driver.signal(gateB)).toEqual({ ok: true });
    expect(await waitForGates(child, "RELEASED", 2)).toBe(2);
    expect(gatesAt(child, "RELEASED")).toEqual(new Set([gateA.invocationId, gateB.invocationId]));

    expect(ledger.status().eventCount).toBe(0);

    emitReceipt({
      drill: "GATE-INTENDED-ONLY",
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
      gatesHeld: 2,
      gatesReleased: 2,
    });

    await stopChild(child);
  }, 240_000);

  it("S3 releasing twice releases once: the verb is idempotent, a bare second request is refused", async () => {
    ensureChildBuilt();
    const id = "gate-second-release";
    const invocation = deriveInvocation(randomUUID(), 1, "2026-09-03T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const child = await startChild(id, invocation, null);
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    expect(await parkGate(server.ingressUrl, invocation)).toBe(202);
    expect(await waitForGates(child, "PARKED", 1)).toBe(1);

    const first = await resolveGate(server.ingressUrl, invocation);
    expect(first).toEqual({ ok: true, status: 200 });
    expect(await waitForGates(child, "RELEASED", 1)).toBe(1);

    // Deliberately WITHOUT the idempotency key, so this measures the engine's
    // answer to a genuinely second release rather than a replay of the first.
    const second = await fetch(
      server.ingressUrl + "/AcpGate/" + invocation.invocationId + "/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ released: true }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const secondBody = await second.text();
    // Recorded, never assumed. Measured against the pinned server this is 409.
    expect(second.status).toBe(409);
    expect(secondBody).toContain("promise was already completed");

    // But calling the VERB twice is not that, and the difference is the whole
    // value of deriving the key. `signal()` sends `invocationId` as the
    // idempotency key, so a second call is the SAME call: the engine replays
    // its first answer and reports success rather than conflict. A caller that
    // retries after a timeout therefore gets a truthful `ok` instead of a
    // spurious failure, and the gate is still released exactly once.
    //
    // Measured rather than assumed -- this drill originally asserted the
    // opposite and the engine corrected it.
    const repeated = await cancelDriverFor(root, ledger, invocation, server).signal(invocation);
    expect(repeated).toEqual({ ok: true });

    // That the driver does not LAUNDER a real 409 into success is a different
    // claim, and it is asserted where a real 409 can be produced on demand:
    // the unit suite, against a stubbed engine. Here the engine will not emit
    // one through this path, so asserting it here would require faking the
    // very thing this file exists to run for real.

    // Still one release, and still nothing appended by any of it.
    expect(gatesAt(child, "RELEASED")).toEqual(new Set([invocation.invocationId]));
    expect(ledger.status().eventCount).toBe(0);

    emitReceipt({
      drill: "GATE-SECOND-RELEASE-REFUSED",
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
      gatesReleased: 1,
      secondResolveStatus: second.status,
      engineCalls: 2,
    });

    await stopChild(child);
  }, 240_000);

  it("S4 survives replay in both orders: released before the kill, and after the restart", async () => {
    ensureChildBuilt();
    const id = "gate-replay";
    const early = deriveInvocation(randomUUID(), 1, "2026-09-03T12:00:00.000Z", "a".repeat(64));
    const late = deriveInvocation(randomUUID(), 1, "2026-09-03T12:00:00.000Z", "b".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const doomed = await startChild(id, early, null);
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    // Both gates park; one is released before the endpoint dies and one is not.
    expect(await parkGate(server.ingressUrl, early)).toBe(202);
    expect(await parkGate(server.ingressUrl, late)).toBe(202);
    expect(await waitForGates(doomed, "PARKED", 2)).toBe(2);

    const driver = cancelDriverFor(root, ledger, early, server);
    expect(await driver.signal(early)).toEqual({ ok: true });
    expect(await waitForGates(doomed, "RELEASED", 1)).toBe(1);

    doomed.kill("SIGKILL");
    const died = await waitForExit(doomed);
    expect(died.signal).toBe("SIGKILL");

    const replacement = await startChild(id, early, null);

    // Order 1: released BEFORE the kill. A replay sees a completed promise, so
    // the gate does not wait again -- and the completion survived the restart,
    // which a second release proves by being refused.
    const stillComplete = await fetch(
      server.ingressUrl + "/AcpGate/" + early.invocationId + "/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ released: true }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    await stillComplete.text();
    expect(stillComplete.status).toBe(409);

    // Order 2: released AFTER the restart. The address is recomputed from
    // `(taskId, attempt)` by a driver that was never told it.
    const rebuilt = deriveInvocation(
      late.taskId,
      late.attempt,
      late.submittedAt,
      late.submissionDigest,
    );
    expect(rebuilt.invocationId).toBe(late.invocationId);
    expect(await cancelDriverFor(root, ledger, rebuilt, server).signal(rebuilt)).toEqual({
      ok: true,
    });
    expect(await waitForGates(replacement, "RELEASED", 1)).toBe(1);
    expect(gatesAt(replacement, "RELEASED").has(late.invocationId)).toBe(true);

    expect(ledger.status().eventCount).toBe(0);
    const integrity = ledger.verifyIntegrity();
    expect(integrity.problems).toEqual([]);

    emitReceipt({
      drill: "GATE-REPLAY-BOTH-ORDERS",
      mode: "RESTATE",
      faultPoint: null,
      signal: died.signal,
      eventCount: ledger.status().eventCount,
      effectMarkers: markers(root),
      headSequence: ledger.status().headSequence,
      headEventSha256: ledger.status().headEventSha256,
      verdict: "CONSISTENT",
      integrityOk: integrity.ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      gatesHeld: 2,
      secondResolveStatus: stillComplete.status,
    });

    await stopChild(replacement);
  }, 240_000);

  it("S5 a gate for a key that never parked leaves the ledger byte-identical", async () => {
    ensureChildBuilt();
    const id = "gate-never-parked";
    const walked = deriveInvocation(randomUUID(), 1, "2026-09-03T12:00:00.000Z", "a".repeat(64));
    const never = deriveInvocation(randomUUID(), 1, "2026-09-03T12:00:00.000Z", "b".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const child = await startChild(id, walked, null);
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    // A real task, so the ledger has something to be byte-identical about.
    expect((await submitAdvance(server.ingressUrl, walked, 120_000)).status).toBe(200);
    expect(await waitForCheckpoint(ledger, walked.taskId)).toBe(true);

    const before = ledger.status();
    const beforeEvents = JSON.stringify(ledger.listEvents({ limit: 200 }).events);

    // Signalling a gate nobody ever opened is accepted by the engine -- the
    // promise is simply created complete -- and it appends NOTHING. That is the
    // property worth asserting: the gate holds no fact, so it cannot invent one.
    expect(await cancelDriverFor(root, ledger, never, server).signal(never)).toEqual({ ok: true });

    const after = ledger.status();
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.headSequence).toBe(before.headSequence);
    expect(after.headEventSha256).toBe(before.headEventSha256);
    expect(JSON.stringify(ledger.listEvents({ limit: 200 }).events)).toBe(beforeEvents);
    expect(ledger.getTask(never.taskId)).toBeNull();

    emitReceipt({
      drill: "GATE-NEVER-PARKED-APPENDS-NOTHING",
      mode: "RESTATE",
      faultPoint: null,
      signal: null,
      eventCount: after.eventCount,
      effectMarkers: markers(root),
      headSequence: after.headSequence,
      headEventSha256: after.headEventSha256,
      verdict: "CONSISTENT",
      integrityOk: ledger.verifyIntegrity().ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      gatesHeld: 0,
    });

    await stopChild(child);
  }, 240_000);

  it("S6 no engine-minted identity reaches any surface, and the DERIVED one addresses the gate", async () => {
    ensureChildBuilt();
    const id = "gate-no-engine-identity";
    const invocation = deriveInvocation(randomUUID(), 1, "2026-09-03T12:00:00.000Z", "a".repeat(64));
    const root = scenario(id);
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const server = trackServer(await startServer(root));

    const child = await startChild(id, invocation, null);
    await registerDeployment(server.adminUrl, "http://" + LOOPBACK_HOST + ":" + String(RUNTIME_SERVICE_PORT));

    // A completed walk, so the surfaces below have real content to sweep.
    expect((await submitAdvance(server.ingressUrl, invocation, 120_000)).status).toBe(200);
    expect(await waitForCheckpoint(ledger, invocation.taskId)).toBe(true);

    expect(await parkGate(server.ingressUrl, invocation)).toBe(202);
    expect(await waitForGates(child, "PARKED", 1)).toBe(1);

    const driver = cancelDriverFor(root, ledger, invocation, server);
    const { result, calls } = await countingEngineCalls(() => driver.signal(invocation));
    expect(result).toEqual({ ok: true });
    expect(await waitForGates(child, "RELEASED", 1)).toBe(1);

    // The control that makes the sweep mean something, and it is a different
    // control from the cancellation drill's. There, an engine id demonstrably
    // EXISTED and had to be shown absent. Here the stronger claim holds: the
    // signal path never asks for one. The single call it made is addressed by
    // the DERIVED id, and no lookup or admin request appears beside it.
    expect(calls).toEqual([
      "POST " + server.ingressUrl + "/AcpGate/" + invocation.invocationId + "/resolve",
    ]);
    expect(calls.join(" ")).not.toContain("/restate/lookup");
    expect(calls.join(" ")).not.toContain(server.adminUrl);

    const report = await reconcile({
      ledger,
      invocation,
      readCache: () => readCacheThroughHandler(server.ingressUrl, invocation.taskId),
    });
    const surfaces: readonly [string, unknown][] = [
      ["outcome", result],
      ["events", ledger.listEvents({ limit: 200 }).events.map((r) => r.event)],
      ["task read model", ledger.getTask(invocation.taskId)],
      ["task list", ledger.listTasks().tasks],
      ["reconciliation report", report],
      ["driver status", await driver.status()],
    ];
    for (const [name, surface] of surfaces) {
      const serialized = JSON.stringify(surface);
      expect({ name, leaked: ENGINE_INVOCATION_ID_SHAPE.test(serialized) }).toEqual({
        name,
        leaked: false,
      });
      // The two awakeable shapes the pinned server names, which the rejected
      // design would have had to carry and this one never mints.
      expect({ name, leaked: /awk_1|sign_1/.test(serialized) }).toEqual({ name, leaked: false });
    }

    // And what IS there is the derived address, which the ledger owns.
    expect(
      JSON.stringify(ledger.listEvents({ taskId: invocation.taskId, limit: 200 }).events.map((r) => r.event)),
    ).toContain(invocation.invocationId);

    emitReceipt({
      drill: "GATE-NO-ENGINE-IDENTITY",
      mode: "RESTATE",
      faultPoint: null,
      signal: null,
      eventCount: ledger.status().eventCount,
      effectMarkers: markers(root),
      headSequence: ledger.status().headSequence,
      headEventSha256: ledger.status().headEventSha256,
      verdict: report.verdict,
      integrityOk: ledger.verifyIntegrity().ok,
      rebuildIdentical: true,
      duplicateKeys: 0,
      // The COUNT of surfaces swept, never the identity: a receipt naming what
      // it looked for would be the leak it exists to deny.
      surfacesSwept: surfaces.length,
      engineCalls: calls.length,
    });

    await stopChild(child);
  }, 240_000);

  it("X1 the two drivers now disagree about every verb, and the SQLite one still refuses field-exactly", async () => {
    // A regression assertion on existing behaviour, said plainly rather than
    // presented as new evidence: the supervisor source is untouched and its own
    // suite asserts these refusals. What is NEW is that the divergence is now
    // total -- one driver supports all four verbs and the other supports none.
    const root = scenario("gate-sqlite-refusal");
    const ledger = track(openLedger(scenarioLedgerPath(root)));
    const invocation = deriveInvocation(randomUUID(), 1, "2026-09-03T12:00:00.000Z", "c".repeat(64));
    const supervisor = new SqliteSupervisor({
      ledger,
      invocation,
      effects: toyEffects(root),
      emittedBy: EMITTED_BY,
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      initiativeId: TEST_INITIATIVE_ID,
      route: drillRoute(invocation),
    });

    expect(await supervisor.signal()).toEqual({
      ok: false,
      refusal: "CAPABILITY_UNSUPPORTED",
      at: "signal",
    });
    expect(await supervisor.timer()).toEqual({
      ok: false,
      refusal: "CAPABILITY_UNSUPPORTED",
      at: "timer",
    });
    expect(supervisor.capabilities().verbs.SIGNAL).toBe("UNSUPPORTED");
    expect(supervisor.capabilities().verbs.TIMER).toBe("UNSUPPORTED");
    // It did not quietly delegate to the other driver, and asking cost nothing.
    expect(ledger.status().eventCount).toBe(0);
  }, 60_000);
});
