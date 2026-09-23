import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { CONTRACT_VERSION } from "@acp/contracts";

import {
  DOCUMENT_KINDS,
  GENESIS_SHA256,
  PUBLISHABLE_DOCUMENT_KINDS,
  REGISTRY_PUBLICATION_REFUSALS,
  REGISTRY_PUBLICATION_UUID_NAMESPACE,
  canonicalJsonStringify,
  chainDigest,
  openLedger,
  publishRegistryDocument,
  registryPublicationEventId,
  registryPublicationIdempotencyKey,
  type Ledger,
  type RegistryPublicationFields,
  type RegistryPublicationOutcome,
} from "../../src/index.js";

/**
 * Evidence for registry publication (P-15 escalón R, ADR 0104).
 *
 * The orchestration is asserted over a real ledger, because what it promises is
 * about what the stream holds: a version appended once, a retry answered by the
 * row that exists, a version recorded otherwise refused by the field that differs,
 * and every refusal of the ledger door carried through by its field and its word,
 * with nothing appended. The CLI's suite drives the same through the real verb.
 *
 * The digest is recomputed here from the payload's canonical JSON with
 * `node:crypto`, never with the publication's own helper; the version 5 vectors
 * were derived with an independent implementation (Python's `uuid.uuid5`).
 */

const AT = "2026-09-20T10:00:00.000Z";
const LATER = "2026-09-20T11:00:00.000Z";
const RULES_FROM = "2026-09-01T00:00:00.000Z";
const RULES_LATER = "2026-10-01T00:00:00.000Z";
const OWNER = "claude/opus/coordinator/01";
const OTHER_OWNER = "kimi/k3/coordinator/01";
const MODEL = "claude-opus-5@2026-06-01";
const OTHER_MODEL = "gpt-6@2026-07-01";
const ROUTING = "routing:GLOBAL:implementer:0";
const CATALOG = "catalog-claude";

const roots: string[] = [];
const ledgers: Ledger[] = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      /* closed by the test */
    }
  }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temporaryLedger(): Ledger {
  const dir = mkdtempSync(join(tmpdir(), "acp-registry-publication-"));
  roots.push(dir);
  const ledger = openLedger(join(dir, "ledger.sqlite"));
  ledgers.push(ledger);
  return ledger;
}

function digestOf(payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJsonStringify(payload), "utf8").digest("hex");
}

function modelVersionPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "claude",
    model: "claude-opus-5",
    release: "2026-06-01",
    status: "ACTIVE",
    contextTokens: 200000,
    policyVersion: "2026.09.0",
    deprecatedAt: null,
    eligibleRoles: ["implementer"],
    transports: ["CLI_SUBSCRIPTION"],
    ...overrides,
  };
}

function interval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "claude",
    modelVersionId: MODEL,
    transportKind: "CLI_SUBSCRIPTION",
    tokenClass: "input",
    currency: "USD",
    effectiveFrom: "2026-06-01T00:00:00.000Z",
    effectiveTo: null,
    pricePerMillionNanos: 15_000_000_000,
    ...overrides,
  };
}

/** One interval per token class, as the first task's catalog carries (PC-R1). */
function catalogPayload(): Record<string, unknown> {
  return {
    intervals: [
      interval({ tokenClass: "input", pricePerMillionNanos: 15_000_000_000 }),
      interval({ tokenClass: "output", pricePerMillionNanos: 75_000_000_000 }),
      interval({ tokenClass: "cache_read", pricePerMillionNanos: 1_500_000_000 }),
      interval({ tokenClass: "cache_write", pricePerMillionNanos: 18_750_000_000 }),
    ],
  };
}

function request(overrides: Partial<RegistryPublicationFields> = {}): RegistryPublicationFields {
  return {
    documentKind: "MODEL_VERSION",
    documentId: MODEL,
    documentVersion: 1,
    parentDocumentVersion: null,
    effectiveFrom: RULES_FROM,
    recordedBy: OWNER,
    payload: modelVersionPayload(),
    ...overrides,
  };
}

