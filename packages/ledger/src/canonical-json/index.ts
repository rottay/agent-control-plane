import { createHash } from "node:crypto";

import { LedgerCanonicalizationError } from "../errors/index.js";

/**
 * Canonical JSON for the ledger hash chain.
 *
 * Two properties matter, and JSON.stringify gives neither on its own:
 *
 * 1. Determinism. The same logical value must produce the same bytes on every
 *    machine and every run, so object keys are emitted in ascending UTF-16 code
 *    unit order rather than in insertion order.
 * 2. Losslessness. JSON.stringify silently drops or rewrites values it cannot
 *    represent: undefined members vanish, array holes become null, non finite
 *    numbers become null, a Date becomes a string, a symbol keyed property is
 *    ignored. Every one of those is a silent coercion, and a hash chain built
 *    over silently coerced bytes proves nothing about what was appended.
 *
 * This encoder therefore refuses anything it cannot round-trip. Refusal is the
 * point: the caller learns that the value is not representable instead of
 * discovering later that the ledger recorded something other than what it was
 * handed.
 */

/**
 * Depth budget. The contracts package already bounds event payload size, so
 * this exists to make a pathological or adversarial structure fail with a
 * typed error rather than with a stack overflow.
 */
export const CANONICAL_MAX_DEPTH = 64;

/** The previous digest used for the first event in an empty ledger. */
export const GENESIS_SHA256 = "0".repeat(64);

function formatPath(segments: readonly (string | number)[]): string {
  return segments.length === 0 ? "<root>" : segments.join(".");
}

function reject(segments: readonly (string | number)[], reason: string): never {
  throw new LedgerCanonicalizationError(formatPath(segments), reason);
}

function encodeString(value: string): string {
  // JSON string escaping is fully specified by QuoteJSONString, so this is
  // deterministic across engines. Only key ordering had to be fixed by hand.
  return JSON.stringify(value);
}

function encodeNumber(value: number, segments: readonly (string | number)[]): string {
  if (!Number.isFinite(value)) {
    reject(segments, "NaN and Infinity have no JSON form");
  }
  if (Object.is(value, -0)) {
    // JSON.stringify(-0) is "0", so the sign is lost on the way in and the
    // value that comes back out is a different value. Refuse rather than coerce.
    reject(segments, "negative zero cannot survive a JSON round trip");
  }
  return JSON.stringify(value);
}

function encodeArray(
  value: readonly unknown[],
  segments: readonly (string | number)[],
  seen: Set<object>,
  depth: number,
): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    reject(segments, "array subclasses do not round trip as plain arrays");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    reject(segments, "symbol keyed properties are silently dropped by JSON");
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      reject([...segments, index], "array holes are silently rewritten to null by JSON");
    }
  }
  // Own names are the indices plus length. Anything else is a property that
  // JSON would drop without telling the caller.
  if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
    reject(segments, "arrays must not carry extra own properties");
  }

  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    parts.push(encode(value[index], [...segments, index], seen, depth + 1));
  }
  return "[" + parts.join(",") + "]";
}

function encodeObject(
  value: object,
  segments: readonly (string | number)[],
  seen: Set<object>,
  depth: number,
): string {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    // Date, Map, Set, RegExp, Buffer and class instances all land here. Each of
    // them would be rewritten by JSON.stringify into something that does not
    // reconstruct the original value.
    reject(segments, "only plain objects round trip through JSON without coercion");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    reject(segments, "symbol keyed properties are silently dropped by JSON");
  }

  const names = Object.getOwnPropertyNames(value);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined) continue;
    if (typeof descriptor.get === "function" || typeof descriptor.set === "function") {
      reject([...segments, name], "accessor properties are not plain JSON data");
    }
    if (!descriptor.enumerable) {
      reject([...segments, name], "non enumerable own properties are silently dropped by JSON");
    }
  }

  // Default sort order is ascending UTF-16 code unit order, which is what makes
  // the encoding reproducible.
  const sorted = [...names].sort();
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const name of sorted) {
    parts.push(
      encodeString(name) + ":" + encode(record[name], [...segments, name], seen, depth + 1),
    );
  }
  return "{" + parts.join(",") + "}";
}

function encode(
  value: unknown,
  segments: readonly (string | number)[],
  seen: Set<object>,
  depth: number,
): string {
  if (depth > CANONICAL_MAX_DEPTH) {
    reject(
      segments,
      "value is nested deeper than the canonical depth budget of " +
        String(CANONICAL_MAX_DEPTH),
    );
  }

  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return encodeNumber(value, segments);
    case "string":
      return encodeString(value);
    case "undefined":
      reject(segments, "undefined is not a JSON value");
      break;
    case "bigint":
      reject(segments, "bigint has no JSON form and would throw on stringify");
      break;
    case "function":
      reject(segments, "functions are silently dropped by JSON");
      break;
    case "symbol":
      reject(segments, "symbols are silently dropped by JSON");
      break;
    default:
      break;
  }

  const asObject = value as object;
  if (seen.has(asObject)) {
    reject(segments, "value is cyclic and cannot be serialized");
  }
  seen.add(asObject);
  try {
    if (Array.isArray(asObject)) {
      return encodeArray(asObject as readonly unknown[], segments, seen, depth);
    }
    return encodeObject(asObject, segments, seen, depth);
  } finally {
    // Remove on the way out so that the same object appearing twice as siblings
    // is legal, while a genuine cycle is still caught.
    seen.delete(asObject);
  }
}

/**
 * Encode a value as canonical JSON, or throw LedgerCanonicalizationError.
 *
 * The result is stable across processes and runs for the same logical value.
 */
export function canonicalJsonStringify(value: unknown): string {
  return encode(value, [], new Set<object>(), 0);
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The ledger chain digest.
 *
 * event_sha256 = sha256(previous_sha256 + "\n" + canonical_event_json)
 *
 * The newline separator is not decoration: previous_sha256 is fixed width hex,
 * so without a separator a chain digest and a body could in principle be
 * concatenated ambiguously. With it, the preimage is unambiguous.
 */
export function chainDigest(previousSha256: string, canonicalEventJson: string): string {
  return sha256Hex(previousSha256 + "\n" + canonicalEventJson);
}
