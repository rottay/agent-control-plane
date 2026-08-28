import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DATA_ROOT_RESTATE,
  LOOPBACK_HOST,
  RESTATE_ADMIN_PORT,
  RESTATE_INGRESS_PORT,
  RESTATE_SERVER_SHA256_PIN_PATH,
  RESTATE_SERVER_VERSION,
} from "../constants.js";
import type { ScenarioRoot } from "../toy/repository.js";

/**
 * Locate, start and stop the external pinned Restate server.
 *
 * This is the one module in the repository that starts the external server, and
 * P2D promotes it from test-only so the daemon can use it rather than grow a
 * second spawner. Two spawners drift, and the drift is only ever discovered
 * when they disagree about how to stop a server.
 *
 * Promotion widens the audience, so the surface narrows in the same change.
 * There are two handles here. `ServerHandle` is internal and keeps `dataRoot`
 * and the child, because the drills delete the derived state to prove it is
 * rebuildable. `SafeServerHandle` is what leaves the package: no child, no
 * stdio, no absolute path, and a bounded stop. `startServer` takes a
 * `ScenarioRoot` rather than a string, because a caller that could name a
 * directory could name a real repository.
 *
 * Nothing here downloads. The binary is acquired by an explicit operator
 * command and verified against a tracked digest; this module refuses to run if
 * that has not happened.
 */

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

export function serverInstallDir(): string {
  return join(REPO_ROOT, ".acp-local", "tools", "restate-server-" + RESTATE_SERVER_VERSION);
}

export function serverBinaryPath(): string {
  return join(serverInstallDir(), "restate-server");
}

/** The platform key this host runs as. */
export function platformKey(): string {
  return process.platform + "-" + process.arch;
}

/** Read the tracked pin, which is the content authority for the binary. */
export function readTrackedPin(): Record<string, unknown> {
  const pinPath = join(REPO_ROOT, RESTATE_SERVER_SHA256_PIN_PATH);
  return JSON.parse(readFileSync(pinPath, "utf8")) as Record<string, unknown>;
}

/**
 * Does a verification receipt agree with the tracked pin, field by field?
 *
 * Pure, so the tamper negatives can exercise every field without touching the
 * real install. Checking only the version was too weak: a receipt naming the
 * right version but a different asset, URL or digest would have passed, and the
 * receipt is the only thing standing between a drill and an unverified binary.
 */
export function receiptMatchesPin(
  receipt: Record<string, unknown>,
  pin: Record<string, unknown>,
  key: string = platformKey(),
): { ok: boolean; reason: string } {
  const platforms = pin["platforms"];
  if (typeof platforms !== "object" || platforms === null) {
    return { ok: false, reason: "the pin declares no platforms" };
  }
  const entry = (platforms as Record<string, unknown>)[key];
  if (typeof entry !== "object" || entry === null) {
    return { ok: false, reason: "the pin describes no platform " + key };
  }
  const pinned = entry as Record<string, unknown>;

  const expectations: readonly [string, unknown][] = [
    ["version", pin["version"]],
    ["platform", key],
    ["asset", pinned["asset"]],
    ["url", pinned["url"]],
    ["archiveSha256", pinned["sha256"]],
    ["binarySha256", pinned["binarySha256"]],
  ];
  for (const [field, expected] of expectations) {
    if (receipt[field] !== expected) {
      return {
        ok: false,
        reason: "the receipt's " + field + " does not match the tracked pin",
      };
    }
  }
  const binaryDigest = receipt["binarySha256"];
  if (typeof binaryDigest !== "string" || !/^[0-9a-f]{64}$/.test(binaryDigest)) {
    return { ok: false, reason: "the receipt carries no usable binary digest" };
  }
  return { ok: true, reason: "verified" };
}

/**
 * Is a verified binary available?
 *
 * Three things must agree: the receipt must match the tracked pin field by
 * field, the binary on disk must hash to what the receipt claims, and the
 * version must be the one this build expects. A binary without a receipt, or
 * whose receipt no longer describes it, is treated as absent — a drill that ran
 * against an unverified binary would prove nothing about the pinned one.
 */
