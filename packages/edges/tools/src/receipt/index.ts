/**
 * The tool call receipt — `@acp/tools` (V2-B4b stage 1).
 *
 * Ten members, every one a scalar, pinned member by member by the fence. This
 * is how "no tool arguments, no server content, no prompt and no credential in
 * the record" is enforced rather than promised: a receipt that *could* carry
 * one would eventually carry one, and then be logged.
 *
 * What is deliberately absent, each with its reason:
 *
 * - **No arguments, result, content or text.** That is the restriction the
 *   roadmap states and the acceptance criterion the V2 gate reads.
 * - **No timestamp and no duration.** Nothing in this package reads a clock.
 *   That makes a receipt a pure function of the call, so a drill can assert it
 *   by equality rather than by picking fields around a moving value. A caller
 *   that wants timing measures it with its own clock, outside the receipt.
 * - **No argument digest.** A digest needs a canonical serializer, and the only
 *   one in this repository lives in `@acp/ledger` — importing a ledger into a
 *   tool edge to borrow a string function would put this package one import
 *   away from appending to it. `argumentBytes` is a count the ceiling forces
 *   this code to compute anyway, and it is the honest half of what a digest
 *   would have offered.
 *
 * **A refusal gets a receipt too.** The refused calls are the ones an auditor
 * most needs to see; a refusal that left no record would make the allowlist
 * unfalsifiable in operation.
 *
 * Persisting a receipt into the ledger, and projecting it safely through the
 * event stream, are a later stage's work and are not claimed here. This stage
 * returns the receipt to its caller and stops.
 */

import { findCredentialViolations, findTranscriptViolations } from "@acp/contracts";
import type { WorkerIdentityString } from "@acp/contracts";

import type { ToolRefusal, ToolTransportKind } from "../contract/index.js";

export type ToolCallOutcomeName = "COMPLETED" | "REFUSED";

export interface ToolCallReceipt {
  readonly sessionId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly transport: ToolTransportKind;
  readonly identity: WorkerIdentityString;
  readonly outcome: ToolCallOutcomeName;
  readonly refusal: ToolRefusal | null;
  readonly argumentBytes: number;
  readonly resultBytes: number;
  readonly contentBlocks: number;
}

/** What a caller states; the receipt is a pure function of exactly this. */
export interface ToolReceiptInput {
  readonly sessionId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly transport: ToolTransportKind;
  readonly identity: WorkerIdentityString;
  readonly refusal: ToolRefusal | null;
  readonly argumentBytes: number;
  readonly resultBytes: number;
  readonly contentBlocks: number;
}

/** What a redacted coordinate reads as. Never a fragment of what it replaced. */
const REDACTED = "REDACTED";

/**
 * Build the one receipt, and run the contracts guards over the finished object.
 *
 * The type already makes a violation nearly unreachable — every member is a
 * scalar and none is named for anything a credential travels in. The guard is
 * what makes "nearly" stop being the argument: a credential-shaped *value* can
 * still arrive through a free-text coordinate, most plausibly a tool name in a
 * badly-written server configuration.
 *
 * When that happens the receipt is refused and rebuilt with its free-text
 * coordinates replaced. That loses the coordinates, which is the deliberate
 * trade: the coordinates are recoverable from the call that produced them, and
 * a leaked fragment is recoverable from nowhere once it has been written down.
 */
export function toolReceipt(input: ToolReceiptInput): ToolCallReceipt {
  const receipt: ToolCallReceipt = Object.freeze({
    sessionId: input.sessionId,
    serverId: input.serverId,
    toolName: input.toolName,
    transport: input.transport,
    identity: input.identity,
    outcome: input.refusal === null ? "COMPLETED" : "REFUSED",
    refusal: input.refusal,
    argumentBytes: input.argumentBytes,
    resultBytes: input.resultBytes,
    contentBlocks: input.contentBlocks,
  });

  const violations = [
    ...findCredentialViolations(receipt),
    ...findTranscriptViolations(receipt),
  ];
  if (violations.length === 0) return receipt;

  return Object.freeze({
    sessionId: REDACTED,
    serverId: REDACTED,
    toolName: REDACTED,
    transport: input.transport,
    identity: REDACTED as WorkerIdentityString,
    outcome: "REFUSED",
    refusal: "RESULT_UNSAFE",
    argumentBytes: 0,
    resultBytes: 0,
    contentBlocks: 0,
  });
}

/**
 * Does this value carry anything the plane refuses to hand on?
 *
 * Applied to a server's `tools/call` result before any of it is returned. A
 * server that answers with something credential-shaped is a server whose
 * output this plane will not carry — refused whole, never filtered, because a
 * filtered answer is one the caller cannot tell from a complete one.
 */
export function toolResultIsUnsafe(value: unknown): boolean {
  return findCredentialViolations(value).length > 0 || findTranscriptViolations(value).length > 0;
}
