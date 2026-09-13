import { randomUUID } from "node:crypto";

import {
  artifactBlobLeaseStorePath,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  registerInitiative,
} from "@acp/ledger";
import type { InitiativeRegistrationTestFaults } from "@acp/ledger";
import {
  API_CONTRACT_VERSION,
  InitiativeRegistrationRequest,
  InitiativeRegistrationResponse,
  LEDGER_CONTRACT_VERSION,
} from "@acp/protocol";
import type { ApiErrorCode } from "@acp/protocol";

import { openForWrite, readOperatorDocument } from "../tool-call/index.js";

/**
 * The CLI's initiative registration door (P-14/B, ADR 0086).
 *
 * The plane's second door onto the same registration, and deliberately **not**
 * an HTTP client of the gateway, for the tool call's reason: two independent
 * producers over one ledger is what makes "the same initiative by command and by
 * API is the same row" evidence rather than a tautology.
 *
 * **One behaviour authority.** `registerInitiative` in `@acp/ledger` decides,
 * publishes the objective and appends; the gateway's POST calls it too. This
 * module reads the operator's document, opens the handles, mints the identities
 * and prints what came back — and nothing else.
 *
 * **The request is the API's request, byte for byte.** The `--request` document
 * is parsed by `InitiativeRegistrationRequest`, the schema the POST body is
 * parsed by, and read through the same uid ladder `acp tool-call` reads its
 * request through. The ledger is taken through the same `openForWrite`: this verb
 * shares the tool call's one writable open rather than adding a second, so
 * `L-B4B-11` stays literally true (H-3).
 *
 * **The caller names the initiative.** No identifier here stands for the
 * initiative: its id is the document's, and it is the registration's
 * idempotency coordinate. A retry of the same document is a replay.
 */

/** A refusal that never became a registration. Shaped exactly like the tool call's. */
export class InitiativeRefused extends Error {
  readonly code: ApiErrorCode;
  /** The field path or the plane's word a refusal names. Never the operator's value. */
  readonly at: string | null;

  constructor(code: ApiErrorCode, message: string, at: string | null = null) {
    super(message);
    this.name = "InitiativeRefused";
    this.code = code;
    this.at = at;
  }
}

export interface InitiativeVerbInput {
  readonly databasePath: string;
  readonly requestPath: string;
  /** Test-only. */
  readonly __testFaults?: InitiativeRegistrationTestFaults;
}

export interface InitiativeVerbResult {
  readonly document: InitiativeRegistrationResponse;
}

/**
 * Register one initiative and return the document to print.
 *
 * Everything the operator could have got wrong is refused before a ledger is
 * opened: an unreadable document and a request the schema refuses are
 * `BAD_REQUEST`. What the recorded state refuses is `WRITE_REFUSED`, carrying the
 * registration's own word — the API door's 409, in the exit-code table's terms.
 */
export function runInitiativeVerb(input: InitiativeVerbInput): InitiativeVerbResult {
  const rawRequest = readOperatorDocument({ path: input.requestPath, at: "request", secret: false });

  const parsed = InitiativeRegistrationRequest.safeParse(rawRequest);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // The field path only: an objective echoed into a diagnostic is an
    // objective in a terminal log.
    const at = issue === undefined ? "request" : "request." + issue.path.join(".");
    throw new InitiativeRefused("BAD_REQUEST", "the request document is not a valid initiative registration", at);
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
      const outcome = registerInitiative({
        ledger,
        plane,
        request: {
          initiativeId: request.initiativeId,
          slug: request.slug,
          title: request.title,
          objective: request.objective,
          recordedBy: request.recordedBy,
        },
        recordedAt,
        holderPid: process.pid,
        identities: {
          eventId: randomUUID(),
          commandId: randomUUID(),
          artifactPinId: randomUUID(),
          artifactReferenceId: randomUUID(),
          intentionEventId: randomUUID(),
          terminalEventId: randomUUID(),
        },
        ...(input.__testFaults === undefined ? {} : { __testFaults: input.__testFaults }),
      });

      if (!outcome.ok) {
        throw new InitiativeRefused(
          "WRITE_REFUSED",
          "the initiative registration was refused: " + outcome.reason,
          outcome.at,
        );
      }

      return {
        document: InitiativeRegistrationResponse.parse({
          apiContractVersion: API_CONTRACT_VERSION,
          ledgerContractVersion: LEDGER_CONTRACT_VERSION,
          replayed: outcome.replayed,
          sequence: outcome.sequence,
          registration: {
            initiativeId: outcome.registration.initiativeId,
            slug: outcome.registration.slug,
            title: outcome.registration.title,
            objectiveSha256: outcome.registration.objectiveSha256,
            status: outcome.registration.status,
            eventCount: outcome.registration.eventCount,
            createdAt: outcome.registration.createdAt,
            updatedAt: outcome.registration.updatedAt,
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
