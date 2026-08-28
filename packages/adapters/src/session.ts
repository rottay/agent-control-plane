import { StringDecoder } from "node:string_decoder";

import type { HealthProbe, WorkerIdentityString } from "@acp/contracts";
import { parseWorkerIdentity } from "@acp/contracts";

import type {
  CapabilityRecord,
  ParseCursor,
  ProviderAdapter,
  ProviderName,
  SessionRequest,
  SessionState,
} from "./contract.js";
import { EMPTY_CURSOR, isLegalTransition, unknownCapabilities } from "./contract.js";
import { AdapterError } from "./errors.js";
import type { NormalizedEvent } from "./events.js";
import { normalizedEvent, toNormalized } from "./events.js";
import { ProcessHandle } from "./process/handle.js";
import type { InterruptRecord } from "./process/handle.js";
import { spawnAdmitted } from "./process/spawn.js";
import { shapePayload } from "./redact.js";

/**
 * The session controller: start, stream, interrupt, close, health.
 *
 * This is the only module that calls the spawner, which is what makes "one
 * process boundary" a fact about the import graph rather than a convention.
 *
 * Two details here are load-bearing and easy to get subtly wrong:
 *
 * 1. **The output budget is counted on raw bytes, before decoding.** `spawn`
 *    has no `maxBuffer` — that is an `exec`/`execFile` option it silently
 *    ignores — so the bound has to be ours. Counting after decoding would
 *    measure characters, and a provider emitting multibyte output could pass a
 *    byte budget it had already blown.
 * 2. **Decoding is stateful.** A UTF-8 codepoint can be split across two
 *    `data` chunks. `StringDecoder` holds the partial sequence; decoding each
 *    chunk independently would corrupt exactly the boundary cases a provider
 *    stream hits under load.
 */

const SIGNAL_FLOOR_NOTE = "signal floor; provider-native cancel unproven";

export interface AdapterSession {
  readonly provider: ProviderName;
  readonly state: SessionState;
  readonly capabilities: readonly CapabilityRecord[];
  readonly pid: number;
  events(): AsyncIterable<NormalizedEvent>;
  interrupt(): Promise<InterruptRecord>;
  close(): Promise<void>;
  health(): HealthProbe;
  /**
   * Await the teardown a terminal failure started.
   *
   * Present so a caller can observe that a failed session has finished dying;
   * it is not a substitute for `close()`, which remains required on the
   * success path.
   */
  settled(): Promise<void>;
}

/** Is this identity structurally forbidden from causing a write? */
export function isReadOnlyIdentity(identity: WorkerIdentityString): boolean {
  const parsed = parseWorkerIdentity(identity);
  return parsed.role === "reviewer";
}

class Session implements AdapterSession {
  readonly provider: ProviderName;
  readonly pid: number;
  state: SessionState = "CREATED";
  capabilities: readonly CapabilityRecord[] = unknownCapabilities();

  private readonly adapter: ProviderAdapter;
  private readonly request: SessionRequest;
  private readonly handle: ProcessHandle;
  private readonly decoder = new StringDecoder("utf8");
  private readonly context: { readonly provider: string; readonly taskId: string };
  private readonly readOnly: boolean;
  private cursor: ParseCursor = EMPTY_CURSOR;
  private bytesSeen = 0;
  private failure: AdapterError | null = null;
  private startedAtIso = "1970-01-01T00:00:00.000Z";
  private readonly queue: NormalizedEvent[] = [];
  private ended = false;
  private wake: (() => void) | null = null;
  private pumping = false;
  /** Resolves once a terminal failure has finished tearing the child down. */
  private teardown: Promise<void> | null = null;

  constructor(adapter: ProviderAdapter, request: SessionRequest, handle: ProcessHandle) {
    this.adapter = adapter;
    this.request = request;
    this.handle = handle;
    this.pid = handle.pid;
    this.provider = adapter.provider;
    this.context = { provider: adapter.provider, taskId: request.taskId };
    this.readOnly = isReadOnlyIdentity(request.identity);
  }

  transition(to: SessionState): void {
    if (!isLegalTransition(this.state, to)) {
      throw new AdapterError("ILLEGAL_TRANSITION", this.context);
    }
    this.state = to;
  }

