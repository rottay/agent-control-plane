import { StringDecoder } from "node:string_decoder";

import type { ExecutionOutputSink, HealthProbe, WorkerIdentityString } from "@acp/contracts";
import { findCredentialViolations, parseWorkerIdentity } from "@acp/contracts";

import type {
  CapabilityRecord,
  ParseCursor,
  ProviderAdapter,
  ProviderName,
  SessionRequest,
  SessionState,
} from "../contract/index.js";
import { EMPTY_CURSOR, isLegalTransition, unknownCapabilities } from "../contract/index.js";
import { AdapterError } from "../errors/index.js";
import type { NormalizedEvent } from "../events/index.js";
import { normalizedEvent, toNormalized } from "../events/index.js";
import { ProcessHandle } from "../process/handle/index.js";
import type { InterruptRecord } from "../process/handle/index.js";
import { spawnAdmitted } from "../process/spawn/index.js";
import { shapePayload } from "../redact/index.js";

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
  /**
   * How the child ended, as observed, or null when no exit has been observed —
   * never a fabricated 0 (P-07 escalón C, ADR 0099).
   */
  exit(): { readonly exitCode: number | null; readonly signal: string | null } | null;
  /** What the operation said about its outcome, at most once, or null when it said nothing. */
  operation(): "SUCCEEDED" | "FAILED" | null;
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
  /** The caller's private sink for output text, bound at spawn (P-07 escalón C). */
  private readonly sink: ExecutionOutputSink | undefined;
  /** The operation's verdict, held once. */
  private verdict: "SUCCEEDED" | "FAILED" | null = null;

  constructor(adapter: ProviderAdapter, request: SessionRequest, handle: ProcessHandle, sink?: ExecutionOutputSink) {
    this.adapter = adapter;
    this.request = request;
    this.handle = handle;
    this.sink = sink;
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
      // The two private signals are intercepted before anything normalizes: the
      // output text goes to the caller's sink and nowhere else, and the verdict is
      // held on the session (P-07 escalón C, ADR 0099).
      if (signal.kind === "output") {
        this.deliverOutput(signal.text);
        continue;
      }
      if (signal.kind === "operation") {
        // A second verdict in one session is not overwritten: it fails the
        // session, because nothing observed says which of the two to believe.
        if (this.verdict !== null) throw new AdapterError("MALFORMED_EVENT", this.context);
        this.verdict = signal.status;
        continue;
      }
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
   * Hand one delta of output text to the caller's sink, and do nothing else with
   * it. Without a sink the text is dropped, which is the legacy path. This
   * function names no recorder, no event builder and no error: the fence holds
   * that (L-P07C-1).
   *
   * A sink that throws fails the session, classified `MALFORMED_EVENT`: the throw
   * surfaces inside the stream's digest, whose catch classifies anything that is
   * not an adapter error that way. The caller's sink must not throw — escalón D's
   * assembler included.
   */
  private deliverOutput(text: string): void {
    this.sink?.(text);
  }

  exit(): { readonly exitCode: number | null; readonly signal: string | null } | null {
    return this.handle.exitStatus();
  }

  operation(): "SUCCEEDED" | "FAILED" | null {
    return this.verdict;
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
 * Start one session, and deliver the instruction it carries.
 *
 * Read-only enforcement happens here, before the spawn: a reviewer descriptor
 * whose argv carries a write-enabling flag never becomes a process.
 *
 * This is the **one impure seam** (V2-B1c). Adapters declare how a transport
 * takes an instruction; only this function performs it. The order below is the
 * whole of the fail-closed story and it is the order rather than the checks
 * that matters:
 *
 * 1. the read-only argv scan, so a reviewer identity is refused before
 *    anything else is considered;
 * 2. the delivery-support check, so a transport that cannot take an
 *    instruction refuses **before a process exists** -- never a silent skip,
 *    never a spawn-then-discard;
 * 3. the credential scan over the content;
 * 4. spawn;
 * 5. write, then **close**.
 *
 * The write is last and the close is not optional. The pipe is opened by the
 * spawn either way, so a delivery that wrote without closing would convert
 * today's silent no-op into a silent block until the step's timeout -- a worse
 * failure, and a harder one to see.
 */
export function startSession(
  adapter: ProviderAdapter,
  request: SessionRequest,
  sink?: ExecutionOutputSink,
): AdapterSession {
  const context = { provider: adapter.provider, taskId: request.taskId };
  const descriptor = adapter.describe(request);

  if (isReadOnlyIdentity(request.identity) && descriptorEnablesWrites(descriptor.argv)) {
    throw new AdapterError("READ_ONLY_VIOLATION", context);
  }

  // Before the spawn. A transport whose protocol needs a handshake this plane
  // has not performed, or whose instruction frame needs an id the server has
  // not yet returned, cannot be handed an instruction -- so no process is
  // created, no byte is written and no frame is sent.
  //
  // TWO reasons reach this one point since P-06/C (ADR 0095). The second is the
  // CONTENT's: a transport whose protocol is fine may still be unable to carry
  // the classes the instruction was composed from, and it says so by declaring
  // `MODALITY_UNSUPPORTED` in its descriptor. It is refused here, at the same
  // place and for the same reason as the first -- contratos §4.3 requires the
  // refusal to happen "en el preflight, antes de gastar cuota" -- so a class
  // this route cannot take costs nothing and starts nothing.
  //
  // `PROTOCOL_UNSUPPORTED` rather than a new code, for BOTH reasons: the
  // specificity lives in the descriptor's own `reason`, and minting a member
  // would move a pinned closed set for no semantic gain (ADR 0034).
  const delivery = descriptor.delivery;
  switch (delivery.kind) {
    case "UNSUPPORTED":
      throw new AdapterError("PROTOCOL_UNSUPPORTED", context);
    case "STDIN":
      break;
    default: {
      // The union is closed and the compiler enforces it here: a third kind
      // added without a branch fails the build rather than falling through to
      // a spawn that quietly delivered nothing.
      const unreachable: never = delivery;
      return unreachable;
    }
  }

  // Scanned as an OBJECT, not as a bare string: the guard's value scan is what
  // must run over the content. A hit refuses before the write, and the
  // offending bytes never reach the child and never reach the message.
  //
  // `findTranscriptViolations` is deliberately not invoked: it scans denied
  // KEYS, so it is vacuous on this content, and calling it would look like
  // content filtering that is not happening.
  if (findCredentialViolations({ instructions: request.instructions }).length > 0) {
    throw new AdapterError("CREDENTIAL_MATERIAL", context);
  }

  const spawned = spawnAdmitted(request.binary, descriptor, request.limits, context);
  const handle = new ProcessHandle(spawned, request.limits, context);

  // Written once, then closed, so the child sees EOF and can act. The bytes
  // cross exactly this boundary and are recorded nowhere.
  spawned.child.stdin.end(request.instructions);

  const session = new Session(adapter, request, handle, sink);
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
