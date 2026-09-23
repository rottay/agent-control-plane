import { publishRegistryDocument } from "@acp/ledger";
import {
  API_CONTRACT_VERSION,
  LEDGER_CONTRACT_VERSION,
  RegistryPublicationRequest,
  RegistryPublicationResponse,
} from "@acp/protocol";
import type { ApiErrorCode } from "@acp/protocol";

import { openForWrite, readOperatorDocument } from "../tool-call/index.js";

/**
 * The CLI's registry publication door (P-15 escalón R, ADR 0104).
 *
 * The one door onto registry publication, and CLI only (decision 128): registry
 * configuration is an owner act on the local plane, and no specification row asks
 * for an API door.
 *
 * **One behaviour authority.** `publishRegistryDocument` in `@acp/ledger` derives
 * the digest, the key and the event id, answers an exact retry as a replay and
 * refuses a version recorded otherwise; the ledger door validates. This module
 * reads the operator's document, opens the ledger, reads the clock and prints what
 * came back — and nothing else.
 *
 * **Read and opened as every writing verb is.** The `--request` document is parsed
 * by `RegistryPublicationRequest` and read through the same uid ladder `acp
 * tool-call` reads its request through. The ledger is taken through the same
 * `openForWrite`: this verb shares the tool call's one writable open rather than
 * adding a second, so `L-B4B-11` stays literally true.
 */

/** A refusal that never became a publication. Shaped exactly like the tool call's. */
export class RegistryRefused extends Error {
  readonly code: ApiErrorCode;
  /** The field path a refusal names. Never the operator's value. */
  readonly at: string | null;

  constructor(code: ApiErrorCode, message: string, at: string | null = null) {
    super(message);
    this.name = "RegistryRefused";
    this.code = code;
    this.at = at;
  }
}

export interface RegistryVerbInput {
  readonly databasePath: string;
  readonly requestPath: string;
}

export interface RegistryVerbResult {
  readonly document: RegistryPublicationResponse;
}

/**
 * Publish one registry version and return the document to print.
 *
 * Everything the operator could have got wrong is refused before a ledger is
 * opened: an unreadable document and a request the schema refuses are
 * `BAD_REQUEST`. What the recorded state refuses is `WRITE_REFUSED`, carrying the
 * publication's word and, for a refusal of the ledger door, the door's own word.
 */
export function runRegistryVerb(input: RegistryVerbInput): RegistryVerbResult {
  const rawRequest = readOperatorDocument({ path: input.requestPath, at: "request", secret: false });

  const parsed = RegistryPublicationRequest.safeParse(rawRequest);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // The field path only: a value echoed into a diagnostic is configuration in a
    // terminal log.
    // A key the strict object does not declare is an issue at the root, and names
    // the request itself.
    const at = issue === undefined || issue.path.length === 0 ? "request" : "request." + issue.path.join(".");
    throw new RegistryRefused("BAD_REQUEST", "the request document is not a valid registry publication", at);
  }
  const request = parsed.data;

  const ledger = openForWrite(input.databasePath);
  try {
    const outcome = publishRegistryDocument({
      ledger,
      request: {
        documentKind: request.documentKind,
        documentId: request.documentId,
        documentVersion: request.documentVersion,
        parentDocumentVersion: request.parentDocumentVersion,
        effectiveFrom: request.effectiveFrom,
        recordedBy: request.recordedBy,
        payload: request.payload,
      },
      recordedAt: new Date().toISOString(),
    });

    if (!outcome.ok) {
      throw new RegistryRefused(
        "WRITE_REFUSED",
        "the registry publication was refused: " + outcome.reason + (outcome.word === null ? "" : " " + outcome.word),
        outcome.at,
      );
    }

    return {
      document: RegistryPublicationResponse.parse({
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        replayed: outcome.replayed,
        sequence: outcome.sequence,
        document: {
          documentKind: outcome.document.documentKind,
          documentId: outcome.document.documentId,
          documentVersion: outcome.document.documentVersion,
          parentDocumentVersion: outcome.document.parentDocumentVersion,
          contentDigest: outcome.document.contentDigest,
          effectiveFrom: outcome.document.effectiveFrom,
          recordedBy: outcome.document.recordedBy,
          recordedAt: outcome.document.recordedAt,
          eventId: outcome.document.eventId,
        },
      }),
    };
  } finally {
    ledger.close();
  }
}