function routingRequest(overrides: Partial<RegistryPublicationFields> = {}): RegistryPublicationFields {
  return request({
    documentKind: "ROUTING_ASSIGNMENT_GLOBAL",
    documentId: ROUTING,
    payload: { role: "implementer", slot: 0, provider: "claude", modelVersionId: MODEL, fallbacks: [] },
    ...overrides,
  });
}

function catalogRequest(overrides: Partial<RegistryPublicationFields> = {}): RegistryPublicationFields {
  return request({ documentKind: "PRICE_TABLE", documentId: CATALOG, payload: catalogPayload(), ...overrides });
}

function publish(ledger: Ledger, fields: RegistryPublicationFields, recordedAt = AT): RegistryPublicationOutcome {
  return publishRegistryDocument({ ledger, request: fields, recordedAt });
}

function published(outcome: RegistryPublicationOutcome): RegistryPublicationOutcome & { ok: true } {
  if (!outcome.ok) throw new Error("expected a publication, got " + outcome.reason + " at " + outcome.at);
  return outcome;
}

function refused(outcome: RegistryPublicationOutcome): { reason: string; at: string; word: string | null } {
  if (outcome.ok) throw new Error("expected a refusal, got a publication");
  return { reason: outcome.reason, at: outcome.at, word: outcome.word };
}

/** Everything a publication could move: the registry head, its rows and the three read models. */
function footprint(ledger: Ledger): unknown {
  const raw = new Database(ledger.path, { readonly: true });
  try {
    const read = (sql: string): unknown => raw.prepare(sql).all();
    return {
      meta: read("SELECT key, value FROM ledger_meta WHERE key LIKE 'registry_%' ORDER BY key"),
      rows: read("SELECT sequence, event_sha256 FROM registry_events ORDER BY sequence"),
      models: read("SELECT * FROM model_version_read_model ORDER BY model_version_id"),
      routing: read("SELECT * FROM routing_assignment_read_model ORDER BY assignment_id"),
      prices: read("SELECT * FROM price_interval_read_model ORDER BY catalog_document_id, catalog_version, token_class"),
      watermarks: read("SELECT * FROM projection_watermark WHERE source_stream = 'registry_events' ORDER BY projection_name"),
    };
  } finally {
    raw.close();
  }
}

/** The three documents the first task needs, published in order. */
function seedFirstTask(ledger: Ledger): void {
  published(publish(ledger, request()));
  published(publish(ledger, routingRequest()));
  published(publish(ledger, catalogRequest()));
}

describe("the derivations are the door's, and pinned", () => {
  it("PC-R4: the digest is the payload's canonical JSON, the key one per version, the id a version 5 UUID", () => {
    const ledger = temporaryLedger();
    published(publish(ledger, request()));
    const outcome = published(publish(ledger, catalogRequest()));
    expect(outcome.document.contentDigest).toBe(digestOf(catalogPayload()));
    expect(outcome.record.idempotencyKey).toBe("registry/" + CATALOG + "/1");
    expect(outcome.record.eventId).toBe("7c4a701f-2d9c-50bc-bcc8-a9456ee22dfd");
    expect(outcome.record.document.contractVersion).toBe(CONTRACT_VERSION);
    expect(outcome.record.document.occurredAt).toBe(AT);
    expect(outcome.record.document.recordedAt).toBe(AT);
  });

  it("pins the namespace and the vectors, derived independently", () => {
    expect(REGISTRY_PUBLICATION_UUID_NAMESPACE).toBe("2f704b2b-1dc7-40df-b428-95feb11010de");
    expect(registryPublicationIdempotencyKey(MODEL, 1)).toBe("registry/" + MODEL + "/1");
    expect(registryPublicationEventId(MODEL, 1)).toBe("cf0a45a5-4b51-5a54-95b3-ffde06aea222");
    expect(registryPublicationEventId(ROUTING, 2)).toBe("061335fa-ba0c-56f8-914e-440ae5ee1305");
    expect(registryPublicationEventId(CATALOG, 1)).toBe("7c4a701f-2d9c-50bc-bcc8-a9456ee22dfd");
  });

  it("closes its vocabularies: three publishable kinds, four refusals, sorted", () => {
    expect([...PUBLISHABLE_DOCUMENT_KINDS]).toEqual(["MODEL_VERSION", "PRICE_TABLE", "ROUTING_ASSIGNMENT_GLOBAL"]);
    expect([...REGISTRY_PUBLICATION_REFUSALS]).toEqual([...REGISTRY_PUBLICATION_REFUSALS].sort());
    expect(REGISTRY_PUBLICATION_REFUSALS).toHaveLength(4);
  });
});

