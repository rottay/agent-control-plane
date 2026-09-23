/**
 * The value types of the recorded-task reader (P-15 escalón D1, ADR 0105).
 *
 * The ports it reads through, the refusal vocabulary's derived union and the
 * outcome: the declarations this concept owns, in the concept's own leaf rather
 * than interleaved with the reader (owner law `docs/audit/architecture/index.md`
 * §7; the operation-result leaf is the precedent).
 *
 * A pure type leaf: it declares data and nothing else, and imports only types. The
 * closed set the union is derived from stays in `../index.ts` beside the reader and
 * is read here type-only, which is §7.1's one-way derivation and is erased at emit.
 */

import type { ResolvedRoute, TaskEnvelope } from "@acp/contracts";
import type { ArtifactReadOutcome, ArtifactReadRequest, TaskIntakeResolution } from "@acp/ledger";

import type { DurableInvocation, InvocationRevision } from "../../contracts/index.js";
import type { RECORDED_TASK_REFUSALS } from "../index.js";

export type RecordedTaskRefusal = (typeof RECORDED_TASK_REFUSALS)[number];

/** The ledger surface the reader needs. Satisfied structurally by `Ledger`; read-only by shape. */
export interface RecordedTaskLedgerPort {
  getTask(taskId: string): { readonly firstSequence: number } | null;
  getEventBySequence(sequence: number): { readonly canonicalJson: string } | null;
}

/** The plane surface the reader needs: one read by reference, under the task's scope. */
export interface RecordedTaskPlanePort {
  read(request: ArtifactReadRequest): ArtifactReadOutcome;
}

/** A task the intake recorded, read back whole: what the walk that runs it needs. */
export interface RecordedTask {
  readonly taskId: string;
  /** The envelope, read from the private plane by reference and held to its digest. */
  readonly envelope: TaskEnvelope;
  /** The revision record the intake folded: revision 1, attempt 1. Nothing is minted. */
  readonly revision: InvocationRevision;
  /** The intake's flat attempt, which the opening of its coordinate reuses. */
  readonly attempt: number;
  /** The intake event's `occurredAt`: the door's instant, recorded once. */
  readonly submittedAt: string;
  readonly initiativeId: string;
  /** The submission digest over the task, the attempt, the instant, the initiative and the route given. */
  readonly submissionDigest: string;
  /** The V2 invocation the walk runs under. */
  readonly invocation: DurableInvocation;
  /** The role the intake admitted the task for, and the resolution it was admitted on. */
  readonly role: string;
  readonly resolution: TaskIntakeResolution;
}

export interface RecordedTaskReaderInput {
  readonly ledger: RecordedTaskLedgerPort;
  readonly plane: RecordedTaskPlanePort;
  readonly taskId: string;
  /** The route the composition elected, held to the intake's resolution. */
  readonly route: ResolvedRoute;
}

export type RecordedTaskOutcome =
  | { readonly ok: true; readonly task: RecordedTask }
  | {
      readonly ok: false;
      readonly refusal: RecordedTaskRefusal;
      /** The field the refusal is about. Never its value. */
      readonly at: string;
      /** The plane's own refusal word, carried by name when the plane refused. */
      readonly word: string | null;
    };
