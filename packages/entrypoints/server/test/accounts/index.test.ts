import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AccountsResponse,
  ACCOUNTS_UNAVAILABLE_REASONS,
  LEDGER_CONTRACT_VERSION,
} from "@acp/api-contracts";
import { openLedger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../../src/build-server/index.js";

/**
 * Evidence for the accounts read.
 *
 * Every case here drives a real server over a real file on disk, because the
 * whole surface is about what happens to files with particular permissions,
 * sizes and contents — a mocked loader would prove the mock.
 *
 * The owner file must be mode 0600 and owned by this uid: the loader refuses
 * anything else, so each fixture sets the mode explicitly and the READY case
 * would fail loudly if it did not.
 */

const roots: string[] = [];
const AT = "2026-08-31T12:00:00.000Z";

/**
 * The instant this suite pins through the server's seam (P8-8G causal).
 *
 * The fixture's declared reset stays the literal `2026-09-01T00:00:00.000Z`
 * it always was. What changed is that "now" is no longer whatever the wall
 * clock happens to say when the suite runs: it is this value, injected, and
 * it sits before that reset for good. The previous arrangement made the
 * assertion a deadline — it expired at 2026-09-01T00:00:00Z and turned a
 * `DECLARED` reset into `RESET_ALREADY_PASSED` — and a fixture that expires is
 * a fixture that was measuring the calendar rather than the code.
 */
const PINNED_NOW = "2026-08-31T12:00:00.000Z";

function temporaryRoot(): string {
  // Canonical, deliberately. On macOS `mkdtemp` hands back `/var/folders/…`
  // while the real path is `/private/var/folders/…`, and the loader refuses a
  // non-canonical path — correctly, since a symlinked owner file could point
  // somewhere none of its checks ever looked. Resolving here means these
  // fixtures exercise the rungs they mean to instead of all failing at that one.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acp-accounts-")));
  roots.push(root);
  return root;
}

/**
 * A real, created ledger.
 *
 * The accounts read now folds the action overlay (P8-8G packet 2), so it needs
 * an open ledger where before it needed none. That is the honest dependency:
 * answering "which source governs this account's state" requires reading the
 * action history, and returning file-only state when the history is
 * unreadable would publish an authority claim that might be wrong.
 */
function ledgerPath(root: string): string {
  const dir = join(root, "ledger");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "acp.sqlite3");
  openLedger(path).close();
  return path;
}

/** A valid account, with the two reference fields deliberately present. */
function account(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    // Read from the contract rather than hardcoded: a fixture pinning a stale
    // literal would fail the loader for the wrong reason.
    contractVersion: LEDGER_CONTRACT_VERSION,
    accountId: "acct-primary",
    provider: "anthropic",
    alias: "primary",
    authMode: "PREAUTHENTICATED_PROFILE",
    authProfileRef: "profile://acp-primary",
    credentialRef: null,
    plan: "max",
    enabledModels: ["opus", "sonnet"],
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
      estimatedAt: AT,
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

/** The document envelope the loader requires, around whatever the case needs. */
function ownerDocument(accounts: readonly unknown[]): Record<string, unknown> {
  return { contractVersion: LEDGER_CONTRACT_VERSION, accounts };
}

function writeOwnerFile(root: string, body: unknown, mode = 0o600): string {
  const path = join(root, "accounts.local.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body), "utf8");
  chmodSync(path, mode);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // the temp dir is already gone
    }
  }
});

async function get(root: string, accountsFilePath?: string): Promise<AccountsResponse> {
  const app = buildServer({ ledgerPath: ledgerPath(root), accountsFilePath, now: () => PINNED_NOW });
  const response = await app.inject({ method: "GET", url: "/api/v1/accounts" });
  expect(response.statusCode).toBe(200);
  const body = AccountsResponse.parse(response.json());
  await app.close();
  return body;
}

