import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AccountActionWriteResponse,
  AccountActionsResponse,
  AccountsResponse,
  ApiError,
  LEDGER_CONTRACT_VERSION,
} from "@acp/protocol";
import { openLedger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { foldEffectiveState as foldAccountState } from "@acp/accounts";
import { readAccountActions } from "@acp/runtime";

import { foldEffectiveState } from "../../src/account-actions/index.js";
import { readAccounts } from "../../src/accounts/index.js";
import { buildServer } from "../../src/build-server/index.js";

/**
 * Evidence for the account-actions door and the authority law.
 *
 * The law is the thing worth drilling: which of two sources governs an
 * account's state, and — the case a reader would otherwise assume backwards —
 * that a later owner-file edit does **not** reclaim authority from a recorded
 * action.
 */

const roots: string[] = [];
const TOKEN = "p8-8g-actions-" + "t".repeat(30);
const AUTH = { authorization: "Bearer " + TOKEN };
const ACTOR = "kimi/k3/coordinator/01";
const ACCOUNT = "acct-primary";

/**
 * The instant this suite pins through the server's seam (P8-8G causal).
 *
 * Same pin as the accounts suite, for a quieter reason: nothing here asserted
 * on the reset, so when the fixture's `2026-09-01T00:00:00.000Z` fell into the
 * past this suite stayed green while every response it read resolved that
 * reset to `UNKNOWN`. Green, and no longer saying what the fixture said. A
 * pinned instant keeps the declaration meaning what it claims.
 */
const PINNED_NOW = "2026-08-31T12:00:00.000Z";

function root(): string {
  const created = realpathSync(mkdtempSync(join(tmpdir(), "acp-actions-")));
  roots.push(created);
  return created;
}

function tokenFile(dir: string): string {
  const path = join(dir, "write.token");
  writeFileSync(path, TOKEN + "\n", "utf8");
  chmodSync(path, 0o600);
  return path;
}

function account(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    accountId: ACCOUNT,
    provider: "anthropic",
    alias: "primary",
    authMode: "PREAUTHENTICATED_PROFILE",
    authProfileRef: "profile://acp-primary",
    credentialRef: null,
    plan: "max",
    enabledModels: ["opus"],
    knownLimits: { weekly: 1_000_000 },
    resetSchedule: {
      kind: "DECLARED",
      nextResetAt: "2026-09-01T00:00:00.000Z",
      timezone: "UTC",
      confidence: "HIGH",
    },
    quotaEstimate: {
      remainingRatio: 0.5,
      estimatedTokensRemaining: 500_000,
      estimatedAt: "2026-08-31T12:00:00.000Z",
      confidence: "MEDIUM",
    },
    lastHealthProbe: null,
    lastClassifiedError: null,
    status: "AVAILABLE",
    isolatedConfigRoot: "/tmp/acp-primary",
    contextSwitchCost: { estimatedTokens: 1000, estimatedSeconds: 10 },
    ...overrides,
  };
}

function ownerFile(dir: string, accounts: readonly unknown[]): string {
  const path = join(dir, "accounts.local.json");
  writeFileSync(path, JSON.stringify({ contractVersion: LEDGER_CONTRACT_VERSION, accounts }), "utf8");
  chmodSync(path, 0o600);
  return path;
}

function ledgerPath(dir: string): string {
  const nested = join(dir, "ledger");
  mkdirSync(nested, { recursive: true });
  const path = join(nested, "acp.sqlite3");
  openLedger(path).close();
  return path;
}

interface Harness {
  readonly dir: string;
  readonly app: ReturnType<typeof buildServer>;
  readonly accountsPath: string;
}

function harness(accounts: readonly unknown[] = [account()]): Harness {
  const dir = root();
  const accountsPath = ownerFile(dir, accounts);
  return {
    dir,
    accountsPath,
    app: buildServer({
      ledgerPath: ledgerPath(dir),
      accountsFilePath: accountsPath,
      writeBearerPath: tokenFile(dir),
      now: () => PINNED_NOW,
    }),
  };
}

const actionsUrl = (accountId = ACCOUNT): string => "/api/v1/accounts/" + accountId + "/actions";

async function act(
  app: Harness["app"],
  body: Record<string, unknown>,
  accountId = ACCOUNT,
): Promise<ReturnType<typeof app.inject> extends Promise<infer R> ? R : never> {
  return await app.inject({ method: "POST", url: actionsUrl(accountId), payload: body, headers: AUTH });
}

const drain = { action: "DRAIN", setState: null, note: "quota exhausted", actor: ACTOR };

