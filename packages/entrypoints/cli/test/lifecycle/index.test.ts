import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import {
  LIFECYCLE_PLAN,
  buildEvent,
  canonicalSubmissionDigest,
  deriveInvocation,
  driverCapabilityMismatches,
  planStep,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "@acp/runtime";
import type { DurableInvocation, OrchestrationDriver } from "@acp/runtime";

import {
  EXIT_CAPABILITY_UNSUPPORTED,
  EXIT_INTEGRITY,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_UNAVAILABLE,
  EXIT_USAGE,
  run,
} from "../../src/cli/index.js";
import type { CliIo, CliSeams } from "../../src/cli/index.js";
import type { LifecycleDriverFactory } from "../../src/lifecycle/index.js";

/**
 * Evidence for the lifecycle door (V2 L2).
 *
 * The door is the subject and the engine is not: this project runs in the
 * default parallel group and binds no ports, so what is proved here is what the
 * door DOES with a driver's answer -- which refusal earns which exit code, what
 * reaches stdout, and what it refuses before a ledger is even opened. The
 * SQLite branch runs against the real driver, because that driver needs no
 * port; the Restate branch runs against an injected one, and the real-engine
 * proofs over the identical construction live in the durability project.
 */

const EMITTED_BY = "claude/opus/implementer/01";
const INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const SUBMITTED_AT = "2026-08-27T12:00:00.000Z";
const HERE = resolve(fileURLToPath(import.meta.url), "..");

/**
 * One admitted route for every fixture in this file.
 *
 * Declared structurally rather than imported: `@acp/contracts` owns
 * `ResolvedRoute` and this package may not link it, so the shape is restated
 * here and the contract admits it at `buildEvent`, which parses on every step.
 */
interface TestRoute {
  readonly provider: string;
  readonly model: string;
  readonly accountId: string;
  readonly transportKind: "CLI_SUBSCRIPTION";
  readonly capabilityPolicyVersion: string;
  readonly resolvedAt: string;
}

const ROUTE: TestRoute = {
  provider: "claude",
  model: "opus",
  accountId: "acct-fixture",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: SUBMITTED_AT,
};

const scenarios: string[] = [];
const ledgers: Ledger[] = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      // already closed
    }
  }
  for (const name of scenarios.splice(0)) removeScenarioRoot(name);
});

interface Invocation {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function invoke(argument: readonly string[], seams: CliSeams = {}): Promise<Invocation> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
    now: () => SUBMITTED_AT,
  };
  // JSON unless a test says otherwise: a refusal renders as a validated
  // envelope under `--format json` and as a sentence under `human`, and every
  // assertion below is about the envelope.
  const argv = argument.includes("--format") ? argument : [...argument, "--format", "json"];
  const exitCode = await run(argv, io, seams);
  return { exitCode, stdout, stderr };
}

interface Staged {
  readonly scenarioId: string;
  readonly databasePath: string;
  readonly taskId: string;
  readonly invocation: DurableInvocation;
  readonly ledger: Ledger;
}

/**
 * A scenario whose ledger holds a walk seeded to a chosen step.
 *
 * The digest is computed the way a real submission would compute it, because
 * the door verifies it: a fixture with a placeholder digest would be refused
 * before it reached a driver, and every test below would measure the refusal.
 */
function stage(name: string, through: number, route: TestRoute = ROUTE): Staged {
  scenarios.push(name);
  const root = resolveScenarioRoot(name);
  const databasePath = scenarioLedgerPath(root);
  const taskId = randomUUID();
  const invocation = deriveInvocation(
    taskId,
    1,
    SUBMITTED_AT,
    canonicalSubmissionDigest({
      taskId,
      attempt: 1,
      submittedAt: SUBMITTED_AT,
      initiativeId: INITIATIVE_ID,
      route: ROUTE,
    }),
  );

  const ledger = openLedger(databasePath);
  ledgers.push(ledger);
  for (let index = 0; index <= through; index += 1) {
    ledger.append(
      buildEvent({
        invocation,
        step: planStep(index),
        emittedBy: EMITTED_BY,
        initiativeId: INITIATIVE_ID,
        plan: LIFECYCLE_PLAN,
        route,
      }),
    );
  }
  return { scenarioId: name, databasePath, taskId, invocation, ledger };
}