describe("a first task's registry, published through one door (P-15/R)", () => {
  it("PC-R1: a model version, its GLOBAL slot and a covering catalog land exactly as sent, verify and rebuild", () => {
    const ledger = temporaryLedger();
    seedFirstTask(ledger);

    const model = ledger.getModelVersion(MODEL).modelVersion;
    expect(model?.row).toMatchObject({ modelVersionId: MODEL, provider: "claude", status: "ACTIVE", contextTokens: 200000 });
    expect(model?.eligibleRoles).toEqual(["implementer"]);
    expect(model?.transports).toEqual(["CLI_SUBSCRIPTION"]);
    const assignment = ledger.getGlobalRoutingAssignment({ role: "implementer", slot: 0 });
    expect(assignment.assignment).toMatchObject({ modelVersionId: MODEL, provider: "claude" });
    const prices = ledger.readPriceIntervals({ catalogDocumentId: CATALOG, catalogVersion: 1 });
    expect(prices.map((row) => [row.tokenClass, row.pricePerMillionNanos, row.currency, row.effectiveTo])).toEqual([
      ["cache_read", 1_500_000_000, "USD", null],
      ["cache_write", 18_750_000_000, "USD", null],
      ["input", 15_000_000_000, "USD", null],
      ["output", 75_000_000_000, "USD", null],
    ]);
    expect(ledger.getVigentCatalogPin(CATALOG, "2026-09-12T09:00:00.000Z")).toEqual({ catalogDocumentId: CATALOG, catalogVersion: 1 });
    expect(ledger.verifyIntegrity().problems).toEqual([]);

    const before = footprint(ledger);
    ledger.rebuildReadModel();
    expect(footprint(ledger)).toEqual(before);
    expect(ledger.verifyIntegrity().problems).toEqual([]);
  });

  it("PC-R2: an exact retry with another clock and another author is a replay, and nothing is appended", () => {
    const ledger = temporaryLedger();
    seedFirstTask(ledger);
    const before = footprint(ledger);
    for (const fields of [request(), routingRequest(), catalogRequest()]) {
      const first = ledger.getRegistryDocumentVersion(fields.documentId, 1);
      const again = published(publish(ledger, { ...fields, recordedBy: OTHER_OWNER }, LATER));
      expect(again.replayed).toBe(true);
      expect(again.sequence).toBe(first?.sequence);
      expect(again.document.recordedAt).toBe(AT);
      expect(again.document.recordedBy).toBe(OWNER);
    }
    expect(footprint(ledger)).toEqual(before);
  });

  it("PC-R3: a second catalog version, later, is admitted, and the version in force turns at its instant", () => {
    const ledger = temporaryLedger();
    seedFirstTask(ledger);
    const second = published(
      publish(ledger, catalogRequest({ documentVersion: 2, parentDocumentVersion: 1, effectiveFrom: RULES_LATER, payload: { intervals: [interval({ pricePerMillionNanos: 12_000_000_000 })] } })),
    );
    expect(second.replayed).toBe(false);
    expect(ledger.getVigentCatalogPin(CATALOG, "2026-09-30T23:59:59.999Z")).toEqual({ catalogDocumentId: CATALOG, catalogVersion: 1 });
    expect(ledger.getVigentCatalogPin(CATALOG, RULES_LATER)).toEqual({ catalogDocumentId: CATALOG, catalogVersion: 2 });
  });
});

