import { describe, expect, it } from "vitest";

import { PRICE_RESOLUTION_STATUSES, resolvePrice } from "../../src/price-catalog/index.js";
import type { PriceKey, PricePin } from "../../src/price-catalog/index.js";
import type { PriceIntervalReadModel } from "../../src/types/index.js";

/**
 * Price resolution inside a pinned catalog version (P-33/catálogo escalón B, ADR 0092).
 *
 * Escalón A's suites prove the catalog is stored and read whole by version; these
 * prove what one version's rows *answer*. Every drill is a pure call: rows, a
 * pin, a key, an instant. No database is opened, because there is nothing here
 * that could need one.
 */

const CATALOG = "catalog-claude";
const MODEL = "claude-opus-5@2026-06-01";
const OTHER_MODEL = "claude-sonnet-5@2026-06-01";

const JAN = "2026-01-01T00:00:00.000Z";
const FEB = "2026-02-01T00:00:00.000Z";
const MAR = "2026-03-01T00:00:00.000Z";

const PIN: PricePin = { catalogDocumentId: CATALOG, catalogVersion: 1 };
const PIN_TWO: PricePin = { catalogDocumentId: CATALOG, catalogVersion: 2 };

/** The key the fixtures price unless a drill says otherwise. */
function key(overrides: Partial<PriceKey> = {}): PriceKey {
  return {
    provider: "claude",
    modelVersionId: MODEL,
    transportKind: "API_KEY",
    tokenClass: "input",
    currency: "USD",
    ...overrides,
  };
}

/** One row of the catalog, in the shape `readPriceIntervals` returns. */
function interval(overrides: Partial<PriceIntervalReadModel> = {}): PriceIntervalReadModel {
  return {
    catalogDocumentId: CATALOG,
    catalogVersion: 1,
    provider: "claude",
    modelVersionId: MODEL,
    transportKind: "API_KEY",
    tokenClass: "input",
    currency: "USD",
    effectiveFrom: JAN,
    effectiveTo: null,
    pricePerMillionNanos: 15_000_000_000,
    recordedBy: "agent:acp/writer",
    sequence: 4,
    ...overrides,
  };
}

describe("the verdict is closed, and says found or missing and nothing else", () => {
  it("names its two statuses, in order, and carries no third", () => {
    expect([...PRICE_RESOLUTION_STATUSES]).toEqual(["FOUND", "PRICE_MISSING"]);
  });

  it("answers FOUND with the row itself, so the price, the currency and the window travel", () => {
    const row = interval();
    const verdict = resolvePrice([row], PIN, key(), FEB);
    expect(verdict).toEqual({ status: "FOUND", interval: row });
    expect(verdict.status === "FOUND" ? verdict.interval.pricePerMillionNanos : null).toBe(15_000_000_000);
    expect(verdict.status === "FOUND" ? verdict.interval.currency : null).toBe("USD");
  });

  it("answers PRICE_MISSING with the pin, and with no amount of any kind", () => {
    const verdict = resolvePrice([], PIN, key(), FEB);
    expect(verdict).toEqual({ status: "PRICE_MISSING", pin: { catalogDocumentId: CATALOG, catalogVersion: 1 } });
    // No price field exists to be zero: the shape itself refuses a zero rate.
    expect(Object.keys(verdict).sort()).toEqual(["pin", "status"]);
  });

  it("is pure: the same four arguments give the same verdict, and no argument is mutated", () => {
    const rows = [interval(), interval({ tokenClass: "output", pricePerMillionNanos: 75_000_000_000 })];
    const pin: PricePin = { catalogDocumentId: CATALOG, catalogVersion: 1 };
    const asked = key();
    const before = JSON.stringify({ rows, pin, asked });

    const first = resolvePrice(rows, pin, asked, FEB);
    const second = resolvePrice(rows, pin, asked, FEB);
    expect(first).toEqual(second);
    expect(JSON.stringify({ rows, pin, asked })).toBe(before);
  });

  it("does not alias the caller's pin into the verdict", () => {
    const mutable = { catalogDocumentId: CATALOG, catalogVersion: 1 };
    const verdict = resolvePrice([], mutable, key(), FEB);
    expect(verdict.status === "PRICE_MISSING" ? verdict.pin : null).not.toBe(mutable);
    expect(verdict.status === "PRICE_MISSING" ? verdict.pin : null).toEqual(mutable);
  });
});