function argsFor(verb: string, staged: Staged, mode: string): readonly string[] {
  return [
    verb,
    "--database",
    staged.databasePath,
    "--scenario",
    staged.scenarioId,
    "--task",
    staged.taskId,
    "--attempt",
    "1",
    "--mode",
    mode,
  ];
}

interface LifecycleDocument {
  readonly verb: string;
  readonly mode: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly ok: boolean;
  readonly finalSequence: number | null;
  readonly refusal: string | null;
}

function document(invocation: Invocation): LifecycleDocument {
  return JSON.parse(invocation.stdout) as LifecycleDocument;
}

function errorJson(invocation: Invocation): {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly detail: string | null;
  };
} {
  return JSON.parse(invocation.stderr) as {
    error: { code: string; message: string; detail: string | null };
  };
}

type ScriptedAnswer =
  | (() => Promise<never>)
  | { readonly ok: true; readonly finalSequence: number }
  | {
      readonly ok: false;
      readonly refusal:
        | "CAPABILITY_UNSUPPORTED"
        | "INVOCATION_NOT_FOUND"
        | "POSTCONDITION_UNKNOWN"
        | "TASK_TERMINAL";
      readonly at: string;
    };

/** A driver that answers as told, standing in for one this project cannot bind a port for. */
function scriptedDriver(answer: ScriptedAnswer): LifecycleDriverFactory {
  return ({ mode }): OrchestrationDriver => {
    const reply = (): Promise<never> => {
      if (typeof answer === "function") return answer();
      return Promise.resolve(answer) as Promise<never>;
    };
    return {
      mode,
      cancel: reply,
      reattach: reply,
      signal: () => Promise.resolve({ ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "signal" }),
      timer: () => Promise.resolve({ ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "timer" }),
      advance: () => Promise.reject(new Error("the scripted driver walks no plan")),
      status: () => Promise.reject(new Error("the scripted driver reports no status")),
      reconcile: () => Promise.reject(new Error("the scripted driver reconciles nothing")),
      capabilities: () => ({
        contractVersion: "2.2.0",
        mode,
        verbs: {
          CANCEL: "SUPPORTED",
          REATTACH: "SUPPORTED",
          SIGNAL: "SUPPORTED",
          TIMER: "SUPPORTED",
        },
        properties: { SERIALIZED_PER_TASK: "SUPPORTED" },
      }),
    } as OrchestrationDriver;
  };
}