afterEach(() => {
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // already gone
    }
  }
});

describe("the fold: which source governs", () => {
  it("is the owner file while no action exists", () => {
    expect(foldEffectiveState("AVAILABLE", [])).toEqual({
      effectiveState: "AVAILABLE",
      stateSource: "OWNER_FILE",
      lastAction: null,
    });
  });

  it("is the ledger once any action exists, and the newest one wins", async () => {
    const { app } = harness();
    const first = await act(app, drain);
    expect(first.statusCode).toBe(200);

    const read = await app.inject({ method: "GET", url: "/api/v1/accounts" });
    const body = AccountsResponse.parse(read.json());
    if (body.status !== "READY") throw new Error("expected READY");
    const item = body.items[0];
    if (item === undefined) throw new Error("expected one account");

    // The file still says AVAILABLE; the ledger says DRAINING; the effective
    // state is the ledger's, and both are published so the disagreement is
    // visible rather than hidden behind one number.
    expect(item.state).toBe("AVAILABLE");
    expect(item.effectiveState).toBe("DRAINING");
    expect(item.stateSource).toBe("OPERATOR_ACTION");
    expect(item.lastAction).toEqual({ action: "DRAIN", at: expect.any(String), by: ACTOR });

    // A second action, and the newest wins.
    const second = await act(app, { action: "ACCOUNT_READY", setState: null, note: null, actor: ACTOR });
    expect(second.statusCode).toBe(200);
    const after = AccountsResponse.parse(
      (await app.inject({ method: "GET", url: "/api/v1/accounts" })).json(),
    );
    if (after.status !== "READY") throw new Error("expected READY");
    expect(after.items[0]?.effectiveState).toBe("AVAILABLE");
    expect(after.items[0]?.lastAction?.action).toBe("ACCOUNT_READY");
    await app.close();
  });

  it("does NOT let a later owner-file edit override an earlier action", async () => {
    // The silent case, spoken. An operator drains on Monday and edits the
    // file on Tuesday; the file cannot know about Monday, so letting it win
    // would erase a recorded decision with an unrecorded one.
    const { app, dir, accountsPath } = harness();
    expect((await act(app, drain)).statusCode).toBe(200);

    // The file now claims a different state outright.
    writeFileSync(
      accountsPath,
      JSON.stringify({
        contractVersion: LEDGER_CONTRACT_VERSION,
        accounts: [account({ status: "COOLDOWN" })],
      }),
      "utf8",
    );
    chmodSync(accountsPath, 0o600);
    void dir;

    const body = AccountsResponse.parse(
      (await app.inject({ method: "GET", url: "/api/v1/accounts" })).json(),
    );
    if (body.status !== "READY") throw new Error("expected READY");
    // The file's new claim is published as `state`; it does not govern.
    expect(body.items[0]?.state).toBe("COOLDOWN");
    expect(body.items[0]?.effectiveState).toBe("DRAINING");
    expect(body.items[0]?.stateSource).toBe("OPERATOR_ACTION");
    await app.close();
  });

  it("returns authority to the file's value only through an explicit act", async () => {
    const { app } = harness();
    await act(app, drain);
    // The correction path is an act, recorded like any other — not an edit.
    const corrected = await act(app, {
      action: "ACCOUNT_READY",
      setState: null,
      note: "back in service",
      actor: ACTOR,
    });
    expect(corrected.statusCode).toBe(200);
    const body = AccountsResponse.parse(
      (await app.inject({ method: "GET", url: "/api/v1/accounts" })).json(),
    );
    if (body.status !== "READY") throw new Error("expected READY");
    expect(body.items[0]?.effectiveState).toBe("AVAILABLE");
    // Still the ledger's answer, not the file's — the state coincides, the
    // authority does not.
    expect(body.items[0]?.stateSource).toBe("OPERATOR_ACTION");
    await app.close();
  });

  it("re-folds to the same state across a restart", async () => {
    const { app, dir } = harness();
    await act(app, drain);
    await app.close();

    // A second server over the same ledger and file: the fold is pure over
    // both, so a restart cannot change the answer.
    const restarted = buildServer({
      ledgerPath: join(dir, "ledger", "acp.sqlite3"),
      accountsFilePath: join(dir, "accounts.local.json"),
      writeBearerPath: join(dir, "write.token"),
      now: () => PINNED_NOW,
    });
    const body = AccountsResponse.parse(
      (await restarted.inject({ method: "GET", url: "/api/v1/accounts" })).json(),
    );
    if (body.status !== "READY") throw new Error("expected READY");
    expect(body.items[0]?.effectiveState).toBe("DRAINING");
    await restarted.close();
  });
});

