/**
 * Build a query string from a loose record of filter values.
 *
 * `undefined`, `null` and empty-string values are omitted rather than sent as
 * literal empty parameters, so a cleared filter field actually clears the
 * request instead of asking the server to match an empty string.
 */
export function buildQueryString(
  params: Readonly<Record<string, string | number | undefined | null>>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized === "" ? "" : "?" + serialized;
}

export function buildPath(
  base: string,
  params: Readonly<Record<string, string | number | undefined | null>>,
): string {
  return base + buildQueryString(params);
}