describe("GET /api/v1/accounts — READY", () => {
  it("serves the owner's accounts with quota and reset confidence", async () => {
    const root = temporaryRoot();
    const path = writeOwnerFile(root, ownerDocument([account()]));
    const body = await get(root, path);

    expect(body.status).toBe("READY");
    if (body.status !== "READY") throw new Error("expected READY");
    expect(body.count).toBe(1);

    const item = body.items[0];
    if (item === undefined) throw new Error("expected one account");
    expect(item.accountId).toBe("acct-primary");
    expect(item.provider).toBe("anthropic");
    expect(item.models).toEqual(["opus", "sonnet"]);
    expect(item.state).toBe("AVAILABLE");
    // Reset is declared in the fixture, so the source says so rather than
    // claiming an observation nobody made.
    expect(item.reset.source).toBe("DECLARED");
    expect(item.reset.nextResetAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("omits the reference fields entirely — not nulled, not redacted", async () => {
    const root = temporaryRoot();
    const path = writeOwnerFile(root, ownerDocument([account()]));
    const body = await get(root, path);
    if (body.status !== "READY") throw new Error("expected READY");

    const item = body.items[0];
    if (item === undefined) throw new Error("expected one account");
    // The fixture carries `authProfileRef`. The response does not carry it in
    // any form: a present-but-opaque field would still tell a reader that a
    // secret reference exists and what it is called.
    expect(Object.keys(item)).not.toContain("authProfileRef");
    expect(Object.keys(item)).not.toContain("credentialRef");
    expect(JSON.stringify(body)).not.toContain("profile://");
  });

  it("pins estimatedAt to the request's own instant", async () => {
    const root = temporaryRoot();
    const path = writeOwnerFile(root, ownerDocument([account()]));
    const body = await get(root, path);
    if (body.status !== "READY") throw new Error("expected READY");

    // Exactly the injected instant, not merely one bracketed by two wall-clock
    // reads taken around the request. The old bracketing could only show the
    // answer fell inside a window; pinning shows the handler took the instant
    // it was given and the read model never reached for a clock of its own.
    expect(body.estimatedAt).toBe(PINNED_NOW);
  });
});

describe("GET /api/v1/accounts — every UNAVAILABLE word", () => {
  it("ACCOUNTS_FILE_UNCONFIGURED when the operator wired no path", async () => {
    const body = await get(temporaryRoot(), undefined);
    expect(body.status).toBe("UNAVAILABLE");
    if (body.status !== "UNAVAILABLE") throw new Error("expected UNAVAILABLE");
    expect(body.reason).toBe("ACCOUNTS_FILE_UNCONFIGURED");
  });

  it("ACCOUNTS_FILE_ABSENT when the path names nothing", async () => {
    const root = temporaryRoot();
    const body = await get(root, join(root, "does-not-exist.json"));
    if (body.status !== "UNAVAILABLE") throw new Error("expected UNAVAILABLE");
    expect(body.reason).toBe("ACCOUNTS_FILE_ABSENT");
  });

  it("ACCOUNTS_FILE_UNREADABLE when the mode is not exactly 0600", async () => {
    const root = temporaryRoot();
    // World-readable. An owner file anyone can read has already failed at the
    // one thing it is for, so the loader refuses and this reports it.
    const path = writeOwnerFile(root, ownerDocument([account()]), 0o644);
    const body = await get(root, path);
    if (body.status !== "UNAVAILABLE") throw new Error("expected UNAVAILABLE");
    expect(body.reason).toBe("ACCOUNTS_FILE_UNREADABLE");
  });

  it("ACCOUNTS_FILE_SCHEMA_REFUSED for bytes that are not an accounts file", async () => {
    const root = temporaryRoot();
    const path = writeOwnerFile(root, "{ not json");
    const body = await get(root, path);
    if (body.status !== "UNAVAILABLE") throw new Error("expected UNAVAILABLE");
    expect(body.reason).toBe("ACCOUNTS_FILE_SCHEMA_REFUSED");
  });

  it("ACCOUNTS_FILE_OVERSIZE when the file exceeds the loader's bound", async () => {
    const root = temporaryRoot();
    // Past 256 KiB. Built from a repeated harmless string, so the refusal is
    // about size and nothing else.
    const path = writeOwnerFile(root, JSON.stringify({ ...ownerDocument([]), filler: "x".repeat(300 * 1024) }));
    const body = await get(root, path);
    if (body.status !== "UNAVAILABLE") throw new Error("expected UNAVAILABLE");
    expect(body.reason).toBe("ACCOUNTS_FILE_OVERSIZE");
  });

  it("covers every word in the closed vocabulary", () => {
    // The one-per-refusal convention, asserted rather than assumed: this suite
    // names all five, so a sixth word added to the contract without a drill
    // fails here.
    const drilled = new Set([
      "ACCOUNTS_FILE_UNCONFIGURED",
      "ACCOUNTS_FILE_ABSENT",
      "ACCOUNTS_FILE_UNREADABLE",
      "ACCOUNTS_FILE_SCHEMA_REFUSED",
      "ACCOUNTS_FILE_OVERSIZE",
    ]);
    expect([...drilled].sort()).toEqual([...ACCOUNTS_UNAVAILABLE_REASONS].sort());
  });
});

describe("the owner file's contents never leave", () => {
  it("refuses a planted credential and echoes none of it", async () => {
    const root = temporaryRoot();
    const planted = "sk-ant-api03-" + "A".repeat(80);
    const path = writeOwnerFile(root, ownerDocument([account({ credentialRef: planted })]));
    const body = await get(root, path);

    if (body.status !== "UNAVAILABLE") throw new Error("expected the guard to refuse");
    expect(body.reason).toBe("ACCOUNTS_FILE_SCHEMA_REFUSED");
    // Refused, and the value never travels: the detail is a field path.
    expect(JSON.stringify(body)).not.toContain(planted);
    expect(JSON.stringify(body)).not.toContain("sk-ant");
  });

  it("carries a field path as detail, never a line or a value", async () => {
    const root = temporaryRoot();
    const path = writeOwnerFile(root, ownerDocument([account({ provider: 42 })]));
    const body = await get(root, path);
    if (body.status !== "UNAVAILABLE") throw new Error("expected UNAVAILABLE");
    expect(body.detail).toBeDefined();
    // A path names where, not what.
    expect(body.detail).not.toContain("42");
  });
});

describe("the accounts route is a read", () => {
  it("answers GET and refuses every other verb with 405", async () => {
    const root = temporaryRoot();
    const app = buildServer({ ledgerPath: ledgerPath(root), now: () => PINNED_NOW });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({ method, url: "/api/v1/accounts" });
      expect({ method, status: response.statusCode }).toEqual({ method, status: 405 });
    }
    expect((await app.inject({ method: "GET", url: "/api/v1/accounts" })).statusCode).toBe(200);
    await app.close();
  });

  it("refuses a query string, like every other read", async () => {
    const root = temporaryRoot();
    const app = buildServer({ ledgerPath: ledgerPath(root), now: () => PINNED_NOW });
    const response = await app.inject({ method: "GET", url: "/api/v1/accounts?limit=5" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

void randomUUID;

describe("the authority overlay on the accounts read (P8-8G packet 2)", () => {
  it("reports the owner file as the source while no action exists", async () => {
    const root = temporaryRoot();
    const path = writeOwnerFile(root, ownerDocument([account()]));
    const body = await get(root, path);
    if (body.status !== "READY") throw new Error("expected READY");

    const item = body.items[0];
    if (item === undefined) throw new Error("expected one account");
    // Nothing has been recorded, so the file is the only thing that has
    // spoken — and it is the answer.
    expect(item.stateSource).toBe("OWNER_FILE");
    expect(item.effectiveState).toBe(item.state);
    expect(item.lastAction).toBeNull();
  });
});
