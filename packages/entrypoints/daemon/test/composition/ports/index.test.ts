import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTRACT_VERSION, findCredentialViolations } from "@acp/contracts";
import type { ResolvedRoute } from "@acp/contracts";
import { createAgentHarness } from "@acp/providers";
import type { ApiStreamingClient } from "@acp/providers";
import { afterEach, describe, expect, it } from "vitest";

import {
  bindingForRoute,
  checkpointsFor,
  cliBindingsOf,
  conformanceGateFor,
  executionPortFor,
  switchPortFor,
  transportClientsFor,
} from "../../../src/composition/ports/index.js";
import type { DaemonExecutionConfig } from "../../../src/daemon-child/index.js";
import { StartupError } from "../../../src/errors/index.js";

/**
 * The mirror of `src/composition/ports/index.ts` (structure §5). P-13's
 * escalón 2 partitioned the extracted composition root: every seam the root
 * closes over a live dependency — the per-binding execution port, the switch
 * port, the conformance gate and the checkpoint port — lives in this module
 * now. This suite is the cheap proof that the partition is real and
 * importable; the behavioural drills live in the suites that always owned
 * them.
 */

describe("the composed ports", () => {
  it("carries the execution-port seam builders", () => {
    expect(typeof executionPortFor).toBe("function");
    expect(typeof bindingForRoute).toBe("function");
    expect(typeof cliBindingsOf).toBe("function");
  });

  it("carries the transport-client composition (P-15/E)", () => {
    expect(typeof transportClientsFor).toBe("function");
  });

  it("carries the switch, conformance and checkpoint seam builders", () => {
    expect(typeof switchPortFor).toBe("function");
    expect(typeof conformanceGateFor).toBe("function");
    expect(typeof checkpointsFor).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// P-15 escalón E (ADR 0108; L-P15E-3): the one receiver of a credential closure
// ---------------------------------------------------------------------------

const TMP_ROOT = realpathSync(tmpdir());
const PREFIX = "acp-p15e-ports-";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) if (dir.startsWith(join(TMP_ROOT, PREFIX))) rmSync(dir, { recursive: true, force: true });
});

const CANARY = "sk-" + "ant-" + "api03-" + "C".repeat(40) + "PORTS01";
const API_ACCOUNT = "acct-api";
const LOCAL_ACCOUNT = "acct-local";
const AT = "2026-09-23T12:00:00.000Z";
const LIMITS = { timeoutMs: 5_000, outputBudgetBytes: 65_536, interruptGraceMs: 100, termGraceMs: 100 };

/** A disposable owner directory: an accounts file naming both accounts, and a sibling unless told otherwise. */
function ownerDir(entries: Readonly<Record<string, string>> | null = { "api-main": CANARY, "local-main": CANARY }): string {
  const dir = join(TMP_ROOT, PREFIX + randomUUID());
  mkdirSync(dir, { mode: 0o700 });
  dirs.push(dir);
  const record = (accountId: string, provider: string, ref: string): Record<string, unknown> => ({
    contractVersion: CONTRACT_VERSION,
    accountId,
    provider,
    alias: accountId,
    authMode: "LOCAL_CREDENTIAL_FALLBACK",
    authProfileRef: "profile://acp-drill-" + accountId,
    credentialRef: ref,
    plan: null,
    enabledModels: [],
    knownLimits: {},
    resetSchedule: { kind: "UNKNOWN", nextResetAt: null, timezone: "UTC", confidence: "LOW" },
    quotaEstimate: { remainingRatio: null, estimatedTokensRemaining: null, estimatedAt: "2026-09-23T00:00:00Z", confidence: "LOW" },
    lastHealthProbe: null,
    lastClassifiedError: null,
    status: "AVAILABLE",
    isolatedConfigRoot: "/tmp/acp-p15e-isolated",
    contextSwitchCost: { estimatedTokens: 0, estimatedSeconds: 0 },
  });
  const accountsFile = join(dir, "accounts.local.json");
  writeFileSync(
    accountsFile,
    JSON.stringify({
      contractVersion: CONTRACT_VERSION,
      accounts: [record(API_ACCOUNT, "claude", "file://api-main"), record(LOCAL_ACCOUNT, "llama-cpp", "file://local-main")],
    }),
  );
  chmodSync(accountsFile, 0o600);
  if (entries !== null) {
    const credentialsFile = join(dir, "credentials.local.json");
    writeFileSync(credentialsFile, JSON.stringify({ contractVersion: CONTRACT_VERSION, credentials: entries }));
    chmodSync(credentialsFile, 0o600);
  }
  return accountsFile;
}

function route(transportKind: ResolvedRoute["transportKind"], accountId: string, provider: string, model: string): ResolvedRoute {
  return { provider, model, accountId, transportKind, capabilityPolicyVersion: "p15e", resolvedAt: AT };
}

function execution(accountsFile: string | undefined, localAuth: "NONE" | "CREDENTIAL" = "CREDENTIAL"): DaemonExecutionConfig {
  const workdir = TMP_ROOT;
  return {
    route: route("API_KEY", API_ACCOUNT, "claude", "claude-syn-1"),
    bindings: [
      { accountId: API_ACCOUNT, transportKind: "API_KEY", workdir, limits: LIMITS, models: ["claude-syn-1"], maxTokens: 64 },
      {
        accountId: LOCAL_ACCOUNT,
        transportKind: "LOCAL_OR_SELF_HOSTED",
        workdir,
        limits: LIMITS,
        provider: "llama-cpp",
        baseUrl: "http://127.0.0.1:18082/v1",
        models: ["local-syn-1"],
        auth: localAuth,
      },
    ],
    ...(accountsFile === undefined ? {} : { accountsFile }),
  };
}

const REQUEST = {
  taskId: "00000000-0000-4000-8000-0000000e0d06",
  attempt: 1,
  identity: "anthropic/claude-opus-5/implementer/01",
  instructions: "x",
  modalities: ["text" as const],
  reattach: null,
};

describe("the transport clients a config names (P-15/E)", () => {
  it("detects its own canary (positive control)", () => {
    expect(findCredentialViolations({ value: CANARY }).length).toBeGreaterThan(0);
  });

  it("composes the Messages client and the local client, and the composed records carry no credential (sink 8b)", () => {
    const config = execution(ownerDir());
    const clients = transportClientsFor(config);
    const api = clients.apiClientFor(API_ACCOUNT);
    const local = clients.localClientFor(LOCAL_ACCOUNT);
    expect(api).toMatchObject({ provider: "claude", models: ["claude-syn-1"] });
    expect(local).toMatchObject({ provider: "llama-cpp", models: ["local-syn-1"] });
    expect(clients.apiClientFor(LOCAL_ACCOUNT)).toBeUndefined();
    expect(clients.localClientFor(API_ACCOUNT)).toBeUndefined();
    const port = executionPortFor(config, REQUEST.taskId, createAgentHarness(), clients.apiClientFor, clients.localClientFor);
    for (const surface of [config, clients, api, local, port]) {
      expect((JSON.stringify(surface) as string | undefined) ?? "").not.toContain(CANARY);
    }
  });

  it("composes a local client with no credential for auth NONE, without reading any owner file", () => {
    const clients = transportClientsFor(execution(undefined, "NONE"));
    expect(clients.localClientFor(LOCAL_ACCOUNT)).toMatchObject({ provider: "llama-cpp" });
    expect(clients.apiClientFor(API_ACCOUNT)).toBeUndefined();
  });

  it("leaves an entry that needs a credential unbound when no accounts file is named, and the port refuses the account", async () => {
    const config = execution(undefined);
    const clients = transportClientsFor(config);
    expect(clients.apiClientFor(API_ACCOUNT)).toBeUndefined();
    expect(clients.localClientFor(LOCAL_ACCOUNT)).toBeUndefined();
    const port = executionPortFor(config, REQUEST.taskId, createAgentHarness(), clients.apiClientFor, clients.localClientFor);
    expect(await port.start(route("API_KEY", API_ACCOUNT, "claude", "claude-syn-1"), REQUEST)).toEqual({
      ok: false,
      refusal: "TRANSPORT_UNAVAILABLE",
      at: "route.accountId",
    });
    expect(await port.start(route("LOCAL_OR_SELF_HOSTED", LOCAL_ACCOUNT, "llama-cpp", "local-syn-1"), REQUEST)).toEqual({
      ok: false,
      refusal: "TRANSPORT_UNAVAILABLE",
      at: "route.accountId",
    });
  });

  it("refuses the start when a credential is refused, naming the word and the entry, never the value (N-E-19)", () => {
    const rows: readonly [Readonly<Record<string, string>> | null, string][] = [
      [null, "OWNER_FILE_ABSENT at credentials.local.json"],
      [{ "local-main": CANARY }, "CREDENTIAL_ENTRY_ABSENT at credentials.api-main"],
      [{ "api-main": CANARY + "\n" + CANARY, "local-main": CANARY }, "CREDENTIAL_ENTRY_INVALID at credentials.api-main"],
    ];
    for (const [entries, word] of rows) {
      let thrown: unknown = null;
      try {
        transportClientsFor(execution(ownerDir(entries)));
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(StartupError);
      const message = (thrown as Error).message;
      expect(message).toContain("the credential for " + API_ACCOUNT + " was refused: " + word);
      expect(message + JSON.stringify(thrown) + String(thrown) + ((thrown as Error).stack ?? "")).not.toContain(CANARY);
    }
  });

  it("replaces the composed API clients whole with an injected factory, resolving no credential for them", () => {
    const injected: ApiStreamingClient = {
      provider: "claude",
      models: ["claude-syn-1"],
      stream: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true as const, value: undefined }) }),
      }),
    };
    // The sibling lacks the API entry: resolving it would refuse. The injected
    // factory means it is never resolved.
    const clients = transportClientsFor(execution(ownerDir({ "local-main": CANARY })), () => injected);
    expect(clients.apiClientFor(API_ACCOUNT)).toBe(injected);
    expect(clients.localClientFor(LOCAL_ACCOUNT)).toMatchObject({ provider: "llama-cpp" });
  });
});
