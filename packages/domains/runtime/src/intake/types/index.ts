/**
 * The value types of task intake (P-14 escalón C, ADR 0087).
 *
 * The three vocabularies' derived unions, the fields a request carries, the parsed
 * intake, the refusal, the recorded intake and its identities, the test faults, the
 * input, the task the intake answers with and the outcome: the declarations this
 * concept owns, in the concept's own leaf rather than interleaved with the intake
 * that records them (owner law `docs/audit/architecture/index.md` §7; the ADR 0088
 * errata of 2026-09-14 withdraws that record's "Types live inline in the module" for
 * every new declaration, and decision 90 registers this seam).
 *
 * A pure type leaf, on `@acp/ledger`'s `src/types/index.ts` pattern: it declares data
 * and nothing else, and imports only types. The closed sets the unions are derived
 * from stay in `../index.ts` beside the intake, and are read here type-only, which is
 * §7.1's one-way derivation and is erased at emit.
 *
 * Nothing was renamed and no field changed: these are the same declarations, moved,
 * and `../index.ts` re-exports every one of them, so no importer sees a difference.
 */

import type { AssignmentProposal } from "@acp/accounts";
import type { TaskEnvelope, TaskState, TransportKind, WorkerRole } from "@acp/contracts";
import type {
  ArtifactPlane,
  Ledger,
  TaskIntakePayload,
  TaskIntakeResolution,
  TaskSubmissionReadModel,
} from "@acp/ledger";
import type {
  TASK_INTAKE_CODES,
  TASK_INTAKE_REFUSALS,
  TASK_INTAKE_WRITE_REFUSALS,
} from "../index.js";

export type TaskIntakeRefusal = (typeof TASK_INTAKE_REFUSALS)[number];

export type TaskIntakeWriteRefusal = (typeof TASK_INTAKE_WRITE_REFUSALS)[number];

export type TaskIntakeCode = (typeof TASK_INTAKE_CODES)[number];

/** What a door hands over. Structural: the doors parse `TaskIntakeRequest` first. */
export interface TaskIntakeFields {
  readonly envelope: unknown;
  readonly clientScope: string;
  readonly clientRequestKey: string;
  readonly roadmapVersionId: string | null;
  readonly stepId: string | null;
  readonly role: string;
  readonly slot: number;
  readonly transportKind: string;
  readonly recordedBy: string;
}

/** A request whose form holds, with the envelope parsed and its two digests computed. */
export interface ParsedTaskIntake {
  readonly envelope: TaskEnvelope;
  /** The envelope's identity digest: `envelopeSha256(envelope)`. */
  readonly envelopeSha256: string;
  /** The bytes the plane publishes, and their own digest. */
  readonly envelopeBytes: Uint8Array;
  readonly contentSha256: string;
  readonly clientScope: string;
  readonly clientRequestKey: string;
  readonly roadmapVersionId: string | null;
  readonly stepId: string | null;
  readonly role: WorkerRole;
  readonly slot: number;
  readonly transportKind: TransportKind;
  readonly recordedBy: string;
}

export interface TaskIntakeRefused {
  readonly ok: false;
  readonly reason: TaskIntakeWriteRefusal;
  /** The intake's own code, `@acp/accounts`' word, or the plane's. */
  readonly code: string;
  /** A field path, or the resolver's own path. Never a value. */
  readonly at: string;
  /** Set when the resolver proposes one: a retired version's migration. */
  readonly proposal: AssignmentProposal | null;
}

/** What a client key recorded: its row, and the intake payload of the event that folded it. */
export interface RecordedTaskIntake {
  readonly submission: TaskSubmissionReadModel;
  readonly payload: TaskIntakePayload;
}

/** The identifiers a door mints for one attempt. A retry's are ignored where a record stands. */
export interface TaskIntakeIdentities {
  /** The `TASK_DISCOVERED` event's id. */
  readonly eventId: string;
  readonly revisionId: string;
  readonly commandId: string;
  readonly artifactPinId: string;
  readonly artifactReferenceId: string;
  readonly intentionEventId: string;
  readonly terminalEventId: string;
}

/** Test-only fault points. Production callers never set this. */
export interface TaskIntakeTestFaults {
  /** The envelope is published and referenced; the intake is not appended yet. */
  readonly afterEnvelopePublished?: (() => void) | undefined;
}

export interface TaskIntakeInput {
  /** A writable ledger. The intake and the plane append through it. */
  readonly ledger: Ledger;
  /** The private plane of the same ledger. */
  readonly plane: ArtifactPlane;
  readonly request: TaskIntakeFields;
  /** Injected: the recording instant, ISO-8601 in UTC with milliseconds. */
  readonly recordedAt: string;
  /** Injected: the pid the envelope's holding records. */
  readonly holderPid: number;
  readonly identities: TaskIntakeIdentities;
  /** Test-only. */
  readonly __testFaults?: TaskIntakeTestFaults;
}

/** The task a response is built from: what the key names, as the stream holds it. */
export interface IntakeTask {
  readonly taskId: string;
  readonly revisionNumber: number;
  readonly revisionId: string;
  readonly envelopeSha256: string;
  readonly envelopeArtifactReferenceId: string;
  readonly state: TaskState;
  readonly resolution: TaskIntakeResolution;
}

export type TaskIntakeOutcome =
  | {
      readonly ok: true;
      /** true when the key already named this request and nothing was written. */
      readonly replayed: boolean;
      /** The task-stream position of the intake. */
      readonly sequence: number;
      readonly task: IntakeTask;
    }
  | TaskIntakeRefused;
