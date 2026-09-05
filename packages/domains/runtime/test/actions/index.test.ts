/**
 * Evidence for the operator-action reader (V2-B1e).
 *
 * Driven through the structural `ActionEventSource` rather than a real ledger,
 * for the reason its usage sibling gives: the ceiling case needs more rows than
 * it is reasonable to append, and what is under test is the reader and its
 * refusal, not SQLite. The ledger's own account filtering and `version ASC`
 * ordering are drilled where they live, in the ledger suite.
 *
 * Nothing here spawns a process, opens a socket or touches a provider (N9).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";

import { ACCOUNT_ACTIONS_MAX } from "@acp/accounts";
import { ACCOUNT_ACTION_STATE } from "@acp/contracts";
import type { AccountAction, AccountActionEvent, AccountStatus } from "@acp/contracts";

import {
  ACCOUNT_WRITE_REFUSALS,
  readAccountActions,
  recordAccountAction,
} from "../../src/actions/index.js";
import type { AccountActionWrite, ActionEventSource } from "../../src/actions/index.js";

const ACCOUNT = "acct-b1e-reader";
const OTHER = "acct-b1e-other";
const ACTOR = "claude/opus/implementer/01";

/**
 * One action row, shaped as the ledger projects it.
 *
 * Cast rather than parsed: this suite is about the reader's paging-free
 * exhaustiveness and its ceiling, and the ceiling case builds ten thousand and
 * one of these. The contract's own admission is drilled in the accounts suite,
 * over parsed fixtures.
 */
function row(
  version: number,
  action: AccountAction = "DRAIN",
  accountId = ACCOUNT,
  setState: AccountStatus | null = null,
): { readonly event: AccountActionEvent } {
  const resultingState = ACCOUNT_ACTION_STATE[action] ?? setState ?? "COOLDOWN";
  return {
    event: {
      accountId,
      version,
      action,
      resultingState,
      actor: ACTOR,
      note: null,
      recordedAt: "2026-09-01T00:00:00.000Z",
      occurredAt: "2026-09-01T00:00:00.000Z",
    } as AccountActionEvent,
  };
}

/** A source that answers with fixed rows, and records what it was asked. */
function sourceOf(
  rows: readonly { readonly event: AccountActionEvent }[],
): { readonly source: ActionEventSource; readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    source: {
      listAccountActions(accountId: string) {
        asked.push(accountId);
        return rows.filter((entry) => entry.event.accountId === accountId);
      },
    },
  };
}

describe("P5: the reader returns the whole history, in the ledger's order", () => {
  it("hands back every row for the requested account, oldest first, unmodified", () => {
    const { source, asked } = sourceOf([
      row(1, "DRAIN"),
      row(2, "ACCOUNT_READY"),
      row(3, "REAUTH_REQUIRED"),
    ]);

    const read = readAccountActions(source, ACCOUNT);
    if (!read.ok) throw new Error("expected the read to succeed");

    // The order is the ledger's `version ASC`, carried through untouched: the
    // fold's `at(-1)` is only the newest action because of it, so a reader that
    // re-sorted would be deciding something it has no standing to decide.
    expect(read.history.map((event) => event.version)).toEqual([1, 2, 3]);
    expect(read.history.map((event) => event.action)).toEqual([
      "DRAIN",
      "ACCOUNT_READY",
      "REAUTH_REQUIRED",
    ]);
    expect(asked).toEqual([ACCOUNT]);
  });

  it("unwraps the row and returns the event, which is what the fold reads", () => {
    const { source } = sourceOf([row(1, "DRAIN")]);
    const read = readAccountActions(source, ACCOUNT);
    if (!read.ok) throw new Error("expected the read to succeed");
    expect(read.history[0]).toEqual(
      expect.objectContaining({ action: "DRAIN", resultingState: "DRAINING", version: 1 }),
    );
  });

  it("an empty history is a success, not a refusal", () => {
    // The distinction the whole packet turns on: no rows means "the owner file
    // stands", which is a fact. A read that could not complete is not that
    // fact, and must never be coerced into it.
    const { source } = sourceOf([]);
    const read = readAccountActions(source, ACCOUNT);
    expect(read).toEqual({ ok: true, history: [] });
  });

  it("asks the source exactly once, for exactly the account it was given", () => {
    // Unpaginated by construction: one call, no cursor, no second query. There
    // is no partial-history state to guard because there is no paging.
    const { source, asked } = sourceOf([row(1), row(2)]);
    readAccountActions(source, ACCOUNT);
    expect(asked).toEqual([ACCOUNT]);
  });
});

