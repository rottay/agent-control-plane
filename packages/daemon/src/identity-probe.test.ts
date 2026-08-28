import { describe, expect, it } from "vitest";

import { IdentityProbeError } from "./errors.js";
import type { ProcessFacts, ProcessInspector, RecordedIdentity } from "./identity-probe.js";
import {
  commandDigest,
  createPsInspector,
  interpretPsResult,
  ownIdentity,
  parsePsLine,
  probeIdentity,
} from "./identity-probe.js";

const RECORDED: RecordedIdentity = {
  pid: 4242,
  startToken: "Wed Aug 27 18:46:07 2026",
  argvDigest: commandDigest("node /repo/daemon-child.js {}"),
};

function inspectorReturning(facts: ProcessFacts | null): ProcessInspector {
  return { inspect: () => Promise.resolve(facts) };
}

function inspectorThrowing(): ProcessInspector {
  return { inspect: () => Promise.reject(new IdentityProbeError("ps is unavailable")) };
}

describe("parsing a ps line", () => {
  it("splits the C-locale start time from the command", () => {
    const facts = parsePsLine("Wed Aug 27 18:46:07 2026 node /repo/daemon-child.js {}");
    expect(facts?.startToken).toBe("Wed Aug 27 18:46:07 2026");
    expect(facts?.argvDigest).toBe(commandDigest("node /repo/daemon-child.js {}"));
  });

  it("collapses whitespace so two renderings of one argv agree", () => {
    const spaced = parsePsLine("Wed Aug  27 18:46:07 2026 node   /repo/x.js");
    const tight = parsePsLine("Wed Aug 27 18:46:07 2026 node /repo/x.js");
    expect(spaced?.argvDigest).toBe(tight?.argvDigest);
  });

  it("returns null rather than guessing at an unparseable line", () => {
    expect(parsePsLine("")).toBeNull();
    expect(parsePsLine("nonsense")).toBeNull();
    expect(parsePsLine("Wed Aug 27 18:46:07 2026")).toBeNull();
  });
});

describe("classifying a recorded identity", () => {
  it("is SAME_LIVE_DAEMON only when start time and argv both agree", async () => {
    const inspector = inspectorReturning({
      startToken: RECORDED.startToken,
      argvDigest: RECORDED.argvDigest,
    });
    await expect(probeIdentity(RECORDED, inspector, "darwin")).resolves.toBe("SAME_LIVE_DAEMON");
  });

  it("is NOT_SAME when no such process exists", async () => {
    await expect(probeIdentity(RECORDED, inspectorReturning(null), "darwin")).resolves.toBe(
      "NOT_SAME",
    );
  });

  it("is NOT_SAME when the pid was recycled", async () => {
    // A recycled pid has a later start time. This is the one case the probe can
    // actually prove, which is why it is the only one that permits recovery.
    const inspector = inspectorReturning({
      startToken: "Thu Aug 28 09:00:00 2026",
      argvDigest: RECORDED.argvDigest,
    });
    await expect(probeIdentity(RECORDED, inspector, "darwin")).resolves.toBe("NOT_SAME");
  });

  it("is INDETERMINATE when the start time agrees but the argv does not", async () => {
    // Deliberately not NOT_SAME. It could be a rendering difference or a
    // different program, and both are reasons to leave the lock alone.
    const inspector = inspectorReturning({
      startToken: RECORDED.startToken,
      argvDigest: commandDigest("node /repo/something-else.js"),
    });
    await expect(probeIdentity(RECORDED, inspector, "darwin")).resolves.toBe("INDETERMINATE");
  });

  it("is INDETERMINATE when the probe cannot run at all", async () => {
    await expect(probeIdentity(RECORDED, inspectorThrowing(), "darwin")).resolves.toBe(
      "INDETERMINATE",
    );
  });

  it("is UNSUPPORTED_PLATFORM off Darwin, without consulting the inspector", async () => {
    let consulted = 0;
    const inspector: ProcessInspector = {
      inspect: () => {
        consulted += 1;
        return Promise.resolve(null);
      },
    };
    await expect(probeIdentity(RECORDED, inspector, "linux")).resolves.toBe(
      "UNSUPPORTED_PLATFORM",
    );
    expect(consulted).toBe(0);
  });
});

describe("the real ps inspector", () => {
  it("treats only exit 1 as an absent process", () => {
    expect(interpretPsResult(1, "")).toBeNull();
    expect(interpretPsResult(1, "anything at all")).toBeNull();
  });

  it("refuses to read a successful but empty answer as a dead process", () => {
    // This is the dangerous confusion. "ps worked and said nothing I can read"
    // is not "the process is gone" — and NOT_SAME is the one verdict explicit
    // recovery acts on, so getting it wrong removes a live daemon's lock.
    expect(() => interpretPsResult(0, "")).toThrow(IdentityProbeError);
    expect(() => interpretPsResult(0, "   \n  \n")).toThrow(IdentityProbeError);
  });

  it("refuses to read unparseable output as a dead process", () => {
    expect(() => interpretPsResult(0, "garbage without a date")).toThrow(IdentityProbeError);
    // A locale-shaped line: plausible, and still not the C-locale format the
    // parser was written against.
    expect(() => interpretPsResult(0, "mié 27 ago 2026 18:46:07 node x.js")).toThrow(
      IdentityProbeError,
    );
  });

  it("accepts a well-formed successful answer", () => {
    const facts = interpretPsResult(0, "Wed Aug 27 18:46:07 2026 node /repo/x.js");
    expect(facts?.startToken).toBe("Wed Aug 27 18:46:07 2026");
  });

  it("turns an unreadable answer into INDETERMINATE, never NOT_SAME", async () => {
    const hostile: ProcessInspector = {
      inspect: () => Promise.reject(new IdentityProbeError("ps output could not be parsed")),
    };
    await expect(probeIdentity(RECORDED, hostile, "darwin")).resolves.toBe("INDETERMINATE");
  });

  it("observes this very process", async () => {
    const inspector = createPsInspector();
    const facts = await inspector.inspect(process.pid);
    expect(facts).not.toBeNull();
    expect(facts?.startToken).toMatch(new RegExp("\\d{2}:\\d{2}:\\d{2}"));
  });

  it("reports an absent process as absent rather than as a failure", async () => {
    const inspector = createPsInspector();
    // A pid above the platform maximum cannot exist.
    await expect(inspector.inspect(4_194_303)).resolves.toBeNull();
  });

  it("refuses a pid that is not a positive integer", async () => {
    const inspector = createPsInspector();
    await expect(inspector.inspect(0)).rejects.toThrow(IdentityProbeError);
    await expect(inspector.inspect(-1)).rejects.toThrow(IdentityProbeError);
  });

  it("records an identity that a later probe agrees with", async () => {
    const inspector = createPsInspector();
    const first = await ownIdentity(inspector);
    expect(first.pid).toBe(process.pid);
    await expect(probeIdentity(first, inspector, "darwin")).resolves.toBe("SAME_LIVE_DAEMON");
  });

  it("records what ps reports, not what process.argv says", async () => {
    // These are two different strings. process.argv is what this runtime
    // parsed; ps reports the operating system's rendering of the command line,
    // and under a test runner they do not match. Recording one and observing
    // the other would make every live daemon look indeterminate, so the
    // recorded digest must come from the same source the probe will consult.
    const identity = await ownIdentity(createPsInspector());
    expect(identity.argvDigest).not.toBe(commandDigest(process.argv.join(" ")));
  });
});
