import type { PriceIntervalReadModel } from "../types/index.js";

import type {
  CatalogVersionFact,
  PinCoverageKey,
  PriceKey,
  PricePin,
  PriceResolution,
  VigentSelection,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf,
 * `./types/index.ts`, and are re-exported here unchanged so every importer
 * keeps reading them from this module (owner law §7, ADR 0088 errata,
 * decision 90; `usage-settlement`'s and `outbox-store`'s precedent).
 */
export type {
  PriceResolutionStatus,
  PricePin,
  PriceKey,
  PriceFound,
  PriceMissing,
  PriceResolution,
  CatalogVersionFact,
  VigentSelection,
  PinCoverageKey,
} from "./types/index.js";

/**
 * Price resolution inside a pinned catalog version (P-33/catálogo escalón B, ADR 0092).
 *
 * Escalón A made the catalog storable: economy §3's `price_interval_read_model`,
 * the append door that holds a `PRICE_TABLE` to a closed payload, the fold that
 * publishes a version whole, and `readPriceIntervals` which reads one version
 * exactly. What A deliberately did not do is *answer a price*, because the
 * registry "sets no price". This module is that answer, and nothing else.
 *
 * **It is a pure function.** Rows in, a pin, a key and an instant in; a verdict
 * out. No database handle, no clock, no identity, no I/O — the same four
 * arguments always give the same verdict, which is what lets a replay reprice a
 * spend and get the number the spend was charged. `resolvePrice` does not read
 * the catalog: the caller has already read it, with `readPriceIntervals`, whose
 * answer is already bounded to one version.
 *
 * **It selects; it does not re-admit.** Economy §3 forbids two intervals of one
 * quintuple meeting inside a version, and A's door refuses such a version
 * fail-closed before any row is written. So the resolver does not re-check
 * overlap, does not re-validate a row's shape and does not ask whether a model
 * version is still registered — a rebuild folds what the door admitted
 * (N-P14A-7), and a resolver that re-judged stored rows would be a second,
 * weaker door. What it does check is the *question*: the pin, the key and the
 * instant, against the rows it was handed.
 *
 * **It never invents a number.** There is no fallback rate of `0` (economy §3
 * `:195-197`, and data `:674-675`). A key nothing prices is `PRICE_MISSING` with
 * the pin intact — economy §3 `:284-286`'s sentence, as a value — and never a
 * zero price, never an empty row, never the nearest neighbour's price.
 *
 * ## What this escalón is not wired to
 *
 * Nothing calls it yet, and that is deliberate. Persisting the pin on an
 * execution route segment or a dispatch, so that a spend records the version it
 * was priced against *before* the money moves, is P-15's, with the amendment to
 * the execution dictionary that needs (the DT's Q1). Rationals, rounding,
 * `cost_snapshot_*`, valuation policy, periods and proration are economy §4-§6
 * and are not here. L-P33B-1 holds that reach: the resolution is reached through
 * the ledger's barrel by name, and no consumer reimplements the selection.
 */

/**
 * The two verdicts resolution can reach, closed.
 *
 * The vocabulary is a value and lives beside the resolver; the union derived from
 * it is declared in the type leaf, which is §7.1's one-way derivation. Two
 * members, in the order a reader meets them: the answer, then its absence.
 * `PRICE_MISSING` is the word economy §4's valuation status uses, spelled here so
 * the ledger and the dictionary do not drift into two names for one outcome.
 */
export const PRICE_RESOLUTION_STATUSES = ["FOUND", "PRICE_MISSING"] as const;

/**
 * Resolve one price key at one instant, inside one pinned catalog version.
 *
 * @param intervals The rows of the pinned version, as `readPriceIntervals`
 *   returns them. Rows of any other document or version are ignored rather than
 *   trusted — economy §3 `:205`: a lookup never crosses versions, so a v2 row
 *   that is in force at the instant is still not v1's answer (N-P33-9). Passing a
 *   wider list than one version is therefore safe, not permitted-by-accident.
 * @param pin The catalog document and version the spend was pinned to.
 * @param key The five columns that choose a row inside that version. A null
 *   `modelVersionId` resolves `PRICE_MISSING` and is never aliased (N-P33B-1).
 * @param instant The authoritative instant of the dispatch, as the canonical
 *   ISO-8601 millisecond UTC text the catalog's own columns carry. The window is
 *   **half-open**, `[effectiveFrom, effectiveTo)`: the start is covered, the end
 *   is not (economy §3 `:184-185`; estimation `:291`'s
 *   `effectiveFrom <= asOf < effectiveTo`). An `effectiveTo` of `null` is no
 *   declared end and covers every instant at or after the start.
 *
 * @returns `FOUND` with the interval, or `PRICE_MISSING` with the pin.
 */
export function resolvePrice(
  intervals: readonly PriceIntervalReadModel[],
  pin: PricePin,
  key: PriceKey,
  instant: string,
): PriceResolution {
  // Economy §3's identity is exact, and a model version nobody named is not a
  // model version. Answered before the rows are touched, so no scan can find a
  // row "close enough" to a key that is missing one of its five columns.
  const modelVersionId = key.modelVersionId;
  if (modelVersionId === null) return missing(pin);

  for (const interval of intervals) {
    // The version first: two of the eight columns, and the two that make the
    // answer reproducible. A row of another document or another version is not a
    // candidate, however current it looks.
    if (interval.catalogDocumentId !== pin.catalogDocumentId) continue;
    if (interval.catalogVersion !== pin.catalogVersion) continue;

    // Then the five of the key, each exactly. No fallback between currencies,
    // transports or token classes: the currency is part of the identity and is
    // never converted here.
    if (interval.provider !== key.provider) continue;
    if (interval.modelVersionId !== modelVersionId) continue;
    if (interval.transportKind !== key.transportKind) continue;
    if (interval.tokenClass !== key.tokenClass) continue;
    if (interval.currency !== key.currency) continue;

    // And the window, half-open. Text order is time order for the canonical form
    // the door admits, which is why the comparison is the one the column's own
    // `ck_price_interval_read_model__interval_order` makes.
    if (instant < interval.effectiveFrom) continue;
    if (interval.effectiveTo !== null && instant >= interval.effectiveTo) continue;

    // At most one row of a quintuple can cover an instant: the door refused the
    // version otherwise. The first match is therefore the only match, and taking
    // it is selection, not a tie-break.
    return { status: "FOUND", interval };
  }

  return missing(pin);
}

/**
 * The absence, with the pin carried back and nothing else invented.
 *
 * The pin is rebuilt field by field rather than passed through, so the verdict
 * cannot alias a caller's mutable object and cannot smuggle a field the pin does
 * not have. Economy §3 `:284-286`: document and version kept, interval reference
 * empty, `PRICE_MISSING`.
 */
function missing(pin: PricePin): PriceResolution {
  return {
    status: "PRICE_MISSING",
    pin: { catalogDocumentId: pin.catalogDocumentId, catalogVersion: pin.catalogVersion },
  };
}

/**
 * The version of one catalog document in force at an instant (P-15 escalón C,
 * ADR 0103; adjudication v2 C3 (ii); streams `:313, :338`).
 *
 * Among the versions whose `effectiveFrom` is at or before the instant, the one
 * with the greatest `effectiveFrom`. A version that has not taken effect yet is
 * never in force, however high its number; an older version is not in force while
 * a newer one rules. Pure: the caller reads the versions, this decides.
 *
 * **A tie is refused, never broken.** Two versions sharing the greatest
 * `effectiveFrom` are `AMBIGUOUS` (Q-C3): neither the higher number nor the later
 * sequence is a rule anybody wrote, so picking one would invent a precedence. The
 * registry does not yet forbid publishing such a pair, so this is the one place
 * the ambiguity is caught.
 *
 * Text order is time order for the canonical ISO-8601 millisecond UTC form the
 * registry's own column carries, which is the comparison `resolvePrice` makes.
 */
export function selectVigentCatalogVersion(
  versions: readonly CatalogVersionFact[],
  instant: string,
): VigentSelection {
  let greatest: string | null = null;
  for (const version of versions) {
    if (version.effectiveFrom > instant) continue;
    if (greatest === null || version.effectiveFrom > greatest) greatest = version.effectiveFrom;
  }
  if (greatest === null) return { kind: "NONE" };
  const ruling = versions
    .filter((version) => version.effectiveFrom === greatest)
    .map((version) => version.catalogVersion)
    .sort((a, b) => a - b);
  const [only] = ruling;
  if (ruling.length !== 1 || only === undefined) {
    return { kind: "AMBIGUOUS", catalogVersions: ruling, effectiveFrom: greatest };
  }
  return { kind: "VIGENT", catalogVersion: only, effectiveFrom: greatest };
}

/**
 * Does a pinned version cover a delivery's segment at an instant (P-15 escalón C,
 * ADR 0103; adjudication v2 C3 (iii))?
 *
 * Yes when at least one interval of that exact version names the segment's
 * provider, model version and transport kind, and its half-open window
 * `[effectiveFrom, effectiveTo)` holds the instant — `resolvePrice`'s own window.
 * A segment whose model version is `null` is **never** covered (ADR 0092 Four): a
 * price for a model nobody named is not aliased from another. Class and currency
 * are not asked here: an absent class is valuation's `PRICE_MISSING`, not a reason
 * to refuse the delivery.
 */
export function pinCovers(
  intervals: readonly PriceIntervalReadModel[],
  pin: PricePin,
  key: PinCoverageKey,
  instant: string,
): boolean {
  const modelVersionId = key.modelVersionId;
  if (modelVersionId === null) return false;
  return intervals.some(
    (interval) =>
      interval.catalogDocumentId === pin.catalogDocumentId &&
      interval.catalogVersion === pin.catalogVersion &&
      interval.provider === key.provider &&
      interval.modelVersionId === modelVersionId &&
      interval.transportKind === key.transportKind &&
      instant >= interval.effectiveFrom &&
      (interval.effectiveTo === null || instant < interval.effectiveTo),
  );
}