describe("N5: another account's actions never reach this account's fold", () => {
  it("returns only the requested account's rows", () => {
    const { source } = sourceOf([
      row(1, "DRAIN", OTHER),
      row(1, "ACCOUNT_READY", ACCOUNT),
      row(2, "DRAIN", OTHER),
    ]);

    const read = readAccountActions(source, ACCOUNT);
    if (!read.ok) throw new Error("expected the read to succeed");
    expect(read.history).toHaveLength(1);
    expect(read.history[0]?.accountId).toBe(ACCOUNT);
    expect(read.history[0]?.action).toBe("ACCOUNT_READY");
  });

  it("a drain recorded against another account leaves this one with an empty history", () => {
    const { source } = sourceOf([row(1, "DRAIN", OTHER)]);
    expect(readAccountActions(source, ACCOUNT)).toEqual({ ok: true, history: [] });
  });
});

describe("N1: above the ceiling the reader refuses, and folds no prefix", () => {
  it("refuses ACTION_HISTORY_EXCEEDED one row above the ceiling", () => {
    const rows = Array.from({ length: ACCOUNT_ACTIONS_MAX + 1 }, (_, index) => row(index + 1));
    const { source } = sourceOf(rows);

    const read = readAccountActions(source, ACCOUNT);
    expect(read).toEqual({ ok: false, reason: "ACTION_HISTORY_EXCEEDED", at: "history" });
  });

  it("admits exactly the ceiling, so the threshold is the stated number", () => {
    const rows = Array.from({ length: ACCOUNT_ACTIONS_MAX }, (_, index) => row(index + 1));
    const { source } = sourceOf(rows);

    const read = readAccountActions(source, ACCOUNT);
    if (!read.ok) throw new Error("expected the ceiling itself to be admitted");
    expect(read.history).toHaveLength(ACCOUNT_ACTIONS_MAX);
  });

  it("returns no history at all above the ceiling; no older state can resurface", () => {
    // The refusal exists because a prefix would answer with a stale state. The
    // newest row here says AVAILABLE and every earlier one says DRAINING, so a
    // reader that truncated the newest end would report a drained account as
    // available -- the exact widening the ceiling is a refusal to avoid.
    const rows = [
      ...Array.from({ length: ACCOUNT_ACTIONS_MAX }, (_, index) => row(index + 1, "DRAIN")),
      row(ACCOUNT_ACTIONS_MAX + 1, "ACCOUNT_READY"),
    ];
    const { source } = sourceOf(rows);

    const read = readAccountActions(source, ACCOUNT);
    expect(read.ok).toBe(false);
    expect(read).not.toHaveProperty("history");
  });

  it("the refusal names a field, never a value out of the ledger", () => {
    const rows = Array.from({ length: ACCOUNT_ACTIONS_MAX + 1 }, (_, index) => row(index + 1));
    const { source } = sourceOf(rows);
    const read = readAccountActions(source, ACCOUNT);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.at).toBe("history");
    expect(read.at).not.toContain(ACCOUNT);
    expect(read.at).not.toContain(ACTOR);
  });
});

// ---------------------------------------------------------------------------
// V2-B1f/F4c — the write half of the seam
// ---------------------------------------------------------------------------

/**
 * Evidence for the door that records what an account's state became.
 *
 * The write cases use a **real** `mkdtemp` ledger, because what is under test
 * here is the append, the monotone version, the idempotency key and the
 * conflict — all of them the database's own behaviour. The reader's cases
 * above stay structural, for the reason they always gave.
 *
 * Nothing here spawns a process, opens a socket, touches a provider or reads
 * an owner file: **the baseline arrives as a value**, which is the whole point
 * of where this door now lives.
 */

const F4C_ACTOR = "claude/opus/implementer/01";
const F4C_AT = "2026-09-05T12:00:00.000Z";

const writeRoots: string[] = [];