export function serverAvailability(): { available: boolean; reason: string } {
  const binary = serverBinaryPath();
  if (!existsSync(binary)) {
    return { available: false, reason: "no binary at " + binary };
  }
  const receiptPath = join(serverInstallDir(), "verification-receipt.json");
  if (!existsSync(receiptPath)) {
    return { available: false, reason: "no verification receipt beside the binary" };
  }

  let receipt: Record<string, unknown>;
  let pin: Record<string, unknown>;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    pin = readTrackedPin();
  } catch {
    return { available: false, reason: "unreadable verification receipt or pin" };
  }

  if (receipt["version"] !== RESTATE_SERVER_VERSION) {
    return { available: false, reason: "the receipt is for a different version" };
  }
  const agreement = receiptMatchesPin(receipt, pin);
  if (!agreement.ok) return { available: false, reason: agreement.reason };

  const actual = createHash("sha256").update(readFileSync(binary)).digest("hex");
  if (actual !== receipt["binarySha256"]) {
    return { available: false, reason: "the binary no longer hashes to its receipt" };
  }

  // And against the TRACKED pin, not only its own receipt. A receipt is a
  // record of what was installed; the pin is the authority on what may be.
  const platforms = pin["platforms"] as Record<string, Record<string, unknown>> | undefined;
  const pinnedBinary = platforms?.[platformKey()]?.["binarySha256"];
  if (typeof pinnedBinary !== "string" || actual !== pinnedBinary) {
    return { available: false, reason: "the installed binary does not match the tracked pin" };
  }
  return { available: true, reason: "verified" };
}

/**
 * How a server run ended, classified.
 *
 * A daemon has to tell "I stopped it" apart from "it died on me", and it must
 * do so without forwarding raw stderr, which is unbounded text of unknown
 * provenance. Three reasons are enough to decide, and none of them carries a
 * message.
 */
