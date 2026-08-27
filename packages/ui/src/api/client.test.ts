import { API_CONTRACT_VERSION, LEDGER_CONTRACT_VERSION } from "@acp/api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchEvents, fetchOverview, fetchTaskDetail, fetchTasks, fetchWorkerDetail } from "./client.js";

const SHA = "a".repeat(64);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validOverview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    state: "EMPTY",
    observedAt: "2026-01-01T00:00:00.000Z",
    database: { id: SHA, label: "acp.db", pathRedacted: true },
    ledger: { eventCount: 0, headSequence: 0, headEventSha256: SHA, lastEventAt: null },
    integrity: { checked: false, ok: null, problemCount: null, checkedAt: null },
    tasks: { total: 0, terminal: 0, active: 0, byState: [] },
    workers: { total: 0, byRole: [] },
    capabilities: { readOnly: true, writes: false, routing: false, accounts: false, leases: false },
    notice: null,
    ...overrides,
  };
}

function validApiError(code = "LEDGER_UNAVAILABLE"): Record<string, unknown> {
  return {
    apiContractVersion: API_CONTRACT_VERSION,
    error: { code, message: "the ledger could not be opened", detail: null },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchOverview", () => {
  it("returns ok with parsed data for a contract-conformant success response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, validOverview())));
    const result = await fetchOverview();
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.data.state).toBe("EMPTY");
    }
  });

  it("reports contract-mismatch when a success response does not satisfy the schema", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { nonsense: true })));
    const result = await fetchOverview();
    expect(result.kind).toBe("contract-mismatch");
  });

  it("reports contract-mismatch when the response body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not json", { status: 200 })),
    );
    const result = await fetchOverview();
    expect(result.kind).toBe("contract-mismatch");
  });

  it("returns api-error with the parsed envelope for a well formed error response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(503, validApiError("LEDGER_UNAVAILABLE"))));
    const result = await fetchOverview();
    expect(result.kind).toBe("api-error");
    if (result.kind === "api-error") {
      expect(result.code).toBe("LEDGER_UNAVAILABLE");
      expect(result.status).toBe(503);
    }
  });

  it("reports contract-mismatch when an error response does not match the error envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, { oops: true })));
    const result = await fetchOverview();
    expect(result.kind).toBe("contract-mismatch");
  });

  it("reports network-error when fetch itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const result = await fetchOverview();
    expect(result.kind).toBe("network-error");
    if (result.kind === "network-error") {
      expect(result.detail).toContain("connection refused");
    }
  });
});

describe("fetchTaskDetail and fetchWorkerDetail", () => {
  it("rejects a malformed task id without calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchTaskDetail("not-a-uuid");
    expect(result.kind).toBe("contract-mismatch");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a malformed worker identity without calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchWorkerDetail("not/an/identity");
    expect(result.kind).toBe("contract-mismatch");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("query construction", () => {
  it("omits absent filters and encodes present ones for fetchTasks", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        items: [],
        page: { nextCursor: null, hasMore: false, limit: 50, returned: 0 },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await fetchTasks({ state: "RUNNING", limit: 50 });
    const calledPath = String((fetchSpy.mock.calls[0] as unknown[])[0]);
    expect(calledPath).toContain("/api/v1/tasks?");
    expect(calledPath).toContain("state=RUNNING");
    expect(calledPath).toContain("limit=50");
    expect(calledPath).not.toContain("cursor");
  });

  it("encodes multiple filters for fetchEvents", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        items: [],
        page: { nextCursor: null, hasMore: false, limit: 50, returned: 0 },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await fetchEvents({ taskId: "123e4567-e89b-12d3-a456-426614174000", toState: "RUNNING" });
    const calledPath = String((fetchSpy.mock.calls[0] as unknown[])[0]);
    expect(calledPath).toContain("taskId=123e4567-e89b-12d3-a456-426614174000");
    expect(calledPath).toContain("toState=RUNNING");
  });
});