afterEach(() => {
  for (const path of writeRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function writableLedger(): Ledger {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "acp-f4c-"));
  writeRoots.push(root);
  return openLedger(join(root, "ledger.sqlite"));
}

function writeInput(
  ledger: Ledger,
  overrides: Partial<AccountActionWrite> = {},
): AccountActionWrite {
  return {
    source: ledger,
    accountId: ACCOUNT,
    baseline: "AVAILABLE",
    action: "DRAIN",
    setState: null,
    actor: F4C_ACTOR,
    note: null,
    recordedAt: F4C_AT,
    eventId: randomUUID(),
    ...overrides,
  };
}

describe("F4c P1/P2: the verb governs the state, and the newest row wins", () => {
  it("P1: records DRAIN and REAUTH_REQUIRED with a monotone version and its own key", () => {
    const ledger = writableLedger();
    const first = recordAccountAction(writeInput(ledger));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.record.event.resultingState).toBe("DRAINING");
    expect(first.record.event.version).toBe(1);
    expect(first.record.event.idempotencyKey).toBe(ACCOUNT + "/1/action.1");
    expect(first.inserted).toBe(true);

    const second = recordAccountAction(writeInput(ledger, { action: "REAUTH_REQUIRED" }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.record.event.resultingState).toBe("AUTH_REQUIRED");
    // Monotone from the folded history, never from a counter this module keeps.
    expect(second.record.event.version).toBe(2);
    expect(second.record.event.idempotencyKey).toBe(ACCOUNT + "/1/action.2");
  });

  it("P2: ACCOUNT_READY restores an account, and the fold starts from the baseline", () => {
    const ledger = writableLedger();
    expect(recordAccountAction(writeInput(ledger)).ok).toBe(true);
    const restored = recordAccountAction(writeInput(ledger, { action: "ACCOUNT_READY" }));
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.record.event.resultingState).toBe("AVAILABLE");

    // And the ledger owns the lifecycle from the first action on: a baseline
    // that disagrees does not resurrect the file's answer.
    const noop = recordAccountAction(writeInput(ledger, { action: "ACCOUNT_READY", baseline: "DRAINING" }));
    expect(noop.ok).toBe(false);
    if (noop.ok) return;
    expect(noop.reason).toBe("ALREADY_IN_STATE");
  });
});