describe("the window is half-open, [effectiveFrom, effectiveTo) (N-P33-10 complete, E3)", () => {
  const bounded = interval({ effectiveTo: FEB });

  it("N-P33-10: the instant equal to effectiveFrom is FOUND, and the one equal to effectiveTo is PRICE_MISSING", () => {
    expect(resolvePrice([bounded], PIN, key(), JAN).status).toBe("FOUND");
    expect(resolvePrice([bounded], PIN, key(), FEB).status).toBe("PRICE_MISSING");
  });

  it("covers strictly inside, and neither before the start nor at or after the end", () => {
    expect(resolvePrice([bounded], PIN, key(), "2026-01-15T12:00:00.000Z").status).toBe("FOUND");
    expect(resolvePrice([bounded], PIN, key(), "2025-12-31T23:59:59.999Z").status).toBe("PRICE_MISSING");
    expect(resolvePrice([bounded], PIN, key(), "2026-02-01T00:00:00.001Z").status).toBe("PRICE_MISSING");
    // The last instant the bounded window covers, one millisecond before its end.
    expect(resolvePrice([bounded], PIN, key(), "2026-01-31T23:59:59.999Z").status).toBe("FOUND");
  });

  it("a null effectiveTo is no declared end, and covers every instant at or after the start", () => {
    const open = interval({ effectiveTo: null });
    expect(resolvePrice([open], PIN, key(), JAN).status).toBe("FOUND");
    expect(resolvePrice([open], PIN, key(), "2099-12-31T23:59:59.999Z").status).toBe("FOUND");
    expect(resolvePrice([open], PIN, key(), "2025-12-31T23:59:59.999Z").status).toBe("PRICE_MISSING");
  });

  it("adjacent intervals hand over at the boundary: exactly one prices the instant, and it is the later", () => {
    const rows = [
      interval({ effectiveTo: FEB, pricePerMillionNanos: 15_000_000_000 }),
      interval({ effectiveFrom: FEB, effectiveTo: MAR, pricePerMillionNanos: 16_000_000_000 }),
    ];
    const at = (instant: string): number | null => {
      const verdict = resolvePrice(rows, PIN, key(), instant);
      return verdict.status === "FOUND" ? verdict.interval.pricePerMillionNanos : null;
    };
    expect(at(JAN)).toBe(15_000_000_000);
    expect(at(FEB)).toBe(16_000_000_000);
    expect(at("2026-01-31T23:59:59.999Z")).toBe(15_000_000_000);
    expect(at("2026-02-28T23:59:59.999Z")).toBe(16_000_000_000);
    // And past the last end, nothing prices it: no row stands in as a zero.
    expect(at(MAR)).toBeNull();
    // Order of the input does not decide the answer.
    expect(resolvePrice([...rows].reverse(), PIN, key(), FEB)).toEqual(resolvePrice(rows, PIN, key(), FEB));
  });
});