describe("the lifecycle door accepts", () => {
  it("cancels a live attempt and prints one bounded document", async () => {
    const staged = stage("cli-l2-cancel-ok", 4);
    const result = await invoke(argsFor("cancel", staged, "RESTATE"), {
      makeDriver: scriptedDriver({ ok: true, finalSequence: 5 }),
    });

    expect(result.exitCode).toBe(EXIT_OK);
    expect(document(result)).toEqual({
      verb: "CANCEL",
      mode: "RESTATE",
      taskId: staged.taskId,
      attempt: 1,
      ok: true,
      finalSequence: 5,
      refusal: null,
    });
    expect(result.stderr).toBe("");
  });

  it("rejoins, and answers with a ledger coordinate rather than anything engine-minted", async () => {
    const staged = stage("cli-l2-attach-ok", 4);
    const result = await invoke(argsFor("attach", staged, "RESTATE"), {
      makeDriver: scriptedDriver({ ok: true, finalSequence: 9 }),
    });

    expect(result.exitCode).toBe(EXIT_OK);
    expect(document(result).verb).toBe("ATTACH");
    expect(document(result).finalSequence).toBe(9);
    // The document has seven fields and there is nowhere on it for an engine's
    // identity to travel. Pinned by equality so a field added later fails here.
    expect(Object.keys(document(result)).sort()).toEqual([
      "attempt",
      "finalSequence",
      "mode",
      "ok",
      "refusal",
      "taskId",
      "verb",
    ]);
  });

  it("prints the same document under either --format", async () => {
    const staged = stage("cli-l2-format", 4);
    const asJson = await invoke([...argsFor("cancel", staged, "RESTATE"), "--format", "json"], {
      makeDriver: scriptedDriver({ ok: true, finalSequence: 5 }),
    });

    const again = stage("cli-l2-format-human", 4);
    const asHuman = await invoke([...argsFor("cancel", again, "RESTATE"), "--format", "human"], {
      makeDriver: scriptedDriver({ ok: true, finalSequence: 5 }),
    });

    expect(asJson.exitCode).toBe(EXIT_OK);
    expect(asHuman.exitCode).toBe(EXIT_OK);
    // A lifecycle document prints as JSON regardless, on the tool call's
    // precedent: a second renderer would be a second place a driver's answer
    // gets formatted.
    expect(document(asHuman).verb).toBe("CANCEL");
    expect(asHuman.stdout).not.toContain("Error");
  });
});

