import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { daemonRootPath, resolveDaemonRoot, statusPath } from "../../src/paths/index.js";
import type { DaemonStatusDocument } from "../../src/status/index.js";
import { STATUS_MAX_BYTES, assertPublishable, clearStatus, readStatusFrom, writeStatus } from "../../src/status/index.js";

const BASE: DaemonStatusDocument = {
  phase: "READY",
  mode: "SQLITE_SUPERVISOR",
  scenarioId: "daemon-status",
  pid: 4242,
  serverPid: null,
  serverStartToken: null,
  serverArgvDigest: null,
  ledgerHeadSequence: 11,
  ledgerHeadSha256: "a".repeat(64),
  errorCode: null,
  startedAt: "2026-08-27T18:46:07.000Z",
  updatedAt: "2026-08-27T18:46:08.000Z",
};

afterEach(() => {
  rmSync(daemonRootPath(), { recursive: true, force: true });
});

describe("what a status document may carry", () => {
  it("accepts a well-formed document", () => {
    expect(() => { assertPublishable(BASE); }).not.toThrow();
  });

  it("carries process ids, which are not secrets", () => {
    // An operator and a drill both need these to terminate exactly the right
    // process rather than pattern-matching across the machine.
    //
    // Since V2-B2-6 a server pid travels with the identity that proves it, so
    // the pid is supplied here as the whole triple rather than alone: a pid on
    // its own is the half-identity the document now refuses.
    expect(() => {
      assertPublishable({
        ...BASE,
        serverPid: 5150,
        serverStartToken: "Wed Aug 27 18:46:07 2026",
        serverArgvDigest: "c".repeat(64),
      });
    }).not.toThrow();
  });

  it("refuses anything that looks like a path where the scenario belongs", () => {
    expect(() => { assertPublishable({ ...BASE, scenarioId: "/Users/someone/repo" }); }).toThrow();
    expect(() => { assertPublishable({ ...BASE, scenarioId: "../escape" }); }).toThrow();
    expect(() => { assertPublishable({ ...BASE, scenarioId: "" }); }).toThrow();
  });

  it("refuses a head digest that is not 64 lowercase hex", () => {
    expect(() => { assertPublishable({ ...BASE, ledgerHeadSha256: "A".repeat(64) }); }).toThrow();
    expect(() => { assertPublishable({ ...BASE, ledgerHeadSha256: "abc" }); }).toThrow();
  });

  it("refuses an oversized document", () => {
    // Now that every field is shape-checked, an oversized document is also a
    // malformed one: there is no valid shape large enough to reach the byte
    // cap. The cap stays as defence in depth rather than as the only guard.
    const oversized = { ...BASE, mode: "x".repeat(STATUS_MAX_BYTES) };
    expect(() => { assertPublishable(oversized); }).toThrow();
  });

  it("refuses an extra key", () => {
    // The type annotation was doing no work at runtime, so a widened document
    // passed every other check. Extra keys are how a payload or a path arrives
    // in an observation that otherwise looks perfectly well-formed.
    const widened = { ...BASE, secret: "/Users/someone/token" } as unknown as DaemonStatusDocument;
    expect(() => { assertPublishable(widened); }).toThrow(/unexpected key set/);
  });

  it("refuses a missing key", () => {
    const rest: Record<string, unknown> = { ...BASE };
    delete rest["serverPid"];
    expect(() => { assertPublishable(rest as unknown as DaemonStatusDocument); }).toThrow(
      /unexpected key set/,
    );
  });

  it("refuses an unknown phase, mode or error code", () => {
    expect(() => { assertPublishable({ ...BASE, phase: "ASCENDED" as never }); }).toThrow(/phase/);
    expect(() => { assertPublishable({ ...BASE, mode: "AUTO" }); }).toThrow(/mode/);
    expect(() => { assertPublishable({ ...BASE, errorCode: "OOPS" as never }); }).toThrow(/errorCode/);
  });

  it("refuses a malformed pid", () => {
    expect(() => { assertPublishable({ ...BASE, pid: 0 }); }).toThrow(/pid/);
    expect(() => { assertPublishable({ ...BASE, pid: -1 }); }).toThrow(/pid/);
    expect(() => { assertPublishable({ ...BASE, pid: 1.5 }); }).toThrow(/pid/);
    expect(() => { assertPublishable({ ...BASE, serverPid: 0 }); }).toThrow(/serverPid/);
  });

  it("refuses a malformed timestamp", () => {
    expect(() => { assertPublishable({ ...BASE, startedAt: "yesterday" }); }).toThrow(/startedAt/);
    expect(() => { assertPublishable({ ...BASE, updatedAt: "2026-08-27" }); }).toThrow(/updatedAt/);
  });

  it("refuses a malformed head sequence", () => {
    expect(() => { assertPublishable({ ...BASE, ledgerHeadSequence: -1 }); }).toThrow(/Sequence/);
  });
});

