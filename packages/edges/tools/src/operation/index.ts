import type { ToolCallRequest, ToolRefusal } from "../contract/index.js";
import { createToolProtocolPort } from "../port/index.js";
import type { ToolCallOutcome } from "../port/index.js";
import type { AdmittedToolServer } from "../admission/index.js";

/**
 * One open tool operation, as a scope (V2-B4b stage 3C).
 *
 * This is the composition site: the one place outside this package's own suites
 * where a tool protocol port is constructed. A door opens a scope, runs exactly
 * one operation through it, and closes it — one scope, one operation, one
 * request — so process-start authority lives at a named seam rather than being
 * available wherever the port could be imported.
 *
 * **Liveness is a boolean, not a deadline.** The scope answers live for exactly
 * its own scope id until `close()`, and false for every other id and for every
 * id afterwards. Nothing here reads a clock: a scope that expired on its own
 * would make the same request succeed or fail depending on when it arrived.
 *
 * **`close()` drops liveness before it reaps.** The order is what makes the
 * reap final: a call that arrives during the close finds a dead session and is
 * refused rather than racing a child that is being killed. Close is idempotent,
 * and reaps by pid.
 *
 * **Structural, by law.** This module may not name the runtime package — the
 * fence forbids the string in code — so `ToolOperationScope` satisfies the
 * runtime's port by shape and nothing here knows that it does. That is the same
 * arrangement the effect port has, and it is why the tool edge and the domain
 * can be reviewed independently.
 *
 * **The scope id is the caller's, and it is compared by equality.** The
 * operation builds the same string from the same coordinates and refuses a
 * scope whose id differs, so a scope opened for one operation cannot serve
 * another's request. The shape is `tool/<taskId>/<attempt>/<operationIndex>`:
 * four segments led by a literal, which is what keeps it disjoint from an
 * execution session's three led by a task id.
 *
 * ## The invariant this module owns: `ok` agrees with the receipt
 *
 * The port answers a discriminated union, but both arms carry the same receipt
 * type, and the receipt carries its own `outcome` and `refusal`. Nothing in the
 * types forbids the two from disagreeing — and they can, through code that is
 * already shipped: `toolReceipt` scans the receipt's **own fields** for
 * credential and transcript shapes, and on a hit returns a redacted receipt
 * whose outcome is `REFUSED` and whose refusal is `RESULT_UNSAFE`, regardless
 * of what the caller asked for. The port's success path builds that receipt and
 * returns `ok: true` with content beside it.
 *
 * Left alone, the operation downstream records a durable `REFUSED` row while
 * the door hands the caller the content the row says was unsafe. The recorder
 * cannot catch it: `REFUSED` with a refusal word is internally coherent, so
 * nothing throws.
 *
 * So the scope judges the port's answer before returning it, and resolves a
 * disagreement **as a refusal, with no content**. That direction is the only
 * safe one: the redaction fired because something in the receipt looked like a
 * secret, and the conservative reading of "this may be a secret" is to refuse,
 * never to overwrite the refusal with a success. No vocabulary is invented —
 * `RESULT_UNSAFE` is already a refusal word — and Packet B's documented
 * assumption of a conforming port is met here by construction rather than by
 * hope.
 *
 * Note what this cannot be: coherence is only decidable after the port returns,
 * because the values do not exist before it. It is not a precheck. What it
 * guarantees is that no incoherent outcome ever leaves this seam.
 */

/** The scope a door opens for one operation, and closes when it is done. */
export interface ToolOperationScope {
  readonly scopeId: string;
  readonly callTool: (request: ToolCallRequest) => Promise<ToolCallOutcome>;
  readonly close: () => Promise<void>;
}

export interface ToolOperationInput {
  readonly scopeId: string;
  readonly servers: readonly AdmittedToolServer[];
  /** The child's hard backstop, forwarded for suites that need to observe it. */
  readonly serverLifetimeMs?: number;
}

/**
 * Is this outcome self-consistent?
 *
 * A success must carry a completed receipt with no refusal; a refusal must
 * carry a refused receipt naming the same word. Anything else is the seam this
 * module exists to close.
 */
function isCoherent(outcome: ToolCallOutcome): boolean {
  if (outcome.ok) {
    return outcome.receipt.outcome === "COMPLETED" && outcome.receipt.refusal === null;
  }
  return outcome.receipt.outcome === "REFUSED" && outcome.receipt.refusal === outcome.refusal;
}

/**
 * Resolve an incoherent outcome as a refusal, carrying the receipt unchanged.
 *
 * The receipt is not rewritten: it is the evidence of what happened, and a
 * scope that edited it would be deciding what the record says. Only the arm
 * changes — to the refusing one — and the content is dropped, because content
 * beside a receipt that says `REFUSED` is exactly the pairing this refuses to
 * hand on.
 *
 * `server.result` is the field path, because a redacted receipt is a statement
 * about what came back from the server rather than about anything the caller
 * sent. `RESULT_UNSAFE` is the fallback word when the receipt names none.
 */
function asRefusal(outcome: ToolCallOutcome): ToolCallOutcome {
  const refusal: ToolRefusal = outcome.receipt.refusal ?? "RESULT_UNSAFE";
  return { ok: false, receipt: outcome.receipt, refusal, at: "server.result" };
}

/**
 * Open one tool operation.
 *
 * The port is constructed here and nowhere else outside this package's suites.
 * The caller owes a `close()` — in a `finally`, so a throw on the way out still
 * reaps the children this scope started.
 */
export function openToolOperation(input: ToolOperationInput): ToolOperationScope {
  let live = true;
  const port = createToolProtocolPort({
    servers: input.servers,
    liveness: { isLive: (sessionId: string) => live && sessionId === input.scopeId },
    ...(input.serverLifetimeMs === undefined ? {} : { serverLifetimeMs: input.serverLifetimeMs }),
  });

  return Object.freeze({
    scopeId: input.scopeId,
    async callTool(request: ToolCallRequest): Promise<ToolCallOutcome> {
      const outcome = await port.callTool(request);
      return isCoherent(outcome) ? outcome : asRefusal(outcome);
    },
    async close(): Promise<void> {
      // Liveness first, then the reap. A call arriving in between finds a dead
      // session and is refused, rather than racing a child being killed.
      live = false;
      await port.closeAll();
    },
  });
}
