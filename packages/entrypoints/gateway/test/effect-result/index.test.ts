import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  API_CONTRACT_VERSION,
  API_PRIVATE_READ_ROUTES,
  API_ROUTE_PATTERNS,
  API_ROUTES,
  ApiError,
  EFFECT_RESULT_STATES,
  LEDGER_CONTRACT_VERSION,
  TaskEffectResultResponse,
  TaskEffectsResponse,
  isPrivateReadRoute,
  taskEffectResultPath,
  taskEffectsPath,
} from "@acp/protocol";
import type { ApiRouteName } from "@acp/protocol";
import { EFFECT_OUTCOME_STATUSES, openLedger } from "@acp/ledger";
import * as runtimeModule from "@acp/runtime";
import type { EffectResultReading } from "@acp/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "../../src/build-server/index.js";

/**
 * P-15 escalón F (ADR 0107): the two effect reads at the HTTP door.
 *
 * The door's own behaviour is proved here: the bearer on the one private read
 * and on nothing else, the method and parameter refusals, `no-store`, and the
 * mapping of every answer the runtime reader can give onto the wire and the one
 * error envelope. The reader's decisions are proved against a real ledger and a
 * real plane in the runtime's suite, and the whole path — a task entered by a
 * real door, executed by the daemon, read back through this route and the CLI
 * verb — in the daemon's door-to-result drill. The reader is wrapped here so a
 * test can make it answer each of its words on demand; every other call reaches
 * the real one.
 */
vi.mock("@acp/runtime", async (importOriginal) => {
  const original = await importOriginal<typeof runtimeModule>();
  return { ...original, readEffectResult: vi.fn(original.readEffectResult) };
});

const dirs: string[] = [];
const TOKEN = "p15f-test-token-" + "x".repeat(24);
const AUTH = { authorization: "Bearer " + TOKEN };
const EFFECT = "a".repeat(64);
const AT = "2026-09-23T12:00:00.000Z";

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.mocked(runtimeModule.readEffectResult).mockClear();
});

function directory(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acp-p15f-gateway-")));
  dirs.push(root);
  return root;
}

function bearerFile(): string {
  const path = join(directory(), "bearer.token");
  writeFileSync(path, TOKEN + "\n", "utf8");
  chmodSync(path, 0o600);
  return path;
}

/** A ledger holding one discovered task and no effects. */
function seeded(): { readonly ledgerPath: string; readonly taskId: string } {
  const ledgerPath = join(directory(), "control-plane.sqlite");
  const ledger = openLedger(ledgerPath);
  const taskId = randomUUID();
  ledger.append({
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: randomUUID(),
    taskId,
    attempt: 1,
    transitionId: "discover",
    idempotencyKey: taskId + "/1/discover",
    type: "TASK_DISCOVERED",
    fromState: null,
    toState: "DISCOVERED",
    emittedBy: "kimi/k3/coordinator/01",
    occurredAt: AT,
    recordedAt: AT,
    correlationId: null,
    causationId: null,
    payload: {},
  });
  ledger.close();
  return { ledgerPath, taskId };
}

function answer(reading: EffectResultReading): void {
  vi.mocked(runtimeModule.readEffectResult).mockImplementationOnce(() => reading);
}

const DOCUMENT = {
  resultContractVersion: 1 as const,
  effectId: EFFECT,
  status: "SUCCEEDED" as const,
  blocks: [
    {
      kind: "text" as const,
      blockId: "output-001",
      mediaType: "text/plain; charset=utf-8",
      byteLength: 2,
      contentSha256: "2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df",
      artifactRefId: null,
      text: "ok",
      toolCallId: null,
      effectId: null,
    },
  ],
  usageReference: EFFECT,
};

