import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LedgerEventRecord } from "@acp/ledger";
import { openLedger } from "@acp/ledger";
import { MAX_PAYLOAD_KEYS } from "@acp/observation";
import { LEDGER_CONTRACT_VERSION, TimelineItem } from "@acp/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { timelineItem } from "../../src/mappers/index.js";

/**
 * The gateway door's own fixture for the payload-key projection (P-12,
 * structure §4.1 :205-206).
 *
 * Every expected array is written by hand in code-unit order, never derived
 * from the mapper or the projection: the suites this file complements sorted
 * both sides before comparing, which is the habit that let two divergent
 * implementations stay green for a phase. This fixture drives the gateway's
 * own `timelineItem` from a record read back out of a real disposable ledger
 * and never calls the CLI's mapper or compares one door against the other —
 * two calls to one helper agreeing with each other is not evidence.
 *
 * It runs against `dist/`, deliberately. The gateway vitest project aliases
 * the kernel and persistence packages to source and no more, so
 * `@acp/observation` resolves through its manifest to the built output; a run
 * without a preceding `tsc --build` proves nothing in either direction.
 */

const AT = "2026-09-11T12:00:00.000Z";
const TASK_ID = "5f5f5f5f-5f5f-4f5f-8f5f-5f5f5f5f5f0a";
const EMITTED_BY = "kimi/k3/coordinator/01";

const temporaryDirectories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "acp-p12-gateway-mappers-"));
  temporaryDirectories.push(directory);
  return join(directory, "control-plane.sqlite");
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

/** One candidate event carrying exactly the payload the fixture names. */
function makeEvent(payload: Record<string, unknown>): Record<string, unknown> {
  const attempt = 1;
  const transitionId = "observe";
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: randomUUID(),
    taskId: TASK_ID,
    attempt,
    transitionId,
    idempotencyKey: TASK_ID + "/" + String(attempt) + "/" + transitionId,
    type: "TASK_DISCOVERED",
    fromState: null,
    toState: "DISCOVERED",
    emittedBy: EMITTED_BY,
    occurredAt: AT,
    recordedAt: AT,
    correlationId: null,
    causationId: null,
    payload,
  };
}

/**
 * The record the ledger actually stored, so the mapper is exercised on what a
 * consumer would receive rather than on the builder's return value.
 */
function recordWith(payload: Record<string, unknown>): LedgerEventRecord {
  const path = temporaryDatabase();
  const ledger = openLedger(path);
  try {
    ledger.append(makeEvent(payload));
  } finally {
    ledger.close();
  }
  const reader = openLedger(path, { readOnly: true });
  try {
    const record = reader.listEvents({ limit: 1 }).events[0];
    if (record === undefined) throw new Error("the seeded event must read back out of the ledger");
    return record;
  } finally {
    reader.close();
  }
}

/** Every field but `payloadKeys` is identical across the two parses below. */
function timelineItemShape(keys: readonly string[]): Record<string, unknown> {
  return {
    sequence: 1,
    eventId: randomUUID(),
    taskId: randomUUID(),
    attempt: 1,
    transitionId: "observe",
    type: "TASK_DISCOVERED",
    fromState: null,
    toState: "DISCOVERED",
    emittedBy: EMITTED_BY,
    occurredAt: AT,
    recordedAt: AT,
    correlationId: null,
    causationId: null,
    previousSha256: "a".repeat(64),
    eventSha256: "b".repeat(64),
    payloadByteSize: 2,
    payloadKeys: keys,
  };
}

describe("the gateway's timeline item projects payload keys", () => {
  it("lists an unsorted payload in canonical code-unit order", () => {
    const record = recordWith({ zebra: 1, mango: 2, Apple: 3, "10": 4, banana: 5 });
    expect(timelineItem(record).payloadKeys).toEqual(["10", "Apple", "banana", "mango", "zebra"]);
  });

  it("orders characters that sort differently between locales by code unit", () => {
    // Hand-written UTF-16 code-unit order: digits, uppercase, lowercase,
    // Latin-1 supplements. Any locale-aware collation reorders this list,
    // which is the divergence the projection exists to end.
    const record = recordWith({ cherry: 1, "2": 2, äpfel: 3, "10": 4, Zebra: 5, banana: 6, Apple: 7, _under: 8 });
    expect(timelineItem(record).payloadKeys).toEqual([
      "10",
      "2",
      "Apple",
      "Zebra",
      "_under",
      "banana",
      "cherry",
      "äpfel",
    ]);
  });

  it("caps a pathological payload at the ceiling, dropping the sorted tail", () => {
    const keys = Array.from({ length: 70 }, (_, index) => "k" + String(index).padStart(2, "0"));
    const record = recordWith(Object.fromEntries(keys.map((key) => [key, true])));
    // Hand-written: k00 through k63, in that order. k64-k69 are past the
    // ceiling; the item still parses, which is the hole this packet closes —
    // previously the gateway answered in insertion order with no ceiling and
    // an over-sized payload broke the strict parse downstream.
    expect(timelineItem(record).payloadKeys).toEqual([
      "k00", "k01", "k02", "k03", "k04", "k05", "k06", "k07", "k08", "k09",
      "k10", "k11", "k12", "k13", "k14", "k15", "k16", "k17", "k18", "k19",
      "k20", "k21", "k22", "k23", "k24", "k25", "k26", "k27", "k28", "k29",
      "k30", "k31", "k32", "k33", "k34", "k35", "k36", "k37", "k38", "k39",
      "k40", "k41", "k42", "k43", "k44", "k45", "k46", "k47", "k48", "k49",
      "k50", "k51", "k52", "k53", "k54", "k55", "k56", "k57", "k58", "k59",
      "k60", "k61", "k62", "k63",
    ]);
  });
});

describe("the projection ceiling is tied to the contract empirically", () => {
  it("accepts exactly MAX_PAYLOAD_KEYS key names and refuses one more", () => {
    const atCeiling = Array.from({ length: MAX_PAYLOAD_KEYS }, (_, index) => "k" + String(index).padStart(3, "0"));
    const parsed = TimelineItem.safeParse(timelineItemShape(atCeiling));
    expect(parsed.success).toBe(true);

    const overCeiling = Array.from({ length: MAX_PAYLOAD_KEYS + 1 }, (_, index) => "k" + String(index).padStart(3, "0"));
    expect(TimelineItem.safeParse(timelineItemShape(overCeiling)).success).toBe(false);
  });
});
