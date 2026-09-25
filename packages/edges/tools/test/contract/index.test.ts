import { describe, expect, it } from "vitest";

import { WORKER_ROLES } from "@acp/contracts";

import {
  TOOL_ARGUMENTS_BYTES_MAX,
  TOOL_CALL_TIMEOUT_MS,
  TOOL_CONTENT_STRING_MAX,
  TOOL_CURSOR_BYTES_MAX,
  TOOL_FRAME_BYTES_MAX,
  TOOL_LIST_DEADLINE_MS,
  TOOL_LIST_PAGES_MAX,
  TOOL_LIST_TOOLS_MAX,
  TOOL_REFUSALS,
  TOOL_SCHEMA_BYTES_MAX,
  TOOL_SCHEMA_DEPTH_MAX,
  TOOL_RESULT_BYTES_MAX,
  TOOL_SERVER_ENV_KEYS,
  TOOL_HTTP_CLOSE_TIMEOUT_MS,
  TOOL_HTTP_REQUEST_TIMEOUT_MS,
  TOOL_HTTP_STREAM_BYTES_MAX,
  TOOL_HTTP_STREAM_EVENTS_MAX,
  TOOL_MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_RECORD,
  TOOL_TRANSPORT_KINDS,
  TOOL_TRANSPORT_UNRESOLVED,
  TOOL_WRITE_ROLES,
  holdsToolWriteAuthority,
} from "../../src/contract/index.js";
import { realpathSync } from "node:fs";

import { admitToolServer } from "../../src/admission/index.js";