  markStarted(iso: string): void {
    this.startedAtIso = iso;
  }

  /**
   * Count raw bytes, then decode statefully.
   *
   * Returns the decoded text, or throws `OUTPUT_BUDGET_EXCEEDED` once the
   * budget is gone — before the excess is decoded, and before it is parsed.
   */
  consume(chunk: Buffer): string {
    this.bytesSeen += chunk.byteLength;
    if (this.bytesSeen > this.request.limits.outputBudgetBytes) {
      throw new AdapterError("OUTPUT_BUDGET_EXCEEDED", this.context);
    }
    return this.decoder.write(chunk);
  }

  /** Parse decoded text into normalized events, fail-closed on anything odd. */
  digest(text: string): readonly NormalizedEvent[] {
    const outcome = this.adapter.parse(text, this.cursor);
    if (!outcome.ok) {
      throw new AdapterError(outcome.code, this.context);
    }
    this.cursor = outcome.cursor;

    const events: NormalizedEvent[] = [];
    for (const signal of outcome.events) {
      if (signal.kind === "write" && this.readOnly) {
        // Layer 2, and the layer the receipts rest on: a reviewer session that
        // produces a write-class signal is killed, whatever the provider's own
        // settings claimed. `fail()` below performs that kill — the sentence is
        // true of the code, not of the caller's good intentions.
        throw new AdapterError("READ_ONLY_VIOLATION", this.context);
      }
      const normalized = toNormalized(signal, this.provider, this.request.taskId);
      if (normalized === null) continue;
      events.push(
        normalizedEvent(normalized.name, this.provider, this.request.taskId, shapePayload(normalized.payload)),
      );
    }
    return events;
  }

  /**
   * Record a terminal failure, and tear the child down as part of it.
   *
   * The session initiates the kill itself rather than leaving a dead-but-running
   * child for a caller to notice. Anything else would make `FAILED` mean "we
   * stopped reading" while the provider kept working — and the reviewer
   * guarantee, which is the whole point of the read-only layer, would depend on
   * a `close()` the caller might never reach.
   *
   * `ProcessHandle.close()` is idempotent, so a later `close()` is still safe.
   */
  fail(error: AdapterError): void {
    this.failure = error;
    if (isLegalTransition(this.state, "FAILED")) this.state = "FAILED";
    this.teardown ??= this.handle.close();
  }

  /** Await whatever teardown a terminal failure started. */
  async settled(): Promise<void> {
    if (this.teardown !== null) await this.teardown;
  }

  /**
   * Attach to stdout and stderr and start counting.
   *
   * Both streams feed one budget and one decoder, because the bound is on what
   * the process produced, not on which pipe it chose. A provider that wrote
   * its overflow to stderr would otherwise slip a stdout-only budget.
   */
  pump(): void {
    if (this.pumping) return;
    this.pumping = true;

    const onData = (chunk: Buffer): void => {
      if (this.ended) return;
      try {
        const text = this.consume(chunk);
        if (text !== "") {
          for (const event of this.digest(text)) this.queue.push(event);
        }
      } catch (error: unknown) {
        this.fail(error instanceof AdapterError ? error : new AdapterError("MALFORMED_EVENT", this.context));
        this.end();
        return;
      }
      this.wake?.();
    };

    this.handle.stdout.on("data", onData);
    this.handle.stderr.on("data", onData);
    this.handle.onExit(() => {
      // Flush whatever the decoder still holds, then stop.
      const tail = this.decoder.end();
      if (tail !== "" && !this.ended) {
        try {
          for (const event of this.digest(tail)) this.queue.push(event);
        } catch (error: unknown) {
          this.fail(error instanceof AdapterError ? error : new AdapterError("MALFORMED_EVENT", this.context));
        }
      }
      this.end();
    });
  }

  private end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *events(): AsyncIterable<NormalizedEvent> {
    if (this.state === "READY") this.transition("STREAMING");
    this.pump();
    for (;;) {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next !== undefined) yield next;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }

