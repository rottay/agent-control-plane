/**
 * The value types of price resolution (P-33/catálogo escalón B, ADR 0092).
 *
 * The status vocabulary's derived union, the catalog pin, the price key, and the
 * two verdicts with their union: the declarations this concept owns, in the
 * concept's own leaf rather than interleaved with the resolver that reads them.
 * Born conforming to the owner's law `docs/audit/architecture/index.md` §7 — the
 * ADR 0088 errata of 2026-09-14 withdrew that record's "Types live inline in the
 * module" for every new declaration, decision 90 registered it, and C-3 / P-37
 * seam 1 paid the debt for six older concepts; this one starts where they ended.
 *
 * A pure type leaf, on `../../types/index.ts`' and `../../usage-settlement/types/index.ts`'
 * pattern: it declares data and nothing else, and imports only types. The closed
 * set the union is derived from stays in `../index.ts` beside the resolver, and is
 * read here type-only, which is §7.1's one-way derivation and is erased at emit.
 */

import type { PriceIntervalReadModel, PriceTokenClass } from "../../types/index.js";
import type { PRICE_RESOLUTION_STATUSES } from "../index.js";

export type PriceResolutionStatus = (typeof PRICE_RESOLUTION_STATUSES)[number];

/**
 * The catalog version a spend is priced against: a document, and one of its
 * versions.
 *
 * Fixed before the spend and reused by every later replay (economy §3's rebuild
 * row, `:207`), which is what makes a cost reproducible: the question is never
 * "what does this cost now" but "what did the version we pinned say". The pin is
 * *not* the whole identity of an interval — economy §3's primary key is eight
 * columns — it is the two that choose the version, and {@link PriceKey} carries
 * the five that choose the row inside it. The eighth, `effectiveFrom`, is not
 * asked for: it is what resolution *finds*.
 *
 * Structurally identical to `PriceIntervalQuery`, which is what `readPriceIntervals`
 * reads a version by, so the rows a caller holds and the pin it resolves against
 * come from one coordinate rather than two spellings of it.
 */
export interface PricePin {
  readonly catalogDocumentId: string;
  readonly catalogVersion: number;
}

/**
 * What is being priced, inside an already pinned version: economy §3's primary
 * key without the document, the version and `effectiveFrom`.
 *
 * `modelVersionId` is nullable because the asking side may not know it — an
 * execution route segment records `provider` and `transport_kind` but admits a
 * NULL `model_version_id`. A null is answered `PRICE_MISSING` and **never**
 * aliased to another model version's price: a price for a model nobody named is
 * an invented number, which economy §3 `:195-197` forbids more strongly than it
 * dislikes a missing one.
 *
 * Every one of the five participates in the match, exactly. There is no fallback
 * between currencies, transports or token classes: the currency is part of the
 * identity and is never converted, so "no price in USD" is a missing price and
 * not a reason to read the EUR row.
 */
export interface PriceKey {
  readonly provider: string;
  readonly modelVersionId: string | null;
  readonly transportKind: string;
  readonly tokenClass: PriceTokenClass;
  readonly currency: string;
}

/** The interval in force for the key at the instant, inside the pinned version. */
export interface PriceFound {
  readonly status: "FOUND";
  /** The row itself, so the caller keeps the price, the currency and the window it was read from. */
  readonly interval: PriceIntervalReadModel;
}

/**
 * No interval of the pinned version prices the key at the instant.
 *
 * Carries the pin back, intact and never widened: economy §3 `:284-286` keeps a
 * known catalog pin's document and version on a line it cannot value, empties the
 * interval reference, and marks it `PRICE_MISSING`. This verdict is that sentence
 * as a value — there is no price, no zero and no row standing in for one.
 */
export interface PriceMissing {
  readonly status: "PRICE_MISSING";
  readonly pin: PricePin;
}

/**
 * The verdict of resolution: found, or named missing.
 *
 * Two members and no third. There is no "defaulted", no "estimated" and no
 * amount-bearing failure, because economy §3 `:195-197` has no fallback rate of
 * `0`: a cost that could not be priced is reported as unpriced, and the decision
 * about what that means for a budget belongs to whoever reads it.
 */
export type PriceResolution = PriceFound | PriceMissing;

/**
 * One published version of a price catalog document, as the vigente rule reads it
 * (P-15 escalón C, ADR 0103): its number and the instant it takes effect.
 */
export interface CatalogVersionFact {
  readonly catalogVersion: number;
  readonly effectiveFrom: string;
}

/**
 * Which version of one document is in force at an instant (adjudication v2 C3).
 *
 * Three members and no fourth: the one version in force, none (no version has
 * taken effect yet), or an ambiguity — two or more versions sharing the greatest
 * `effectiveFrom` at or before the instant — which is refused, never resolved by
 * picking one.
 */
export type VigentSelection =
  | { readonly kind: "VIGENT"; readonly catalogVersion: number; readonly effectiveFrom: string }
  | { readonly kind: "NONE" }
  | { readonly kind: "AMBIGUOUS"; readonly catalogVersions: readonly number[]; readonly effectiveFrom: string };

/** What a pin must cover: the delivery segment's three columns of economy §3's key. */
export interface PinCoverageKey {
  readonly provider: string;
  readonly modelVersionId: string | null;
  readonly transportKind: string;
}
