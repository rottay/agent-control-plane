/**
 * The product-path markers — `@acp/contracts` (P-15 escalón D3, ADR 0105).
 *
 * The path fragments that mean "this is somebody's product checkout". A directory
 * whose path carries one is refused outright, whatever else is true about it: a
 * provider's configuration root or working directory (the providers' own
 * admission), and the evidence root a recorded walk writes its markers under (the
 * runtime's). Two admissions read one vocabulary, and neither may import the
 * other, so the set lives in the one package both can reach (decision 139, C-D1).
 *
 * Data only. The filesystem checks that read it stay with each admitting module,
 * and a shared vector table holds the two copies of those checks to one answer.
 */

/** Substrings of an absolute path that name a product checkout. */
export const PRODUCT_PATH_MARKERS: readonly string[] = Object.freeze([
  "/Rottay/app-",
  "/Rottay/dm-",
  "/Rottay/svc-",
  "/Rottay/ui-",
  "/Rottay/platform",
]);