  async interrupt(): Promise<InterruptRecord> {
    if (this.state === "READY" || this.state === "STREAMING" || this.state === "STARTING") {
      this.transition("INTERRUPTING");
    }
    // No protocol cancel is passed: no provider has proven one in P4.
    const record = await this.handle.interrupt();
    if (isLegalTransition(this.state, "CLOSED")) this.state = "CLOSED";
    return record;
  }

  async close(): Promise<void> {
    await this.handle.close();
    if (isLegalTransition(this.state, "CLOSED")) this.state = "CLOSED";
  }

  health(): HealthProbe {
    const status =
      this.state === "FAILED"
        ? "FAILED"
        : this.state === "READY" || this.state === "STREAMING"
          ? "OK"
          : this.state === "CLOSED"
            ? "UNKNOWN"
            : "DEGRADED";
    return {
      status,
      // Event-supplied, never a clock read: a probe that stamped itself with
      // the current time could not be compared against one taken yesterday.
      checkedAt: this.startedAtIso,
      latencyMs: null,
      classifiedError: this.failure === null ? null : this.failure.code,
    };
  }

  get ladderNote(): string {
    return SIGNAL_FLOOR_NOTE;
  }
}

/**
 * Start one session.
 *
 * Read-only enforcement happens here, before the spawn: a reviewer descriptor
 * whose argv carries a write-enabling flag never becomes a process.
 */
export function startSession(adapter: ProviderAdapter, request: SessionRequest): AdapterSession {
  const context = { provider: adapter.provider, taskId: request.taskId };
  const descriptor = adapter.describe(request);

  if (isReadOnlyIdentity(request.identity) && descriptorEnablesWrites(descriptor.argv)) {
    throw new AdapterError("READ_ONLY_VIOLATION", context);
  }

  const spawned = spawnAdmitted(request.binary, descriptor, request.limits, context);
  const handle = new ProcessHandle(spawned, request.limits, context);
  const session = new Session(adapter, request, handle);
  session.transition("STARTING");
  return session;
}

/**
 * Bare flags that enable writing on their own. No value follows them.
 */
const WRITE_ENABLING_TOKENS: readonly string[] = Object.freeze([
  "--yolo",
  "-y",
  "--auto",
  "--approve-for-me",
]);

/**
 * Flags whose *value* decides, and the values that are safe.
 *
 * These are the ones a single-token scan gets wrong. Every CLI here accepts
 * both `--flag=value` and `--flag value`, so a scan that only matched
 * `--sandbox=workspace-write` would wave through the identical, equally
 * dangerous `["--sandbox", "workspace-write"]`. Listing the *safe* values
 * rather than the dangerous ones is deliberate: a provider that adds a new
 * permissive mode is then refused by default instead of silently admitted.
 */
const PAIR_FLAG_SAFE_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "--permission-mode": Object.freeze(["plan"]),
  "--sandbox": Object.freeze(["read-only"]),
  "-s": Object.freeze(["read-only"]),
  "--ask-for-approval": Object.freeze(["never"]),
  "-a": Object.freeze(["never"]),
});

function enablesWrite(flag: string, value: string | undefined): boolean {
  const safe = PAIR_FLAG_SAFE_VALUES[flag];
  if (safe === undefined) return false;
  // A pair flag with no value at all is refused: an unreadable argument is not
  // an argument this scan may assume is harmless.
  if (value === undefined) return true;
  return !safe.includes(value);
}

/**
 * Would this argv let a provider write? Both spellings, and aliases.
 *
 * Refusal is the default for anything this scan cannot read.
 */
export function descriptorEnablesWrites(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    if (token.startsWith("--dangerously-")) return true;
    if (WRITE_ENABLING_TOKENS.includes(token)) return true;

    const equals = token.indexOf("=");
    if (equals > 0) {
      // `--flag=value`
      if (enablesWrite(token.slice(0, equals), token.slice(equals + 1))) return true;
      continue;
    }
    if (Object.hasOwn(PAIR_FLAG_SAFE_VALUES, token)) {
      // `--flag value`
      if (enablesWrite(token, argv[index + 1])) return true;
      index += 1;
    }
  }
  return false;
}

/** Exposed for tests and for the session pump a provider packet supplies. */
export type { Session as InternalSession };