describe("reading a widened or malformed document", () => {
  it("returns null rather than casting it to the interface", () => {
    const root = resolveDaemonRoot();
    writeStatus(root, BASE);
    // Written by hand, past the writer's checks — the shape a future component
    // or an unrelated process could leave behind.
    writeFileSync(statusPath(root), JSON.stringify({ ...BASE, extra: "x" }), "utf8");
    expect(readStatusFrom(root)).toBeNull();

    writeFileSync(statusPath(root), JSON.stringify({ ...BASE, phase: "NOPE" }), "utf8");
    expect(readStatusFrom(root)).toBeNull();

    writeFileSync(statusPath(root), "{ not json", "utf8");
    expect(readStatusFrom(root)).toBeNull();
  });
});

describe("publishing the status", () => {
  it("writes atomically and leaves no temporary behind", () => {
    const root = resolveDaemonRoot();
    writeStatus(root, BASE);
    expect(readStatusFrom(root)).toEqual(BASE);
    // A reader must never be able to catch a half-written file, which is what
    // write-then-rename buys; the absence of the temporary is the evidence.
    expect(existsSync(statusPath(root) + ".tmp")).toBe(false);
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("replaces the previous document rather than appending to it", () => {
    const root = resolveDaemonRoot();
    writeStatus(root, BASE);
    writeStatus(root, { ...BASE, phase: "SUPERVISING" });
    expect(readStatusFrom(root)?.phase).toBe("SUPERVISING");
    expect(JSON.parse(readFileSync(statusPath(root), "utf8"))).toEqual({
      ...BASE,
      phase: "SUPERVISING",
    });
  });

  it("never writes a document it would refuse", () => {
    const root = resolveDaemonRoot();
    expect(() => { writeStatus(root, { ...BASE, scenarioId: "/etc/passwd" }); }).toThrow();
    expect(existsSync(statusPath(root))).toBe(false);
  });

  it("reads back nothing when there is nothing to read", () => {
    const root = resolveDaemonRoot();
    expect(readStatusFrom(root)).toBeNull();
    writeStatus(root, BASE);
    clearStatus(root);
    expect(readStatusFrom(root)).toBeNull();
    clearStatus(root);
  });
});

describe("the server identity a status may carry (V2-B2-6)", () => {
  const START_TOKEN = "Wed Aug 27 18:46:07 2026";
  const IDENTIFIED: DaemonStatusDocument = {
    ...BASE,
    mode: "RESTATE",
    serverPid: 4243,
    serverStartToken: START_TOKEN,
    serverArgvDigest: "b".repeat(64),
  };

  it("P4 accepts the full triple, in the probe's own rendering", () => {
    // The token grammar is the probe's five-field C-locale `lstart` form, not
    // any text that happens to be a date: both sides of the later comparison
    // come from `ps`, so the document may only carry what `ps` renders.
    expect(() => { assertPublishable(IDENTIFIED); }).not.toThrow();
  });

  it("P4 keeps the triple atomic — a half-identity is malformed, not partial", () => {
    // A pid without an identity proves nothing about the process now holding
    // it, and an identity without a pid names nothing to probe. Recovery must
    // never have to decide what half a proof means, so the document refuses to
    // carry one.
    const halves: readonly Partial<DaemonStatusDocument>[] = [
      { serverPid: 4243, serverStartToken: null, serverArgvDigest: null },
      { serverPid: 4243, serverStartToken: START_TOKEN, serverArgvDigest: null },
      { serverPid: 4243, serverStartToken: null, serverArgvDigest: "b".repeat(64) },
      { serverPid: null, serverStartToken: START_TOKEN, serverArgvDigest: "b".repeat(64) },
      { serverPid: null, serverStartToken: START_TOKEN, serverArgvDigest: null },
    ];
    for (const half of halves) {
      expect(() => { assertPublishable({ ...IDENTIFIED, ...half }); }).toThrow();
    }
    // All three null is the SQLITE_SUPERVISOR shape, and is not a half.
    expect(() => {
      assertPublishable({
        ...IDENTIFIED,
        serverPid: null,
        serverStartToken: null,
        serverArgvDigest: null,
      });
    }).not.toThrow();
  });

  it("P4 bounds both fields rather than accepting any string", () => {
    for (const token of ["", "2026-08-27T18:46:07Z", "Wed Aug 27 18:46:07", "x".repeat(200)]) {
      expect(() => {
        assertPublishable({ ...IDENTIFIED, serverStartToken: token });
      }).toThrow();
    }
    for (const digest of ["", "B".repeat(64), "b".repeat(63), "/etc/passwd"]) {
      expect(() => {
        assertPublishable({ ...IDENTIFIED, serverArgvDigest: digest });
      }).toThrow();
    }
  });

  it("P4 refuses a pre-packet document, so an older status vouches for nothing", () => {
    // The migration row, stated rather than discovered: widening the key set
    // makes a status written by an older binary fail validation, `readStatusFrom`
    // returns null, and recovery reclaims the lock and signals nothing. That is
    // the correct direction — a document from a binary that never recorded a
    // server identity cannot be evidence about one.
    const older: Record<string, unknown> = { ...BASE };
    delete older["serverStartToken"];
    delete older["serverArgvDigest"];
    writeFileSync(statusPath(resolveDaemonRoot()), JSON.stringify(older), "utf8");
    expect(readStatusFrom(resolveDaemonRoot())).toBeNull();
  });
});
