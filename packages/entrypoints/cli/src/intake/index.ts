import { randomUUID } from "node:crypto";

import { artifactBlobLeaseStorePath, openArtifactBlobLeaseStore, openArtifactPlane } from "@acp/ledger";
import {
  API_CONTRACT_VERSION,
  LEDGER_CONTRACT_VERSION,
  TaskIntakeRequest,
  TaskIntakeResponse,
} from "@acp/protocol";
import type { ApiErrorCode } from "@acp/protocol";
import { intakeTask } from "@acp/runtime";
import type { TaskIntakeTestFaults } from "@acp/runtime";

import { openForWrite, readOperatorDocument } from "../tool-call/index.js";

/**
 * The CLI's task intake door (P-14/C, ADR 0087).
 *
 * The plane's second door onto the same intake, and deliberately **not** an HTTP
 * client of the gateway, for the initiative verb's reason: two independent
 * producers over one ledger is what makes "the same task by command and by API is
 * the same task" evidence rather than a tautology.
 *
 * **One behaviour authority.** `intakeTask` in `@acp/runtime` decides, resolves
 * the role, publishes the envelope and appends; the gateway's POST calls it too.
 * This module reads the operator's document, opens the handles, mints the
 * identities and prints what came back — and nothing else.
 *
 * **The request is the API's request, byte for byte.** The `--request` document
 * is parsed by `TaskIntakeRequest`, the schema the POST body is parsed by, and
 * read through the same uid ladder `acp tool-call` reads its request through.
 * The ledger is taken through the same `openForWrite`: this verb shares the tool
 * call's one writable open rather than adding a second, so `L-B4B-11` stays
 * literally true.
 *
 * **The caller names the key and the task.** No identifier here stands for
 * either: the client key and the task id are the document's, and a retry of the
 * same document is a replay.
 */

/** A refusal that never became an intake. Shaped exactly like the tool call's. */
export class IntakeRefused extends Error {
  readonly code: ApiErrorCode;
  /** The field path a refusal names. Never the operator's value. */
  readonly at: string | null;

  constructor(code: ApiErrorCode, message: string, at: string | null = null) {
    super(message);
    this.name = "IntakeRefused";
    this.code = code;
    this.at = at;
  }
}

export interface IntakeVerbInput {
  readonly databasePath: string;
  readonly requestPath: string;
  /** Test-only. */
  readonly __testFaults?: TaskIntakeTestFaults;
}

export interface IntakeVerbResult {
  readonly document: TaskIntakeResponse;
}

/**
 * Enter one task and return the document to print.
 *
 * Everything the operator could have got wrong is refused before a ledger is
 * opened: an unreadable document and a request the schema refuses — the
 * envelope's own contract included — are `BAD_REQUEST`. What the recorded state
 * refuses is `WRITE_REFUSED`, carrying the intake's class, code and proposal —
 * the API door's 409, in the exit-code table's terms.
 */
export function runIntakeVerb(input: IntakeVerbInput): IntakeVerbResult {
  const rawRequest = readOperatorDocument({ path: input.requestPath, at: "request", secret: false });

  const parsed = TaskIntakeRequest.safeParse(rawRequest);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // The field path only: an objective echoed into a diagnostic is an
    // objective in a terminal log.
    const at = issue === undefined ? "request" : "request." + issue.path.join(".");
    throw new IntakeRefused("BAD_REQUEST", "the request document is not a valid task intake", at);
  }
  const request = parsed.data;

  const ledger = openForWrite(input.databasePath);
  try {
    const recordedAt = new Date().toISOString();
    const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(ledger.path), {
      incarnationId: randomUUID(),
      createdAt: recordedAt,
    });
    try {
      const plane = openArtifactPlane({ ledger, leaseStore, ledgerPath: ledger.path });
      const outcome = intakeTask({
        ledger,
        plane,
        request: {
          envelope: request.envelope,
          clientScope: request.clientScope,
          clientRequestKey: request.clientRequestKey,
          roadmapVersionId: request.roadmapVersionId,
          stepId: request.stepId,
          role: request.role,
          slot: request.slot,
          transportKind: request.transportKind,
          recordedBy: request.recordedBy,
        },
        recordedAt,
        holderPid: process.pid,
        identities: {
          eventId: randomUUID(),
          revisionId: randomUUID(),
          commandId: randomUUID(),
          artifactPinId: randomUUID(),
          artifactReferenceId: randomUUID(),
          intentionEventId: randomUUID(),
          terminalEventId: randomUUID(),
        },
        ...(input.__testFaults === undefined ? {} : { __testFaults: input.__testFaults }),
      });

      if (!outcome.ok) {
        throw new IntakeRefused(
          "WRITE_REFUSED",
          "the task intake was refused: " +
            outcome.reason +
            " " +
            outcome.code +
            (outcome.proposal === null ? "" : "; proposal " + outcome.proposal),
          outcome.at,
        );
      }

      return {
        document: TaskIntakeResponse.parse({
          apiContractVersion: API_CONTRACT_VERSION,
          ledgerContractVersion: LEDGER_CONTRACT_VERSION,
          replayed: outcome.replayed,
          sequence: outcome.sequence,
          task: {
            taskId: outcome.task.taskId,
            revisionNumber: outcome.task.revisionNumber,
            revisionId: outcome.task.revisionId,
            envelopeSha256: outcome.task.envelopeSha256,
            envelopeArtifactReferenceId: outcome.task.envelopeArtifactReferenceId,
            state: outcome.task.state,
            resolution: outcome.task.resolution,
          },
        }),
      };
    } finally {
      leaseStore.close();
    }
  } finally {
    ledger.close();
  }
}