describe("the tool vocabulary is closed and honest", () => {
  it("names two transports, and each has a producer", () => {
    // Stage 1 held this at one member and promised the second would "arrive
    // with the transport rather than before it". V2-B4b S4-1 kept that promise:
    // both members are emittable by an admission and speakable by a connection,
    // which is what keeps the union from being the vacuity this repository
    // refuses. The producers are asserted below, not assumed.
    expect([...TOOL_TRANSPORT_KINDS]).toEqual(["STDIO", "HTTP_LOOPBACK"]);
  });

  it("keeps the refusals sorted, distinct and non-empty", () => {
    expect([...TOOL_REFUSALS]).toEqual([...TOOL_REFUSALS].slice().sort());
    expect(new Set(TOOL_REFUSALS).size).toBe(TOOL_REFUSALS.length);
    expect(TOOL_REFUSALS.length).toBe(12);
  });

  it("pins the refusal vocabulary exactly, in order (P-11)", () => {
    // P-11 widens the union by one member, and the map's warning is written
    // down rather than left for someone to rediscover: a RESULT_* word sorts
    // into the middle of the list, between PROTOCOL_VIOLATION and
    // RESULT_UNBOUNDED — not to the tail, where an append-only edit would
    // have put it and where the sortedness assertion would have caught it.
    expect([...TOOL_REFUSALS]).toEqual([
      "ARGUMENTS_UNBOUNDED",
      "IDENTITY_FORBIDS_WRITE",
      "PROTOCOL_VIOLATION",
      "RESULT_IS_ERROR",
      // P-24/B(b) (ADR 0117): sorts between RESULT_IS_ERROR and RESULT_UNBOUNDED.
      "RESULT_NOT_CARRIED",
      "RESULT_UNBOUNDED",
      "RESULT_UNSAFE",
      // P-24 (ADR 0109): sorts between RESULT_UNSAFE and SERVER_NOT_ADMITTED.
      "SCHEMA_MISMATCH",
      "SERVER_NOT_ADMITTED",
      "SESSION_NOT_LIVE",
      "TOOL_NOT_ALLOWED",
      "TRANSPORT_REFUSED",
    ]);
    // No third outcome word: the receipt still has two, and a marked-error
    // result refuses as REFUSED with this reason (ADR 0069).
    expect([...TOOL_REFUSALS]).not.toContain("FAILED");
  });

  it("keeps the environment allowlist at three variables", () => {
    expect([...TOOL_SERVER_ENV_KEYS]).toEqual(["HOME", "LC_ALL", "PATH"]);
  });

  it("orders the ceilings the way the protocol nests them", () => {
    // A content block cannot exceed a result, and a result cannot exceed a
    // frame — a ceiling ordering that inverted would leave the inner bound
    // unreachable and the outer one doing all the work.
    expect(TOOL_CONTENT_STRING_MAX).toBeLessThan(TOOL_RESULT_BYTES_MAX);
    expect(TOOL_RESULT_BYTES_MAX).toBeLessThan(TOOL_FRAME_BYTES_MAX);
    expect(TOOL_ARGUMENTS_BYTES_MAX).toBeLessThan(TOOL_RESULT_BYTES_MAX);
    expect(TOOL_CALL_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("write authority is a closed subset of the control plane roles", () => {
  it("is a subset of WORKER_ROLES", () => {
    for (const role of TOOL_WRITE_ROLES) {
      expect(WORKER_ROLES).toContain(role);
    }
    expect(TOOL_WRITE_ROLES.length).toBeLessThan(WORKER_ROLES.length);
  });

  it("admits the implementer and refuses every other role", () => {
    // Both directions, over the whole role vocabulary. A test that only
    // asserted the refusals would pass against a predicate that refuses
    // everything, which is the failure that looks most like success.
    expect(holdsToolWriteAuthority("implementer")).toBe(true);
    for (const role of WORKER_ROLES) {
      if (role === "implementer") continue;
      expect(holdsToolWriteAuthority(role)).toBe(false);
    }
  });
});

describe("the unresolved word is a receipt coordinate, not a transport (V2-B4b S4-0)", () => {
  it("is absent from the transport union, which does not move", () => {
    // The pin above still reads exactly ["STDIO"]; this packet widens no union.
    // That is the point: a kind an admission could emit but no connection could
    // speak would be the mirror of the vacuity this repository refuses.
    expect((TOOL_TRANSPORT_KINDS as readonly string[]).includes(TOOL_TRANSPORT_UNRESOLVED)).toBe(
      false,
    );
  });

  it("matches the recorder's vocabulary grammar, which is why it is a word", () => {
    // `@acp/runtime`'s recorder calls requireVocabularyWord on `transport` and
    // refuses a null outright, so a screaming-snake word crosses the stratum
    // boundary a null could not. The pattern is restated here rather than
    // imported: that package is forbidden to this one by name, and a
    // cross-package recordability drill belongs in its own suite.
    expect(TOOL_TRANSPORT_UNRESOLVED).toMatch(/^[A-Z][A-Z0-9_]{0,39}$/);
  });

  it("is refused as a declared transport, because it is not one", () => {
    const outcome = admitToolServer({
      serverId: "docs",
      transport: TOOL_TRANSPORT_UNRESOLVED as unknown as "STDIO",
      command: "/bin/true",
      tools: [{ name: "docs.search", writes: false, inputSchema: { type: "object" } }],
    });
    expect(outcome).toEqual({
      ok: false,
      refusal: "TRANSPORT_REFUSED",
      at: "descriptor.transport",
    });
  });
});

describe("the loopback leg's vocabulary and its capability record (V2-B4b S4-1)", () => {
  it("gives every transport member an admission that can emit it", () => {
    // The anti-vacuity assertion, driven rather than argued: a kind no
    // admission can produce is a union entry pretending to be a capability.
    // `process.execPath` is this run's own node: absolute, existing, owned by
    // this uid and not group-writable, which is what `admitCommand` requires.
    const stdioOutcome = admitToolServer({
      serverId: "docs",
      transport: "STDIO",
      command: realpathSync(process.execPath),
      tools: [{ name: "docs.search", writes: false, inputSchema: { type: "object" } }],
    });
    const loopbackOutcome = admitToolServer({
      serverId: "docs",
      transport: "HTTP_LOOPBACK",
      url: "http://127.0.0.1:9000/mcp",
      tools: [{ name: "docs.search", writes: false, inputSchema: { type: "object" } }],
    });
    const emitted = [stdioOutcome, loopbackOutcome]
      .filter((outcome) => outcome.ok)
      .map((outcome) => outcome.server.kind);
    expect(emitted.sort()).toEqual([...TOOL_TRANSPORT_KINDS].sort());
  });

  it("keeps the unresolved word out of the union", () => {
    expect((TOOL_TRANSPORT_KINDS as readonly string[]).includes(TOOL_TRANSPORT_UNRESOLVED)).toBe(
      false,
    );
  });

  it("orders the ceilings so a frame the reader accepts is never cut off beneath it", () => {
    expect(TOOL_FRAME_BYTES_MAX).toBeLessThanOrEqual(TOOL_HTTP_STREAM_BYTES_MAX);
    for (const ceiling of [
      TOOL_HTTP_REQUEST_TIMEOUT_MS,
      TOOL_HTTP_STREAM_BYTES_MAX,
      TOOL_HTTP_STREAM_EVENTS_MAX,
      TOOL_HTTP_CLOSE_TIMEOUT_MS,
    ]) {
      expect(Number.isInteger(ceiling)).toBe(true);
      expect(ceiling).toBeGreaterThan(0);
    }
  });

  it("carries a concrete fact or an explicit UNKNOWN/NONE in every record key", () => {
    // The rule that makes the record a capability model rather than decoration:
    // no key absent, no value empty. A field that reads NONE corresponds to a
    // refusal or an absence in the code, never to a guess.
    // Read back through `unknown` so the check is about the runtime object
    // rather than about the literal type the freeze happens to give it: a
    // comparison the compiler can settle proves nothing about the value.
    const entries = Object.entries(MCP_PROTOCOL_RECORD as Readonly<Record<string, unknown>>);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, value] of entries) {
      const empty = typeof value !== "string" || value.trim().length === 0;
      expect({ key, empty }).toEqual({ key, empty: false });
    }
  });

  it("records the citation gate honestly: no bytes, so no digest", () => {
    // Built under the citation gate rather than the vendoring gate. There are
    // no bytes on disk, so there is nothing to digest and nothing to assert the
    // constants against -- and the record says exactly that rather than
    // carrying a checksum of something nothing read.
    expect(MCP_PROTOCOL_RECORD.SPEC_MANIFEST_DIGEST).toBe("NONE");
    expect(MCP_PROTOCOL_RECORD.SPEC_CITATION).toContain("2025-06-18");
    expect(MCP_PROTOCOL_RECORD.LIVE_CONFORMANCE).toBe("NONE");
    expect(MCP_PROTOCOL_RECORD.SOCKET_EXERCISED).toBe("NONE");
    expect(MCP_PROTOCOL_RECORD.REVISION).toBe(TOOL_MCP_PROTOCOL_VERSION);
  });

  it("names the marked-error result as a refusal, not as unhandled (P-11)", () => {
    // The value the audit's N07 finding read — "UNHANDLED" — was the
    // confession that isError was never read. It is read now, and the record
    // names the refusal word the README and the drills stand behind.
    expect(MCP_PROTOCOL_RECORD.IS_ERROR_RESULT).toContain("RESULT_IS_ERROR");
    expect(MCP_PROTOCOL_RECORD.IS_ERROR_RESULT).not.toBe("UNHANDLED");
  });
});

describe("P-24 (ADR 0109): the record names the pin, the listing and what is not read", () => {
  it("records pagination as followed and bounded, and keeps the README marker", () => {
    expect(MCP_PROTOCOL_RECORD.LIST_PAGINATION).toContain("followed");
    expect(MCP_PROTOCOL_RECORD.LIST_PAGINATION).toContain("repeated cursor refused");
    expect(MCP_PROTOCOL_RECORD.TOOL_SCHEMA).toContain("SCHEMA_MISMATCH");
    expect(MCP_PROTOCOL_RECORD.TOOL_SCHEMA).toContain("arguments never validated");
    expect(MCP_PROTOCOL_RECORD.LIST_CHANGED).toContain("not seen");
    // P-24/B(b) (ADR 0117): the output schema is read and pinned now.
    expect(MCP_PROTOCOL_RECORD.OUTPUT_SCHEMA).not.toBe("NOT_READ");
  });

  it("orders the listing's bounds the way they nest", () => {
    // A listing deadline shorter than one page's timeout could never be read
    // between pages; a cursor or a pin larger than a frame could never arrive.
    expect(TOOL_LIST_DEADLINE_MS).toBeGreaterThan(TOOL_CALL_TIMEOUT_MS);
    expect(TOOL_CURSOR_BYTES_MAX).toBeLessThan(TOOL_FRAME_BYTES_MAX);
    expect(TOOL_SCHEMA_BYTES_MAX).toBeLessThan(TOOL_FRAME_BYTES_MAX);
    expect(TOOL_LIST_PAGES_MAX).toBeGreaterThan(0);
    expect(TOOL_LIST_TOOLS_MAX).toBeGreaterThan(0);
    expect(TOOL_SCHEMA_DEPTH_MAX).toBeGreaterThan(0);
  });

  it("keeps every new field path inside the protocol's 120-character at", () => {
    // The longest paths this cut produces: the mismatch paths carry no tool name
    // (a 120-character bounded name would overflow), and the admission path
    // carries indices, not names.
    const paths = [
      "server.tools",
      "server.tools.inputSchema",
      "server.tools.nextCursor",
      "descriptor.tools[" + String(TOOL_LIST_TOOLS_MAX) + "].inputSchema",
      "servers[" + String(TOOL_LIST_TOOLS_MAX) + "].tools[" + String(TOOL_LIST_TOOLS_MAX) + "].inputSchema",
      // P-24/B(b) (ADR 0117).
      "server.tools.outputSchema",
      "server.result.structuredContent",
      "servers[" + String(TOOL_LIST_TOOLS_MAX) + "].tools[" + String(TOOL_LIST_TOOLS_MAX) + "].outputSchema",
    ];
    for (const path of paths) expect({ path, fits: path.length <= 120 }).toEqual({ path, fits: true });
    // What the named form would have cost: a name at the grammar's bound.
    expect(("server.tools." + "x".repeat(120) + ".inputSchema").length).toBeGreaterThan(120);
  });
});

describe("P-24/B(b) (ADR 0117): the record names the output pin and the structured result", () => {
  it("records the output schema as pinned and never validated against", () => {
    expect(MCP_PROTOCOL_RECORD.OUTPUT_SCHEMA).toContain("pinned per tool by value");
    expect(MCP_PROTOCOL_RECORD.OUTPUT_SCHEMA).toContain("SCHEMA_MISMATCH");
    expect(MCP_PROTOCOL_RECORD.OUTPUT_SCHEMA).toContain("never validated");
  });

  it("records structured content as carried only by its text, and names the word", () => {
    expect(MCP_PROTOCOL_RECORD.STRUCTURED_CONTENT).toContain("RESULT_NOT_CARRIED");
    expect(MCP_PROTOCOL_RECORD.STRUCTURED_CONTENT).toContain("required under a pinned output schema");
    expect(MCP_PROTOCOL_RECORD.STRUCTURED_CONTENT).toContain("never a field of its own");
  });

  it("holds twenty keys: STRUCTURED_CONTENT joined, none left", () => {
    expect(Object.keys(MCP_PROTOCOL_RECORD)).toHaveLength(20);
    expect(Object.keys(MCP_PROTOCOL_RECORD)).toContain("STRUCTURED_CONTENT");
  });

  it("measures the two new at paths", () => {
    expect("server.tools.outputSchema".length).toBe(25);
    expect("server.result.structuredContent".length).toBe(31);
  });
});