describe("what the door refuses, it refuses by name and appends nothing", () => {
  it("N-R1: every kind outside the three is not publishable", () => {
    const ledger = temporaryLedger();
    const before = footprint(ledger);
    const others = DOCUMENT_KINDS.filter((kind) => !(PUBLISHABLE_DOCUMENT_KINDS as readonly string[]).includes(kind));
    expect(others).toHaveLength(11);
    for (const kind of [...others, "NOT_A_KIND"]) {
      expect({ kind, refusal: refused(publish(ledger, request({ documentKind: kind, documentId: "doc-" + kind.toLowerCase() }))) }).toEqual({
        kind,
        refusal: { reason: "REGISTRY_KIND_NOT_PUBLISHABLE", at: "documentKind", word: null },
      });
    }
    expect(footprint(ledger)).toEqual(before);
  });

  it("N-R2: the same version with another payload, parent, instant or kind is a conflict naming the field, never a new version", () => {
    const ledger = temporaryLedger();
    seedFirstTask(ledger);
    published(publish(ledger, catalogRequest({ documentVersion: 2, parentDocumentVersion: 1, effectiveFrom: RULES_LATER })));
    const before = footprint(ledger);
    const cases: readonly (readonly [RegistryPublicationFields, string])[] = [
      [catalogRequest({ payload: { intervals: [interval({ pricePerMillionNanos: 1 })] } }), "contentDigest"],
      [catalogRequest({ documentVersion: 2, parentDocumentVersion: null, effectiveFrom: RULES_LATER }), "parentDocumentVersion"],
      [catalogRequest({ effectiveFrom: RULES_LATER }), "effectiveFrom"],
      [request({ documentKind: "PRICE_TABLE", documentId: MODEL }), "documentKind"],
    ];
    for (const [fields, at] of cases) {
      expect(refused(publish(ledger, fields, LATER))).toEqual({ reason: "REGISTRY_VERSION_CONFLICT", at, word: null });
    }
    expect(footprint(ledger)).toEqual(before);
  });

  it("N-R2, pre-R history: a version recorded with a placeholder digest conflicts at contentDigest when republished", () => {
    const ledger = temporaryLedger();
    const path = ledger.path;
    ledger.close();
    // A version written before this door, whose digest is no function of its
    // payload: planted on the chain, as the ledger door no longer admits it.
    plantPreRVersion(path, catalogRequest({ documentKind: "MODEL_VERSION", documentId: MODEL, payload: modelVersionPayload() }), "1".repeat(64));
    const reopened = openLedger(path);
    ledgers.push(reopened);
    const before = footprint(reopened);
    expect(refused(publish(reopened, request()))).toEqual({ reason: "REGISTRY_VERSION_CONFLICT", at: "contentDigest", word: null });
    expect(footprint(reopened)).toEqual(before);
  });

  it("N-R3 and N-R4: a second catalog version at an instant already taken is refused; another catalog at that instant is not", () => {
    const ledger = temporaryLedger();
    seedFirstTask(ledger);
    const before = footprint(ledger);
    expect(refused(publish(ledger, catalogRequest({ documentVersion: 2, parentDocumentVersion: 1 })))).toEqual({
      reason: "REGISTRY_DOCUMENT_REFUSED",
      at: "effectiveFrom",
      word: "REGISTRY_EFFECTIVE_FROM_TAKEN",
    });
    expect(footprint(ledger)).toEqual(before);
    expect(published(publish(ledger, catalogRequest({ documentId: "catalog-other" }))).replayed).toBe(false);
  });

  it("N-R5: an interval naming an unregistered model version, or one registered under another provider, is the door's word", () => {
    const ledger = temporaryLedger();
    published(publish(ledger, request()));
    const before = footprint(ledger);
    expect(refused(publish(ledger, catalogRequest({ payload: { intervals: [interval({ modelVersionId: OTHER_MODEL })] } })))).toEqual({
      reason: "REGISTRY_DOCUMENT_REFUSED",
      at: "payload.intervals[0].modelVersionId",
      word: "MODEL_VERSION_UNKNOWN",
    });
    expect(refused(publish(ledger, catalogRequest({ payload: { intervals: [interval({ provider: "openai" })] } })))).toEqual({
      reason: "REGISTRY_DOCUMENT_REFUSED",
      at: "payload.intervals[0].provider",
      word: "MODEL_VERSION_PROVIDER_MISMATCH",
    });
    expect(footprint(ledger)).toEqual(before);
  });

  it("N-R6: a GLOBAL assignment naming an unknown or a non-eligible model version is the door's word", () => {
    const ledger = temporaryLedger();
    published(publish(ledger, request()));
    const before = footprint(ledger);
    expect(refused(publish(ledger, routingRequest({ payload: { role: "implementer", slot: 0, provider: "claude", modelVersionId: OTHER_MODEL, fallbacks: [] } })))).toMatchObject({
      reason: "REGISTRY_DOCUMENT_REFUSED",
      word: "MODEL_VERSION_UNKNOWN",
    });
    expect(
      refused(publish(ledger, routingRequest({ documentId: "routing:GLOBAL:reviewer:0", payload: { role: "reviewer", slot: 0, provider: "claude", modelVersionId: MODEL, fallbacks: [] } }))),
    ).toMatchObject({ reason: "REGISTRY_DOCUMENT_REFUSED", word: "ROLE_NOT_ELIGIBLE" });
    expect(footprint(ledger)).toEqual(before);
  });

  it("N-R7: a currency that is not three upper-case letters is refused", () => {
    const ledger = temporaryLedger();
    published(publish(ledger, request()));
    const before = footprint(ledger);
    for (const currency of ["usd", "US", "EURO", "123", ""]) {
      expect(refused(publish(ledger, catalogRequest({ payload: { intervals: [interval({ currency })] } }))), currency).toEqual({
        reason: "REGISTRY_DOCUMENT_REFUSED",
        at: "payload.intervals[0].currency",
        word: null,
      });
    }
    expect(footprint(ledger)).toEqual(before);
  });

  it("N-R8: every interval rule the door holds is refused by its words, and adjacency is admitted", () => {
    const ledger = temporaryLedger();
    published(publish(ledger, request()));
    const before = footprint(ledger);
    const cases: readonly (readonly [readonly Record<string, unknown>[], string, string | null])[] = [
      [[interval({ effectiveTo: "2026-06-01T00:00:00.000Z" })], "payload.intervals[0].effectiveTo", null],
      [[interval({ effectiveTo: "2026-05-01T00:00:00.000Z" })], "payload.intervals[0].effectiveTo", null],
      [[interval({ effectiveFrom: "2026-06-01T00:00:00Z" })], "payload.intervals[0].effectiveFrom", null],
      [[interval({ effectiveFrom: "2026-06-01T02:00:00.000+02:00" })], "payload.intervals[0].effectiveFrom", null],
      [[interval({ effectiveFrom: "2026-02-30T00:00:00.000Z" })], "payload.intervals[0].effectiveFrom", null],
      [[interval({ pricePerMillionNanos: -1 })], "payload.intervals[0].pricePerMillionNanos", null],
      [[interval({ pricePerMillionNanos: 1.5 })], "payload.intervals[0].pricePerMillionNanos", null],
      [[interval({ pricePerMillionNanos: 2 ** 53 })], "payload.intervals[0].pricePerMillionNanos", null],
      [[interval({ pricePerMillionNanos: "100" })], "payload.intervals[0].pricePerMillionNanos", null],
      [[interval({ transportKind: "CARRIER_PIGEON" })], "payload.intervals[0].transportKind", null],
      [[interval({ tokenClass: "thinking" })], "payload.intervals[0].tokenClass", null],
      [[interval(), interval()], "payload.intervals[1]", "PRICE_INTERVAL_DUPLICATE"],
      [
        [interval({ effectiveTo: "2026-08-01T00:00:00.000Z" }), interval({ effectiveFrom: "2026-07-01T00:00:00.000Z" })],
        "payload.intervals[1]",
        "PRICE_INTERVAL_OVERLAP",
      ],
    ];
    for (const [intervals, at, word] of cases) {
      expect(refused(publish(ledger, catalogRequest({ payload: { intervals } }))), at).toEqual({ reason: "REGISTRY_DOCUMENT_REFUSED", at, word });
    }
    expect(footprint(ledger)).toEqual(before);
    // Adjacent intervals, [a, b) then [b, c), do not meet.
    const adjacent = published(
      publish(ledger, catalogRequest({ payload: { intervals: [interval({ effectiveTo: "2026-07-01T00:00:00.000Z" }), interval({ effectiveFrom: "2026-07-01T00:00:00.000Z" })] } })),
    );
    expect(adjacent.replayed).toBe(false);
  });

  it("N-R9: a missing price, currency or end is refused, never defaulted, and no zero is stored", () => {
    const ledger = temporaryLedger();
    published(publish(ledger, request()));
    const before = footprint(ledger);
    for (const key of ["pricePerMillionNanos", "currency", "effectiveTo"]) {
      const partial = interval();
      Reflect.deleteProperty(partial, key);
      expect(refused(publish(ledger, catalogRequest({ payload: { intervals: [partial] } }))), key).toEqual({
        reason: "REGISTRY_DOCUMENT_REFUSED",
        at: "payload.intervals[0]." + key,
        word: null,
      });
    }
    expect(footprint(ledger)).toEqual(before);
    const raw = new Database(ledger.path, { readonly: true });
    try {
      expect(raw.prepare("SELECT COUNT(*) AS n FROM price_interval_read_model WHERE price_per_million_nanos = 0").get()).toEqual({ n: 0 });
    } finally {
      raw.close();
    }
  });

  it("a payload with no canonical JSON form has no digest, and is refused at payload", () => {
    const ledger = temporaryLedger();
    const before = footprint(ledger);
    expect(refused(publish(ledger, request({ payload: { ...modelVersionPayload(), contextTokens: Number.NaN } })))).toEqual({
      reason: "REGISTRY_DOCUMENT_REFUSED",
      at: "payload",
      word: null,
    });
    expect(footprint(ledger)).toEqual(before);
  });
});