export interface ServerExit {
  readonly reason: "STOPPED" | "KILLED_AFTER_DEADLINE" | "UNEXPECTED_EXIT";
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Internal handle. Keeps the child and the data root; never leaves the package. */
export interface ServerHandle {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly ingressUrl: string;
  readonly adminUrl: string;
  readonly dataRoot: string;
  /** Resolves whenever the child ends, however it ends. */
  readonly exited: Promise<ServerExit>;
  stop(signal?: NodeJS.Signals, deadlineMs?: number): Promise<ServerExit>;
}

/**
 * The public handle.
 *
 * No `child`, so a caller cannot signal the server out of band and defeat the
 * bounded stop. No `dataRoot`, because it is an absolute path and absolute
 * paths name a home directory, a user account and a machine layout.
 */
export interface SafeServerHandle {
  readonly pid: number;
  readonly ingressUrl: string;
  readonly adminUrl: string;
  readonly exited: Promise<ServerExit>;
  waitForExit(): Promise<ServerExit>;
  stop(signal?: NodeJS.Signals, deadlineMs?: number): Promise<ServerExit>;
}

/**
 * Write the per-scenario configuration.
 *
 * Every bind address is pinned explicitly. The server's own `--dump-config`
 * shows no `bind-address` under `[ingress]` or `[admin]`, which matches the
 * documentation stating the field but no default, so relying on a default here
 * would be relying on something nobody has written down.
 */
export function writeServerConfig(scenarioRoot: ScenarioRoot): string {
  const dataRoot = join(scenarioRoot, DATA_ROOT_RESTATE);
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const configPath = join(scenarioRoot, "restate-config.toml");
  const config = [
    'base-dir = "' + dataRoot + '"',
    'cluster-name = "acp-drill"',
    "auto-provision = true",
    "default-num-partitions = 1",
    "default-replication = 1",
    'advertised-host = "' + LOOPBACK_HOST + '"',
    "",
    "[admin]",
    'bind-address = "' + LOOPBACK_HOST + ":" + String(RESTATE_ADMIN_PORT) + '"',
    "",
    "[ingress]",
    'bind-address = "' + LOOPBACK_HOST + ":" + String(RESTATE_INGRESS_PORT) + '"',
    "",
  ].join("\n");
  writeFileSync(configPath, config, { encoding: "utf8", mode: 0o600 });
  return configPath;
}

/**
 * Start the pinned server for one scenario, on loopback, and wait for admin.
 *
 * Once the child exists this function owns it until it hands the handle back.
 * If readiness fails, nobody has received a handle and nobody can have pushed
 * one onto an unwind stack, so a child left running here would be a leak no
 * caller could clean up. The failure path therefore performs the same bounded
 * stop before rethrowing.
 */
export async function startServer(
  scenarioRoot: ScenarioRoot,
  /** Readiness seam. Defaults to the real admin poll; the drills fail it. */
  __awaitReady: (adminUrl: string, child: ChildProcess) => Promise<void> = (url, proc) =>
    waitForAdmin(url, proc),
): Promise<ServerHandle> {
  const availability = serverAvailability();
  if (!availability.available) {
    throw new Error("refusing to start an unverified Restate server: " + availability.reason);
  }

  const configPath = writeServerConfig(scenarioRoot);
  const child = spawn(
    serverBinaryPath(),
    [
      "--config-file",
      configPath,
      "--listen-mode",
      "tcp",
      "--bind-ip",
      LOOPBACK_HOST,
      "--no-logo",
    ],
    { stdio: ["ignore", "pipe", "pipe"], cwd: scenarioRoot },
  );

  const ingressUrl = "http://" + LOOPBACK_HOST + ":" + String(RESTATE_INGRESS_PORT);
  const adminUrl = "http://" + LOOPBACK_HOST + ":" + String(RESTATE_ADMIN_PORT);

  // Attached before anything can await it, so an immediate death is still
  // observed rather than lost between spawn and subscription.
  //
  // One variable classifies the exit, and both `stop()` and `exited` read it.
  // Two independent classifications disagreed after a deadline escalation:
  // `stop()` reported KILLED_AFTER_DEADLINE while `waitForExit()` reported
  // STOPPED for the same exit, so a caller's answer depended on which one it
  // happened to hold.
  let intent: ServerExit["reason"] = "UNEXPECTED_EXIT";
  const exited = new Promise<ServerExit>((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise({ reason: intent, code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("close", (code, closeSignal) => {
      resolvePromise({ reason: intent, code, signal: closeSignal });
    });
  });
  // Nothing may reject: the daemon races this against draining, and an
  // unhandled rejection during shutdown would be a second failure on top of
  // whatever caused the first.
  exited.catch(() => undefined);

  const stop = async (
    signal: NodeJS.Signals = "SIGTERM",
    deadlineMs = 15_000,
  ): Promise<ServerExit> => {
    intent = "STOPPED";
    if (child.exitCode !== null || child.signalCode !== null) return exited;
    child.kill(signal);

    // A bound, not a hope. An unbounded stop in a daemon is a hang, and this
    // repository has already paid for one of those.
    let timer: NodeJS.Timeout | undefined;
    const escalation = new Promise<"DEADLINE">((resolveEscalation) => {
      timer = setTimeout(() => { resolveEscalation("DEADLINE"); }, deadlineMs);
    });
    const outcome = await Promise.race([exited, escalation]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome !== "DEADLINE") return outcome;

    // Recorded before the kill, so the close listener classifies it the same
    // way this function is about to.
    intent = "KILLED_AFTER_DEADLINE";
    child.kill("SIGKILL");
    return await exited;
  };

  const handle: ServerHandle = {
    child,
    pid: child.pid ?? -1,
    ingressUrl,
    adminUrl,
    dataRoot: join(scenarioRoot, DATA_ROOT_RESTATE),
    exited,
    stop,
  };

  try {
    await __awaitReady(adminUrl, child);
  } catch (error: unknown) {
    // The child is ours and no caller knows it exists yet.
    await stop("SIGTERM", 15_000);
    throw error;
  }
  return handle;
}

/**
 * Narrow an internal handle to the public one.
 *
 * Deliberately a projection rather than a cast: the fields that must not leave
 * the package are absent from the returned object, not merely absent from its
 * type, so a structural cast downstream cannot recover them.
 */
export function narrowServerHandle(handle: ServerHandle): SafeServerHandle {
  return {
    pid: handle.pid,
    ingressUrl: handle.ingressUrl,
    adminUrl: handle.adminUrl,
    exited: handle.exited,
    waitForExit: () => handle.exited,
    stop: (signal?: NodeJS.Signals, deadlineMs?: number) => handle.stop(signal, deadlineMs),
  };
}

/**
 * The public way to start the pinned server.
 *
 * This is what `@acp/runtime` exports. `startServer` stays available inside the
 * package for the drills, which need `dataRoot` to delete derived state and
 * prove it rebuilds from the ledger.
 */
export async function startVerifiedServer(
  scenarioRoot: ScenarioRoot,
  __awaitReady?: (adminUrl: string, child: ChildProcess) => Promise<void>,
): Promise<SafeServerHandle> {
  return narrowServerHandle(
    __awaitReady === undefined
      ? await startServer(scenarioRoot)
      : await startServer(scenarioRoot, __awaitReady),
  );
}

/**
 * Poll until the admin API answers.
 *
 * A deadline rather than a sleep: a server that never comes up should fail the
 * drill quickly with a reason, not hang the suite until the runner gives up.
 */
export async function waitForAdmin(
  adminUrl: string,
  child: ChildProcess | null = null,
  deadlineMs = 60_000,
): Promise<void> {
  const started = Date.now();
  let lastError = "not attempted";
  while (Date.now() - started < deadlineMs) {
    if (child !== null && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(
        "the server exited before admin became ready (code " + String(child.exitCode) + ")",
      );
    }
    try {
      const response = await fetch(adminUrl + "/health", { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = "status " + String(response.status);
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : "unreachable";
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("the Restate admin API never became ready: " + lastError);
}
