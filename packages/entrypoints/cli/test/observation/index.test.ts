import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LedgerEventRecord } from "@acp/ledger";
import { openLedger } from "@acp/ledger";
import { LEDGER_CONTRACT_VERSION } from "@acp/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { toTimelineItem } from "../../src/observation/index.js";

/**
 * The CLI door's own fixture for the payload-key projection (P-12, structure
 * §4.1 :205-206).
 *
 * Independent from the gateway's: the payloads, the oracles and the mapper
 * under test are this door's alone, and nothing here calls the gateway's
 * mapper or the projection module directly — the agreement between the doors
 * is the projection's property to hold, not this file's to assert by wiring
 * both sides to one helper. Expected arrays are written by hand in code-unit
 * order, never derived from the code under test.
 *
 * `@acp/observation` resolves through its manifest to the built output (the
 * cli vitest project aliases the kernel and persistence packages to source
 * and no more), so a run without a preceding `tsc --build` proves nothing.
 */

const AT = "2026-09-11T12:00:00.000Z";
const EMITTED_BY = "kimi/k3/coordinator/01";

const temporaryDirectories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "acp-p12-cli-observation-"));
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
  const taskId = randomUUID();
  const attempt = 1;
  const transitionId = "observe";
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: randomUUID(),
    taskId,
    attempt,
    transitionId,
    idempotencyKey: taskId + "/" + String(attempt) + "/" + transitionId,
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
 * The record the ledger actually stored, so the CLI's mapper is exercised on
 * what a reader of the ledger would receive rather than on a hand-built shape.
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

describe("the CLI's timeline item projects payload keys", () => {
  it("lists an unsorted payload in canonical code-unit order", () => {
    const record = recordWith({ quince: 1, "42": 2, kiwi: 3, Mango: 4, apricot: 5 });
    expect(toTimelineItem(record).payloadKeys).toEqual(["42", "Mango", "apricot", "kiwi", "quince"]);
  });

  it("orders characters that sort differently between locales by code unit", () => {
    // Hand-written UTF-16 code-unit order: digits, uppercase, lowercase,
    // Latin-1 supplements. A locale collator disagrees; the projection must
    // not.
    const record = recordWith({ øre: 1, "7": 2, Tango: 3, "15": 4, sierra: 5, Romeo: 6, papa: 7 });
    expect(toTimelineItem(record).payloadKeys).toEqual(["15", "7", "Romeo", "Tango", "papa", "sierra", "øre"]);
  });

  it("caps a pathological payload at the ceiling, dropping the sorted tail", () => {
    const keys = Array.from({ length: 70 }, (_, index) => "k" + String(index).padStart(2, "0"));
    const record = recordWith(Object.fromEntries(keys.map((key) => [key, true])));
    // Hand-written: k00 through k63. Before P-12 the CLI already answered
    // this way; the point of the fixture is that the answer is now the
    // projection's, so a regression in either door shows up here in bytes.
    expect(toTimelineItem(record).payloadKeys).toEqual([
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