describe("N-R10: every MODEL_VERSION payload key, absent, null, invalid and valid, against an oracle", () => {
  it("refuses at the key exactly the cells the oracle refuses, and admits the rest", () => {
    const ABSENT = Symbol("absent");
    const invalid: Record<string, unknown> = {
      provider: 7,
      model: "",
      release: 7,
      status: "WIZARD",
      contextTokens: -1,
      policyVersion: 7,
      deprecatedAt: "yesterday",
      eligibleRoles: ["wizard"],
      transports: ["CARRIER_PIGEON"],
    };
    const valid = modelVersionPayload();
    // The oracle: a key is required and holds its valid value; `deprecatedAt` is null
    // exactly while the version is ACTIVE, so null is its valid value here.
    const admits = (key: string, value: unknown): boolean =>
      value !== ABSENT && (key === "deprecatedAt" ? value === null : value !== null && value === valid[key]);
    let admitted = 0;
    let refusedCells = 0;
    for (const key of Object.keys(valid)) {
      for (const value of [ABSENT, null, invalid[key], valid[key]]) {
        const ledger = temporaryLedger();
        const payload: Record<string, unknown> = { ...valid };
        if (value === ABSENT) Reflect.deleteProperty(payload, key);
        else payload[key] = value;
        const cell = key + "=" + (value === ABSENT ? "<absent>" : JSON.stringify(value));
        const outcome = publish(ledger, request({ payload }));
        if (admits(key, value)) {
          expect({ cell, ok: outcome.ok }).toEqual({ cell, ok: true });
          admitted += 1;
        } else {
          expect({ cell, ok: outcome.ok }).toEqual({ cell, ok: false });
          const refusal = refused(outcome);
          expect({ cell, reason: refusal.reason, key: refusal.at.startsWith("payload." + key) }).toEqual({
            cell,
            reason: "REGISTRY_DOCUMENT_REFUSED",
            key: true,
          });
          refusedCells += 1;
        }
      }
    }
    // Nine valid cells, plus deprecatedAt's null cell, which is its valid value.
    expect(admitted).toBe(10);
    expect(refusedCells).toBe(26);
  });
});

