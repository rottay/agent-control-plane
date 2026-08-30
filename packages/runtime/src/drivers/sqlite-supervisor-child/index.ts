import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CommitPolicy } from "@acp/contracts";
import { openLedger } from "@acp/ledger";

import type { DurableInvocation } from "../../contracts/index.js";
import { SupervisorError } from "../../errors/index.js";
import { resolveScenarioRoot, scenarioLedgerPath } from "../../toy/repository/index.js";
import { SqliteSupervisor } from "../sqlite-supervisor/index.js";
import type { FaultPoint } from "../sqlite-supervisor/index.js";

/**
 * The child entry point for the kill/restart drills.
 *
 * A restart drill is only evidence if the process actually dies. A thrown
 * exception caught by the same process proves nothing about durability: the
 * SQLite page cache, the open handle and every JavaScript object survive it.
 * So the drill runs the supervisor here, in a real child, and kills it with a
 * real signal at a chosen instant.
 *
 * Importing this module does nothing. It runs only when it is the process entry
 * point, and only on a config it has validated itself.
 */

const FAULT_POINTS: readonly string[] = ["AFTER_INTENT", "AFTER_EFFECT", "AFTER_OUTCOME"];

/** The digest pins what was asked for, so its shape is checked at the door. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface ChildConfig {
  readonly scenarioId: string;
  readonly invocation: DurableInvocation;
  readonly emittedBy: string;
  /** The packet's commit policy. Required in the JSON, never defaulted here. */
  readonly commitPolicy: CommitPolicy;
  /** The packet's initiative. Required in the JSON, never defaulted here. */
  readonly initiativeId: string;
  readonly faultPoint: FaultPoint | null;
}

/**
 * Validate the child's configuration.
 *
 * Every field that reaches an event is checked here. Nothing is read from the
 * environment: an environment variable is mutable state, and mutable state that
 * reaches event bytes is exactly what breaks replay determinism.
 */
export function parseChildConfig(raw: unknown): ChildConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new SupervisorError("child config must be an object");
  }
  const value = raw as Record<string, unknown>;
  const invocation = value["invocation"];
  if (typeof invocation !== "object" || invocation === null) {
    throw new SupervisorError("child config requires an invocation");
  }
  const inv = invocation as Record<string, unknown>;

  const scenarioId = value["scenarioId"];
  const emittedBy = value["emittedBy"];
  // Admitted by the contract's own enum, like every other field that reaches an
  // event: a child that did not say which policy it runs under is refused
  // rather than handed the commit-capable plan.
  const commitPolicy = CommitPolicy.safeParse(value["commitPolicy"]);
  if (!commitPolicy.success) {
    throw new SupervisorError("child config requires an explicit commitPolicy");
  }
  // The same law as the policy above: a child that did not say which
  // initiative it runs under is refused rather than handed a default, because
  // the value reaches the discovery event's payload and a wrong attribution
  // cannot be corrected by any later event.
  const initiativeId = value["initiativeId"];
  if (typeof initiativeId !== "string" || initiativeId.length === 0) {
    throw new SupervisorError("child config requires an explicit initiativeId");
  }

  const rawFaultPoint = value["faultPoint"] ?? null;
  const faultPoint = typeof rawFaultPoint === "string" ? rawFaultPoint : null;
  if (rawFaultPoint !== null && faultPoint === null) {
    throw new SupervisorError("faultPoint must be null or a string");
  }

  if (typeof scenarioId !== "string") throw new SupervisorError("scenarioId must be a string");
  if (typeof emittedBy !== "string") throw new SupervisorError("emittedBy must be a string");
  if (faultPoint !== null && !FAULT_POINTS.includes(faultPoint)) {
    throw new SupervisorError("faultPoint must be null or a known fault point");
  }

  const taskId = inv["taskId"];
  const attempt = inv["attempt"];
  const invocationId = inv["invocationId"];
  const submittedAt = inv["submittedAt"];
  const submissionDigest = inv["submissionDigest"];

  if (
    typeof taskId !== "string" ||
    typeof invocationId !== "string" ||
    typeof submittedAt !== "string" ||
    typeof submissionDigest !== "string" ||
    typeof attempt !== "number" ||
    !Number.isInteger(attempt) ||
    attempt < 1
  ) {
    throw new SupervisorError("child config carries a malformed invocation");
  }
  if (!SHA256_HEX.test(submissionDigest)) {
    throw new SupervisorError("submissionDigest must be 64 lowercase hex characters");
  }

  return {
    scenarioId,
    emittedBy,
    commitPolicy: commitPolicy.data,
    initiativeId,
    faultPoint: faultPoint as FaultPoint | null,
    invocation: { taskId, attempt, invocationId, submittedAt, submissionDigest },
  };
}

/** Run one supervisor pass, optionally killing this process at a fault point. */
export function runChild(config: ChildConfig): void {
  const scenarioRoot = resolveScenarioRoot(config.scenarioId);
  const ledger = openLedger(scenarioLedgerPath(scenarioRoot));

  try {
    const supervisor = new SqliteSupervisor({
      ledger,
      invocation: config.invocation,
      scenarioRoot,
      emittedBy: config.emittedBy,
      commitPolicy: config.commitPolicy,
      initiativeId: config.initiativeId,
      __faultPoint: config.faultPoint ?? undefined,
      // A real signal, not an exception. SIGKILL cannot be caught, so nothing
      // in this process gets a chance to flush, close or tidy up, which is the
      // only honest simulation of a machine losing power mid-step.
      __onFault: () => {
        process.kill(process.pid, "SIGKILL");
      },
    });

    const result = supervisor.runToCheckpoint();
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    ledger.close();
  }
}

const invoked = process.argv[1];
if (
  invoked !== undefined &&
  realpathSync(resolve(invoked)) === realpathSync(fileURLToPath(import.meta.url))
) {
  const raw = process.argv[2];
  if (raw === undefined) {
    process.stderr.write("acp-supervisor-child: a JSON config argument is required\n");
    process.exitCode = 2;
  } else {
    runChild(parseChildConfig(JSON.parse(raw)));
  }
}
