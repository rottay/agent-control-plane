import { describe, expect, it } from "vitest";

import { EXIT_PATH, EXIT_USAGE, parseArgv } from "../../src/bin/index.js";

/**
 * Evidence for the operator start entry (P8-8G packet 2, C6).
 *
 * `parseArgv` is pure over its input, so the whole decision an operator can
 * get wrong is testable without starting a server or spawning a process —
 * which is the reason it is a separate exported function rather than inlined.
 */

describe("the entry accepts what an operator legitimately types", () => {
  it("takes the ledger alone", () => {
    const outcome = parseArgv(["--ledger", "/tmp/acp/ledger.sqlite3"]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected options");
    expect(outcome.options.ledgerPath).toBe("/tmp/acp/ledger.sqlite3");
    expect(outcome.options.accountsFilePath).toBeUndefined();
    expect(outcome.options.writeBearerPath).toBeUndefined();
    expect(outcome.options.port).toBeUndefined();
  });

  it("takes every flag together, in any order", () => {
    const outcome = parseArgv([
      "--write-bearer",
      "/tmp/acp/write.token",
      "--port",
      "0",
      "--ledger",
      "/tmp/acp/ledger.sqlite3",
      "--accounts-file",
      "/tmp/acp/accounts.json",
    ]);
    if (!outcome.ok) throw new Error("expected options");
    expect(outcome.options).toEqual({
      ledgerPath: "/tmp/acp/ledger.sqlite3",
      accountsFilePath: "/tmp/acp/accounts.json",
      writeBearerPath: "/tmp/acp/write.token",
      port: 0,
    });
  });

  it("accepts port 0, which asks the OS for a free one", () => {
    const outcome = parseArgv(["--ledger", "/tmp/l.sqlite3", "--port", "0"]);
    if (!outcome.ok) throw new Error("expected options");
    // Zero is a real request, not a missing value: a caller wanting an
    // ephemeral port says 0, and treating it as absent would silently bind
    // the default instead.
    expect(outcome.options.port).toBe(0);
  });
});

describe("the entry refuses by classified reason, never by echoing argv", () => {
  it("requires the ledger", () => {
    expect(parseArgv([])).toEqual({
      ok: false,
      reason: "LEDGER_PATH_REQUIRED",
      exit: EXIT_USAGE,
    });
  });

  it("refuses an unknown flag without repeating what was typed", () => {
    const outcome = parseArgv(["--ledger", "/tmp/l.sqlite3", "--secret", "hunter2"]);
    expect(outcome).toEqual({ ok: false, reason: "UNKNOWN_FLAG", exit: EXIT_USAGE });
    // The reason names the class, not the value. Echoing argv would put
    // whatever the operator typed — possibly a path, possibly a credential
    // they misplaced — into stderr and from there into a log.
    expect(JSON.stringify(outcome)).not.toContain("hunter2");
    expect(JSON.stringify(outcome)).not.toContain("--secret");
  });

  it("refuses a flag with no value, and a flag followed by another flag", () => {
    expect(parseArgv(["--ledger"])).toEqual({
      ok: false,
      reason: "FLAG_WITHOUT_VALUE",
      exit: EXIT_USAGE,
    });
    expect(parseArgv(["--ledger", "--port"])).toEqual({
      ok: false,
      reason: "FLAG_WITHOUT_VALUE",
      exit: EXIT_USAGE,
    });
  });

  it("refuses a relative path, with its own exit code", () => {
    // A usage error rather than a loader's problem: a relative path means
    // something different depending on where the operator was standing.
    const outcome = parseArgv(["--ledger", "ledger.sqlite3"]);
    expect(outcome).toEqual({ ok: false, reason: "PATH_NOT_ABSOLUTE", exit: EXIT_PATH });
    // A distinct code, so a caller can branch without parsing prose.
    expect(EXIT_PATH).not.toBe(EXIT_USAGE);
  });

  it("refuses every relative path, not only the ledger's", () => {
    for (const flag of ["--accounts-file", "--write-bearer"]) {
      const outcome = parseArgv(["--ledger", "/tmp/l.sqlite3", flag, "relative/thing"]);
      expect({ flag, outcome }).toEqual({
        flag,
        outcome: { ok: false, reason: "PATH_NOT_ABSOLUTE", exit: EXIT_PATH },
      });
    }
  });

  it("refuses a port that is not a number, and one out of range", () => {
    expect(parseArgv(["--ledger", "/tmp/l.sqlite3", "--port", "eighty"])).toEqual({
      ok: false,
      reason: "PORT_NOT_A_NUMBER",
      exit: EXIT_USAGE,
    });
    expect(parseArgv(["--ledger", "/tmp/l.sqlite3", "--port", "70000"])).toEqual({
      ok: false,
      reason: "PORT_OUT_OF_RANGE",
      exit: EXIT_USAGE,
    });
  });
});