describe("a form problem is refused as one, before any comparison (post-audit C1)", () => {
  it("an offset or no-millis instant, a fractional parent, an empty author and an empty id are form refusals at their field, even with a version recorded", () => {
    const ledger = temporaryLedger();
    published(publish(ledger, request()));
    published(publish(ledger, request({ documentVersion: 2, parentDocumentVersion: 1, payload: modelVersionPayload({ contextTokens: 100000 }) })));
    const before = footprint(ledger);
    const cases: readonly (readonly [RegistryPublicationFields, string])[] = [
      // Each would differ from the recorded version at this very field, and before
      // the door's parse ran first each was answered REGISTRY_VERSION_CONFLICT there.
      [request({ effectiveFrom: "2026-09-01T02:00:00.000+02:00" }), "effectiveFrom"],
      [request({ effectiveFrom: "2026-09-01T00:00:00Z" }), "effectiveFrom"],
      [request({ documentVersion: 2, parentDocumentVersion: 1.5, payload: modelVersionPayload({ contextTokens: 100000 }) }), "parentDocumentVersion"],
      [request({ documentVersion: 2, parentDocumentVersion: 0.5, payload: modelVersionPayload({ contextTokens: 100000 }) }), "parentDocumentVersion"],
      // Otherwise an exact replay of version 1: the author is excluded from the
      // comparison, so only the parse stands between it and an answered success.
      [request({ recordedBy: "" }), "recordedBy"],
      [request({ documentId: "" }), "documentId"],
    ];
    for (const [fields, at] of cases) {
      const outcome = publish(ledger, fields, LATER);
      expect({ at, ok: outcome.ok }).toEqual({ at, ok: false });
      expect(refused(outcome), at).toEqual({ reason: "REGISTRY_DOCUMENT_REFUSED", at, word: null });
    }
    expect(footprint(ledger)).toEqual(before);
  });
});