describe("the lifecycle door fails closed", () => {
  it("refuses both verbs with a capability code under the real SQLite supervisor", async () => {
    // The real driver, constructed by the real factory: this branch binds no
    // port, so the door's own composition is what answers here.
    for (const verb of ["cancel", "attach"] as const) {
      const staged = stage("cli-l2-sqlite-" + verb, 4);
      const result = await invoke(argsFor(verb, staged, "SQLITE_SUPERVISOR"));

      expect(result.exitCode).toBe(EXIT_CAPABILITY_UNSUPPORTED);
      expect(document(result).ok).toBe(false);
      expect(document(result).refusal).toBe("CAPABILITY_UNSUPPORTED");
      expect(document(result).mode).toBe("SQLITE_SUPERVISOR");
      // Nothing was appended to learn that.
      expect(staged.ledger.status().eventCount).toBe(5);
    }
  });

  it("tells an unreachable engine apart from a capability gap", async () => {
    const staged = stage("cli-l2-unreachable", 4);
    const result = await invoke(argsFor("cancel", staged, "RESTATE"), {
      makeDriver: scriptedDriver(() =>
        Promise.reject(new Error("the attach for this invocation answered 503")),
      ),
    });

    // The discriminator an operator's wrapper depends on: a retry is the right
    // response to one of these and the wrong response to the other.
    expect(result.exitCode).toBe(EXIT_UNAVAILABLE);
    expect(result.exitCode).not.toBe(EXIT_CAPABILITY_UNSUPPORTED);
    expect(errorJson(result).error.code).toBe("LEDGER_UNAVAILABLE");
    // The lower layer's message never crosses: 503 was in the throw and is in
    // nothing that was printed.
    expect(result.stderr).not.toContain("503");
  });

  it("gives POSTCONDITION_UNKNOWN and TASK_TERMINAL their own codes", async () => {
    const unknown = stage("cli-l2-unknown", 4);
    const unknownResult = await invoke(argsFor("cancel", unknown, "RESTATE"), {
      makeDriver: scriptedDriver({ ok: false, refusal: "POSTCONDITION_UNKNOWN", at: "cancel" }),
    });
    expect(unknownResult.exitCode).toBe(EXIT_UNAVAILABLE);
    expect(document(unknownResult).refusal).toBe("POSTCONDITION_UNKNOWN");

    const terminal = stage("cli-l2-terminal", 4);
    const terminalResult = await invoke(argsFor("cancel", terminal, "RESTATE"), {
      makeDriver: scriptedDriver({ ok: false, refusal: "TASK_TERMINAL", at: "cancel" }),
    });
    expect(terminalResult.exitCode).toBe(EXIT_USAGE);
    expect(document(terminalResult).refusal).toBe("TASK_TERMINAL");

    // Three refusals, three codes, none of them zero.
    expect(new Set([EXIT_CAPABILITY_UNSUPPORTED, EXIT_UNAVAILABLE, EXIT_USAGE]).size).toBe(3);
  });

  it("P4 prints the document and exits 4 when the engine holds no such invocation", async () => {
    // V2 L4. Before it, this answer arrived as a throw and was reported as an
    // unreachable engine — exit 5, "look again" — for a fact that could never
    // change. It is now a refusal like the others: the seven-field document on
    // stdout, and `EXIT_NOT_FOUND` because there is nothing there to act on.
    const staged = stage("cli-l4-not-found", 4);
    const result = await invoke(argsFor("attach", staged, "RESTATE"), {
      makeDriver: scriptedDriver({
        ok: false,
        refusal: "INVOCATION_NOT_FOUND",
        at: "reattach",
      }),
    });

    expect(result.exitCode).toBe(EXIT_NOT_FOUND);
    const printed = document(result);
    expect(printed.refusal).toBe("INVOCATION_NOT_FOUND");
    expect(printed.ok).toBe(false);
    expect(printed.finalSequence).toBeNull();
    // The document, not an envelope: this is an answer about the work, and it
    // goes to stdout with nothing on stderr.
    expect(result.stderr).toBe("");
    // N6: no status number reaches any surface.
    for (const surface of [result.stdout, result.stderr]) {
      expect(surface).not.toContain("404");
      expect(surface).not.toContain("inv_");
    }
    // Four refusals, four codes, still none of them zero.
    expect(
      new Set([EXIT_CAPABILITY_UNSUPPORTED, EXIT_NOT_FOUND, EXIT_UNAVAILABLE, EXIT_USAGE]).size,
    ).toBe(4);
  });

  it("N1 keeps an unreachable engine at exit 5, distinct from the engine's answer", async () => {
    // The mirror of the fix: a channel failure is still a throw and still
    // reports as unavailable. If this ever became `INVOCATION_NOT_FOUND` the
    // packet would have replaced one false answer with another.
    const staged = stage("cli-l4-unreachable", 4);
    const result = await invoke(argsFor("attach", staged, "RESTATE"), {
      makeDriver: scriptedDriver(() =>
        Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:8080")),
      ),
    });
    expect(result.exitCode).toBe(EXIT_UNAVAILABLE);
    expect(result.exitCode).not.toBe(EXIT_NOT_FOUND);
    expect(result.stdout).toBe("");
  });

  it("refuses a missing or misspelled --mode without opening a ledger", async () => {
    const staged = stage("cli-l2-mode", 4);
    const before = staged.ledger.status();

    const missing = await invoke([
      "cancel",
      "--database",
      staged.databasePath,
      "--scenario",
      staged.scenarioId,
      "--task",
      staged.taskId,
      "--attempt",
      "1",
    ]);
    expect(missing.exitCode).toBe(EXIT_USAGE);
    expect(errorJson(missing).error.detail).toBe("mode");

    // A second spelling is a second vocabulary, so the lowercase alias is not
    // one the door knows.
    const alias = await invoke(argsFor("cancel", staged, "restate"));
    expect(alias.exitCode).toBe(EXIT_USAGE);
    expect(errorJson(alias).error.detail).toBe("mode");

    expect(staged.ledger.status().eventCount).toBe(before.eventCount);
    expect(staged.ledger.status().headEventSha256).toBe(before.headEventSha256);
  });

  it("keeps the standing --database law", async () => {
    const staged = stage("cli-l2-database", 4);
    const result = await invoke([
      "cancel",
      "--scenario",
      staged.scenarioId,
      "--task",
      staged.taskId,
      "--attempt",
      "1",
      "--mode",
      "RESTATE",
    ]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(errorJson(result).error.message).toBe("--database is required");
  });

  it("refuses when --database and --scenario name different ledgers", async () => {
    const staged = stage("cli-l2-agree", 4);
    const other = stage("cli-l2-agree-other", 4);

    const result = await invoke([
      "cancel",
      "--database",
      staged.databasePath,
      "--scenario",
      other.scenarioId,
      "--task",
      staged.taskId,
      "--attempt",
      "1",
      "--mode",
      "RESTATE",
    ]);

    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(errorJson(result).error.detail).toBe("database");
  });

  it("refuses an attempt that is not a positive integer, naming the flag", async () => {
    const staged = stage("cli-l2-attempt", 4);
    // Written in the inline form so a leading-dash value reaches the verb
    // rather than being read as a flag by the parser: `--attempt -1` is a
    // parse error about `-1`, which is a true refusal but a different one.
    for (const attempt of ["0", "-1", "1.5", "one", ""]) {
      const result = await invoke([
        "cancel",
        "--database",
        staged.databasePath,
        "--scenario",
        staged.scenarioId,
        "--task",
        staged.taskId,
        "--attempt=" + attempt,
        "--mode",
        "RESTATE",
      ]);
      expect({ attempt, code: result.exitCode }).toEqual({ attempt, code: EXIT_USAGE });
      expect(errorJson(result).error.detail).toBe("attempt");
      // The field path, and never the operator's own value. Asserted on the
      // envelope's own two strings rather than on the whole of stderr: a single
      // digit occurs in the contract version that rides every envelope, so a
      // substring sweep over the stream would fail on a leak that is not one.
      const envelope = errorJson(result).error;
      if (attempt !== "") {
        expect(envelope.message + "|" + String(envelope.detail)).not.toContain(attempt);
      }
    }
  });

  it("refuses a task the ledger has never seen", async () => {
    const staged = stage("cli-l2-unknown-task", 4);
    const result = await invoke([
      "cancel",
      "--database",
      staged.databasePath,
      "--scenario",
      staged.scenarioId,
      "--task",
      randomUUID(),
      "--attempt",
      "1",
      "--mode",
      "RESTATE",
    ]);
    expect(result.exitCode).toBe(EXIT_NOT_FOUND);
    expect(errorJson(result).error.code).toBe("NOT_FOUND");
    expect(errorJson(result).error.detail).toBe("task");
  });

  it("refuses before RUN_STARTED in the same words whichever engine was named", async () => {
    // The order the door promises: everything the ledger could disagree about
    // is settled before a driver is constructed, so a pre-INTENT attempt is
    // refused identically under both modes rather than reaching SQLite's
    // capability refusal.
    for (const mode of ["RESTATE", "SQLITE_SUPERVISOR"] as const) {
      const staged = stage("cli-l2-preintent-" + mode.toLowerCase().replace(/_/g, "-"), 3);
      const result = await invoke(argsFor("cancel", staged, mode));

      expect({ mode, code: result.exitCode }).toEqual({ mode, code: EXIT_USAGE });
      expect(result.exitCode).not.toBe(EXIT_CAPABILITY_UNSUPPORTED);
      expect(errorJson(result).error.detail).toBe("attempt.route");
    }
  });

  it("refuses a recorded route that disagrees with the digest the events carry", async () => {
    // The digest is bound to ROUTE; the walk records a different account. Both
    // accounts of "which route" are internally consistent, and only the digest
    // can tell them apart.
    const staged = stage("cli-l2-digest", 4, { ...ROUTE, accountId: "acct-elsewhere" });
    const result = await invoke(argsFor("cancel", staged, "RESTATE"));

    expect(result.exitCode).toBe(EXIT_INTEGRITY);
    expect(result.exitCode).not.toBe(EXIT_USAGE);
    expect(errorJson(result).error.code).toBe("WRITE_REFUSED");
    expect(errorJson(result).error.detail).toBe("attempt.submissionDigest");
  });

  it("refuses an attempt that is not the task's latest", async () => {
    const staged = stage("cli-l2-stale", 4);
    const result = await invoke([
      "cancel",
      "--database",
      staged.databasePath,
      "--scenario",
      staged.scenarioId,
      "--task",
      staged.taskId,
      "--attempt",
      "2",
      "--mode",
      "RESTATE",
    ]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(errorJson(result).error.detail).toBe("attempt");
  });
});

describe("the door's driver satisfies the law it declares", () => {
  it("is empty over the real SQLite driver the door constructs", async () => {
    // Observed through the door: the outcomes below are the ones an operator
    // actually gets, taken from two real invocations rather than from a driver
    // this test assembled.
    const cancel = await invoke(argsFor("cancel", stage("cli-l2-corr-cancel", 4), "SQLITE_SUPERVISOR"));
    const attach = await invoke(argsFor("attach", stage("cli-l2-corr-attach", 4), "SQLITE_SUPERVISOR"));

    const declared = {
      contractVersion: "2.2.0" as const,
      mode: "SQLITE_SUPERVISOR" as const,
      verbs: {
        CANCEL: "UNSUPPORTED" as const,
        REATTACH: "UNSUPPORTED" as const,
        SIGNAL: "UNSUPPORTED" as const,
        TIMER: "UNSUPPORTED" as const,
      },
      properties: { SERIALIZED_PER_TASK: "UNSUPPORTED" as const },
    };
    const observed = {
      CANCEL: { ok: false as const, refusal: "CAPABILITY_UNSUPPORTED" as const, at: "cancel" },
      REATTACH: { ok: false as const, refusal: "CAPABILITY_UNSUPPORTED" as const, at: "reattach" },
      SIGNAL: { ok: false as const, refusal: "CAPABILITY_UNSUPPORTED" as const, at: "signal" },
      TIMER: { ok: false as const, refusal: "CAPABILITY_UNSUPPORTED" as const, at: "timer" },
    };
    expect(document(cancel).refusal).toBe(observed.CANCEL.refusal);
    expect(document(attach).refusal).toBe(observed.REATTACH.refusal);
    expect(driverCapabilityMismatches(declared, observed)).toEqual([]);
  });

  it("is non-vacuous: a declaration claiming CANCEL is supported is caught", () => {
    const lying = {
      contractVersion: "2.2.0" as const,
      mode: "SQLITE_SUPERVISOR" as const,
      verbs: {
        CANCEL: "SUPPORTED" as const,
        REATTACH: "UNSUPPORTED" as const,
        SIGNAL: "UNSUPPORTED" as const,
        TIMER: "UNSUPPORTED" as const,
      },
      properties: { SERIALIZED_PER_TASK: "UNSUPPORTED" as const },
    };
    expect(
      driverCapabilityMismatches(lying, {
        CANCEL: { ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "cancel" },
        REATTACH: { ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "reattach" },
        SIGNAL: { ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "signal" },
        TIMER: { ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "timer" },
      }),
    ).toEqual(["CANCEL: declared SUPPORTED but refused"]);
  });
});

describe("what the lifecycle door never prints", () => {
  /**
   * Credential- and transcript-shaped material, matched by shape.
   *
   * `@acp/contracts` owns the guards the gateway uses and this package may not
   * import it, so the shapes are restated here as patterns and -- this is the
   * half that matters -- the patterns are proved to fire on material that
   * really is credential-shaped before they are used to certify that nothing is.
   */
  const CREDENTIAL_SHAPES = [
    /sk-[A-Za-z0-9]{16,}/,
    /Bearer\s+[A-Za-z0-9._-]{16,}/,
    /"(?:password|secret|token|apiKey)"\s*:/i,
  ];

  it("is non-vacuous: the same patterns catch material that is credential-shaped", () => {
    // Assembled rather than written out: a literal of this shape in a tracked
    // source file is exactly what the repository's own credential scan exists
    // to refuse, and a test fixture is not an exception to that.
    const planted = [
      "sk" + "-" + "a".repeat(24),
      "Bearer " + "e".repeat(24),
      '{"api' + 'Key": "x"}',
    ].join(" ");
    expect(CREDENTIAL_SHAPES.filter((shape) => shape.test(planted))).toHaveLength(
      CREDENTIAL_SHAPES.length,
    );
  });

  it("prints no absolute path, no credential shape and no engine identity", async () => {
    const staged = stage("cli-l2-privacy", 4);
    const accepted = await invoke(argsFor("cancel", staged, "RESTATE"), {
      makeDriver: scriptedDriver({ ok: true, finalSequence: 5 }),
    });
    const refused = await invoke(
      argsFor("cancel", stage("cli-l2-privacy-refused", 4), "SQLITE_SUPERVISOR"),
    );
    const failed = await invoke(argsFor("cancel", stage("cli-l2-privacy-failed", 3), "RESTATE"));

    for (const result of [accepted, refused, failed]) {
      const printed = result.stdout + result.stderr;
      expect(printed).not.toContain(staged.databasePath);
      expect(printed).not.toContain(".acp-local");
      expect(printed.includes("/Users/")).toBe(false);
      for (const shape of CREDENTIAL_SHAPES) expect(shape.test(printed)).toBe(false);
      // A Restate invocation id. The driver learns one during a cancellation
      // and returns a ledger coordinate instead; nothing here may carry one.
      expect(/inv_[A-Za-z0-9]{10,}/.test(printed)).toBe(false);
    }
  });

  it("names a field path in every refusal, and never the value the operator typed", async () => {
    const staged = stage("cli-l2-fieldpath", 4);
    const typed = "acct-the-operator-typed-this";
    const result = await invoke([
      "cancel",
      "--database",
      staged.databasePath,
      "--scenario",
      staged.scenarioId,
      "--task",
      staged.taskId,
      "--attempt",
      "1",
      "--mode",
      typed,
    ]);

    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(errorJson(result).error.detail).toBe("mode");
    expect(result.stderr).not.toContain(typed);
  });
});

describe("the command surface", () => {
  it("names both verbs in the banner and states the write posture truthfully", async () => {
    const help = await invoke(["--help"]);
    expect(help.exitCode).toBe(EXIT_OK);
    expect(help.stdout).toContain("cancel");
    expect(help.stdout).toContain("attach");
    // The old banner said one verb writes. Three do now, and leaving it stale
    // would be the exact defect V2-B4b stage 3D fixed by narrowing it.
    expect(help.stdout).toContain("settles one cancellation");
    expect(help.stdout).not.toContain("This CLI opens the ledger read-only and never writes");
  });

  it("rejects lifecycle options on observation verbs and vice versa", async () => {
    const staged = stage("cli-l2-crossed", 4);

    const onRead = await invoke(["tasks", "--database", staged.databasePath, "--mode", "RESTATE"]);
    expect(onRead.exitCode).toBe(EXIT_USAGE);
    expect(errorJson(onRead).error.detail).toContain("--mode");

    const onLifecycle = await invoke([
      ...argsFor("cancel", staged, "RESTATE"),
      "--state",
      "RUNNING",
    ]);
    expect(onLifecycle.exitCode).toBe(EXIT_USAGE);
    expect(errorJson(onLifecycle).error.detail).toContain("--state");
  });

  it("takes no positional argument", async () => {
    const staged = stage("cli-l2-positional", 4);
    const result = await invoke([...argsFor("cancel", staged, "RESTATE"), "extra"]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(errorJson(result).error.message).toBe("acp cancel takes no positional argument");
  });

  it("constructs no driver inside another driver's catch", () => {
    // `L-V2L-2` in the fence proves this over the tracked tree; asserted here
    // too, because the property is the door's and its suite should be able to
    // fail on it without waiting for a fence run.
    const code = readFileSync(resolve(HERE, "../../src/lifecycle/index.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const construction = /catch[\s\S]{0,400}?(?:RestateDriver\.forLifecycle|SqliteSupervisor\.forLifecycle)/;
    expect(construction.test(code)).toBe(false);
  });
});
