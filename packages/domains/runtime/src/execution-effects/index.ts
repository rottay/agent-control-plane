import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

import type {
  ExecutionEvent,
  ExecutionRefusal,
  ExecutionRequest,
  ModelExecutionPort,
  ResolvedRoute,
} from "@acp/contracts";
import { canonicalJsonStringify } from "@acp/ledger";

import type { OperationCoordinate, PostconditionVerdict } from "../contracts/index.js";
import { operationDigest } from "../core/coordinates/index.js";
import type { EffectPort } from "../core/step-executor/index.js";
import { PostconditionUnknownError } from "../errors/index.js";
// The scenario-root brand is taken type-only through this package's own entry
// point rather than from `toy/repository` by path. The brand is the toy
// module's, but the module's *specifier* is what the toy-binding law counts,
// and that law pins the deep specifier to exactly the barrel and the drill
// child. A type-only import is erased at compile time, so no runtime cycle
// exists; what remains is the brand, which is the whole point: a caller cannot
// hand this module a directory it named itself.
import type { ScenarioRoot } from "../index.js";

/**
 * The execution-backed effect port (V2-B1b, stage 2).
 *
 * The beats in `core/step-executor` ask one question of a side effect: has it
 * happened, and if not, make it happen. Until this stage the only answer was
 * the toy filesystem marker. This module answers the same question with a real
 * execution on the owned `ModelExecutionPort` boundary, and it answers it in
 * exactly the toy's shape, so `closeIntent`'s probe -> apply -> probe -> append
 * law and its three verdicts are preserved byte for byte in meaning.
 *
 * **The port is injected, never built here.** This module is typed against
 * `@acp/contracts` and imports nothing from the providers edge. Whoever
 * assembles the daemon builds the port from admitted bindings and hands it in;
 * the runtime domain's dependency set does not move, and a fake port in a test
 * proves this module without a provider anywhere.
 *
 * **Evidence is written only after the terminal event, and only for
 * `completed`.** `apply` starts the execution, drains its events to the one
 * terminal the port's law guarantees, and then records a digest-keyed marker
 * under the scenario's own `executions/` directory carrying the operation
 * digest and the digest of the canonical trail. A refused `start`, a stream
 * that ends in `error`, or a stream that ends without a terminal at all throws
 * `ExecutionEffectError` carrying the closed refusal name: the walk fails
 * classified, nothing is recorded as done, and nothing is retried silently.
 *
 * **The evidence home is this module's own.** The toy's `effects/` markers stay
 * the toy's; this module never reads or writes them.
 *
 * **Idempotent by evidence.** A second `apply` for an operation whose marker
 * is present and verifies starts nothing: the execution already happened, and
 * running it again would perform the effect twice under one intent, which is
 * the defect the three-beat order exists to prevent. A marker that is present
 * but is not this operation's is somebody else's evidence; `apply` refuses to
 * overwrite it and `probe` reports `UNKNOWN`, so the caller fails closed.
 */

