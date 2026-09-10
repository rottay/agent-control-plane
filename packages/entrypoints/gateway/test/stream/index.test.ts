import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  API_CONTRACT_VERSION,
  ApiError,
  EventPageResponse,
  LEDGER_CONTRACT_VERSION,
  STREAM_CHANNEL_BY_EVENT_TYPE,
  StreamFrame,
  canonicalize,
  hasObservationPrivacyViolation,
} from "@acp/protocol";
import { openLedger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { startServer, type RunningServer } from "../../src/start/index.js";
import {
  HEARTBEAT_COMMENT,
  RETRY_DIRECTIVE,
  createStreamRegistry,
  encodeControlFrame,
  encodeEventFrame,
  parseStreamAnchor,
} from "../../src/stream/index.js";
import { STREAM_MAX_CONNECTIONS } from "../../src/constants/index.js";

/**
 * The ledger sequence as a stream (V2-B3a).
 *
 * **Every liveness claim here is made over a real loopback socket.**
 * `app.inject()` is deliberately absent from the connection drills: it never
 * touches a socket, and — more to the point — it cannot terminate a hijacked
 * response, so a stream opened through it would hang the suite rather than
 * prove anything. The pure halves of the module (the anchor grammar, the frame
 * encoders) are exercised directly, because a socket adds nothing to a string
 * function but flakiness.
 *
 * This package may not name `@acp/contracts`, so the channel map's **totality**
 * over the twenty-four ledger types is asserted in the protocol suite, which
 * may read the vocabulary. What is asserted here is the other half: every
 * channel that reaches the wire is the one the shared map names.
 */

// ---------------------------------------------------------------------------
// Disposable ledgers. Nothing here writes to a repository path.
// ---------------------------------------------------------------------------

const temporaryDirectories: string[] = [];
const runningServers: RunningServer[] = [];

afterEach(async () => {
  while (runningServers.length > 0) {
    const running = runningServers.pop();
    if (running !== undefined) await running.close();
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "acp-stream-"));
  temporaryDirectories.push(directory);
  return join(directory, "control-plane.sqlite");
}

const WORKER = "kimi/k3/coordinator/01";

/**
 * Every ledger event type, in the order the contract declares them.
 *
 * Restated here rather than imported: this package may not reach
 * `@acp/contracts`, which is the standing exclusion `mappers/index.ts` records.
 * The list is not load-bearing for totality — the protocol suite asserts that
 * against the contract's own vocabulary — it is a fixture that makes every
 * channel non-empty on the wire.
 */
const EVENT_TYPES = [
  "TASK_DISCOVERED",
  "TASK_CLASSIFIED",
  "TASK_READY",
  "SLOT_RESERVED",
  "RUN_STARTED",
  "ATOMIC_STEP_COMPLETED",
  "CHECKPOINT_WRITTEN",
  "VERIFICATION_COMPLETED",
  "AUDIT_COMPLETED",
  "COMMIT_AUTHORIZED",
  "COMMIT_RECORDED",
  "LEASE_ACQUIRED",
  "LEASE_REVOKED",
  "WRITE_SET_VIOLATION_DETECTED",
  "QUOTA_WARNING",
  "TOKEN_USAGE_RECORDED",
  "TOKEN_RESERVATION_RECORDED",
  "ACCOUNT_SWITCH_STARTED",
  "ACCOUNT_SWITCH_COMPLETED",
  "AUTH_REQUIRED_RAISED",
  "TASK_STATE_CHANGED",
  "TASK_FAILED",
  "TASK_CANCELLED",
] as const;

interface SeedOptions {
  /** How many events to append per task. Cycles through `EVENT_TYPES`. */
  readonly perTask?: number;
  /** How many tasks to interleave. Two is enough for the filter law. */
  readonly tasks?: number;
  /** Payload keys, so a redaction drill can seed shapes worth refusing. */
  readonly payload?: Record<string, unknown>;
  /**
   * The types to cycle through, when a drill is about one type in particular.
   *
   * Defaults to `EVENT_TYPES`, which stays exactly as it is: `seed()` defaults
   * `perTask` to that array's length, so appending a twenty-fourth entry to it
   * would silently renumber every `headSequence` this file asserts against. A
   * dedicated seed costs one option and moves nothing.
   */
  readonly types?: readonly string[];
}

interface Seed {
  readonly path: string;
  readonly taskIds: readonly string[];
  readonly headSequence: number;
}

/**
 * Append a lawful chain, interleaved across tasks.
 *
 * The ledger enforces lifecycle continuity — the first event of a task must
 * declare `fromState: null` and every later one must declare the state the
 * task is actually in — so the walk tracks each task's state rather than
 * writing a fixture the ledger would refuse. `TASK_STATE_CHANGED` is the one
 * type that must actually move, and it is the only one given a different
 * `toState`.
 */
function seed(options: SeedOptions = {}): Seed {
  const types = options.types ?? EVENT_TYPES;
  const perTask = options.perTask ?? types.length;
  const taskCount = options.tasks ?? 1;
  const path = temporaryDatabase();
  const ledger = openLedger(path);
  const taskIds = Array.from({ length: taskCount }, () => randomUUID());
  const state = new Map<string, string | null>(taskIds.map((id) => [id, null]));

  for (let index = 0; index < perTask; index += 1) {
    for (const taskId of taskIds) {
      const type = types[index % types.length] ?? "TASK_DISCOVERED";
      const fromState = state.get(taskId) ?? null;
      const toState =
        type === "TASK_STATE_CHANGED"
          ? fromState === "RUNNING"
            ? "VERIFYING"
            : "RUNNING"
          : (fromState ?? "RUNNING");
      const transitionId = "step-" + String(index);
      ledger.append({
        contractVersion: LEDGER_CONTRACT_VERSION,
        eventId: randomUUID(),
        taskId,
        attempt: 1,
        transitionId,
        // Mirrors @acp/contracts' buildIdempotencyKey, restated rather than
        // imported: this package's dependency surface excludes that package.
        idempotencyKey: taskId + "/1/" + transitionId,
        type,
        fromState,
        toState,
        emittedBy: WORKER,
        occurredAt: "2026-09-01T00:00:00.000Z",
        recordedAt: "2026-09-01T00:00:00.000Z",
        correlationId: null,
        causationId: null,
        payload: options.payload ?? {},
      });
      state.set(taskId, toState);
    }
  }

  const headSequence = ledger.status().headSequence;
  ledger.close();
  return { path, taskIds, headSequence };
}

/** Every sequence the ledger itself holds, read back independently. */
function sequencesInLedger(path: string, taskId?: string): number[] {
  const ledger = openLedger(path, { readOnly: true });
  try {
    const page = ledger.listEvents({ taskId, limit: 1_000 });
    return page.events.map((record) => record.sequence);
  } finally {
    ledger.close();
  }
}

// ---------------------------------------------------------------------------
// A Server-Sent Events client, over `node:http`
// ---------------------------------------------------------------------------

interface WireFrame {
  readonly id: string | null;
  readonly event: string | null;
  readonly data: string;
}

interface SseClient {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  /** Everything received, byte for byte, including comments and directives. */
  readonly raw: () => string;
  readonly frames: () => readonly WireFrame[];
  readonly comments: () => readonly string[];
  readonly ended: () => boolean;
  waitForFrames(count: number): Promise<void>;
  waitUntil(predicate: () => boolean, what: string): Promise<void>;
  waitForEnd(): Promise<void>;
  /** Destroy the socket the way a browser tab closing would. */
  abort(): void;
}

/**
 * Open one stream and parse it as it arrives.
 *
 * `node:http` rather than `fetch`, for the reason the build-server suite
 * already records: undici intermittently fails to reach `127.0.0.1` from
 * inside a Vitest worker in this environment, and `node:http` does not.
 */
function openStream(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const frames: WireFrame[] = [];
    const comments: string[] = [];
    let raw = "";
    let pending = "";
    let ended = false;
    const waiters: (() => void)[] = [];

    const notify = (): void => {
      for (const waiter of [...waiters]) waiter();
    };

    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", headers, agent: false },
      (response: IncomingMessage) => {
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          raw += chunk;
          pending += chunk;
          // SSE blocks are separated by a blank line. Anything after the last
          // separator is a partial block and stays pending.
          const blocks = pending.split("\n\n");
          pending = blocks.pop() ?? "";
          for (const block of blocks) {
            if (block === "") continue;
            let id: string | null = null;
            let event: string | null = null;
            let data = "";
            for (const line of block.split("\n")) {
              if (line.startsWith(":")) {
                comments.push(line);
                continue;
              }
              if (line.startsWith("id: ")) id = line.slice(4);
              else if (line.startsWith("event: ")) event = line.slice(7);
              else if (line.startsWith("data: ")) data += line.slice(6);
            }
            // `retry:` is a directive, not a frame, and carries no data.
            if (data === "" && id === null && event === null) continue;
            frames.push({ id, event, data });
          }
          notify();
        });
        response.on("end", () => {
          ended = true;
          notify();
        });
        response.on("close", () => {
          ended = true;
          notify();
        });

        const wait = (predicate: () => boolean, what: string): Promise<void> =>
          new Promise<void>((settle, fail) => {
            const timer = setTimeout(() => {
              fail(new Error("timed out waiting for " + what + "; wire so far: " + raw.slice(0, 400)));
            }, 20_000);
            const check = (): void => {
              if (!predicate()) return;
              clearTimeout(timer);
              const at = waiters.indexOf(check);
              if (at >= 0) waiters.splice(at, 1);
              settle();
            };
            waiters.push(check);
            check();
          });

        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          raw: () => raw,
          frames: () => frames,
          comments: () => comments,
          ended: () => ended,
          waitForFrames: (count) =>
            wait(() => frames.length >= count, String(count) + " frame(s)"),
          waitUntil: (predicate, what) => wait(predicate, what),
          waitForEnd: () => wait(() => ended, "the stream to end"),
          abort: () => {
            req.destroy();
          },
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Read a bounded JSON body — the error envelopes and the paged events route. */
function getJson(port: number, path: string, headers: Record<string, string> = {}): Promise<{
  status: number;
  body: unknown;
}> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", headers, agent: false },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => {
          try {
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as unknown });
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Send one non-GET verb and report the status only. */
function statusOf(port: number, path: string, method: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, agent: false }, (response) => {
      response.resume();
      response.on("end", () => {
        resolve(response.statusCode ?? 0);
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function serve(path: string): Promise<RunningServer> {
  const running = await startServer({ ledgerPath: path, port: 0 });
  runningServers.push(running);
  return running;
}

const STREAM_PATH = "/api/v1/events/stream";

/** The frames of one client, parsed against the real contract schema. */
function parsedFrames(client: SseClient): StreamFrame[] {
  return client.frames().map((frame) => StreamFrame.parse(JSON.parse(frame.data)));
}

/**
 * The event frames only, and the ids they carry (V2-B3c).
 *
 * Since B3c an anchored connection opens with a `hello` like a live one does,
 * so "the frames" and "the rows" stopped being the same list. These two helpers
 * are what keep the reconnect and parity drills measuring rows: they were
 * counting frames, which was the same number until a control frame appeared in
 * front of the replay.
 *
 * `id` is read from the raw SSE frame rather than from the parsed body, because
 * the claim under test is about the wire — that the `id:` line a browser will
 * resume from is the row's own sequence.
 */
function eventFrames(client: SseClient): StreamFrame[] {
  return parsedFrames(client).filter((frame) => frame.kind === "event");
}

function eventIds(client: SseClient): number[] {
  return client
    .frames()
    .filter((frame) => frame.id !== null && frame.id !== "")
    .map((frame) => Number(frame.id));
}

// ---------------------------------------------------------------------------
// The anchor grammar
// ---------------------------------------------------------------------------

describe("the anchor grammar", () => {
  it("treats an absent, empty or blank header as live rather than as an error", () => {
    // The ordinary case: a browser opening an EventSource for the first time
    // sends no such header at all.
    for (const raw of [undefined, "", "   ", "\t"]) {
      expect({ raw, kind: parseStreamAnchor(raw).kind }).toEqual({ raw, kind: "live" });
    }
  });

  it("accepts a decimal sequence, including the zero that means the whole log", () => {
    expect(parseStreamAnchor("0")).toEqual({ kind: "at", sequence: 0 });
    expect(parseStreamAnchor("1")).toEqual({ kind: "at", sequence: 1 });
    expect(parseStreamAnchor("4711")).toEqual({ kind: "at", sequence: 4711 });
    // Surrounding whitespace is a transport artifact, not a different anchor.
    expect(parseStreamAnchor(" 12 ")).toEqual({ kind: "at", sequence: 12 });
  });

  it("refuses everything Number() would have silently accepted", () => {
    // The negative that matters. `Number()` accepts every one of these and
    // would have turned a typo into a position the caller never wrote.
    const outside = [
      "abc",
      "-1",
      "1e3",
      "0x10",
      "1.0",
      "+1",
      "01",
      "Infinity",
      "NaN",
      "1,2",
      "9".repeat(40),
    ];
    for (const raw of outside) {
      expect({ raw, kind: parseStreamAnchor(raw).kind }).toEqual({ raw, kind: "malformed" });
    }
  });

  it("refuses a digit string too long to be a safe integer sequence", () => {
    expect(parseStreamAnchor("9".repeat(17)).kind).toBe("malformed");
    expect(parseStreamAnchor("9".repeat(15)).kind).toBe("at");
  });
});

// ---------------------------------------------------------------------------
// The identity law, at the encoder
// ---------------------------------------------------------------------------

describe("only a ledger row carries an id, and the id is its sequence", () => {
  function eventFrame(sequence: number): StreamFrame {
    const { path } = seed({ perTask: 1 });
    const ledger = openLedger(path, { readOnly: true });
    const record = ledger.listEvents({ limit: 1 }).events[0];
    ledger.close();
    if (record === undefined) throw new Error("expected a seeded event");
    return StreamFrame.parse({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      kind: "event",
      channel: STREAM_CHANNEL_BY_EVENT_TYPE[record.event.type],
      item: {
        sequence,
        eventId: record.eventId,
        taskId: record.event.taskId,
        attempt: record.event.attempt,
        transitionId: record.event.transitionId,
        type: record.event.type,
        fromState: record.event.fromState,
        toState: record.event.toState,
        emittedBy: record.event.emittedBy,
        occurredAt: record.event.occurredAt,
        recordedAt: record.event.recordedAt,
        correlationId: record.event.correlationId,
        causationId: record.event.causationId,
        previousSha256: record.previousSha256,
        eventSha256: record.eventSha256,
        payloadByteSize: 2,
        payloadKeys: [],
      },
    });
  }

  it("writes the sequence verbatim as the id line", () => {
    expect(encodeEventFrame(eventFrame(4711), 4711)).toContain("id: 4711\n");
  });

  it("refuses an id that is not the sequence of the row it carries", () => {
    // The law is not "an id exists" — it is that the wire id and the body can
    // never disagree, which is what a client's cursor depends on.
    expect(() => encodeEventFrame(eventFrame(7), 8)).toThrow(/must be the sequence/);
  });

  it("gives a control frame no id line at all, in either kind", () => {
    const hello = encodeControlFrame(
      StreamFrame.parse({
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        kind: "hello",
        database: {
          id: "a".repeat(64),
          label: "control-plane.sqlite",
          pathRedacted: true,
        },
        instance: {
          instanceId: "11111111-1111-4111-8111-111111111111",
          restoreId: "22222222-2222-4222-8222-222222222222",
          restoreEpoch: 0,
        },
        headSequence: 12,
        resumedFrom: null,
      }),
    );
    const resync = encodeControlFrame(
      StreamFrame.parse({
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        kind: "resync",
        reason: "ANCHOR_AHEAD_OF_HEAD",
      }),
    );
    for (const [name, encoded] of [
      ["hello", hello],
      ["resync", resync],
    ] as const) {
      expect({ name, hasId: encoded.includes("id: ") }).toEqual({ name, hasId: false });
    }
    // `headSequence` travels in the body, where it is data, and not as an id,
    // where it would be a cursor the client had not reached.
    expect(hello).toContain('"headSequence":12');
  });

  it("keeps the two encoders from being used for each other's frames", () => {
    expect(() => encodeControlFrame(eventFrame(1))).toThrow(/must be encoded with its sequence/);
    expect(() =>
      encodeEventFrame(
        StreamFrame.parse({
          apiContractVersion: API_CONTRACT_VERSION,
          ledgerContractVersion: LEDGER_CONTRACT_VERSION,
          kind: "resync",
          reason: "ANCHOR_AHEAD_OF_HEAD",
        }),
        1,
      ),
    ).toThrow(/only an event frame/);
  });

  it("keeps the heartbeat a comment, so it can never advance a cursor", () => {
    // The structural half of the heartbeat law; the wire half is drilled over
    // a real socket below.
    expect(HEARTBEAT_COMMENT.startsWith(":")).toBe(true);
    expect(HEARTBEAT_COMMENT).not.toContain("id:");
    expect(HEARTBEAT_COMMENT).not.toContain("data:");
    expect(RETRY_DIRECTIVE).not.toContain("id:");
  });
});

// ---------------------------------------------------------------------------
// Reconnection: the whole point of the packet
// ---------------------------------------------------------------------------

describe("a reconnect loses nothing and repeats nothing", () => {
  /**
   * Append `count` rows for a brand-new task, with the connection closed.
   *
   * A NEW task is what makes this cheap: the ledger enforces lifecycle
   * continuity, so continuing an existing task after the fact would mean
   * rebuilding the per-task state `seed()` tracks internally and then discards
   * when it closes. A task whose first event declares `fromState: null` needs
   * none of that. The idiom is the one the late-append drill below already
   * uses; it is named here because two reconnect tests need it.
   *
   * Payloads stay empty. These rows travel over SSE, and the gate criterion on
   * this plane is that no secret, prompt or tool argument ever does.
   */
  function appendAwayWindow(path: string, count: number): void {
    const ledger = openLedger(path);
    const taskId = randomUUID();
    for (let index = 0; index < count; index += 1) {
      const transitionId = "away-" + String(index);
      ledger.append({
        contractVersion: LEDGER_CONTRACT_VERSION,
        eventId: randomUUID(),
        taskId,
        attempt: 1,
        transitionId,
        idempotencyKey: taskId + "/1/" + transitionId,
        type: "TASK_DISCOVERED",
        fromState: index === 0 ? null : "DISCOVERED",
        toState: "DISCOVERED",
        emittedBy: WORKER,
        occurredAt: "2026-09-03T00:00:00.000Z",
        recordedAt: "2026-09-03T00:00:00.000Z",
        correlationId: null,
        causationId: null,
        payload: {},
      });
    }
    ledger.close();
  }

  it("delivers exactly the rows appended while it was away, measured against the ledger", async () => {
    // **The away window is what makes this test causal.**
    //
    // The predecessor of this test resumed leg two from wherever leg one
    // happened to stop, and then waited for `headSequence - resumeFrom` rows.
    // Leg one drains the whole log without sleeping between rows, so it
    // normally reached the head before the abort crossed the loopback: the
    // remainder was zero and the wait was satisfied by the `hello` alone.
    // Measured over eight runs of that test, unmodified, leg two received zero
    // rows in six of them. A server that replayed a from-zero anchor correctly
    // and then delivered NOTHING after the `hello` on a resumed connection
    // passed it.
    //
    // Creating the remainder AFTER the disconnect removes the timing from the
    // question. The rows below exist only because nobody was connected when
    // they were written, so a resumed connection that delivers them cannot
    // have done anything but replay.
    const { path, headSequence } = seed({ perTask: 6 });
    expect(headSequence).toBe(6);
    const running = await serve(path);

    // Leg one: anchored at zero, so it replays the whole log, and it is held
    // until it has all of it. Waiting for the exact count rather than a floor
    // is what makes `resumeFrom` a known value instead of a race.
    const first = await openStream(running.port, STREAM_PATH, { "last-event-id": "0" });
    expect(first.status).toBe(200);
    await first.waitUntil(() => eventIds(first).length === 6, "the whole seeded log");
    const firstIds = eventIds(first);
    first.abort();
    expect(firstIds).toEqual([1, 2, 3, 4, 5, 6]);

    const resumeFrom = firstIds[firstIds.length - 1];
    if (resumeFrom === undefined) throw new Error("leg one must have received rows");

    // The away window: three rows that exist only because they were appended
    // with no connection open.
    appendAwayWindow(path, 3);
    expect(sequencesInLedger(path)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // The anti-vacuity guard, and it is the whole reason this file changed. If
    // a future edit ever restores the state where leg two is allowed to be
    // empty, this line fails before any coverage assertion can pass vacuously.
    expect(resumeFrom).toBeLessThan(9);

    const second = await openStream(running.port, STREAM_PATH, {
      "last-event-id": String(resumeFrom),
    });
    // The wait names ROWS and an EXACT count. A `>=` form would silently
    // restore the defect, and a frame-count form is satisfied by the `hello`,
    // which carries no id and moves no cursor.
    await second.waitUntil(() => eventIds(second).length === 3, "exactly the three missed rows");
    const opening = parsedFrames(second)[0];
    expect(opening?.kind).toBe("hello");
    if (opening?.kind !== "hello") throw new Error("expected a hello");
    expect(opening.resumedFrom).toBe(resumeFrom);
    const secondIds = eventIds(second);
    second.abort();

    // Exact equality, not a floor: a prefix, a superset and a repeat all fail
    // here, which is what "no gaps, no duplicates" actually asserts.
    expect(secondIds).toEqual([7, 8, 9]);

    // The oracle stays the ledger rather than a fixture: what the two
    // connections saw together must be exactly what the database holds.
    const union = [...firstIds, ...secondIds];
    expect(union).toEqual([...union].sort((a, b) => a - b));
    expect(new Set(union).size).toBe(union.length);
    expect(union).toEqual(sequencesInLedger(path));
  });

  it("does not repeat the anchor row when the anchor came from a broken connection", async () => {
    // The fresh-anchor case is proved below, on a connection that never
    // disconnected. This is the reconnect case, and it is a different one: an
    // off-by-one that only appeared on resume would satisfy that test and
    // double-count one row on every real reconnection.
    const { path } = seed({ perTask: 6 });
    const running = await serve(path);

    const first = await openStream(running.port, STREAM_PATH, { "last-event-id": "0" });
    await first.waitUntil(() => eventIds(first).length === 6, "the whole seeded log");
    const resumeFrom = eventIds(first)[5];
    first.abort();
    if (resumeFrom === undefined) throw new Error("leg one must have received rows");

    appendAwayWindow(path, 2);

    const second = await openStream(running.port, STREAM_PATH, {
      "last-event-id": String(resumeFrom),
    });
    await second.waitUntil(() => eventIds(second).length === 2, "the two missed rows");
    const secondIds = eventIds(second);
    second.abort();

    // The cursor is exclusive across a reconnect too.
    expect(secondIds[0]).toBe(7);
    expect(secondIds).not.toContain(resumeFrom);
  });

  it("sends nothing on a further reconnect when nothing was appended", async () => {
    // The duplicate half, stated positively. A server that re-sent the away
    // window on every reconnect would satisfy the exact-remainder assertion
    // above on its first resume and corrupt every one after it.
    const { path } = seed({ perTask: 6 });
    const running = await serve(path);

    const first = await openStream(running.port, STREAM_PATH, { "last-event-id": "0" });
    await first.waitUntil(() => eventIds(first).length === 6, "the whole seeded log");
    first.abort();

    appendAwayWindow(path, 3);

    const second = await openStream(running.port, STREAM_PATH, { "last-event-id": "6" });
    await second.waitUntil(() => eventIds(second).length === 3, "the three missed rows");
    second.abort();

    // Third leg: caught up, and nothing has been appended since.
    const third = await openStream(running.port, STREAM_PATH, { "last-event-id": "9" });
    await third.waitForFrames(1);
    const opening = parsedFrames(third)[0];
    expect(opening?.kind).toBe("hello");
    if (opening?.kind !== "hello") throw new Error("expected a hello");

    // It opens truthfully — the anchor it was given and the head it found —
    // and it says so with values rather than by omission.
    expect(opening.resumedFrom).toBe(9);
    expect(opening.headSequence).toBe(9);
    // And it delivers no row at all. Asserted after the `hello` has arrived,
    // so this is "nothing followed the opening frame" rather than "nothing has
    // happened yet".
    expect(eventIds(third)).toEqual([]);
    third.abort();
  });

  it("resumes without repeating the anchor row itself", async () => {
    // The cursor is exclusive, like every other cursor on this plane. An
    // inclusive one would deliver one duplicate per reconnect — the commonest
    // way a stream quietly double-counts.
    const { path } = seed({ perTask: 6 });
    const running = await serve(path);
    const client = await openStream(running.port, STREAM_PATH, { "last-event-id": "3" });
    await client.waitUntil(() => eventIds(client).length >= 3, "three rows after the anchor");
    const ids = eventIds(client);
    // The `hello` precedes the replay and carries no id, so the first ROW is
    // still the one after the anchor.
    const opening = parsedFrames(client)[0];
    expect(opening?.kind).toBe("hello");
    client.abort();
    expect(ids[0]).toBe(4);
    expect(ids).not.toContain(3);
  });

  it("serves live from the head when no anchor is given, after one hello", async () => {
    const { path, headSequence } = seed({ perTask: 4 });
    const running = await serve(path);
    const client = await openStream(running.port, STREAM_PATH);
    await client.waitForFrames(1);

    const frames = parsedFrames(client);
    const hello = frames[0];
    expect(hello?.kind).toBe("hello");
    if (hello?.kind !== "hello") throw new Error("expected a hello");
    expect(hello.headSequence).toBe(headSequence);
    // A live open says so with a value rather than with a missing key
    // (V2-B3c). `null` and "an older server that does not tell you" would
    // otherwise be the same wire shape.
    expect(hello.resumedFrom).toBeNull();
    // The path never crosses: the browser is told which ledger by a digest and
    // a bare label, exactly as every other route tells it.
    expect(hello.database.pathRedacted).toBe(true);
    expect(hello.database.label).toBe("control-plane.sqlite");
    expect(client.frames()[0]?.id).toBeNull();

    // Live means live: history is the paged route's job, so nothing before the
    // head is replayed at a client that did not ask to resume.
    expect(client.frames().filter((frame) => frame.id !== null)).toHaveLength(0);
    client.abort();
  });

  it("carries the instance identity on every open, resumed or live", async () => {
    // Invariant 7: `instance_id` and `restore_id` travel in the `hello` frame.
    // Both arms of `#open()`, because the resumed one is precisely the arm a
    // client cannot learn identity from any other way — `Last-Event-ID` is a
    // bare decimal and has nowhere to put one.
    const { path } = seed({ perTask: 4 });
    const expected = (() => {
      const reader = openLedger(path, { readOnly: true });
      try {
        return reader.status().instance;
      } finally {
        reader.close();
      }
    })();
    expect(expected.instanceId).not.toBeNull();

    const running = await serve(path);

    const live = await openStream(running.port, STREAM_PATH);
    await live.waitForFrames(1);
    const liveHello = parsedFrames(live)[0];
    expect(liveHello?.kind).toBe("hello");
    if (liveHello?.kind !== "hello") throw new Error("expected a hello");
    expect(liveHello.instance).toEqual(expected);
    live.abort();

    const resumed = await openStream(running.port, STREAM_PATH, { "last-event-id": "2" });
    await resumed.waitForFrames(1);
    const resumedHello = parsedFrames(resumed)[0];
    expect(resumedHello?.kind).toBe("hello");
    if (resumedHello?.kind !== "hello") throw new Error("expected a hello");
    expect(resumedHello.instance).toEqual(expected);
    resumed.abort();
  });

  it("restates a moved restore id under an unchanged path", async () => {
    // The server half of DB08, and the only proof that the identity is read per
    // open rather than computed once at startup. The path does not move, so
    // `database` is identical across the two connections; a gateway that cached
    // the identity beside it would serve the OLD restore id after a restore and
    // the client law would never fire.
    const { path } = seed({ perTask: 3 });
    const running = await serve(path);

    const before = await openStream(running.port, STREAM_PATH);
    await before.waitForFrames(1);
    const first = parsedFrames(before)[0];
    if (first?.kind !== "hello") throw new Error("expected a hello");
    before.abort();

    // A formal restore, recorded through the ledger's own door while the
    // gateway stays up.
    const writer = openLedger(path);
    const restored = writer.recordRestore();
    writer.close();

    const after = await openStream(running.port, STREAM_PATH);
    await after.waitForFrames(1);
    const second = parsedFrames(after)[0];
    if (second?.kind !== "hello") throw new Error("expected a hello");
    after.abort();

    // Same location, same file, different restore. This is the tuple the
    // client compares, and only its third member moved.
    expect(second.database).toEqual(first.database);
    expect(second.instance.instanceId).toBe(first.instance.instanceId);
    expect(second.instance.restoreId).not.toBe(first.instance.restoreId);
    expect(second.instance.restoreId).toBe(restored.restoreId);
    expect(second.instance.restoreEpoch).toBe(1);
  });

  it("delivers an event appended after the connection opened", async () => {
    // Without this the tail could be a replay that stops, and every other
    // assertion here would still pass.
    const { path, headSequence } = seed({ perTask: 2 });
    const running = await serve(path);
    const client = await openStream(running.port, STREAM_PATH);
    await client.waitForFrames(1);

    const ledger = openLedger(path);
    const taskId = randomUUID();
    ledger.append({
      contractVersion: LEDGER_CONTRACT_VERSION,
      eventId: randomUUID(),
      taskId,
      attempt: 1,
      transitionId: "late",
      idempotencyKey: taskId + "/1/late",
      type: "TASK_DISCOVERED",
      fromState: null,
      toState: "DISCOVERED",
      emittedBy: WORKER,
      occurredAt: "2026-09-02T00:00:00.000Z",
      recordedAt: "2026-09-02T00:00:00.000Z",
      correlationId: null,
      causationId: null,
      payload: {},
    });
    ledger.close();

    await client.waitUntil(
      () => client.frames().some((frame) => frame.id === String(headSequence + 1)),
      "the newly appended row",
    );
    client.abort();
  });
});

// ---------------------------------------------------------------------------
// V2-B3c: identity is restated on every open, including a resumed one
// ---------------------------------------------------------------------------

/**
 * The server's whole obligation under B3c, and the boundary of it.
 *
 * It cannot detect a foreign resume. `Last-Event-ID` is a bare decimal
 * sequence — the frame union gives an `id:` line only to the `event` arm, and
 * fence law L1 pins the single producer to `String(sequence)` — so this side is
 * handed a number and nothing else. Enriching the cursor to carry a ledger
 * identity would break the shape those two laws exist to hold.
 *
 * So the server restates rather than detects: which ledger this is, how far it
 * has got, and which anchor this connection resumed at. The comparison is the
 * client's, and the console suite is where it is drilled. What is asserted here
 * is that the client is given what it needs to make it, in time to matter.
 */
describe("a resumed connection is told which ledger it resumed into", () => {
  it("writes a hello carrying the anchor, before any replayed row", async () => {
    const { path, headSequence } = seed({ perTask: 6 });
    const running = await serve(path);
    const client = await openStream(running.port, STREAM_PATH, { "last-event-id": "2" });
    expect(client.status).toBe(200);
    await client.waitUntil(() => eventIds(client).length >= 2, "rows after the anchor");
    const frames = parsedFrames(client);
    const wire = client.frames();
    client.abort();

    // First, before anything replayed. Ordering is the assertion: a client that
    // learned the ledger had changed only after applying rows from it would
    // have already mixed two ledgers in one scope.
    const hello = frames[0];
    expect(hello?.kind).toBe("hello");
    if (hello?.kind !== "hello") throw new Error("expected a hello");
    expect(hello.resumedFrom).toBe(2);
    expect(hello.headSequence).toBe(headSequence);
    // The identity itself, redacted exactly as every other route sends it.
    expect(hello.database.pathRedacted).toBe(true);
    expect(hello.database.id).not.toBe("");

    // And it carries no `id:`, so restating identity moves no cursor. This is
    // the structural half of the design: the frame cannot advance a browser's
    // resume position even by accident.
    expect(wire[0]?.id).toBeNull();
    // Every row still arrives after it, numbered by the ledger.
    expect(eventIds(client)[0]).toBe(3);
  });

  it("says resumedFrom zero for the anchor that means the whole log", async () => {
    // Zero is a legitimate anchor — "replay everything" — and it must be
    // distinguishable from a live open, which is `null`. A field that collapsed
    // the two would leave a client unable to tell a full replay from a tail.
    const { path } = seed({ perTask: 3 });
    const running = await serve(path);
    const client = await openStream(running.port, STREAM_PATH, { "last-event-id": "0" });
    await client.waitUntil(() => eventIds(client).length >= 1, "a row");
    const hello = parsedFrames(client)[0];
    client.abort();

    expect(hello?.kind).toBe("hello");
    if (hello?.kind !== "hello") throw new Error("expected a hello");
    expect(hello.resumedFrom).toBe(0);
    expect(hello.resumedFrom).not.toBeNull();
  });

  it("carries no credential- or transcript-shaped material on the resumed hello either", async () => {
    // The privacy sweep, extended to the frame this packet adds rather than
    // duplicated beside it. A new frame on a new code path is exactly where a
    // redaction gap would open unobserved.
    const { path } = seed({
      perTask: 4,
      payload: { accountId: "acct-a", tokens: 12, note: "a bounded operator note" },
    });
    const running = await serve(path);
    const client = await openStream(running.port, STREAM_PATH, { "last-event-id": "1" });
    await client.waitUntil(() => eventIds(client).length >= 1, "a row");
    const hello = parsedFrames(client)[0];
    const raw = client.raw();
    client.abort();

    expect(hello?.kind).toBe("hello");
    if (hello?.kind !== "hello") throw new Error("expected a hello");
    for (const projection of [hello, canonicalize(hello)]) {
      expect(hasObservationPrivacyViolation(projection)).toBe(false);
    }
    // No absolute path reached the wire under the new field's cover.
    expect(raw).not.toContain("/Users/");
    expect(raw).not.toContain(".sqlite3");
  });
});

// ---------------------------------------------------------------------------
// The two unusable anchors, answered rather than papered over
// ---------------------------------------------------------------------------

describe("an anchor this ledger has never reached", () => {
  it("answers one resync and closes, and never restarts from zero", async () => {
    const { path, headSequence } = seed({ perTask: 3 });
    const running = await serve(path);
    const client = await openStream(running.port, STREAM_PATH, {
      "last-event-id": String(headSequence + 1),
    });
    expect(client.status).toBe(200);
    await client.waitForEnd();

    // The refusal comes alone (V2-B3c). An anchor ahead of the head is
    // answered before identity is restated, so a client can still tell a
    // server REFUSAL from the client-side scope reset a foreign `hello`
    // triggers — one arrives as a `resync` and closes, the other as a `hello`
    // followed by a replay. A `hello` here would blur the two.
    expect(parsedFrames(client).map((frame) => frame.kind)).toEqual(["resync"]);

    const frames = parsedFrames(client);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      kind: "resync",
      reason: "ANCHOR_AHEAD_OF_HEAD",
    });
    // The negatives, both of them: no row was emitted, and the connection did
    // not quietly become a fresh stream from the beginning of the log.
    expect(client.frames().filter((frame) => frame.id !== null)).toHaveLength(0);
    expect(client.raw()).not.toContain("id: 1\n");
    expect(client.ended()).toBe(true);
  });
});

describe("a malformed anchor is refused before anything is hijacked", () => {
  it("answers the ordinary error envelope, never a stream", async () => {
    const { path } = seed({ perTask: 2 });
    const running = await serve(path);

    for (const anchor of ["abc", "-1", "1e3", "0x10", "1.5", "9".repeat(40)]) {
      const { status, body } = await getJson(running.port, STREAM_PATH, {
        "last-event-id": anchor,
      });
      const error = ApiError.parse(body);
      expect({ anchor, status, code: error.error.code }).toEqual({
        anchor,
        status: 400,
        code: "BAD_REQUEST",
      });
      // The header's own bytes never come back: this route is not a reflector.
      expect(JSON.stringify(body)).not.toContain(anchor);
    }
  });

  it("refuses an unknown query parameter the same way", async () => {
    const { path } = seed({ perTask: 2 });
    const running = await serve(path);
    const { status, body } = await getJson(running.port, STREAM_PATH + "?bogus=1");
    expect(status).toBe(400);
    expect(ApiError.parse(body).error.code).toBe("BAD_REQUEST");
  });
});

// ---------------------------------------------------------------------------
// The stream is a transport, not a second projection
// ---------------------------------------------------------------------------

describe("the stream and the paged route tell the same story", () => {
  it("carries, for each sequence, the item the events route serves", async () => {
    const { path } = seed({ perTask: 5 });
    const running = await serve(path);

    const client = await openStream(running.port, STREAM_PATH, { "last-event-id": "0" });
    await client.waitUntil(
      () => eventFrames(client).length >= sequencesInLedger(path).length,
      "every row",
    );
    const streamed = eventFrames(client);
    client.abort();

    const { body } = await getJson(running.port, "/api/v1/events?limit=200");
    const page = EventPageResponse.parse(body);

    expect(streamed).toHaveLength(page.items.length);
    for (const [index, item] of page.items.entries()) {
      const frame = streamed[index];
      if (frame?.kind !== "event") throw new Error("expected an event frame");
      // Canonicalised, so this compares the row model rather than key order —
      // the same equality the parity suite is built on.
      expect(canonicalize(frame.item)).toEqual(canonicalize(item));
      // And the channel is the shared map's answer, not this handler's opinion.
      expect(frame.channel).toBe(STREAM_CHANNEL_BY_EVENT_TYPE[item.type]);
    }
  });

  it("reaches every channel the map defines, so no channel is proven only on paper", async () => {
    const { path } = seed();
    const running = await serve(path);
    const client = await openStream(running.port, STREAM_PATH, { "last-event-id": "0" });
    await client.waitUntil(() => eventFrames(client).length >= EVENT_TYPES.length, "every type");
    const channels = new Set(
      eventFrames(client).map((frame) => (frame.kind === "event" ? frame.channel : null)),
    );
    client.abort();
    expect([...channels].sort()).toEqual([
      "execution",
      "lifecycle",
      "progress",
      "state",
      "steps",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Filters narrow the selection without renumbering it
// ---------------------------------------------------------------------------

describe("filters", () => {
  it("serves one task's rows only, with the ledger's own numbering", async () => {
    const { path, taskIds } = seed({ perTask: 4, tasks: 2 });
    const running = await serve(path);
    const target = taskIds[0];
    if (target === undefined) throw new Error("expected a seeded task");

    const filtered = await openStream(
      running.port,
      STREAM_PATH + "?taskId=" + target,
      { "last-event-id": "0" },
    );
    const expected = sequencesInLedger(path, target);
    await filtered.waitUntil(() => eventIds(filtered).length >= expected.length, "the filtered rows");
    const ids = eventIds(filtered);
    const frames = eventFrames(filtered);
    filtered.abort();

    // The rows are that task's, and the ids are the ledger's own sequences —
    // a filtered stream that renumbered from one would make its ids useless as
    // a resume anchor against the unfiltered log.
    expect(ids).toEqual(expected);
    for (const frame of frames) {
      if (frame.kind !== "event") throw new Error("expected an event frame");
      expect(frame.item.taskId).toBe(target);
    }

    const everything = sequencesInLedger(path);
    expect(ids.every((id) => everything.includes(id))).toBe(true);
    expect(ids.length).toBeLessThan(everything.length);
  });
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

describe("redaction is absence, over the wire as well as in the body", () => {
  it("carries no credential- or transcript-shaped material in any frame", async () => {
    // The payload keys are seeded deliberately close to the line: an event
    // whose payload is structured but ordinary. The item carries key NAMES and
    // a byte size, never a value, so nothing here can cross.
    const { path } = seed({
      perTask: 4,
      payload: { accountId: "acct-a", tokens: 12, note: "a bounded operator note" },
    });
    const running = await serve(path);
    const client = await openStream(running.port, STREAM_PATH, { "last-event-id": "0" });
    await client.waitUntil(() => client.frames().length >= 4, "some rows");
    const frames = parsedFrames(client);
    const raw = client.raw();
    client.abort();

    for (const frame of frames) {
      for (const projection of [frame, canonicalize(frame)]) {
        expect(hasObservationPrivacyViolation(projection)).toBe(false);
      }
      if (frame.kind !== "event") continue;
      // The payload's values never cross; only its key names and its size do.
      expect(Object.keys(frame.item)).not.toContain("payload");
      expect(frame.item.payloadKeys.sort()).toEqual(["accountId", "note", "tokens"]);
      expect(raw).not.toContain("a bounded operator note");
    }

    // The concatenated wire bytes, not only the parsed frames: an absolute path
    // or a home directory would show up here even if no schema field held it.
    expect(raw).not.toContain(tmpdir());
    expect(raw).not.toContain("/Users/");
    expect(raw).not.toContain(path);
  });

  it("projects a tool-call receipt as key names and a size, never a value (S1a)", async () => {
    // V2-B4b stage 2. The receipt's nine payload keys are safe by construction
    // — identifiers, screaming-snake vocabulary words and counts — but "safe by
    // construction" is a claim about the producer. What is asserted here is the
    // independent half: whatever the payload holds, the wire carries its key
    // NAMES and its byte size and nothing else, because `timelineItem` never
    // emits `payload` at all.
    //
    // The row is **seeded**, not produced. This proves the projection drops
    // payload values; it proves nothing about a real tool call, which needs the
    // daemon and a tool server and belongs to stage 3.
    const SENTINEL = "sentinel-tool-argument-value";
    const receipt = {
      accountId: "acct-a",
      serverId: SENTINEL,
      toolName: "read_file",
      transport: "STDIO",
      outcome: "COMPLETED",
      refusal: null,
      argumentBytes: 128,
      resultBytes: 4_096,
      contentBlocks: 2,
    };
    const { path } = seed({
      perTask: 2,
      types: ["TOOL_CALL_RECORDED"],
      payload: receipt,
    });
    const running = await serve(path);
    const client = await openStream(running.port, STREAM_PATH, { "last-event-id": "0" });
    await client.waitUntil(() => client.frames().length >= 2, "the receipts");
    const frames = parsedFrames(client);
    const raw = client.raw();
    client.abort();

    let events = 0;
    for (const frame of frames) {
      for (const projection of [frame, canonicalize(frame)]) {
        expect(hasObservationPrivacyViolation(projection)).toBe(false);
      }
      if (frame.kind !== "event") continue;
      events += 1;
      expect(frame.channel).toBe(STREAM_CHANNEL_BY_EVENT_TYPE.TOOL_CALL_RECORDED);
      expect(frame.channel).toBe("execution");
      expect(Object.keys(frame.item)).not.toContain("payload");
      expect(frame.item.payloadKeys.slice().sort()).toEqual(Object.keys(receipt).sort());
      expect(frame.item.payloadByteSize).toBeGreaterThan(0);
    }
    expect(events).toBeGreaterThan(0);

    // The concatenated wire bytes, not only the parsed frames.
    expect(raw).not.toContain(SENTINEL);
    expect(raw).not.toContain(tmpdir());
    expect(raw).not.toContain("/Users/");
    expect(raw).not.toContain(path);

    // S1b — the non-vacuity direction. Without this the assertions above would
    // pass just as happily against a seed that wrote no sentinel at all: what
    // they must show is that the projection dropped it, not that it was never
    // there. It is in the ledger row, read back directly.
    const stored = openLedger(path, { readOnly: true });
    try {
      const page = stored.listEvents({ limit: 10 });
      const canonical = page.events.map((record) => record.canonicalJson).join("");
      expect(canonical).toContain(SENTINEL);
    } finally {
      stored.close();
    }
  });

  it("is not a vacuous check: the same helper refuses a blanked credential", () => {
    // Absence, not emptiness. Without this the assertion above would pass just
    // as happily against a helper that always answered false.
    expect(hasObservationPrivacyViolation({ apiKey: "" })).toBe(true);
    expect(hasObservationPrivacyViolation({ transcript: [] })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The method surface did not move
// ---------------------------------------------------------------------------

describe("the stream is a read", () => {
  it("refuses every non-GET verb with the read plane's own 405", async () => {
    const { path } = seed({ perTask: 2 });
    const running = await serve(path);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect({ method, status: await statusOf(running.port, STREAM_PATH, method) }).toEqual({
        method,
        status: 405,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

describe("the connection ceiling", () => {
  it("refuses the one too many with STREAM_CAPACITY, and holds the rest open", async () => {
    const { path } = seed({ perTask: 2 });
    const running = await serve(path);

    const held: SseClient[] = [];
    for (let index = 0; index < STREAM_MAX_CONNECTIONS; index += 1) {
      const client = await openStream(running.port, STREAM_PATH);
      await client.waitForFrames(1);
      held.push(client);
    }

    const { status, body } = await getJson(running.port, STREAM_PATH);
    const error = ApiError.parse(body);
    expect({ status, code: error.error.code }).toEqual({
      status: 503,
      code: "STREAM_CAPACITY",
    });

    // The refusal is not a stampede: the connections already open are
    // untouched, which is the half of a capacity fuse that is easy to break.
    for (const client of held) {
      expect(client.ended()).toBe(false);
      expect(client.frames()[0]?.event).toBe("acp.hello");
    }

    // And the ceiling releases: close one, and the next caller is served.
    held[0]?.abort();
    const admitted = await openStream(running.port, STREAM_PATH);
    await admitted.waitForFrames(1);
    expect(admitted.status).toBe(200);
    admitted.abort();
    for (const client of held) client.abort();
  });
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

describe("closing the server drains the streams first", () => {
  it("resolves with a live stream open, and the client sees a clean end", async () => {
    // Two failures this rules out at once, and the second is the quieter one:
    // an SSE response is never an idle connection, so without the drain
    // `close()` waits on it forever; and closing the ledger under a handler
    // holding a cursor raises LedgerClosedError inside a hijacked response,
    // where no error envelope can carry it.
    const { path } = seed({ perTask: 3 });
    const running = await startServer({ ledgerPath: path, port: 0 });
    const client = await openStream(running.port, STREAM_PATH, { "last-event-id": "0" });
    await client.waitForFrames(2);
    expect(client.ended()).toBe(false);

    await running.close();

    await client.waitForEnd();
    expect(client.ended()).toBe(true);
    // Nothing was written after the frames: no error object, no stray envelope
    // squeezed onto a socket that was already carrying a stream.
    expect(client.raw()).not.toContain('"error"');
    expect(client.raw()).not.toContain("LEDGER_UNAVAILABLE");

    // Every frame that did arrive is still a lawful frame — a drain that
    // truncated one mid-write would fail here.
    expect(() => parsedFrames(client)).not.toThrow();
  });

  it("resolves with several streams open, not only one", async () => {
    const { path } = seed({ perTask: 3 });
    const running = await startServer({ ledgerPath: path, port: 0 });
    const clients = await Promise.all([
      openStream(running.port, STREAM_PATH),
      openStream(running.port, STREAM_PATH),
      openStream(running.port, STREAM_PATH),
    ]);
    for (const client of clients) await client.waitForFrames(1);

    await running.close();
    for (const client of clients) await client.waitForEnd();
    for (const client of clients) expect(client.ended()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The heartbeat, on the wire
// ---------------------------------------------------------------------------

describe("the heartbeat keeps an idle line open without moving a cursor", () => {
  it("writes comments, and no comment ever carries an id", async () => {
    // The registry's intervals are a module seam, not an operator one: nothing
    // on `buildServer` or the bin can reach them, and a drill asserts that
    // elsewhere. Shortening them here is what makes a fifteen-second law
    // observable in a test rather than asserted about.
    const { path } = seed({ perTask: 2 });
    const registry = createStreamRegistry({
      pollIntervalMs: 10,
      heartbeatIntervalMs: 25,
    });

    const { default: Fastify } = await import("fastify");
    const app = Fastify({ logger: false });
    const ledger = openLedger(path, { readOnly: true });
    app.get(STREAM_PATH, (_request, reply) => {
      registry.serve(reply, {
        ledger,
        database: { id: "b".repeat(64), label: "control-plane.sqlite", pathRedacted: true },
        filters: {},
        anchor: { kind: "live" },
      });
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const client = await openStream(port, STREAM_PATH);
      await client.waitUntil(() => client.comments().length >= 2, "two heartbeats");
      for (const comment of client.comments()) {
        expect(comment).toBe(": heartbeat");
        expect(comment).not.toContain("id:");
      }
      // A heartbeat is not a frame: it reaches no listener and moves nothing.
      expect(client.frames().filter((frame) => frame.id !== null)).toHaveLength(0);
      client.abort();
    } finally {
      await registry.drain();
      await app.close();
      ledger.close();
    }
  });
});
