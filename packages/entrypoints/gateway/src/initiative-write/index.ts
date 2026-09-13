import type { InitiativeRegistrationRequest } from "@acp/protocol";
import {
  artifactBlobLeaseStorePath,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
  registerInitiative,
} from "@acp/ledger";
import type { InitiativeRegistrationOutcome, InitiativeRegistrationTestFaults, Ledger } from "@acp/ledger";

/**
 * The initiative registration write seam — the plane's fifth write door
 * (P-14/B, ADR 0086).
 *
 * This module opens what the registration needs, hands it over, and closes it.
 * It **decides nothing**: whether an initiative may be registered, what a
 * second registration under the same id is, where the objective goes and what
 * the event says all live in `registerInitiative`, which the CLI's `acp
 * initiative` calls too. A copy of any of that here would be the second answer
 * the shared orchestration exists to prevent.
 *
 * **The write capability is scoped to this module, and is short-lived**, as the
 * roadmap seam's is: the server's long-lived handle stays read-only, and a
 * writable ledger, the blob lease store and the plane are opened here for one
 * registration and closed in a `finally`.
 *
 * **Every identity and instant is injected.** The route mints them; this module
 * reads no clock and no random source, and neither does the orchestration. The
 * one identity no door mints is the initiative's: it is the caller's, and it is
 * the registration's idempotency coordinate.
 */

export interface InitiativeWriteInput {
  /** The read-only handle. Used for its path; never appended through. */
  readonly ledger: Ledger;
  readonly request: InitiativeRegistrationRequest;
  /** Injected: the recording instant. */
  readonly recordedAt: string;
  /** Injected: the pid the objective's holding records. */
  readonly holderPid: number;
  /** Injected: the lease store's incarnation, registered only if the file has none. */
  readonly leaseStoreIncarnationId: string;
  readonly eventId: string;
  readonly commandId: string;
  readonly artifactPinId: string;
  readonly artifactReferenceId: string;
  readonly intentionEventId: string;
  readonly terminalEventId: string;
  /** Test-only. */
  readonly __testFaults?: InitiativeRegistrationTestFaults;
}

/** Register one initiative through the shared orchestration, over short-lived handles. */
export function recordInitiativeRegistration(input: InitiativeWriteInput): InitiativeRegistrationOutcome {
  const path = input.ledger.path;
  const writable = openLedger(path);
  try {
    const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(path), {
      incarnationId: input.leaseStoreIncarnationId,
      createdAt: input.recordedAt,
    });
    try {
      const plane = openArtifactPlane({ ledger: writable, leaseStore, ledgerPath: path });
      return registerInitiative({
        ledger: writable,
        plane,
        request: {
          initiativeId: input.request.initiativeId,
          slug: input.request.slug,
          title: input.request.title,
          objective: input.request.objective,
          recordedBy: input.request.recordedBy,
        },
        recordedAt: input.recordedAt,
        holderPid: input.holderPid,
        identities: {
          eventId: input.eventId,
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