export interface ExecutionEffectsInput {
  /** The owned boundary, assembled and admitted by the caller. */
  readonly port: ModelExecutionPort;
  /** The final route. Executed, never interpreted, exactly as the port's law says. */
  readonly route: ResolvedRoute;
  /** The task coordinates and identity the execution is attributed to. */
  readonly request: ExecutionRequest;
  /**
   * The scenario's own directory, as the opaque value only the toy module's
   * resolver can produce. A plain string is deliberately not accepted, for the
   * same reason the supervisor never accepted one: a caller that could name a
   * directory could name a real repository.
   */
  readonly scenarioRoot: ScenarioRoot;
  /**
   * Where the port's own usage entries go (V2-B7T).
   *
   * Injected as a function, so this module still imports no ledger and still
   * writes nothing but its own markers. The daemon closes over the ledger, the
   * invocation, the elected route's account and the emitter — all already in
   * scope at the one production construction site — and hands the closure in.
   *
   * **Optional, and the optionality is deliberate.** The two drill children
   * build this port without a sink and must keep compiling untouched; widening
   * `EffectPort` instead would have moved ten inline `effects: {` literals, one
   * of them production source. Optionality is made safe by a fence law
   * (L-B7T-2) that asserts the production daemon passes one — not by hope.
   */
  readonly recordUsage?: UsageSink | undefined;
  /**
   * Write-set conformance, checked after the effect and before the marker
   * (V2 concurrency C4).
   *
   * Injected as a function for the same reason `recordUsage` is: this module
   * still opens no ledger, spawns nothing and reads no worktree. The daemon
   * closes over the observer, the lease, the envelope's declared write-set and
   * the ledger — all already in scope at each construction site — and hands the
   * closure in.
   *
   * **Optional in the type, mandatory in production.** The drill children build
   * this port without one and must keep compiling; what makes the optionality
   * safe is `L-C-4c`, which asserts that *every* `createExecutionEffects` call
   * in the daemon passes a gate. Under DT Option B there is no production path
   * without one, and that is a fence check rather than a promise.
   *
   * **Synchronous, and a throw is terminal.** It runs in the same window as the
   * usage sink and for the same reason: a resumed walk that finds a verified
   * marker never re-enters `apply`, so a gate after the marker would be
   * unreachable on exactly the window it covers. A gate that throws leaves no
   * marker — but the gate is expected to have *recorded and revoked first*, so
   * the throw settles the walk rather than inviting a retry.
   */
  readonly checkConformance?: ConformanceGate | undefined;
}

/**
 * One `usage` entry from the port's trail, as the sink receives it.
 *
 * `operationIndex` is the operation's own plan index and `stepIndex` is the
 * trail entry's; together they name this observation durably, without a clock
 * and without a counter. The tokens are the port's number, carried verbatim —
 * this module measures nothing and has no opinion about whether the count is
 * right.
 */
export interface UsageSample {
  readonly operationIndex: number;
  readonly stepIndex: number;
  readonly tokensUsed: number;
}

/**
 * The sink the walk hands its spend to.
 *
 * Synchronous by design. It is called between the execution and the marker
 * write, and it must be able to fail the apply closed — an asynchronous sink
 * whose rejection the caller could forget to await would be a sink that
 * silently dropped spend.
 */
export type UsageSink = (sample: UsageSample) => void;

/**
 * The write-set conformance gate, as the walk calls it.
 *
 * It receives the operation's own plan index so the caller can derive a
 * coordinate without a clock or a counter, exactly as `usageTransitionId`
 * does for spend.
 *
 * It returns nothing. A conformant worktree is silence; a violation is a throw,
 * after the caller has recorded the violation and revoked the lease. This
 * module never decides what conformance means and never touches a worktree —
 * it decides only *when* the question is asked.
 */
export type ConformanceGate = (operationIndex: number) => void;

/**
 * The execution could not be carried to completion.
 *
 * Carries one of the contract's closed refusal names and where it applied:
 * the port's own `at` for a refused start, the terminal event for a stream
 * that ended in `error`, or the terminal law itself for a stream that ended
 * without one. Never provider output, never a path.
 */
export class ExecutionEffectError extends Error {
  readonly refusal: ExecutionRefusal;
  readonly at: string;

  constructor(refusal: ExecutionRefusal, at: string) {
    super("the execution effect was refused: " + refusal + " at " + at);
    this.name = "ExecutionEffectError";
    this.refusal = refusal;
    this.at = at;
  }
}

/** The module's evidence directory, beside the toy's `effects/`, never inside it. */
const EVIDENCE_DIRECTORY = "executions";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** What one completed execution leaves behind. Canonical JSON, one file per operation. */
interface EvidenceMarker {
  readonly operationId: string;
  readonly operationDigest: string;
  /** SHA-256 of the canonical JSON of the drained trail, terminal included. */
  readonly trailSha256: string;
  readonly eventCount: number;
}

type MarkerRead =
  | { readonly kind: "ABSENT" }
  | { readonly kind: "MARKER"; readonly marker: EvidenceMarker }
  /** Present, but unreadable or not a marker this module wrote. */
  | { readonly kind: "UNREADABLE" };

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code: unknown = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Where an operation's evidence lives, and the proof that the name stays inside
 * the scenario.
 *
 * The operation id is derived by this package and never contains a separator,
 * but the containment is asserted rather than assumed: an evidence path that
 * could leave the scenario would be a write this module never authorised.
 */