describe("each action records with its receipt", () => {
  it("records all four verbs, each with the state its verb implies", async () => {
    const { app } = harness();
    const expected: readonly (readonly [Record<string, unknown>, string])[] = [
      [{ action: "DRAIN", setState: null, note: null, actor: ACTOR }, "DRAINING"],
      [{ action: "ACCOUNT_READY", setState: null, note: null, actor: ACTOR }, "AVAILABLE"],
      [{ action: "REAUTH_REQUIRED", setState: null, note: null, actor: ACTOR }, "AUTH_REQUIRED"],
      [{ action: "OWNER_OVERRIDE", setState: "COOLDOWN", note: null, actor: ACTOR }, "COOLDOWN"],
    ];

    let version = 0;
    for (const [body, state] of expected) {
      version += 1;
      const response = await act(app, body);
      expect({ action: body["action"], status: response.statusCode }).toEqual({
        action: body["action"],
        status: 200,
      });
      const parsed = AccountActionWriteResponse.parse(response.json());
      // The receipt announces its coordinates (N2): the sequence and the
      // per-account version, so a caller can name what it just recorded.
      expect(parsed.action.resultingState).toBe(state);
      expect(parsed.action.version).toBe(version);
      expect(parsed.action.sequence).toBeGreaterThan(0);
    }
    await app.close();
  });

  it("serves the history through the door's GET arm, oldest first", async () => {
    const { app } = harness();
    await act(app, drain);
    await act(app, { action: "ACCOUNT_READY", setState: null, note: null, actor: ACTOR });

    const response = await app.inject({ method: "GET", url: actionsUrl() });
    expect(response.statusCode).toBe(200);
    const body = AccountActionsResponse.parse(response.json());
    expect(body.count).toBe(2);
    expect(body.items.map((item) => item.action)).toEqual(["DRAIN", "ACCOUNT_READY"]);
    expect(body.items.map((item) => item.version)).toEqual([1, 2]);
    await app.close();
  });
});

describe("the refusals, each by name", () => {
  it("UNKNOWN_ACCOUNT for an id the owner file does not name", async () => {
    const { app } = harness();
    const response = await act(app, drain, "acct-nonexistent");
    expect(response.statusCode).toBe(409);
    const error = ApiError.parse(response.json());
    expect(error.error.code).toBe("WRITE_REFUSED");
    expect(error.error.message).toContain("UNKNOWN_ACCOUNT");
    await app.close();
  });

  it("ALREADY_IN_STATE rather than a silent success", async () => {
    const { app } = harness();
    // The account is AVAILABLE by the file; ACCOUNT_READY would set it to
    // AVAILABLE. Recording that would put "nothing happened" in a log.
    const response = await act(app, {
      action: "ACCOUNT_READY",
      setState: null,
      note: null,
      actor: ACTOR,
    });
    expect(response.statusCode).toBe(409);
    expect(ApiError.parse(response.json()).error.message).toContain("ALREADY_IN_STATE");
    await app.close();
  });

  it("ACCOUNTS_UNAVAILABLE when there is no baseline to act against", async () => {
    const dir = root();
    const app = buildServer({
      ledgerPath: ledgerPath(dir),
      writeBearerPath: tokenFile(dir),
      now: () => PINNED_NOW,
    });
    const response = await act(app, drain);
    expect(response.statusCode).toBe(409);
    expect(ApiError.parse(response.json()).error.message).toContain("ACCOUNTS_UNAVAILABLE");
    await app.close();
  });

  it("refuses the two mismatched override shapes at the contract", async () => {
    const { app } = harness();
    // An override that names no state, and a non-override that names one.
    const noState = await act(app, {
      action: "OWNER_OVERRIDE",
      setState: null,
      note: null,
      actor: ACTOR,
    });
    expect(noState.statusCode).toBe(400);
    expect(ApiError.parse(noState.json()).error.detail).toBe("setState");

    const extraState = await act(app, {
      action: "DRAIN",
      setState: "COOLDOWN",
      note: null,
      actor: ACTOR,
    });
    expect(extraState.statusCode).toBe(400);
    await app.close();
  });
});

