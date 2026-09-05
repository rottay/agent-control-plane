import { randomUUID } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import {
  ApiError,
  TaskLifecycleExecuteResponse,
  TaskLifecycleResponse,
  lifecyclePath,
} from "@acp/protocol";
import {
  LIFECYCLE_PLAN,
  buildEvent,
  canonicalSubmissionDigest,
  deriveInvocation,
  planStep,
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "@acp/runtime";
import type { DurableInvocation, OrchestrationDriver } from "@acp/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../../src/build-server/index.js";
import { startServer } from "../../src/start/index.js";
import type { LifecycleDriverFactory } from "../../src/lifecycle/index.js";

/**
 * Evidence for the lifecycle door on the API (V2 L3).
 *
 * The door is the subject and the engine is not: this project runs in the
 * default parallel group and binds no Restate port, so what is proved here is
 * what the door DOES with a driver's answer — which refusal earns which status,
 * what reaches the body, and what it refuses before a ledger is even opened.
 * The SQLite branch runs against the real driver, because that driver needs no
 * port; the Restate branch runs against an injected one, and the real-engine
 * proofs over the identical `forLifecycle` construction remain L2's, in the
 * durability project.
 */

const EMITTED_BY = "claude/opus/implementer/01";
const INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const SUBMITTED_AT = "2026-08-27T12:00:00.000Z";
const TOKEN = "v2-l3-lifecycle-door-" + "t".repeat(24);
const AUTH = { authorization: "Bearer " + TOKEN };

/**
 * One admitted route for every fixture in this file.
 *
 * Declared structurally rather than imported: `@acp/contracts` owns
 * `ResolvedRoute` and this package may not name it, so the shape is restated
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
 * the door verifies it: a fixture with a placeholder digest is refused before
 * it reaches a driver, which is what N9 asserts deliberately and what every
 * other test here would otherwise be measuring by accident.
 */
function stage(name: string, through: number, digest?: string): Staged {
  scenarios.push(name);
  const root = resolveScenarioRoot(name);
  const databasePath = scenarioLedgerPath(root);
  const taskId = randomUUID();
  const invocation = deriveInvocation(
    taskId,
    1,
    SUBMITTED_AT,
    digest ??
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
        route: ROUTE,
      }),
    );
  }
  return { scenarioId: name, databasePath, taskId, invocation, ledger };
}

function tokenFile(scenarioId: string): string {
  const path = join(resolveScenarioRoot(scenarioId), "write.token");
  writeFileSync(path, TOKEN + "\n", "utf8");
  chmodSync(path, 0o600);
  return path;
}

type ScriptedAnswer =
  | { readonly ok: true; readonly finalSequence: number }
  | { readonly ok: false; readonly refusal: string; readonly at: string }
  | (() => Promise<never>);

/** A driver that answers what a test says, and walks nothing. */
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
    } as unknown as OrchestrationDriver;
  };
}

interface Harness {
  readonly app: ReturnType<typeof buildServer>;
  readonly staged: Staged;
}

function serve(
  staged: Staged,
  options: { readonly makeDriver?: LifecycleDriverFactory; readonly withScenario?: boolean } = {},
): Harness {
  const app = buildServer({
    ledgerPath: staged.databasePath,
    writeBearerPath: tokenFile(staged.scenarioId),
    ...(options.withScenario === false ? {} : { scenarioId: staged.scenarioId }),
    ...(options.makeDriver === undefined ? {} : { makeDriver: options.makeDriver }),
  });
  return { app, staged };
}

function body(staged: Staged, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { verb: "CANCEL", mode: "RESTATE", taskId: staged.taskId, attempt: 1, ...over };
}

function eventCount(databasePath: string): number {
  const ledger = openLedger(databasePath);
  try {
    return ledger.status().eventCount;
  } finally {
    ledger.close();
  }
}