describe("F4c P3: the operator's own override is untouched", () => {
  it("records OWNER_OVERRIDE with the state the operator supplied, including the two no verb implies", () => {
    // The pre-existing operator path, neither widened nor narrowed. The two
    // statuses no verb implies are reachable **only** this way — because a
    // human asked — and never from a machine decision.
    for (const setState of ["EXHAUSTED", "COOLDOWN", "AVAILABLE"] as const) {
      const ledger = writableLedger();
      const outcome = recordAccountAction(
        writeInput(ledger, { action: "OWNER_OVERRIDE", setState, baseline: "DRAINING" }),
      );
      expect({ setState, ok: outcome.ok }).toEqual({ setState, ok: true });
      if (!outcome.ok) continue;
      expect(outcome.record.event.resultingState).toBe(setState);
      expect(outcome.record.event.action).toBe("OWNER_OVERRIDE");
    }
  });

  it("refuses an override that carries no state, as a belt to the contract's braces", () => {
    const ledger = writableLedger();
    const outcome = recordAccountAction(
      writeInput(ledger, { action: "OWNER_OVERRIDE", setState: null }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect({ reason: outcome.reason, at: outcome.at }).toEqual({
      reason: "UNKNOWN_ACCOUNT",
      at: "setState",
    });
    expect(ledger.listAccountActions(ACCOUNT)).toHaveLength(0);
  });
});

describe("F4c P4: the writer takes the baseline as a value and never opens a file", () => {
  it("folds from the value it was handed, and names no loader or owner file", () => {
    // The disposition this packet was ruled on: the admission ladder that
    // resolves an owner file — and the private refusal vocabulary it produces,
    // which reaches an HTTP payload — stays with the caller that owns it. Any
    // caller able to supply a baseline can record, including one forbidden the
    // file entirely.
    const ledger = writableLedger();
    const drained = recordAccountAction(writeInput(ledger, { baseline: "DRAINING" }));
    expect(drained.ok).toBe(false);
    if (drained.ok) return;
    expect(drained.reason).toBe("ALREADY_IN_STATE");

    const available = recordAccountAction(writeInput(ledger, { baseline: "AVAILABLE" }));
    expect(available.ok).toBe(true);

    const here = resolve(fileURLToPath(import.meta.url), "..");
    const source = readFileSync(join(here, "..", "..", "src", "actions", "index.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const forbidden of [
      "loadAccountsFile",
      "readAccounts",
      "accountsFilePath",
      "@acp/protocol",
      "@acp/gateway",
    ]) {
      expect({ forbidden, present: code.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });
});

describe("F4c P5/P6: the conflict, and the short-lived handle", () => {
  it("P5: two writers folding one version collide, and exactly one row lands", () => {
    const ledger = writableLedger();
    // Both fold version 0 and both build `action.1`; the loser is late, not
    // broken, and is refused by name rather than by an exception.
    const first = recordAccountAction(writeInput(ledger));
    const second = recordAccountAction({
      ...writeInput(ledger),
      // A source frozen at the pre-append history, which is what a racing
      // writer holds.
      source: {
        listAccountActions: () => [],
        path: ledger.path,
      },
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect({ reason: second.reason, at: second.at }).toEqual({
      reason: "WRITE_CONFLICT",
      at: "version",
    });
    expect(ledger.listAccountActions(ACCOUNT)).toHaveLength(1);
  });

  it("P6: the writable handle is closed on both the success and the refusal path", () => {
    // Observed rather than read off the source: a handle left open would keep
    // the database locked, and the next writer would fail. Three writes in a
    // row through one source prove each handle was released.
    const ledger = writableLedger();
    expect(recordAccountAction(writeInput(ledger)).ok).toBe(true);
    expect(recordAccountAction(writeInput(ledger, { action: "REAUTH_REQUIRED" })).ok).toBe(true);
    expect(recordAccountAction(writeInput(ledger, { action: "ACCOUNT_READY" })).ok).toBe(true);
    expect(ledger.listAccountActions(ACCOUNT)).toHaveLength(3);

    // And the refusal path releases it too: the no-op below opens nothing, and
    // a fourth write still succeeds afterwards.
    expect(recordAccountAction(writeInput(ledger, { action: "ACCOUNT_READY" })).ok).toBe(false);
    expect(recordAccountAction(writeInput(ledger, { action: "DRAIN" })).ok).toBe(true);
  });
});

describe("F4c N1-N4: what the door refuses, and how many doors there are", () => {
  it("N1: a no-op is refused by name, and nothing is appended", () => {
    const ledger = writableLedger();
    const outcome = recordAccountAction(writeInput(ledger, { action: "ACCOUNT_READY" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect({ reason: outcome.reason, at: outcome.at }).toEqual({
      reason: "ALREADY_IN_STATE",
      at: "AVAILABLE",
    });
    expect(ledger.listAccountActions(ACCOUNT)).toHaveLength(0);
  });

  it("N2: the verb still governs the state — the contract refuses a disagreeing row", () => {
    // The writer never builds a `resultingState` the verb does not imply, and
    // the ledger's own admission would refuse one if it did.
    for (const action of ["DRAIN", "REAUTH_REQUIRED", "ACCOUNT_READY"] as const) {
      const ledger = writableLedger();
      const outcome = recordAccountAction(
        // A `setState` is supplied and must be IGNORED for a verb that implies
        // its own state.
        writeInput(ledger, { action, setState: "EXHAUSTED", baseline: "COOLDOWN" }),
      );
      expect({ action, ok: outcome.ok }).toEqual({ action, ok: true });
      if (!outcome.ok) continue;
      expect({ action, state: outcome.record.event.resultingState }).toEqual({
        action,
        state: ACCOUNT_ACTION_STATE[action],
      });
    }
  });

  it("N3: no machine decision reaches EXHAUSTED or COOLDOWN", () => {
    // Asserted as a property of the vocabulary, not as prose: no verb implies
    // either state, so the only way to record one is an operator-supplied
    // override — which P3 exercises and which nothing here manufactures.
    const implied = Object.values(ACCOUNT_ACTION_STATE).filter((state) => state !== null);
    expect(implied).not.toContain("EXHAUSTED");
    expect(implied).not.toContain("COOLDOWN");

    const here = resolve(fileURLToPath(import.meta.url), "..");
    const source = readFileSync(join(here, "..", "..", "src", "actions", "index.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // The writer names neither status as a literal, and never manufactures the
    // override verb.
    for (const forbidden of ['"EXHAUSTED"', '"COOLDOWN"', '"OWNER_OVERRIDE"']) {
      expect({ forbidden, present: code.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it("N4: one door — appendAccountAction has exactly one source caller", () => {
    // Counted, not assumed. The fence law asserts the same thing over the whole
    // tree; this counts it where the door now lives.
    const here = resolve(fileURLToPath(import.meta.url), "..");
    const runtimeSource = readFileSync(join(here, "..", "..", "src", "actions", "index.ts"), "utf8");
    expect(runtimeSource.includes("appendAccountAction(")).toBe(true);

    const gateway = readFileSync(
      join(here, "..", "..", "..", "..", "entrypoints", "gateway", "src", "account-actions", "index.ts"),
      "utf8",
    );
    const gatewayCode = gateway.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // The wrapper delegates and no longer appends.
    expect(gatewayCode.includes("appendAccountAction")).toBe(false);
    expect(gatewayCode).toContain("recordAccountActionWrite");
  });

  it("N5: the refusal vocabulary is the ledger-side subset, closed at three", () => {
    expect([...ACCOUNT_WRITE_REFUSALS]).toEqual([
      "UNKNOWN_ACCOUNT",
      "ALREADY_IN_STATE",
      "WRITE_CONFLICT",
    ]);
    // A subset of the door's public four, so the wrapper returns what it gets
    // back unchanged — the two file-dependent refusals never cross the seam.
    expect(ACCOUNT_WRITE_REFUSALS).not.toContain("ACCOUNTS_UNAVAILABLE");
  });
});
