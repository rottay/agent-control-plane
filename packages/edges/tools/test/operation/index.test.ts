import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkerIdentityString } from "@acp/contracts";

import { admitToolServer, admitToolServers } from "../../src/admission/index.js";
import type { AdmittedToolServer } from "../../src/admission/index.js";
import { openToolOperation } from "../../src/operation/index.js";
import {
  makeToolFixtureDir,
  readToolCallLog,
  removeToolFixtureDir,
  writeFakeToolServer,
} from "../testing/index.js";

/**
 * Evidence for the operation scope (V2-B4b stage 3C).
 *
 * Two claims. The first is the scope's own lifecycle: one live id, a close that
 * drops liveness before it reaps, and no spawn once it is closed. The second is
 * the invariant this module was added to own — that `ok` agrees with the
 * receipt — and it is driven against the case that reaches it through shipped
 * code rather than only against a stub.
 */

const IMPLEMENTER = "claude/opus/implementer/01" as WorkerIdentityString;
const SCOPE = "tool/7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01/1/0";

const ALLOWLIST = [
  { name: "docs.search", writes: false },
  { name: "docs.leak", writes: false },
];

/**
 * Credential-shaped, assembled at runtime.
 *
 * The repository refuses credential material in a tracked file, and a fixture
 * that looked like a live key would be indistinguishable from one. Built rather
 * than written, exactly as the port suite builds its own.
 */
const LEAKED = "sk-ant-api03-" + "A".repeat(32);

let dir = "";
let pidLog = "";
let server: AdmittedToolServer;

function childPids(): readonly number[] {
  return readToolCallLog(pidLog).map((line) => Number(line));
}

function admitFixture(serverId: string): AdmittedToolServer {
  const fake = writeFakeToolServer(dir, {
    callLog: dir + "/calls.log",
    pidLog,
    advertises: ALLOWLIST.map((entry) => entry.name),
    answers: {
      "docs.search": { kind: "TEXT", blocks: ["the answer"] },
      "docs.leak": { kind: "TEXT", blocks: ["fine"] },
    },
  });
  const admitted = admitToolServer({
    serverId,
    transport: "STDIO",
    command: fake.command,
    args: fake.args,
    tools: ALLOWLIST,
  });
  if (!admitted.ok) throw new Error("fixture server was not admitted: " + admitted.at);
  return admitted.server;
}

beforeEach(() => {
  dir = makeToolFixtureDir();
  pidLog = dir + "/pids.log";
  server = admitFixture("docs");
});

afterEach(() => {
  removeToolFixtureDir(dir);
});

describe("the scope is one operation's, and closes what it started", () => {
  it("answers live for its own id and for no other", async () => {
    const scope = openToolOperation({ scopeId: SCOPE, servers: [server] });
    try {
      expect(scope.scopeId).toBe(SCOPE);

      const wrong = await scope.callTool({
        sessionId: "tool/other/1/0",
        serverId: "docs",
        toolName: "docs.search",
        identity: IMPLEMENTER,
        arguments: { q: "acp" },
      });
      expect(wrong.ok).toBe(false);
      if (!wrong.ok) expect(wrong.refusal).toBe("SESSION_NOT_LIVE");
      // Refused before any server was touched: a dead session must not be able
      // to start a tool server.
      expect(childPids()).toHaveLength(0);
    } finally {
      await scope.close();
    }
  });

  it("refuses a call after close, with no spawn, and closes idempotently", async () => {
    const scope = openToolOperation({ scopeId: SCOPE, servers: [server] });
    await scope.close();
    await scope.close();

    const after = await scope.callTool({
      sessionId: SCOPE,
      serverId: "docs",
      toolName: "docs.search",
      identity: IMPLEMENTER,
      arguments: { q: "acp" },
    });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.refusal).toBe("SESSION_NOT_LIVE");
    expect(childPids()).toHaveLength(0);
  });

  it("completes a real call and reaps the child it started", async () => {
    const scope = openToolOperation({ scopeId: SCOPE, servers: [server] });
    let outcome;
    try {
      outcome = await scope.callTool({
        sessionId: SCOPE,
        serverId: "docs",
        toolName: "docs.search",
        identity: IMPLEMENTER,
        arguments: { q: "acp" },
      });
    } finally {
      await scope.close();
    }

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.content).toEqual(["the answer"]);
    expect(outcome.receipt.outcome).toBe("COMPLETED");
    expect(outcome.receipt.refusal).toBeNull();

    const pids = childPids();
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) {
      // Reaped by pid before close returned.
      expect(() => process.kill(pid, 0)).toThrow();
    }
  });
});