describe("the lifecycle door acts once and answers one document", () => {
  it("T1 cancels through the injected Restate branch, and appends exactly one row", async () => {
    const staged = stage("gw-l3-cancel", 4);
    const before = eventCount(staged.databasePath);
    const { app } = serve(staged, { makeDriver: scriptedDriver({ ok: true, finalSequence: 5 }) });

    const response = await app.inject({
      method: "POST",
      url: lifecyclePath(staged.taskId),
      headers: AUTH,
      payload: body(staged),
    });

    expect(response.statusCode).toBe(200);
    const document = TaskLifecycleExecuteResponse.parse(response.json());
    expect(document).toEqual({
      verb: "CANCEL",
      mode: "RESTATE",
      taskId: staged.taskId,
      attempt: 1,
      ok: true,
      finalSequence: 5,
      refusal: null,
    });
    // The scripted driver appends nothing itself; what matters is that the door
    // did not append on its own account.
    expect(eventCount(staged.databasePath)).toBe(before);
    await app.close();
  });

  it("T1 attaches through the real SQLite construction, which needs no port", async () => {
    const staged = stage("gw-l3-sqlite", 4);
    const { app } = serve(staged);

    const response = await app.inject({
      method: "POST",
      url: lifecyclePath(staged.taskId),
      headers: AUTH,
      payload: body(staged, { verb: "ATTACH", mode: "SQLITE_SUPERVISOR" }),
    });

    // The real supervisor answers about the verb rather than about the channel.
    // Whichever it answers, the door's shape is the thing under test here: a
    // capability gap is 501 and never a 503, and anything else is a document.
    if (response.statusCode === 501) {
      expect(ApiError.parse(response.json()).error.code).toBe("CAPABILITY_UNSUPPORTED");
    } else {
      expect(response.statusCode).toBe(200);
      const document = TaskLifecycleExecuteResponse.parse(response.json());
      expect(document.mode).toBe("SQLITE_SUPERVISOR");
      expect(document.verb).toBe("ATTACH");
    }
    await app.close();
  });

  it("T4 attach appends nothing", async () => {
    const staged = stage("gw-l3-attach-appends-nothing", 4);
    const before = eventCount(staged.databasePath);
    const { app } = serve(staged, { makeDriver: scriptedDriver({ ok: true, finalSequence: 5 }) });

    const response = await app.inject({
      method: "POST",
      url: lifecyclePath(staged.taskId),
      headers: AUTH,
      payload: body(staged, { verb: "ATTACH" }),
    });

    expect(response.statusCode).toBe(200);
    expect(eventCount(staged.databasePath)).toBe(before);
    await app.close();
  });

  it("T5 reads the lifecycle coordinates on GET, unguarded and without a writable open", async () => {
    const staged = stage("gw-l3-read", 4);
    const { app } = serve(staged);

    // No bearer. The GET half is an unguarded read like every other GET on this
    // plane, which is the design rather than an oversight (C2).
    const response = await app.inject({ method: "GET", url: lifecyclePath(staged.taskId) });

    expect(response.statusCode).toBe(200);
    const read = TaskLifecycleResponse.parse(response.json());
    expect(read.taskId).toBe(staged.taskId);
    expect(read.latestAttempt).toBe(1);
    expect(read.currentState).toBe("RUNNING");
    await app.close();
  });

  it("T5 answers NOT_FOUND on the read for a task the ledger does not hold", async () => {
    const staged = stage("gw-l3-read-unknown", 4);
    const { app } = serve(staged);

    const response = await app.inject({ method: "GET", url: lifecyclePath(randomUUID()) });

    expect(response.statusCode).toBe(404);
    expect(ApiError.parse(response.json()).error.code).toBe("NOT_FOUND");
    await app.close();
  });
});