describe("the note is free text, and rides the guards", () => {
  it("refuses a credential-shaped note and echoes none of it", async () => {
    const { app } = harness();
    const planted = "sk-ant-api03-" + "A".repeat(80);
    const response = await act(app, {
      action: "DRAIN",
      setState: null,
      note: planted,
      actor: ACTOR,
    });
    expect(response.statusCode).toBe(400);
    // Refused, and the value never travels: the detail is a field path.
    expect(response.body).not.toContain(planted);
    expect(response.body).not.toContain("sk-ant");
    await app.close();
  });
});

describe("the second door inherits the bearer by where it is registered", () => {
  it("answers 401 with no credential and 403 when none is configured", async () => {
    const { app } = harness();
    const noHeader = await app.inject({ method: "POST", url: actionsUrl(), payload: drain });
    expect(noHeader.statusCode).toBe(401);
    await app.close();

    const dir = root();
    const unarmed = buildServer({
      ledgerPath: ledgerPath(dir),
      accountsFilePath: ownerFile(dir, [account()]),
      now: () => PINNED_NOW,
    });
    const unconfigured = await unarmed.inject({ method: "POST", url: actionsUrl(), payload: drain });
    expect(unconfigured.statusCode).toBe(403);
    expect(ApiError.parse(unconfigured.json()).error.code).toBe("WRITE_BEARER_UNCONFIGURED");
    await unarmed.close();
  });

  it("leaves the GET arm unguarded, like every other read", async () => {
    const { app } = harness();
    const response = await app.inject({ method: "GET", url: actionsUrl() });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("refuses every other verb with 405, ahead of the guard", async () => {
    const { app } = harness();
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({ method, url: actionsUrl() });
      expect({ method, status: response.statusCode }).toEqual({ method, status: 405 });
    }
    await app.close();
  });
});

/**
 * V2-B1e: the fold moved to `@acp/accounts`, and this door delegates to it.
 *
 * What these two describes drill is the *move*, not the law — the law's own
 * precedence matrix lives in the accounts suite now, where it can be exercised
 * over a pure function with no server and no ledger. Here the question is
 * narrower and is the one a relocation actually risks: does this module still
 * answer exactly what it answered before, at both of its call sites.
 */
describe("P7: the delegation changed nothing this door publishes", () => {
  it("the wrapper agrees with the domain fold, row for row, over every shape", () => {
    // Byte-identical in the only sense a structural equality can be: the
    // wrapper's whole remaining job is unwrapping `row.event`, so the two must
    // agree on the empty history, on one row, and on the newest-wins case.
    const rowFor = (version: number, action: string, resultingState: string, at: string) => ({
      sequence: version,
      eventId: "b1e00000-0000-4000-8000-" + String(version).padStart(12, "0"),
      event: {
        contractVersion: LEDGER_CONTRACT_VERSION,
        eventId: "b1e00000-0000-4000-8000-" + String(version).padStart(12, "0"),
        accountId: ACCOUNT,
        version,
        idempotencyKey: ACCOUNT + "/1/action." + String(version),
        action,
        resultingState,
        actor: ACTOR,
        note: null,
        occurredAt: at,
        recordedAt: at,
      },
    });

    const histories = [
      [],
      [rowFor(1, "DRAIN", "DRAINING", "2026-08-31T01:00:00.000Z")],
      [
        rowFor(1, "DRAIN", "DRAINING", "2026-08-31T01:00:00.000Z"),
        rowFor(2, "ACCOUNT_READY", "AVAILABLE", "2026-08-31T02:00:00.000Z"),
      ],
      [rowFor(1, "OWNER_OVERRIDE", "COOLDOWN", "2026-08-31T03:00:00.000Z")],
    ] as never[][];

    for (const fileState of ["AVAILABLE", "DRAINING", "AUTH_REQUIRED"] as const) {
      for (const history of histories) {
        expect(foldEffectiveState(fileState, history)).toEqual(
          foldAccountState(
            fileState,
            history.map((row: { readonly event: never }) => row.event),
          ),
        );
      }
    }
  });

  it("still publishes the pre-move answers for the empty and the recorded case", () => {
    // The literal expectations this suite has always held, restated against
    // the delegating wrapper so the move has to keep them true.
    expect(foldEffectiveState("AVAILABLE", [])).toEqual({
      effectiveState: "AVAILABLE",
      stateSource: "OWNER_FILE",
      lastAction: null,
    });
  });

  it("both call sites still fold: the write door refuses a no-op it read through the wrapper", async () => {
    // `recordAccountAction`'s own call site, exercised end to end. A second
    // DRAIN is a no-op only because the wrapper folded the first one, so this
    // refusal is evidence that the write door's fold still runs.
    const { app } = harness();
    expect((await act(app, drain)).statusCode).toBe(200);

    const repeat = await act(app, drain);
    expect(repeat.statusCode).toBe(409);
    const refusal = ApiError.parse(repeat.json());
    expect(refusal.error.code).toBe("WRITE_REFUSED");
    expect(refusal.error.message).toContain("ALREADY_IN_STATE");
    await app.close();
  });
});

describe("N6: the read model with no action source still reports file-only", () => {
  it("names the owner file as the source and reports no action, exactly as before", () => {
    // `actionsFor` absent means "file only" — the honest answer when nobody
    // asked. The delegation must not have turned an unasked question into a
    // fold over an empty history that claims an operator acted.
    const dir = root();
    const path = ownerFile(dir, [account({ status: "COOLDOWN" })]);
    const outcome = readAccounts(path, PINNED_NOW);
    if (!outcome.ok) throw new Error("expected the owner file to load");
    const item = outcome.items[0];
    if (item === undefined) throw new Error("expected one account");

    expect(item.state).toBe("COOLDOWN");
    expect(item.effectiveState).toBe("COOLDOWN");
    expect(item.stateSource).toBe("OWNER_FILE");
    expect(item.lastAction).toBeNull();
  });

  it("N7: no new API error code reaches the wire from this door", async () => {
    // The refusal vocabulary is closed and did not move with the fold. A
    // relocation that introduced a code would show up here rather than in a
    // reader's surprise.
    const { app } = harness();
    const unknown = await act(app, drain, "acct-nonexistent");
    expect(unknown.statusCode).toBe(409);
    const error = ApiError.parse(unknown.json());
    expect(error.error.code).toBe("WRITE_REFUSED");
    expect(error.error.message).toContain("UNKNOWN_ACCOUNT");
    await app.close();
  });
});


describe("P6: the read model and the CLI's election mechanism agree over one ledger", () => {
  it("publishes exactly what the election's own reader and fold produce", async () => {
    // The gateway half of the parity pair. The CLI half drives the real `run()`
    // verb in the CLI suite; here the real HTTP read model is driven over a
    // ledger written by the real HTTP write door, and the CLI's own election
    // mechanism -- `readAccountActions` then `foldEffectiveState`, the exact
    // pair `runSubmission` runs -- is applied to that same ledger in the same
    // test. Both doors now fold through one implementation, so a disagreement
    // would have to show up here.
    const { app, dir } = harness();
    expect((await act(app, drain)).statusCode).toBe(200);

    const published = AccountsResponse.parse(
      (await app.inject({ method: "GET", url: "/api/v1/accounts" })).json(),
    );
    if (published.status !== "READY") throw new Error("expected READY");
    const item = published.items[0];
    if (item === undefined) throw new Error("expected one account");

    // The election's mechanism, over the same ledger the door just wrote.
    const ledger = openLedger(ledgerPath(dir), { readOnly: true });
    try {
      const read = readAccountActions(ledger, ACCOUNT);
      if (!read.ok) throw new Error("expected the reader to succeed");
      const folded = foldAccountState("AVAILABLE", read.history);

      expect(folded.effectiveState).toBe(item.effectiveState);
      expect(folded.stateSource).toBe(item.stateSource);
      expect(folded.lastAction?.action).toBe(item.lastAction?.action);

      // And the substance: the file still says AVAILABLE, both say DRAINING.
      expect(item.state).toBe("AVAILABLE");
      expect(folded.effectiveState).toBe("DRAINING");
    } finally {
      ledger.close();
    }

    await app.close();
  });

  it("still agrees after the newest row restores the account", async () => {
    const { app, dir } = harness();
    expect((await act(app, drain)).statusCode).toBe(200);
    expect(
      (await act(app, { action: "ACCOUNT_READY", setState: null, note: null, actor: ACTOR })).statusCode,
    ).toBe(200);

    const published = AccountsResponse.parse(
      (await app.inject({ method: "GET", url: "/api/v1/accounts" })).json(),
    );
    if (published.status !== "READY") throw new Error("expected READY");

    const ledger = openLedger(ledgerPath(dir), { readOnly: true });
    try {
      const read = readAccountActions(ledger, ACCOUNT);
      if (!read.ok) throw new Error("expected the reader to succeed");
      expect(foldAccountState("AVAILABLE", read.history).effectiveState).toBe(
        published.items[0]?.effectiveState,
      );
      expect(published.items[0]?.effectiveState).toBe("AVAILABLE");
    } finally {
      ledger.close();
    }

    await app.close();
  });
});

void randomUUID;