describe("N-R13: a lost race is re-read and decided again, and the stream holds one version", () => {
  /**
   * A second connection to the same file publishes between this door's read and its
   * append: the loser meets the winner's row under the derived key. Two connections
   * in one process, not two processes; SQLite serializes them the same way, and
   * the door's re-read is what is under test.
   */
  function racing(ledger: Ledger, winner: RegistryPublicationFields | ((other: Ledger) => void)): Ledger {
    let raced = false;
    return new Proxy(ledger, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (property === "appendRegistryEvent" && !raced) {
          return (...args: unknown[]): unknown => {
            raced = true;
            const other = openLedger(target.path);
            try {
              if (typeof winner === "function") winner(other);
              else published(publishRegistryDocument({ ledger: other, request: winner, recordedAt: AT }));
            } finally {
              other.close();
            }
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  it("the same version won by another writer is a replay; another version won is a conflict at contentDigest", () => {
    const ledger = temporaryLedger();
    const same = published(publishRegistryDocument({ ledger: racing(ledger, request()), request: request(), recordedAt: LATER }));
    expect(same.replayed).toBe(true);
    expect(same.document.recordedAt).toBe(AT);

    const other = temporaryLedger();
    const lost = refused(
      publishRegistryDocument({
        ledger: racing(other, request({ payload: modelVersionPayload({ contextTokens: 100000 }) })),
        request: request(),
        recordedAt: LATER,
      }),
    );
    expect(lost).toEqual({ reason: "REGISTRY_VERSION_CONFLICT", at: "contentDigest", word: null });

    for (const handle of [ledger, other]) {
      const raw = new Database(handle.path, { readonly: true });
      try {
        expect(raw.prepare("SELECT COUNT(*) AS n FROM registry_events WHERE document_id = ?").get(MODEL)).toEqual({ n: 1 });
      } finally {
        raw.close();
      }
    }
  });

  it("a winner under another key reaches the lineage refusal, and is still re-read: a replay, or a conflict", () => {
    // A writer that is not this door (a suite, or history) records the same
    // coordinate under its own key and event id, so the loser's append meets the
    // lineage check rather than the key: the LedgerValidationError branch.
    const underAnotherKey =
      (payload: Record<string, unknown>) =>
      (other: Ledger): void => {
        other.appendRegistryEvent({
          contractVersion: CONTRACT_VERSION,
          eventId: "0000bbbb-0000-4000-8000-000000000001",
          idempotencyKey: MODEL + "/1",
          documentKind: "MODEL_VERSION",
          documentId: MODEL,
          documentVersion: 1,
          parentDocumentVersion: null,
          contentDigest: digestOf(payload),
          recordedBy: OTHER_OWNER,
          effectiveFrom: RULES_FROM,
          occurredAt: AT,
          recordedAt: AT,
          payload,
        });
      };
    const same = temporaryLedger();
    const replay = published(publishRegistryDocument({ ledger: racing(same, underAnotherKey(modelVersionPayload())), request: request(), recordedAt: LATER }));
    expect(replay.replayed).toBe(true);
    expect(replay.record.idempotencyKey).toBe(MODEL + "/1");

    const other = temporaryLedger();
    const lost = refused(
      publishRegistryDocument({
        ledger: racing(other, underAnotherKey(modelVersionPayload({ contextTokens: 100000 }))),
        request: request(),
        recordedAt: LATER,
      }),
    );
    expect(lost).toEqual({ reason: "REGISTRY_VERSION_CONFLICT", at: "contentDigest", word: null });
    for (const handle of [same, other]) {
      const raw = new Database(handle.path, { readonly: true });
      try {
        expect(raw.prepare("SELECT COUNT(*) AS n FROM registry_events WHERE document_id = ?").get(MODEL)).toEqual({ n: 1 });
      } finally {
        raw.close();
      }
    }
  });
});

/**
 * Plant one registry version on the chain, past the door: the history a ledger
 * written before P-15/R may hold. The row, the head and the count move together,
 * so the stream verifies as a chain; the read models are not written.
 */
function plantPreRVersion(path: string, fields: RegistryPublicationFields, contentDigest: string): void {
  const raw = new Database(path);
  try {
    const meta = new Map(
      (raw.prepare("SELECT key, value FROM ledger_meta WHERE key LIKE 'registry_%'").all() as { key: string; value: string }[]).map((row) => [
        row.key,
        row.value,
      ]),
    );
    const previous = meta.get("registry_head_sequence") === "0" ? GENESIS_SHA256 : (meta.get("registry_head_event_sha256") ?? "");
    const body = {
      contractVersion: "2.8.0",
      eventId: "0000aaaa-0000-4000-8000-000000000001",
      idempotencyKey: fields.documentId + "/" + String(fields.documentVersion),
      documentKind: fields.documentKind,
      documentId: fields.documentId,
      documentVersion: fields.documentVersion,
      parentDocumentVersion: fields.parentDocumentVersion,
      contentDigest,
      recordedBy: fields.recordedBy,
      effectiveFrom: fields.effectiveFrom,
      occurredAt: fields.effectiveFrom,
      recordedAt: fields.effectiveFrom,
      payload: fields.payload,
    };
    const canonical = canonicalJsonStringify(body);
    const eventSha256 = chainDigest(previous, canonical);
    const sequence = Number(meta.get("registry_head_sequence") ?? "0") + 1;
    raw
      .prepare(
        "INSERT INTO registry_events (event_id, idempotency_key, subject_kind, document_kind, document_id, document_version, " +
          "content_digest, parent_document_version, recorded_by, effective_from, occurred_at, recorded_at, " +
          "contract_version, event_json, previous_sha256, event_sha256) " +
          "VALUES (?, ?, 'DOCUMENT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        body.eventId,
        body.idempotencyKey,
        body.documentKind,
        body.documentId,
        body.documentVersion,
        body.contentDigest,
        body.parentDocumentVersion,
        body.recordedBy,
        body.effectiveFrom,
        body.occurredAt,
        body.recordedAt,
        body.contractVersion,
        canonical,
        previous,
        eventSha256,
      );
    const set = raw.prepare("UPDATE ledger_meta SET value = ? WHERE key = ?");
    set.run(String(sequence), "registry_head_sequence");
    set.run(eventSha256, "registry_head_event_sha256");
    set.run(String(Number(meta.get("registry_event_count") ?? "0") + 1), "registry_event_count");
  } finally {
    raw.close();
  }
}
