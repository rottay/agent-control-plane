/**
 * Presentation-only formatting helpers.
 *
 * Nothing here talks to the network or holds state. Every function is pure so
 * it can be tested without a DOM, and so a view component stays a thin layer
 * over data it already has.
 */

/** Turn a `SCREAMING_SNAKE_CASE` contract literal into a readable label. */
export function humanizeConstant(value: string): string {
  const lower = value.toLowerCase().split("_").join(" ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormat(style: "full" | "compact"): Intl.DateTimeFormat {
  const cached = dateTimeFormatCache.get(style);
  if (cached !== undefined) {
    return cached;
  }
  const format =
    style === "full"
      ? new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "medium",
        })
      : new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
  dateTimeFormatCache.set(style, format);
  return format;
}

/** Absolute timestamp, formatted for display. Returns `null` untouched. */
export function formatTimestamp(value: string | null, style: "full" | "compact" = "full"): string {
  const parsed = new Date(value ?? "");
  if (value === null || Number.isNaN(parsed.getTime())) {
    return "unknown";
  }
  return dateTimeFormat(style).format(parsed);
}

const RELATIVE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ["year", 1000 * 60 * 60 * 24 * 365],
  ["month", 1000 * 60 * 60 * 24 * 30],
  ["week", 1000 * 60 * 60 * 24 * 7],
  ["day", 1000 * 60 * 60 * 24],
  ["hour", 1000 * 60 * 60],
  ["minute", 1000 * 60],
  ["second", 1000],
];

const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/**
 * Human relative time ("3 minutes ago"), computed against an explicit `now`
 * so the result is deterministic in tests and never depends on a hidden
 * system clock read inside a render.
 */
export function formatRelativeTime(value: string, now: Date): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "unknown";
  }
  const deltaMs = parsed.getTime() - now.getTime();
  const absoluteMs = Math.abs(deltaMs);

  if (absoluteMs < 1000) {
    return "just now";
  }

  for (const [unit, unitMs] of RELATIVE_UNITS) {
    if (absoluteMs >= unitMs || unit === "second") {
      const amount = Math.round(deltaMs / unitMs);
      if (amount === 0) {
        continue;
      }
      return relativeTimeFormat.format(amount, unit);
    }
  }
  return "just now";
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Byte count formatted with a fixed-precision unit, never scientific notation. */
export function formatByteSize(byteCount: number): string {
  if (!Number.isFinite(byteCount) || byteCount < 0) {
    return "unknown";
  }
  if (byteCount < 1024) {
    return String(byteCount) + " B";
  }
  let value = byteCount;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = BYTE_UNITS[unitIndex] ?? "TB";
  const precision = value >= 10 ? 0 : 1;
  return value.toFixed(precision) + " " + unit;
}

/** Whole-number count formatted with locale grouping. */
export function formatCount(count: number): string {
  return new Intl.NumberFormat(undefined).format(count);
}

/**
 * Truncate a long opaque value (id, digest) for display while keeping the
 * full value available in the DOM for assistive technology and copy/paste.
 */
export function truncateMiddle(value: string, headLength = 8, tailLength = 6): string {
  if (value.length <= headLength + tailLength + 1) {
    return value;
  }
  return value.slice(0, headLength) + "…" + value.slice(value.length - tailLength);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Loose client-side shape check, used only to decide whether "Open" is worth trying. */
export function looksLikeUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

/** Join class name fragments, dropping falsy entries. Small clsx substitute. */
export function classNames(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
}