describe("resolution never crosses a catalog version (N-P33-9 complete, E8)", () => {
  it("N-P33-9: a pin on version 1 whose interval is in force only in version 2 is PRICE_MISSING, with the version 1 pin", () => {
    // Version 2 reprices January; version 1 has no row at all for the key.
    const versionTwoOnly = interval({ catalogVersion: 2, pricePerMillionNanos: 12_000_000_000 });
    const verdict = resolvePrice([versionTwoOnly], PIN, key(), FEB);
    expect(verdict).toEqual({ status: "PRICE_MISSING", pin: { catalogDocumentId: CATALOG, catalogVersion: 1 } });
    // Positive control: the same row under its own pin resolves.
    expect(resolvePrice([versionTwoOnly], PIN_TWO, key(), FEB)).toEqual({ status: "FOUND", interval: versionTwoOnly });
  });

  it("N-P33B-2: rows of other versions in the input are ignored even while in force, and the pin's own row wins", () => {
    const rows = [
      interval({ catalogVersion: 2, pricePerMillionNanos: 12_000_000_000 }),
      interval({ catalogVersion: 1, pricePerMillionNanos: 15_000_000_000 }),
      interval({ catalogVersion: 3, pricePerMillionNanos: 99_000_000_000 }),
    ];
    const one = resolvePrice(rows, PIN, key(), FEB);
    expect(one.status === "FOUND" ? one.interval.pricePerMillionNanos : null).toBe(15_000_000_000);
    const two = resolvePrice(rows, PIN_TWO, key(), FEB);
    expect(two.status === "FOUND" ? two.interval.pricePerMillionNanos : null).toBe(12_000_000_000);
    // And a pin whose version is not in the input at all is missing, not the nearest.
    expect(resolvePrice(rows, { catalogDocumentId: CATALOG, catalogVersion: 4 }, key(), FEB).status).toBe(
      "PRICE_MISSING",
    );
  });

  it("another document's row is not this document's answer, however current", () => {
    const foreign = interval({ catalogDocumentId: "catalog-openai" });
    expect(resolvePrice([foreign], PIN, key(), FEB).status).toBe("PRICE_MISSING");
    expect(
      resolvePrice([foreign], { catalogDocumentId: "catalog-openai", catalogVersion: 1 }, key(), FEB).status,
    ).toBe("FOUND");
  });
});

describe("no interval applicable is PRICE_MISSING, never zero (N-P33-11 complete, E7)", () => {
  it("N-P33-11: an empty catalog version, and a version with rows none of which apply, are both PRICE_MISSING", () => {
    expect(resolvePrice([], PIN, key(), FEB).status).toBe("PRICE_MISSING");
    const elsewhere = [interval({ effectiveFrom: MAR, effectiveTo: null })];
    const verdict = resolvePrice(elsewhere, PIN, key(), JAN);
    expect(verdict).toEqual({ status: "PRICE_MISSING", pin: { catalogDocumentId: CATALOG, catalogVersion: 1 } });
    // Positive control: at an instant the row does cover, it resolves.
    expect(resolvePrice(elsewhere, PIN, key(), MAR).status).toBe("FOUND");
  });

  it("a zero-priced row is a real price and resolves FOUND; absence is what is missing", () => {
    // A published price of zero is a fact the catalog may state. What economy §3
    // forbids is *inventing* zero where no row exists, and the two are told apart
    // by the verdict, not by the number.
    const free = interval({ pricePerMillionNanos: 0 });
    const verdict = resolvePrice([free], PIN, key(), FEB);
    expect(verdict.status).toBe("FOUND");
    expect(verdict.status === "FOUND" ? verdict.interval.pricePerMillionNanos : null).toBe(0);
    expect(resolvePrice([], PIN, key(), FEB).status).toBe("PRICE_MISSING");
  });
});