describe("ok agrees with the receipt, or the answer becomes a refusal", () => {
  it("refuses a completed call whose receipt was redacted, and returns no content", async () => {
    // The case that reaches this through shipped code. `toolReceipt` scans the
    // receipt's OWN fields, and a server id that is a valid bounded identifier
    // can still match a credential guard — so the port's success path builds a
    // receipt saying REFUSED / RESULT_UNSAFE and returns it beside `ok: true`.
    // Left alone, the operation records a REFUSED row while the door hands the
    // caller the content that row calls unsafe.
    const redacting = admitFixture(LEAKED);
    const scope = openToolOperation({ scopeId: SCOPE, servers: [redacting] });
    let outcome;
    try {
      outcome = await scope.callTool({
        sessionId: SCOPE,
        serverId: LEAKED,
        toolName: "docs.search",
        identity: IMPLEMENTER,
        arguments: { q: "acp" },
      });
    } finally {
      await scope.close();
    }

    // The scope converted it. The direction is the safe one: a receipt that
    // looked like a secret is refused, never rewritten into a success.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal).toBe("RESULT_UNSAFE");
      expect(outcome.at).toBe("server.result");
    }
    expect(outcome.receipt.outcome).toBe("REFUSED");
    // No content on the refusing arm: the union has nowhere to carry it.
    expect("content" in outcome).toBe(false);
  });

  it("leaves a coherent completion exactly as the port answered it", async () => {
    const scope = openToolOperation({ scopeId: SCOPE, servers: [server] });
    let outcome;
    try {
      outcome = await scope.callTool({
        sessionId: SCOPE,
        serverId: "docs",
        toolName: "docs.search",
        identity: IMPLEMENTER,
        arguments: { q: "acp" },
      });
    } finally {
      await scope.close();
    }
    // Non-vacuous: the conversion above must not be firing on every call.
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.content).toEqual(["the answer"]);
  });

  it("leaves a coherent refusal naming the same word the receipt names", async () => {
    const scope = openToolOperation({ scopeId: SCOPE, servers: [server] });
    let outcome;
    try {
      outcome = await scope.callTool({
        sessionId: SCOPE,
        serverId: "docs",
        toolName: "docs.forbidden",
        identity: IMPLEMENTER,
        arguments: {},
      });
    } finally {
      await scope.close();
    }
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal).toBe("TOOL_NOT_ALLOWED");
      // Untouched by the conversion: the arm and the receipt already agreed.
      expect(outcome.at).toBe("request.toolName");
    }
    expect(outcome.receipt.outcome).toBe("REFUSED");
    expect(outcome.receipt.refusal).toBe("TOOL_NOT_ALLOWED");
  });
});

describe("a whole tool document is admitted all or nothing", () => {
  function descriptor(serverId: string): Record<string, unknown> {
    const fake = writeFakeToolServer(dir, {
      callLog: dir + "/calls.log",
      pidLog,
      advertises: ["docs.search"],
      answers: { "docs.search": { kind: "TEXT", blocks: ["ok"] } },
    });
    return {
      serverId,
      transport: "STDIO",
      command: fake.command,
      args: fake.args,
      tools: [{ name: "docs.search", writes: false }],
    };
  }

  it("admits a well-formed document", () => {
    const outcome = admitToolServers([descriptor("docs"), descriptor("notes")]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.servers.map((entry) => entry.serverId)).toEqual(["docs", "notes"]);
  });

  it("refuses a document that is not an array", () => {
    const outcome = admitToolServers({ servers: [] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal).toBe("SERVER_NOT_ADMITTED");
      expect(outcome.at).toBe("servers");
    }
  });

  it("refuses an empty document", () => {
    const outcome = admitToolServers([]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.at).toBe("servers");
  });

  it("names the entry that refused, not just the document", () => {
    const outcome = admitToolServers([descriptor("docs"), descriptor("not a name")]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal).toBe("SERVER_NOT_ADMITTED");
      // The index and the field, so an operator does not bisect the file.
      expect(outcome.at).toBe("servers[1].serverId");
    }
  });

  it("refuses a duplicate server id", () => {
    const outcome = admitToolServers([descriptor("docs"), descriptor("docs")]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.at).toBe("servers[1].serverId");
  });

  it("refuses a remote descriptor, whatever it claims its transport is", () => {
    const outcome = admitToolServers([
      { serverId: "remote", transport: "STDIO", url: "https://example.com", tools: [] },
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal).toBe("TRANSPORT_REFUSED");
  });

  it("refuses one bad entry rather than admitting the good ones beside it", () => {
    const outcome = admitToolServers([descriptor("docs"), { serverId: "broken" }]);
    expect(outcome.ok).toBe(false);
    // A partial admission would start a plane whose reachable tools depend on
    // which entries happened to parse.
  });
});
