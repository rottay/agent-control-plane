import { existsSync, readFileSync, rmSync, statSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { LOG_MAX_BYTES, LOG_MAX_FILES, LOG_MAX_LINE_BYTES } from "../../src/constants/index.js";
import { createLogger, generationPaths, logBytes, renderLine, scrub } from "../../src/log/index.js";
import { daemonRootPath, logFilePath, resolveDaemonRoot } from "../../src/paths/index.js";

const AT = "2026-08-27T18:46:07.000Z";
const clock = (): string => AT;

afterEach(() => {
  rmSync(daemonRootPath(), { recursive: true, force: true });
});

describe("what a log line may carry", () => {
  it("strips anything that looks like a filesystem path", () => {
    // Absolute paths name a home directory, a user account and a machine
    // layout. A truncated field is a small loss; a leaked home directory is not.
    expect(scrub("/Users/someone/repo/secret.db")).toBe("<path>");
    expect(scrub("opened /var/folders/x/y and failed")).toBe("opened <path> and failed");
  });

  it("passes scalars through untouched", () => {
    expect(scrub(11)).toBe(11);
    expect(scrub(true)).toBe(true);
    expect(scrub(null)).toBeNull();
  });

  it("caps one line so a single message cannot defeat the file cap", () => {
    const rendered = renderLine({
      at: AT,
      level: "info",
      event: "big",
      code: null,
      fields: { blob: "x".repeat(LOG_MAX_LINE_BYTES * 2) },
    });
    expect(rendered.length).toBeLessThanOrEqual(LOG_MAX_LINE_BYTES);
  });

  it("refuses an event name that is not a short identifier", () => {
    expect(() =>
      renderLine({ at: AT, level: "info", event: "not an identifier", code: null, fields: {} }),
    ).toThrow();
  });

  it("drops fields whose keys are not identifiers", () => {
    const rendered = renderLine({
      at: AT,
      level: "warn",
      event: "ok",
      code: "SINGLETON",
      fields: { good: 1, "bad key": 2 },
    });
    const parsed = JSON.parse(rendered) as { fields: Record<string, unknown> };
    expect(parsed.fields).toEqual({ good: 1 });
  });
});

describe("the bounds", () => {
  it("rotates before the active file passes its byte cap", () => {
    const root = resolveDaemonRoot();
    const logger = createLogger(root, clock);
    // Each field is scrubbed to at most 200 characters, so a line costs roughly
    // 250 bytes; 2000 of them comfortably passes the 256KiB cap.
    for (let index = 0; index < 2_000; index += 1) {
      logger.log("info", "fill", null, { index, pad: "y".repeat(500) });
    }
    expect(statSync(logFilePath(root)).size).toBeLessThanOrEqual(LOG_MAX_BYTES);
    expect(existsSync(logFilePath(root) + ".1")).toBe(true);
  });

  it("keeps the total bounded across every generation", () => {
    // A byte cap alone would let an unbounded number of rotated files
    // accumulate, so the file count has to bind as well. Both, or neither.
    const root = resolveDaemonRoot();
    const logger = createLogger(root, clock);
    for (let index = 0; index < 12_000; index += 1) {
      logger.log("info", "fill", null, { index, pad: "z".repeat(500) });
    }
    expect(logBytes(root)).toBeLessThanOrEqual(LOG_MAX_BYTES * LOG_MAX_FILES);

    const beyond = logFilePath(root) + "." + String(LOG_MAX_FILES);
    expect(existsSync(beyond)).toBe(false);
    expect(generationPaths(logFilePath(root))).toHaveLength(LOG_MAX_FILES - 1);
  });

  it("keeps the newest content and drops the oldest", () => {
    const root = resolveDaemonRoot();
    const logger = createLogger(root, clock);
    logger.log("info", "oldest", null, { marker: "first-marker" });
    for (let index = 0; index < 12_000; index += 1) {
      logger.log("info", "fill", null, { index, pad: "q".repeat(500) });
    }
    logger.log("info", "newest", null, { marker: "last-marker" });

    expect(readFileSync(logFilePath(root), "utf8")).toContain("last-marker");
    const everything = [logFilePath(root), ...generationPaths(logFilePath(root))]
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path, "utf8"))
      .join("");
    expect(everything).not.toContain("first-marker");
  });
});
