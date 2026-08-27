import { describe, expect, it } from "vitest";

import {
  classNames,
  formatByteSize,
  formatCount,
  formatRelativeTime,
  formatTimestamp,
  humanizeConstant,
  looksLikeUuid,
  truncateMiddle,
} from "./format.js";

describe("humanizeConstant", () => {
  it("turns a screaming snake case literal into a sentence-cased label", () => {
    expect(humanizeConstant("READY_TO_COMMIT")).toBe("Ready to commit");
    expect(humanizeConstant("RUNNING")).toBe("Running");
    expect(humanizeConstant("A")).toBe("A");
  });
});

describe("formatTimestamp", () => {
  it("formats a valid iso timestamp", () => {
    const formatted = formatTimestamp("2026-01-02T03:04:05.000Z");
    expect(formatted).not.toBe("unknown");
    expect(formatted.length).toBeGreaterThan(0);
  });

  it("reports unknown for null or unparseable input", () => {
    expect(formatTimestamp(null)).toBe("unknown");
    expect(formatTimestamp("not-a-date")).toBe("unknown");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");

  it("describes the recent past", () => {
    expect(formatRelativeTime("2026-01-01T11:59:00.000Z", now)).toContain("minute");
  });

  it("describes the near future", () => {
    const result = formatRelativeTime("2026-01-01T12:05:00.000Z", now);
    expect(result).toContain("minute");
  });

  it("treats sub-second deltas as just now", () => {
    expect(formatRelativeTime("2026-01-01T12:00:00.200Z", now)).toBe("just now");
  });

  it("reports unknown for an unparseable value", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("unknown");
  });
});

describe("formatByteSize", () => {
  it("keeps small counts in bytes", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(512)).toBe("512 B");
  });

  it("scales into kilobytes and megabytes with bounded precision", () => {
    expect(formatByteSize(2048)).toBe("2.0 KB");
    expect(formatByteSize(1024 * 1024 * 5)).toBe("5.0 MB");
  });

  it("reports unknown for a negative or non-finite value", () => {
    expect(formatByteSize(-1)).toBe("unknown");
    expect(formatByteSize(Number.NaN)).toBe("unknown");
  });
});

describe("formatCount", () => {
  it("applies locale grouping", () => {
    expect(formatCount(1000)).toMatch(/1[,.\s]000/);
  });
});

describe("truncateMiddle", () => {
  it("leaves short values untouched", () => {
    expect(truncateMiddle("abc")).toBe("abc");
  });

  it("truncates a long value with an ellipsis in the middle", () => {
    const long = "0123456789abcdef0123456789abcdef";
    const truncated = truncateMiddle(long);
    expect(truncated).not.toBe(long);
    expect(truncated).toContain("…");
    expect(truncated.startsWith(long.slice(0, 8))).toBe(true);
    expect(truncated.endsWith(long.slice(-6))).toBe(true);
  });
});

describe("looksLikeUuid", () => {
  it("accepts a well formed uuid", () => {
    expect(looksLikeUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(looksLikeUuid("not-a-uuid")).toBe(false);
    expect(looksLikeUuid("")).toBe(false);
  });
});

describe("classNames", () => {
  it("joins truthy string fragments and drops falsy ones", () => {
    expect(classNames("a", false, "b", undefined, null, "")).toBe("a b");
  });
});