describe("the key is exact in all five columns (N-P33B-1, N-P33B-3, E12)", () => {
  it("N-P33B-1: a null modelVersionId is PRICE_MISSING, and is never aliased to another model version's price", () => {
    const rows = [interval(), interval({ modelVersionId: OTHER_MODEL, pricePerMillionNanos: 3_000_000_000 })];
    const verdict = resolvePrice(rows, PIN, key({ modelVersionId: null }), FEB);
    expect(verdict).toEqual({ status: "PRICE_MISSING", pin: { catalogDocumentId: CATALOG, catalogVersion: 1 } });
    // Positive control: naming either model resolves that model's own price.
    const named = resolvePrice(rows, PIN, key(), FEB);
    expect(named.status === "FOUND" ? named.interval.pricePerMillionNanos : null).toBe(15_000_000_000);
    const other = resolvePrice(rows, PIN, key({ modelVersionId: OTHER_MODEL }), FEB);
    expect(other.status === "FOUND" ? other.interval.pricePerMillionNanos : null).toBe(3_000_000_000);
  });

  it("N-P33B-1: a single-row catalog is not read as 'the' price when the key names no model version", () => {
    // The dangerous shape: exactly one row, so a resolver that fell back to
    // "the only price" would look correct on every fixture but one.
    expect(resolvePrice([interval()], PIN, key({ modelVersionId: null }), FEB).status).toBe("PRICE_MISSING");
  });

  it("N-P33B-3: a currency, transport or token class with no matching row is PRICE_MISSING, with no fallback", () => {
    const rows = [
      interval({ currency: "USD" }),
      interval({ transportKind: "CLI_SUBSCRIPTION", pricePerMillionNanos: 1_000_000_000 }),
      interval({ tokenClass: "output", pricePerMillionNanos: 75_000_000_000 }),
    ];
    for (const asked of [
      key({ currency: "EUR" }),
      key({ transportKind: "GATEWAY_API" }),
      key({ tokenClass: "cache_write" }),
      key({ provider: "openai" }),
    ]) {
      expect(resolvePrice(rows, PIN, asked, FEB).status, JSON.stringify(asked)).toBe("PRICE_MISSING");
    }
    // Positive control: each row is reachable by its own exact key.
    expect(resolvePrice(rows, PIN, key(), FEB).status).toBe("FOUND");
    expect(resolvePrice(rows, PIN, key({ transportKind: "CLI_SUBSCRIPTION" }), FEB).status).toBe("FOUND");
    expect(resolvePrice(rows, PIN, key({ tokenClass: "output" }), FEB).status).toBe("FOUND");
  });

  it("N-P33B-3, E12: two currencies of one version coexist and neither converts into the other", () => {
    const rows = [
      interval({ currency: "USD", pricePerMillionNanos: 15_000_000_000 }),
      interval({ currency: "EUR", pricePerMillionNanos: 14_000_000_000 }),
    ];
    const usd = resolvePrice(rows, PIN, key({ currency: "USD" }), FEB);
    const eur = resolvePrice(rows, PIN, key({ currency: "EUR" }), FEB);
    expect(usd.status === "FOUND" ? [usd.interval.currency, usd.interval.pricePerMillionNanos] : null).toEqual([
      "USD",
      15_000_000_000,
    ]);
    expect(eur.status === "FOUND" ? [eur.interval.currency, eur.interval.pricePerMillionNanos] : null).toEqual([
      "EUR",
      14_000_000_000,
    ]);
    expect(resolvePrice(rows, PIN, key({ currency: "GBP" }), FEB).status).toBe("PRICE_MISSING");
  });

  it("selects on the whole quintuple at once, not on a prefix of it", () => {
    // One row that matches four of five columns, for each of the five.
    const row = interval();
    for (const asked of [
      key({ provider: "openai" }),
      key({ modelVersionId: OTHER_MODEL }),
      key({ transportKind: "GATEWAY_API" }),
      key({ tokenClass: "cache_read" }),
      key({ currency: "EUR" }),
    ]) {
      expect(resolvePrice([row], PIN, asked, FEB).status, JSON.stringify(asked)).toBe("PRICE_MISSING");
    }
    expect(resolvePrice([row], PIN, key(), FEB).status).toBe("FOUND");
  });
});

describe("the resolver selects and does not re-admit (N-P14A-7's precedent)", () => {
  it("a malformed pin matches nothing and is answered missing, carrying the pin it was asked with", () => {
    for (const pin of [
      { catalogDocumentId: "", catalogVersion: 1 },
      { catalogDocumentId: CATALOG, catalogVersion: 0 },
      { catalogDocumentId: CATALOG, catalogVersion: -1 },
    ]) {
      const verdict = resolvePrice([interval()], pin, key(), FEB);
      expect(verdict, JSON.stringify(pin)).toEqual({ status: "PRICE_MISSING", pin });
    }
  });

  it("does not re-judge a stored row: the door's guarantees are not re-checked here", () => {
    // A row the door could never have admitted — its window is inverted — is not
    // re-validated. It simply does not cover the instant, so the answer is the
    // same missing verdict, reached by selection rather than by a second door.
    const impossible = interval({ effectiveFrom: MAR, effectiveTo: JAN });
    expect(resolvePrice([impossible], PIN, key(), FEB).status).toBe("PRICE_MISSING");
    // And a row whose window is sound resolves, which is all this module decides.
    expect(resolvePrice([interval()], PIN, key(), FEB).status).toBe("FOUND");
  });
});