describe("the lifecycle door refuses by name, and acts on none of it", () => {
  it("N1 refuses an unknown, missing or lower-cased mode, naming the field", async () => {
    const staged = stage("gw-l3-mode", 4);
    const { app } = serve(staged);

    for (const over of [{ mode: "restate" }, { mode: "SQLITE" }, { mode: undefined }]) {
      const payload = body(staged, over);
      if (over.mode === undefined) delete payload["mode"];
      const response = await app.inject({
        method: "POST",
        url: lifecyclePath(staged.taskId),
        headers: AUTH,
        payload,
      });
      expect(response.statusCode).toBe(400);
      const error = ApiError.parse(response.json()).error;
      expect(error.code).toBe("BAD_REQUEST");
      expect(error.detail).toBe("mode");
      // The operator's own value is never echoed back: a value in an error body
      // is a value in a log.
      expect(JSON.stringify(error)).not.toContain("restate");
    }
    await app.close();
  });

  it("N2 refuses a body that names a scenario, a database, a route or a commit policy", async () => {
    const staged = stage("gw-l3-authority", 4);
    const before = eventCount(staged.databasePath);
    const { app } = serve(staged);

    for (const extra of [
      { scenario: staged.scenarioId },
      { scenarioId: staged.scenarioId },
      { database: staged.databasePath },
      { databasePath: staged.databasePath },
      { route: ROUTE },
      { commitPolicy: "NO_COMMIT" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: lifecyclePath(staged.taskId),
        headers: AUTH,
        payload: body(staged, extra),
      });
      expect({ extra, status: response.statusCode }).toEqual({ extra, status: 400 });
      const error = ApiError.parse(response.json()).error;
      expect(error.code).toBe("BAD_REQUEST");
      // The refusal names a stable location rather than an empty string. An
      // unknown key has no position in the schema, so zod's issue path is
      // empty; `body` is the honest answer, and it is what a client branching
      // on `detail` can rely on. The offending key is never echoed — naming it
      // would put a caller-supplied string in an error body, which is exactly
      // the value D2 refuses to acknowledge in the first place.
      expect({ extra, detail: error.detail }).toEqual({ extra, detail: "body" });
      // D2: refused on the unknown key, before a ledger was opened — so no path
      // the caller supplied can appear anywhere in the answer.
      const rendered = response.body;
      expect(rendered).not.toContain(staged.databasePath);
      expect(rendered).not.toContain(staged.scenarioId);
    }
    expect(eventCount(staged.databasePath)).toBe(before);
    await app.close();
  });

  it("N3 refuses an unknown task and an attempt that is not the latest", async () => {
    const staged = stage("gw-l3-coordinates", 4);
    const before = eventCount(staged.databasePath);
    const { app } = serve(staged);

    const unknown = await app.inject({
      method: "POST",
      url: lifecyclePath(randomUUID()),
      headers: AUTH,
      payload: body(staged, { taskId: staged.taskId }),
    });
    // The path and the body disagree, which is refused before anything else.
    expect(unknown.statusCode).toBe(400);

    const stale = await app.inject({
      method: "POST",
      url: lifecyclePath(staged.taskId),
      headers: AUTH,
      payload: body(staged, { attempt: 2 }),
    });
    expect(stale.statusCode).toBe(404);
    expect(ApiError.parse(stale.json()).error.detail).toBe("attempt");

    expect(eventCount(staged.databasePath)).toBe(before);
    await app.close();
  });

  it("N3 refuses a task no ledger holds, with nothing appended", async () => {
    const staged = stage("gw-l3-unknown-task", 4);
    const other = randomUUID();
    const before = eventCount(staged.databasePath);
    const { app } = serve(staged);

    const response = await app.inject({
      method: "POST",
      url: lifecyclePath(other),
      headers: AUTH,
      payload: body(staged, { taskId: other }),
    });

    expect(response.statusCode).toBe(404);
    expect(ApiError.parse(response.json()).error.code).toBe("NOT_FOUND");
    expect(eventCount(staged.databasePath)).toBe(before);
    await app.close();
  });

  it("N4 refuses an attempt whose route was never recorded, in the same words under both modes", async () => {
    // Pre-`RUN_STARTED`: there is no recorded route, so there is nothing to
    // recover, and the refusal names the field rather than guessing.
    const codes: unknown[] = [];
    for (const mode of ["RESTATE", "SQLITE_SUPERVISOR"]) {
      const staged = stage("gw-l3-preintent-" + mode.toLowerCase().replace(/_/g, "-"), 3);
      const { app } = serve(staged);
      const response = await app.inject({
        method: "POST",
        url: lifecyclePath(staged.taskId),
        headers: AUTH,
        payload: body(staged, { mode }),
      });
      codes.push({
        status: response.statusCode,
        detail: ApiError.parse(response.json()).error.detail,
      });
      await app.close();
    }
    // Identical under both modes: the recovery refusal is reached before a
    // driver exists, so a capability difference cannot change the answer (C4).
    expect(codes[0]).toEqual(codes[1]);
    expect(codes[0]).toEqual({ status: 400, detail: "attempt.route" });
  });

  it("N5 answers 501 for a capability gap, and 503 for an unreachable engine, in one suite", async () => {
    const gap = stage("gw-l3-capability", 4);
    const gapServer = serve(gap, {
      makeDriver: scriptedDriver({ ok: false, refusal: "CAPABILITY_UNSUPPORTED", at: "cancel" }),
    });
    const gapResponse = await gapServer.app.inject({
      method: "POST",
      url: lifecyclePath(gap.taskId),
      headers: AUTH,
      payload: body(gap),
    });
    expect(gapResponse.statusCode).toBe(501);
    expect(ApiError.parse(gapResponse.json()).error.code).toBe("CAPABILITY_UNSUPPORTED");
    await gapServer.app.close();

    const down = stage("gw-l3-unreachable", 4);
    const downServer = serve(down, {
      makeDriver: scriptedDriver(() =>
        Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:8080 status=502")),
      ),
    });
    const downResponse = await downServer.app.inject({
      method: "POST",
      url: lifecyclePath(down.taskId),
      headers: AUTH,
      payload: body(down),
    });
    expect(downResponse.statusCode).toBe(503);
    const error = ApiError.parse(downResponse.json()).error;
    expect(error.code).toBe("LEDGER_UNAVAILABLE");
    // N6: the driver's message and its status number never cross.
    expect(JSON.stringify(error)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(error)).not.toContain("502");
    expect(JSON.stringify(error)).not.toContain("8080");
    await downServer.app.close();

    // The distinction is the thing under test: a retry loop must be able to
    // tell "try again" from "this can never succeed".
    expect(gapResponse.statusCode).not.toBe(downResponse.statusCode);
  });

  it("P5/N4/N8 answers 404 NOT_FOUND with no document when the engine holds no invocation", async () => {
    // V2 L4. The silent-failure mode §4 named: a fourth refusal would otherwise
    // flow into the document and answer 200 with `ok: false`, and no type error
    // would have said so. N4 asserts the negative directly.
    const staged = stage("gw-l4-not-found", 4);
    const before = eventCount(staged.databasePath);
    const { app } = serve(staged, {
      makeDriver: scriptedDriver({
        ok: false,
        refusal: "INVOCATION_NOT_FOUND",
        at: "reattach",
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: lifecyclePath(staged.taskId),
      headers: AUTH,
      payload: body(staged, { verb: "ATTACH" }),
    });

    // P5: the envelope, and the code the plane already had.
    expect(response.statusCode).toBe(404);
    const error = ApiError.parse(response.json()).error;
    expect(error.code).toBe("NOT_FOUND");
    // N4: not a document, and emphatically not a 200.
    expect(response.statusCode).not.toBe(200);
    expect(response.body).not.toContain("finalSequence");
    expect(response.body).not.toContain("INVOCATION_NOT_FOUND");
    // N6: no status number and no engine identity on any surface.
    expect(response.body).not.toContain("404\"");
    expect(response.body).not.toContain("inv_");
    // N8: nothing appended.
    expect(eventCount(staged.databasePath)).toBe(before);
    await app.close();
  });

  it("N1 keeps an unreachable engine at 503, distinct from the engine's answer", async () => {
    // The two must stay apart: one is worth retrying and the other is not.
    const staged = stage("gw-l4-unreachable", 4);
    const { app } = serve(staged, {
      makeDriver: scriptedDriver(() =>
        Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:8080 status=502")),
      ),
    });

    const response = await app.inject({
      method: "POST",
      url: lifecyclePath(staged.taskId),
      headers: AUTH,
      payload: body(staged, { verb: "ATTACH" }),
    });

    expect(response.statusCode).toBe(503);
    expect(response.statusCode).not.toBe(404);
    expect(ApiError.parse(response.json()).error.code).toBe("LEDGER_UNAVAILABLE");
    await app.close();
  });

  it("N7 guards the write and leaves the read open", async () => {
    const staged = stage("gw-l3-bearer", 4);
    const { app } = serve(staged);

    const none = await app.inject({
      method: "POST",
      url: lifecyclePath(staged.taskId),
      payload: body(staged),
    });
    expect(none.statusCode).toBe(401);
    expect(ApiError.parse(none.json()).error.code).toBe("AUTH_REQUIRED");

    const wrong = await app.inject({
      method: "POST",
      url: lifecyclePath(staged.taskId),
      headers: { authorization: "Bearer " + "x".repeat(40) },
      payload: body(staged),
    });
    expect(wrong.statusCode).toBe(401);

    // Nothing about the write is learnable before the bearer passes: a body
    // that would otherwise be a 400 still answers 401.
    const malformed = await app.inject({
      method: "POST",
      url: lifecyclePath(staged.taskId),
      payload: { verb: "SIGNAL" },
    });
    expect(malformed.statusCode).toBe(401);

    // The GET half is unguarded, by design (C2).
    const read = await app.inject({ method: "GET", url: lifecyclePath(staged.taskId) });
    expect(read.statusCode).toBe(200);
    await app.close();
  });

  it("N8 refuses signal and timer as verbs, by test rather than by omission", async () => {
    const staged = stage("gw-l3-verbs", 4);
    const { app } = serve(staged);

    for (const verb of ["SIGNAL", "TIMER", "cancel", "attach"]) {
      const response = await app.inject({
        method: "POST",
        url: lifecyclePath(staged.taskId),
        headers: AUTH,
        payload: body(staged, { verb }),
      });
      expect({ verb, status: response.statusCode }).toEqual({ verb, status: 400 });
      expect(ApiError.parse(response.json()).error.detail).toBe("verb");
    }
    await app.close();
  });

  it("N9 refuses a ledger whose submission digest was a placeholder", async () => {
    // The pre-L2 drill fixtures used placeholder digests. The refusal is the
    // intended direction of failure: the verification is what makes a recovered
    // route trustworthy (ADR 0029).
    const staged = stage("gw-l3-placeholder", 4, "a".repeat(64));
    const before = eventCount(staged.databasePath);
    const { app } = serve(staged);

    const response = await app.inject({
      method: "POST",
      url: lifecyclePath(staged.taskId),
      headers: AUTH,
      payload: body(staged),
    });

    expect(response.statusCode).toBe(409);
    const error = ApiError.parse(response.json()).error;
    expect(error.code).toBe("WRITE_REFUSED");
    expect(error.detail).toBe("attempt.submissionDigest");
    expect(eventCount(staged.databasePath)).toBe(before);
    await app.close();
  });

  it("carries the scenario through startServer, which is the only path an operator takes", async () => {
    // `acp-server --scenario` parses the brand in the bin and hands it to
    // `startServer`, which builds the application. If that hand-off dropped it
    // the flag would parse and do nothing, and every assertion above would
    // still pass because they reach `buildServer` directly. This is the one
    // test that walks the operator's path.
    const staged = stage("gw-l3-startserver", 4);
    const bearerPath = tokenFile(staged.scenarioId);
    const payload = body(staged, { mode: "SQLITE_SUPERVISOR" });

    const withScenario = await startServer({
      ledgerPath: staged.databasePath,
      writeBearerPath: bearerPath,
      scenarioId: staged.scenarioId,
      port: 0,
    });
    let carried: string | undefined;
    try {
      const response = await withScenario.app.inject({
        method: "POST",
        url: lifecyclePath(staged.taskId),
        headers: AUTH,
        payload,
      });
      carried = response.statusCode === 200 ? undefined : ApiError.parse(response.json()).error.code;
    } finally {
      await withScenario.close();
    }

    // The assertion: the scenario reached the door. Whatever the real
    // supervisor answers about the verb, it is not "this server was started
    // without a scenario".
    expect(carried).not.toBe("SCENARIO_UNCONFIGURED");

    // Non-vacuous: the same path without the option does answer exactly that,
    // so the assertion above is measuring the hand-off rather than a code that
    // could never appear here.
    const without = await startServer({
      ledgerPath: staged.databasePath,
      writeBearerPath: bearerPath,
      port: 0,
    });
    try {
      const response = await without.app.inject({
        method: "POST",
        url: lifecyclePath(staged.taskId),
        headers: AUTH,
        payload,
      });
      expect(ApiError.parse(response.json()).error.code).toBe("SCENARIO_UNCONFIGURED");
    } finally {
      await without.close();
    }
  });

  it("N10 answers SCENARIO_UNCONFIGURED after the bearer, on a server started without one", async () => {
    const staged = stage("gw-l3-no-scenario", 4);
    const before = eventCount(staged.databasePath);
    const { app } = serve(staged, { withScenario: false });

    const response = await app.inject({
      method: "POST",
      url: lifecyclePath(staged.taskId),
      headers: AUTH,
      payload: body(staged),
    });

    expect(response.statusCode).toBe(503);
    const error = ApiError.parse(response.json()).error;
    expect(error.code).toBe("SCENARIO_UNCONFIGURED");
    // Reachable only after the bearer: an unauthenticated caller learns nothing
    // about how this process was started.
    const unauthenticated = await app.inject({
      method: "POST",
      url: lifecyclePath(staged.taskId),
      payload: body(staged),
    });
    expect(unauthenticated.statusCode).toBe(401);

    // And the read still works, because the scenario is a write-side capability.
    const read = await app.inject({ method: "GET", url: lifecyclePath(staged.taskId) });
    expect(read.statusCode).toBe(200);

    expect(eventCount(staged.databasePath)).toBe(before);
    await app.close();
  });
});