function markerPath(scenarioRoot: ScenarioRoot, operation: OperationCoordinate): string {
  const target = join(scenarioRoot, EVIDENCE_DIRECTORY, operation.operationId + ".json");
  const prefix = scenarioRoot.endsWith(sep) ? scenarioRoot : scenarioRoot + sep;
  if (
    !target.startsWith(prefix) ||
    operation.operationId.includes(sep) ||
    operation.operationId.includes("..")
  ) {
    throw new PostconditionUnknownError(
      operation.operationId,
      "the operation's evidence path would leave the scenario root; refusing to read or write it",
    );
  }
  return target;
}

/**
 * Refuse a descent through a symbolic link.
 *
 * The evidence directory and the marker are the only two names below the
 * root this module touches. Either replaced by a link would make a name inside
 * the scenario resolve outside it, so both are inspected with `lstat`, which
 * does not follow links. A name that does not exist yet is safe.
 */
function assertNoLink(path: string, operationId: string): void {
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return;
    throw new PostconditionUnknownError(
      operationId,
      "the evidence path could not be inspected (" + (errorCode(error) ?? "unknown") + ")",
    );
  }
  if (isLink) {
    throw new PostconditionUnknownError(
      operationId,
      "the evidence path descends through a symbolic link; a name inside the scenario may resolve outside it",
    );
  }
}

/**
 * Read a marker, treating only absence as absence.
 *
 * Anything else that is not exactly a marker this module wrote -- a read error
 * other than `ENOENT`, bytes that are not JSON, JSON of another shape -- is
 * `UNREADABLE`, which the probe reports as `UNKNOWN`. It is never `ABSENT`,
 * because absence invites the caller to perform the effect a second time.
 */
function readMarker(target: string): MarkerRead {
  let text: string;
  try {
    text = readFileSync(target, "utf8");
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT" ? { kind: "ABSENT" } : { kind: "UNREADABLE" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { kind: "UNREADABLE" };
  }
  if (!isRecord(parsed)) return { kind: "UNREADABLE" };
  const operationId = parsed["operationId"];
  const digest = parsed["operationDigest"];
  const trailSha256 = parsed["trailSha256"];
  const eventCount = parsed["eventCount"];
  if (
    typeof operationId !== "string" ||
    typeof digest !== "string" ||
    !SHA256_HEX.test(digest) ||
    typeof trailSha256 !== "string" ||
    !SHA256_HEX.test(trailSha256) ||
    typeof eventCount !== "number" ||
    !Number.isInteger(eventCount) ||
    eventCount < 1
  ) {
    return { kind: "UNREADABLE" };
  }
  return {
    kind: "MARKER",
    marker: { operationId, operationDigest: digest, trailSha256, eventCount },
  };
}

/** Is this marker exactly the one this operation writes? */
function verifies(marker: EvidenceMarker, operation: OperationCoordinate): boolean {
  return (
    marker.operationId === operation.operationId &&
    marker.operationDigest === operationDigest(operation)
  );
}

/**
 * Write the marker atomically: a temporary file in the same directory, then a
 * rename, so a crash mid-write leaves either nothing or the complete marker and
 * never a torn file the probe would have to interpret.
 */
