import type { TaskIntakeRequest } from "@acp/protocol";
import { artifactBlobLeaseStorePath, openArtifactBlobLeaseStore, openArtifactPlane, openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { intakeTask } from "@acp/runtime";
import type { TaskIntakeOutcome, TaskIntakeTestFaults } from "@acp/runtime";

/**
 * The task intake write seam — the plane's sixth write door (P-14/C, ADR 0087).
 *
 * This module opens what the intake needs, hands it over, and closes it. It
 * **decides nothing**: whether a task may enter, what a second submission under
 * the same key is, how the role resolves, where the envelope goes and what the
 * event says all live in `intakeTask`, which the CLI's `acp intake` calls too. A
 * copy of any of that here would be the second answer the shared orchestration
 * exists to prevent.
 *
 * **The write capability is scoped to this module, and is short-lived**, as the
 * initiative seam's is: the server's long-lived handle stays read-only, and a
 * writable ledger, the blob lease store and the plane are opened here for one
 * intake and closed in a `finally`.
 *
 * **Every identity and instant is injected.** The route mints them; this module
 * reads no clock and no random source, and neither does the orchestration. The
 * two identities no door mints are the caller's: the client key and the task id,
 * which together are what makes a retry a replay.
 */

export interface TaskIntakeWriteInput {
  /** The read-only handle. Used for its path; never appended through. */
  readonly ledger: Ledger;
  readonly request: TaskIntakeRequest;
  /** Injected: the recording instant. */
  readonly recordedAt: string;
  /** Injected: the pid the envelope's holding records. */
  readonly holderPid: number;
  /** Injected: the lease store's incarnation, registered only if the file has none. */
  readonly leaseStoreIncarnationId: string;
  readonly eventId: string;
  readonly revisionId: string;
  readonly commandId: string;
  readonly artifactPinId: string;
  readonly artifactReferenceId: string;
  readonly intentionEventId: string;
  readonly terminalEventId: string;
  /** Test-only. */
  readonly __testFaults?: TaskIntakeTestFaults;
}

/** Enter one task through the shared orchestration, over short-lived handles. */
export function recordTaskIntake(input: TaskIntakeWriteInput): TaskIntakeOutcome {
  const path = input.ledger.path;
  const writable = openLedger(path);
  try {
    const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(path), {
      incarnationId: input.leaseStoreIncarnationId,
      createdAt: input.recordedAt,
    });
    try {
      const plane = openArtifactPlane({ ledger: writable, leaseStore, ledgerPath: path });
      return intakeTask({
        ledger: writable,
        plane,
        request: {
          envelope: input.request.envelope,
          clientScope: input.request.clientScope,
          clientRequestKey: input.request.clientRequestKey,
          roadmapVersionId: input.request.roadmapVersionId,
          stepId: input.request.stepId,
          role: input.request.role,
          slot: input.request.slot,
          transportKind: input.request.transportKind,
          recordedBy: input.request.recordedBy,
        },
        recordedAt: input.recordedAt,
        holderPid: input.holderPid,
        identities: {
          eventId: input.eventId,
          revisionId: input.revisionId,
          commandId: input.commandId,
          artifactPinId: input.artifactPinId,
          artifactReferenceId: input.artifactReferenceId,
          intentionEventId: input.intentionEventId,
          terminalEventId: input.terminalEventId,
        },
        ...(input.__testFaults === undefined ? {} : { __testFaults: input.__testFaults }),
      });
    } finally {
      leaseStore.close();
    }
  } finally {
    writable.close();
  }
}
