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

import { describe, expect, it } from "vitest";

import { ACCOUNT_ACTIONS_MAX } from "@acp/accounts";
import { ACCOUNT_ACTION_STATE } from "@acp/contracts";
import type { AccountAction, AccountActionEvent, AccountStatus } from "@acp/contracts";

import { readAccountActions } from "../../src/actions/index.js";
import type { ActionEventSource } from "../../src/actions/index.js";

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