function writeMarker(target: string, marker: EvidenceMarker): void {
  const directory = dirname(target);
  assertNoLink(directory, marker.operationId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // The directory was created, or may have been replaced, since the check
  // above. Re-verify before anything is written through it.
  assertNoLink(directory, marker.operationId);
  assertNoLink(target, marker.operationId);
  const temporary = target + ".partial";
  writeFileSync(temporary, canonicalJsonStringify(marker), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
}

/**
 * Start the execution, drain it to its terminal, and say how it ended.
 *
 * The port's terminal law guarantees exactly one terminal event, `completed`
 * or `error`, and never both. This function trusts that law only as far as it
 * can see it: a stream that ends without a terminal is reported as a transport
 * failure rather than as success, because "the stream stopped" is not evidence
 * that the work finished.
 */
async function execute(input: ExecutionEffectsInput): Promise<readonly ExecutionEvent[]> {
  const started = await input.port.start(input.route, input.request);
  if (!started.ok) throw new ExecutionEffectError(started.refusal, started.at);

  const trail: ExecutionEvent[] = [];
  let terminal: ExecutionEvent | null = null;
  for await (const event of started.events()) {
    trail.push(event);
    if (event.kind === "completed" || event.kind === "error") terminal = event;
  }

  if (terminal === null) throw new ExecutionEffectError("TRANSPORT_UNAVAILABLE", "events.terminal");
  if (terminal.kind === "error") throw new ExecutionEffectError(terminal.refusal, "events.error");
  return trail;
}

/**
 * Build the effect port over one execution.
 *
 * Returns the two-method surface the beats need and nothing else. The port,
 * the route and the request are fixed at construction: an effect port that
 * could be pointed at a different route per call would be a router, and the
 * runtime holds no routing authority.
 */
export function createExecutionEffects(input: ExecutionEffectsInput): EffectPort {
  const { scenarioRoot } = input;

  return {
    async apply(operation: OperationCoordinate): Promise<void> {
      const target = markerPath(scenarioRoot, operation);
      const existing = readMarker(target);
      if (existing.kind === "MARKER" && verifies(existing.marker, operation)) {
        // The execution already happened and left its evidence. Starting it
        // again would perform the effect a second time under the same intent.
        return;
      }
      if (existing.kind !== "ABSENT") {
        // Somebody else's evidence, or bytes this module cannot read. Neither
        // is overwritten: replacing it would destroy the one sign that
        // something unexpected happened here, and the probe says `UNKNOWN`.
        throw new PostconditionUnknownError(
          operation.operationId,
          "the evidence home holds a marker this operation did not write; refusing to overwrite it",
        );
      }

      const trail = await execute(input);

      // V2-B7T. The sink runs BEFORE the marker, and the ordering is the whole
      // of the crash-safety argument rather than a preference.
      //
      // `closeIntent` probes first and, on `DONE`, appends the outcome without
      // re-entering `apply`. So a resumed walk that finds a verified marker
      // never calls this function again — and a sink placed after the marker
      // write would therefore be permanently unreachable on exactly the window
      // it exists to cover. Placed before it, and called synchronously, a
      // throwing sink leaves no marker at all, the probe answers `NOT_DONE`,
      // and the effect re-executes.
      //
      // The invariant this buys, stated no louder than it is: a verified
      // evidence marker implies a recorded usage event. The cost is that a
      // crash between the execution and the marker loses that execution's
      // spend, so the ledger may UNDER-report real provider spend after a
      // crash. It never over-reports, and it never records spend for work that
      // did not happen.
      const recordUsage = input.recordUsage;
      if (recordUsage !== undefined) {
        for (const event of trail) {
          if (event.kind !== "usage") continue;
          recordUsage({
            operationIndex: operation.operationIndex,
            stepIndex: event.stepIndex,
            tokensUsed: event.tokensUsed,
          });
        }
      }

      // Before the marker, and after the spend: a violation must not leave a
      // marker behind, because a marker is what makes the step un-re-runnable
      // and this walk is about to be settled rather than resumed. The gate
      // records and revokes before it throws, so what reaches here is a throw
      // whose evidence is already durable.
      const checkConformance = input.checkConformance;
      if (checkConformance !== undefined) checkConformance(operation.operationIndex);

      writeMarker(target, {
        operationId: operation.operationId,
        operationDigest: operationDigest(operation),
        trailSha256: sha256(canonicalJsonStringify(trail)),
        eventCount: trail.length,
      });
    },

    probe(operation: OperationCoordinate): Promise<PostconditionVerdict> {
      const existing = readMarker(markerPath(scenarioRoot, operation));
      if (existing.kind === "ABSENT") return Promise.resolve("NOT_DONE");
      if (existing.kind === "MARKER" && verifies(existing.marker, operation)) {
        return Promise.resolve("DONE");
      }
      return Promise.resolve("UNKNOWN");
    },
  };
}