describe("P-15/F: the effects list is a plain read", () => {
  it("lists a known task's effects without a bearer, and refuses an unknown task, a bad id and a query", async () => {
    const { ledgerPath, taskId } = seeded();
    const app = buildServer({ ledgerPath, writeBearerPath: bearerFile() });
    const listed = await app.inject({ method: "GET", url: taskEffectsPath(taskId) });
    expect(listed.statusCode).toBe(200);
    expect(TaskEffectsResponse.parse(listed.json())).toEqual({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      taskId,
      effects: [],
      truncated: false,
    });
    const unknown = await app.inject({ method: "GET", url: taskEffectsPath(randomUUID()) });
    expect([unknown.statusCode, ApiError.parse(unknown.json()).error.code]).toEqual([404, "NOT_FOUND"]);
    const bad = await app.inject({ method: "GET", url: API_ROUTES.tasks + "/not-a-uuid/effects" });
    expect([bad.statusCode, ApiError.parse(bad.json()).error.code]).toEqual([400, "BAD_REQUEST"]);
    const query = await app.inject({ method: "GET", url: taskEffectsPath(taskId) + "?limit=1" });
    expect(query.statusCode).toBe(400);
    await app.close();
  });
});

describe("P-15/F N-F-19: the model-output read is the one guarded GET", () => {
  it("answers 401 without a bearer and with a wrong one, alike, before any parameter is read", async () => {
    const { ledgerPath, taskId } = seeded();
    const app = buildServer({ ledgerPath, writeBearerPath: bearerFile() });
    const url = taskEffectResultPath(taskId, EFFECT);
    const missing = await app.inject({ method: "GET", url });
    const wrong = await app.inject({ method: "GET", url, headers: { authorization: "Bearer " + "y".repeat(40) } });
    for (const response of [missing, wrong]) {
      expect(response.statusCode).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
      const body = ApiError.parse(response.json());
      expect(body.error.code).toBe("AUTH_REQUIRED");
      expect(Object.keys(body)).not.toContain("result");
    }
    expect(missing.json()).toEqual(wrong.json());
    // A bad parameter behind a missing bearer is still 401: nothing is learnable first.
    const unauthorizedBadId = await app.inject({ method: "GET", url: API_ROUTES.tasks + "/not-a-uuid/effects/x/result" });
    expect(unauthorizedBadId.statusCode).toBe(401);
    expect(vi.mocked(runtimeModule.readEffectResult)).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers 403 PRIVATE_READ_UNCONFIGURED on a server started without a bearer, whatever is presented", async () => {
    const { ledgerPath, taskId } = seeded();
    const app = buildServer({ ledgerPath });
    const response = await app.inject({ method: "GET", url: taskEffectResultPath(taskId, EFFECT), headers: AUTH });
    expect(response.statusCode).toBe(403);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(ApiError.parse(response.json()).error.code).toBe("PRIVATE_READ_UNCONFIGURED");
    expect(vi.mocked(runtimeModule.readEffectResult)).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers 404 behind the bearer for an effect the task does not hold", async () => {
    const { ledgerPath, taskId } = seeded();
    const app = buildServer({ ledgerPath, writeBearerPath: bearerFile() });
    const response = await app.inject({ method: "GET", url: taskEffectResultPath(taskId, EFFECT), headers: AUTH });
    expect([response.statusCode, ApiError.parse(response.json()).error.code]).toEqual([404, "NOT_FOUND"]);
    expect(response.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("leaves every other GET free: the exception is the private table, and the table names model output only", async () => {
    const { ledgerPath, taskId } = seeded();
    const app = buildServer({ ledgerPath, writeBearerPath: bearerFile() });
    expect([...API_PRIVATE_READ_ROUTES]).toEqual(["taskEffectResult"]);
    for (const name of Object.keys(API_ROUTES) as ApiRouteName[]) {
      expect(isPrivateReadRoute(name)).toBe(name === "taskEffectResult");
    }
    const parameterless = API_ROUTE_PATTERNS.filter((pattern) => !pattern.includes(":") && pattern !== API_ROUTES.eventStream);
    for (const url of [...parameterless, API_ROUTES.tasks + "/" + taskId, taskEffectsPath(taskId)]) {
      const response = await app.inject({ method: "GET", url });
      expect({ url, status: response.statusCode }).not.toEqual({ url, status: 401 });
      expect({ url, status: response.statusCode }).not.toEqual({ url, status: 403 });
    }
    await app.close();
  });
});

describe("P-15/F N-F-20 and N-F-22: methods and parameters", () => {
  it("answers 405 with no-store on every other method", async () => {
    const { ledgerPath, taskId } = seeded();
    const app = buildServer({ ledgerPath, writeBearerPath: bearerFile() });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({ method, url: taskEffectResultPath(taskId, EFFECT), headers: AUTH });
      expect(response.statusCode).toBe(405);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(ApiError.parse(response.json()).error.code).toBe("METHOD_NOT_ALLOWED");
    }
    await app.close();
  });

  it("answers 400 naming the parameter, never echoing its value", async () => {
    const { ledgerPath, taskId } = seeded();
    const app = buildServer({ ledgerPath, writeBearerPath: bearerFile() });
    const base = API_ROUTES.tasks + "/" + taskId + "/effects/";
    const probes = [
      { url: base + "b".repeat(201) + "/result", echo: "b".repeat(201) },
      { url: base + "B".repeat(64) + "/result", echo: "B".repeat(64) },
      { url: base + "a".repeat(32) + "%2F" + "a".repeat(31) + "/result", echo: "a".repeat(31) },
      { url: API_ROUTES.tasks + "/not-a-uuid-at-all/effects/" + EFFECT + "/result", echo: "not-a-uuid-at-all" },
      { url: taskEffectResultPath(taskId, EFFECT) + "?block=x", echo: "=x" },
      { url: taskEffectResultPath(taskId, EFFECT) + "?other=1", echo: "other" },
      { url: taskEffectResultPath(taskId, EFFECT) + "?block=100", echo: "100" },
    ];
    for (const probe of probes) {
      const response = await app.inject({ method: "GET", url: probe.url, headers: AUTH });
      expect({ url: probe.url, status: response.statusCode }).toEqual({ url: probe.url, status: 400 });
      expect(ApiError.parse(response.json()).error.code).toBe("BAD_REQUEST");
      expect(response.body).not.toContain(probe.echo);
    }
    expect(vi.mocked(runtimeModule.readEffectResult)).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("P-15/F v3: a framework refusal on the private path is never cached either", () => {
  it("answers %zz and a 200-character id with 400 and no-store, before any route logic, bearer or not", async () => {
    const { ledgerPath, taskId } = seeded();
    const app = buildServer({ ledgerPath, writeBearerPath: bearerFile() });
    const base = API_ROUTES.tasks + "/" + taskId + "/effects/";
    for (const url of [base + "%zz/result", base + "a".repeat(200) + "/result"]) {
      for (const headers of [{}, AUTH]) {
        const response = await app.inject({ method: "GET", url, headers });
        expect({ url, status: response.statusCode }).toEqual({ url, status: 400 });
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(ApiError.parse(response.json()).error.code).toBe("BAD_REQUEST");
      }
    }
    expect(vi.mocked(runtimeModule.readEffectResult)).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("P-15/F: every answer of the reader maps onto the wire or the one error envelope", () => {
  it("maps the five states to 200 bodies the schema admits, every key present", async () => {
    const { ledgerPath, taskId } = seeded();
    const app = buildServer({ ledgerPath, writeBearerPath: bearerFile() });
    const url = taskEffectResultPath(taskId, EFFECT);
    const base = { apiContractVersion: API_CONTRACT_VERSION, ledgerContractVersion: LEDGER_CONTRACT_VERSION, taskId, effectId: EFFECT };
    const cases: { readonly reading: EffectResultReading; readonly expected: Record<string, unknown> }[] = [
      {
        reading: { kind: "NO_OUTCOME" },
        expected: { ...base, state: "NO_OUTCOME", outcomeStatus: null, outcomeRecordedAt: null, cohort: null, result: null, blockContent: null },
      },
      {
        reading: { kind: "OUTCOME_UNKNOWN", outcomeRecordedAt: AT },
        expected: { ...base, state: "OUTCOME_UNKNOWN", outcomeStatus: "OUTCOME_UNKNOWN", outcomeRecordedAt: AT, cohort: null, result: null, blockContent: null },
      },
      {
        reading: { kind: "CANCELLED", outcomeRecordedAt: AT },
        expected: { ...base, state: "CANCELLED", outcomeStatus: "CANCELLED", outcomeRecordedAt: AT, cohort: null, result: null, blockContent: null },
      },
      {
        reading: { kind: "NO_RESULT_RECORDED", status: "SUCCEEDED", outcomeRecordedAt: AT, cohort: "PRE_RESULT" },
        expected: { ...base, state: "NO_RESULT_RECORDED", outcomeStatus: "SUCCEEDED", outcomeRecordedAt: AT, cohort: "PRE_RESULT", result: null, blockContent: null },
      },
      {
        reading: { kind: "NO_RESULT_RECORDED", status: "FAILED", outcomeRecordedAt: AT, cohort: "CURRENT" },
        expected: { ...base, state: "NO_RESULT_RECORDED", outcomeStatus: "FAILED", outcomeRecordedAt: AT, cohort: "CURRENT", result: null, blockContent: null },
      },
      {
        reading: {
          kind: "RESULT",
          status: "SUCCEEDED",
          outcomeRecordedAt: AT,
          resultSha256: "b".repeat(64),
          artifactReferenceId: "ref-result",
          document: DOCUMENT,
          block: null,
        },
        expected: {
          ...base,
          state: "RESULT",
          outcomeStatus: "SUCCEEDED",
          outcomeRecordedAt: AT,
          cohort: "CURRENT",
          result: { resultSha256: "b".repeat(64), artifactReferenceId: "ref-result", document: DOCUMENT },
          blockContent: null,
        },
      },
    ];
    for (const { reading, expected } of cases) {
      answer(reading);
      const response = await app.inject({ method: "GET", url, headers: AUTH });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(TaskEffectResultResponse.parse(response.json())).toEqual(expected);
    }
    expect(EFFECT_RESULT_STATES).toHaveLength(5);
    await app.close();
  });

  it("maps an unreadable result to 500 LEDGER_INTEGRITY with the closed word alone, and a refused block to 400", async () => {
    const { ledgerPath, taskId } = seeded();
    const app = buildServer({ ledgerPath, writeBearerPath: bearerFile() });
    const url = taskEffectResultPath(taskId, EFFECT);
    answer({ kind: "RESULT_UNREADABLE", refusal: "CONTENT_DOES_NOT_VERIFY" });
    const unreadable = await app.inject({ method: "GET", url, headers: AUTH });
    expect(unreadable.statusCode).toBe(500);
    expect(ApiError.parse(unreadable.json()).error).toMatchObject({ code: "LEDGER_INTEGRITY", detail: "CONTENT_DOES_NOT_VERIFY" });
    expect(unreadable.body).not.toContain(ledgerPath);

    // The reader's class refusal (C1) is one more closed word on the same mapping.
    answer({ kind: "RESULT_UNREADABLE", refusal: "CLASS_REFUSED" });
    const classRefused = await app.inject({ method: "GET", url, headers: AUTH });
    expect([classRefused.statusCode, classRefused.headers["cache-control"]]).toEqual([500, "no-store"]);
    expect(ApiError.parse(classRefused.json()).error).toMatchObject({ code: "LEDGER_INTEGRITY", detail: "CLASS_REFUSED" });

    answer({ kind: "BLOCK_REFUSED" });
    const refused = await app.inject({ method: "GET", url: url + "?block=0", headers: AUTH });
    expect(refused.statusCode).toBe(400);
    expect(ApiError.parse(refused.json()).error).toMatchObject({ code: "BAD_REQUEST", detail: "block" });
    expect(vi.mocked(runtimeModule.readEffectResult).mock.calls.at(-1)?.[1]).toEqual({ taskId, effectId: EFFECT, block: 0 });
    await app.close();
  });

  it("admits exactly the one outcome vocabulary on the wire, the contracts set the ledger re-exports (decision 151)", () => {
    const effect = {
      effectId: EFFECT,
      revisionNumber: 1,
      attemptNumber: 1,
      operationOrdinal: 0,
      effectKind: "model_execution",
      intendedAt: AT,
      outcomeRecordedAt: AT,
      hasResult: false,
    };
    const listed = (outcomeStatus: string): boolean =>
      TaskEffectsResponse.safeParse({
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        taskId: randomUUID(),
        effects: [{ ...effect, outcomeStatus }],
        truncated: false,
      }).success;
    for (const status of EFFECT_OUTCOME_STATUSES) expect({ status, admitted: listed(status) }).toEqual({ status, admitted: true });
    for (const word of ["SETTLED", "RESULT", "NO_OUTCOME", "succeeded", ""]) expect({ word, admitted: listed(word) }).toEqual({ word, admitted: false });
  });
});
