/**
 * A strict structural reader for one fixed generated document shape.
 *
 * Not a plist library, and deliberately not a set of regular expressions over
 * the raw text. A text scan cannot see structure, and the specific way that
 * matters here is duplicate keys: a document carrying `RunAtLoad` twice, once
 * false and once true, satisfies every substring check and passes
 * `plutil -lint` — lint accepts duplicates and conversion silently keeps one —
 * while launchd resolves the duplicate on its own rules. A validator built on
 * text would bless a document whose effective behaviour it never examined.
 *
 * So the reader parses, and every policy question is asked of the parsed
 * structure. The grammar it accepts is exactly what this package generates:
 * one top-level dict, a sequence of keys each followed by exactly one value,
 * values limited to string, boolean and array-of-string. Anything else is
 * refused rather than tolerated, because anything else did not come from here.
 */

export type LaunchdRefusal =
  // structure
  | "MALFORMED_PLIST"
  | "DUPLICATE_KEY"
  | "UNKNOWN_KEY"
  | "MISSING_KEY"
  | "UNEXPECTED_VALUE"
  | "NESTED_DICT"
  | "ENTITY_REFERENCE"
  | "ARGUMENT_MISMATCH"
  // policy
  | "RUN_AT_LOAD_TRUE"
  | "KEEP_ALIVE_TRUE"
  | "FORBIDDEN_KEY"
  | "HOST_SPECIFIC_LITERAL"
  | "UNSUBSTITUTED"
  // rendering
  | "UNKNOWN_PLACEHOLDER"
  | "MISSING_VALUE"
  | "UNUSED_VALUE"
  | "VALUE_REINJECTS"
  | "VALUE_CONTROL_CHAR"
  | "VALUE_NOT_XML_SAFE"
  | "BAD_LABEL"
  // referenced paths
  | "PATH_NOT_ABSOLUTE"
  | "PATH_NOT_CANONICAL"
  | "PATH_MISSING"
  | "PATH_NOT_REGULAR_FILE"
  | "PATH_NOT_DIRECTORY"
  | "PATH_NOT_EXECUTABLE"
  | "PATH_NOT_OWNED"
  | "UNSAFE_PERMISSIONS"
  // destination
  | "DESTINATION_OUTSIDE_LOCAL";

export type LaunchdVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: LaunchdRefusal; readonly detail: string };

export function refuse(reason: LaunchdRefusal, detail: string): LaunchdVerdict {
  return { ok: false, reason, detail };
}

export const ACCEPTED: LaunchdVerdict = { ok: true };

export type PlistValue =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "array"; readonly value: readonly string[] };

export type ParseResult =
  | { readonly ok: true; readonly entries: ReadonlyMap<string, PlistValue> }
  | { readonly ok: false; readonly reason: LaunchdRefusal; readonly detail: string };

/** Exactly the keys this package emits. Anything else did not come from here. */
export const KNOWN_KEYS: readonly string[] = Object.freeze([
  "Label",
  "Program",
  "ProgramArguments",
  "WorkingDirectory",
  "StandardOutPath",
  "StandardErrorPath",
  "RunAtLoad",
  "KeepAlive",
]);

/**
 * Keys that would make launchd start or restart the daemon by itself.
 *
 * The whole point of P2E is an artifact that does nothing until a human loads
 * it deliberately, so every automatic trigger is refused by name.
 */
export const FORBIDDEN_KEYS: readonly string[] = Object.freeze([
  "StartInterval",
  "StartCalendarInterval",
  "WatchPaths",
  "QueueDirectories",
  "StartOnMount",
  "Sockets",
  "MachServices",
  "inetdCompatibility",
]);

/** Literals that would tie a tracked template to one machine or account. */
export const HOST_SPECIFIC_LITERALS: readonly string[] = Object.freeze([
  "/Users/",
  "$HOME",
  "~/",
  "/private/var/root",
  "LaunchAgents",
]);

/**
 * Entity references are refused outright rather than decoded.
 *
 * Decoding only the five named entities left numeric and unknown references in
 * the text, where `plutil` would interpret them and this reader would not — two
 * readers disagreeing about the same document, which is the exact failure the
 * parser exists to prevent. The renderer emits no entity at all (it refuses
 * `<`, `>` and `&` in values), so anything carrying one did not come from here.
 */
function containsEntityReference(text: string): boolean {
  return text.includes("&");
}

/** Skip whitespace and comments; returns the next index of interest. */
function skipTrivia(source: string, from: number): number {
  let index = from;
  for (;;) {
    while (index < source.length && /\s/.test(source.charAt(index))) index += 1;
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index);
      if (end < 0) return -1;
      index = end + 3;
      continue;
    }
    return index;
  }
}

/**
 * Read one complete tag, or report that the document ended inside it.
 *
 * The distinction this draws is the whole reason it exists. A value position
 * holding `<integer>` is a genuine wrong type; a value position holding `<str`
 * is a document that stopped mid-tag. Both used to fall through to the same
 * "unsupported value type" branch, which classified truncation as a type error
 * and let a truncated document be described as something it is not.
 */
function completeTagAt(source: string, index: number): string | null {
  if (source.charAt(index) !== "<") return null;
  const end = source.indexOf(">", index);
  if (end < 0) return null;
  return source.slice(index, end + 1);
}

/**
 * Parse the one shape this package emits.
 *
 * Hand written because the shape is tiny and fixed, and because a dependency
 * that accepted more than this would defeat the purpose: the strictness is the
 * feature.
 */
export function parseFixedPlist(source: string): ParseResult {
  const malformed = (detail: string): ParseResult =>
    ({ ok: false, reason: "MALFORMED_PLIST", detail });

  // The prologue is optional but, when present, must be well formed.
  let index = skipTrivia(source, 0);
  if (index < 0) return malformed("unterminated comment");
  if (source.startsWith("<?xml", index)) {
    const end = source.indexOf("?>", index);
    if (end < 0) return malformed("unterminated xml declaration");
    index = skipTrivia(source, end + 2);
  }
  if (index >= 0 && source.startsWith("<!DOCTYPE", index)) {
    const end = source.indexOf(">", index);
    if (end < 0) return malformed("unterminated doctype");
    index = skipTrivia(source, end + 1);
  }
  if (index < 0) return malformed("unterminated comment");

  // The exact opening this package emits, not "anything beginning <plist".
  // A different version attribute is a different document format, and accepting
  // one would mean validating something other than what we generate.
  const PLIST_OPEN = '<plist version="1.0">';
  if (!source.startsWith(PLIST_OPEN, index)) {
    return malformed("the plist opening is not the exact emitted form");
  }
  index = skipTrivia(source, index + PLIST_OPEN.length);
  if (index < 0) return malformed("unterminated comment");

  if (!source.startsWith("<dict>", index)) return malformed("no top level dict");
  index += "<dict>".length;

  const entries = new Map<string, PlistValue>();

  for (;;) {
    index = skipTrivia(source, index);
    if (index < 0) return malformed("unterminated comment");
    if (index >= source.length) return malformed("document ends inside the dict");

    if (source.startsWith("</dict>", index)) {
      index += "</dict>".length;
      break;
    }

    if (source.startsWith("<dict>", index)) {
      return { ok: false, reason: "NESTED_DICT", detail: "a nested dict is not part of this shape" };
    }
    if (completeTagAt(source, index) === null) {
      return malformed("document ends where a key was expected");
    }
    if (!source.startsWith("<key>", index)) {
      return malformed("expected a key element");
    }

    const keyEnd = source.indexOf("</key>", index);
    if (keyEnd < 0) return malformed("unterminated key element");
    const rawKey = source.slice(index + "<key>".length, keyEnd);
    if (rawKey.includes("<")) return malformed("markup inside a key");
    if (containsEntityReference(rawKey)) {
      return { ok: false, reason: "ENTITY_REFERENCE", detail: "entity reference inside a key" };
    }
    const key = rawKey.trim();
    index = keyEnd + "</key>".length;

    if (entries.has(key)) {
      // The failure this reader exists for. Both orderings are refused: a
      // document is not made safe by which duplicate happens to come first.
      return { ok: false, reason: "DUPLICATE_KEY", detail: key };
    }

    index = skipTrivia(source, index);
    if (index < 0) return malformed("unterminated comment");
    if (index >= source.length) return malformed("document ends after a key");

    // Truncation is settled before any type question is asked, so a document
    // that stopped mid-tag is never reported as a wrong value type.
    if (completeTagAt(source, index) === null) {
      return malformed("document ends inside a value element for " + key);
    }

    if (source.startsWith("<dict>", index)) {
      return { ok: false, reason: "NESTED_DICT", detail: "the value of " + key + " is a dict" };
    }

    if (source.startsWith("<string>", index)) {
      const end = source.indexOf("</string>", index);
      if (end < 0) return malformed("unterminated string value");
      const raw = source.slice(index + "<string>".length, end);
      if (raw.includes("<")) return malformed("markup inside a string value");
      if (containsEntityReference(raw)) {
        return {
          ok: false,
          reason: "ENTITY_REFERENCE",
          detail: "entity reference inside the value of " + key,
        };
      }
      entries.set(key, { kind: "string", value: raw });
      index = end + "</string>".length;
      continue;
    }

    if (source.startsWith("<true/>", index)) {
      entries.set(key, { kind: "bool", value: true });
      index += "<true/>".length;
      continue;
    }
    if (source.startsWith("<false/>", index)) {
      entries.set(key, { kind: "bool", value: false });
      index += "<false/>".length;
      continue;
    }

    if (source.startsWith("<array>", index)) {
      const items: string[] = [];
      let cursor = index + "<array>".length;
      for (;;) {
        cursor = skipTrivia(source, cursor);
        if (cursor < 0) return malformed("unterminated comment");
        if (cursor >= source.length) return malformed("document ends inside an array");
        if (source.startsWith("</array>", cursor)) {
          cursor += "</array>".length;
          break;
        }
        if (completeTagAt(source, cursor) === null) {
          return malformed("document ends inside an array under " + key);
        }
        if (!source.startsWith("<string>", cursor)) {
          return {
            ok: false,
            reason: "UNEXPECTED_VALUE",
            detail: "arrays may hold only strings, under " + key,
          };
        }
        const end = source.indexOf("</string>", cursor);
        if (end < 0) return malformed("unterminated string inside an array");
        const raw = source.slice(cursor + "<string>".length, end);
        if (raw.includes("<")) return malformed("markup inside an array string");
        if (containsEntityReference(raw)) {
          return {
            ok: false,
            reason: "ENTITY_REFERENCE",
            detail: "entity reference inside an array under " + key,
          };
        }
        items.push(raw);
        cursor = end + "</string>".length;
      }
      entries.set(key, { kind: "array", value: items });
      index = cursor;
      continue;
    }

    return { ok: false, reason: "UNEXPECTED_VALUE", detail: "unsupported value type under " + key };
  }

  index = skipTrivia(source, index);
  if (index < 0) return malformed("unterminated comment");
  if (!source.startsWith("</plist>", index)) return malformed("no closing plist element");
  index = skipTrivia(source, index + "</plist>".length);
  if (index < 0) return malformed("unterminated comment");
  if (index < source.length) return malformed("trailing content after the plist");

  return { ok: true, entries };
}

/**
 * Policy, asked of the parsed structure and never of the text.
 *
 * `RunAtLoad` and `KeepAlive` must be present and false. Their absence is a
 * refusal rather than a default: launchd's own default for `RunAtLoad` is
 * false, but relying on that would mean the document no longer says what it
 * does, and the whole claim of this phase is that the artifact is inert on its
 * face.
 */
export function checkPolicy(entries: ReadonlyMap<string, PlistValue>): LaunchdVerdict {
  for (const key of entries.keys()) {
    if (FORBIDDEN_KEYS.includes(key)) {
      return refuse("FORBIDDEN_KEY", key + " would let launchd start the daemon on its own");
    }
    if (!KNOWN_KEYS.includes(key)) {
      return refuse("UNKNOWN_KEY", key);
    }
  }

  for (const key of KNOWN_KEYS) {
    if (!entries.has(key)) return refuse("MISSING_KEY", key);
  }

  const runAtLoad = entries.get("RunAtLoad");
  if (runAtLoad?.kind !== "bool") {
    return refuse("UNEXPECTED_VALUE", "RunAtLoad must be a boolean");
  }
  if (runAtLoad.value) return refuse("RUN_AT_LOAD_TRUE", "RunAtLoad must be false");

  const keepAlive = entries.get("KeepAlive");
  if (keepAlive?.kind !== "bool") {
    return refuse("UNEXPECTED_VALUE", "KeepAlive must be a boolean");
  }
  if (keepAlive.value) return refuse("KEEP_ALIVE_TRUE", "KeepAlive must be false");

  for (const key of ["Label", "Program", "WorkingDirectory", "StandardOutPath", "StandardErrorPath"]) {
    const value = entries.get(key);
    if (value?.kind !== "string") {
      return refuse("UNEXPECTED_VALUE", key + " must be a string");
    }
  }
  const args = entries.get("ProgramArguments");
  if (args?.kind !== "array") {
    return refuse("UNEXPECTED_VALUE", "ProgramArguments must be an array");
  }
  // Exactly two, and argv[0] is the program. An argument vector unrelated to
  // Program is a document that names one executable and would run another,
  // which every other check would happily accept.
  if (args.value.length !== 2) {
    return refuse("ARGUMENT_MISMATCH", "ProgramArguments must hold exactly two strings");
  }
  const program = entries.get("Program");
  if (program?.kind !== "string") {
    return refuse("UNEXPECTED_VALUE", "Program must be a string");
  }
  if (args.value[0] !== program.value) {
    return refuse("ARGUMENT_MISMATCH", "ProgramArguments[0] must equal Program");
  }

  return ACCEPTED;
}

const PLACEHOLDER_ANY = new RegExp("\\{\\{|\\}\\}");

/**
 * The tracked template: parseable, inert, and tied to no machine.
 *
 * Placeholders live inside `<string>` elements, so the template is a valid
 * plist exactly as tracked and can be linted in the form a reviewer reads,
 * rather than only after it has been rendered into something else.
 */
export function validateTemplate(source: string): LaunchdVerdict {
  for (const literal of HOST_SPECIFIC_LITERALS) {
    if (source.includes(literal)) {
      return refuse("HOST_SPECIFIC_LITERAL", literal + " ties the template to one machine");
    }
  }
  const parsed = parseFixedPlist(source);
  if (!parsed.ok) return refuse(parsed.reason, parsed.detail);
  return checkPolicy(parsed.entries);
}

/** A rendered document: parseable, inert, and carrying no placeholder. */
export function validatePlist(source: string): LaunchdVerdict {
  if (PLACEHOLDER_ANY.test(source)) {
    return refuse("UNSUBSTITUTED", "a placeholder delimiter survived rendering");
  }
  const parsed = parseFixedPlist(source);
  if (!parsed.ok) return refuse(parsed.reason, parsed.detail);
  return checkPolicy(parsed.entries);
}

/** The six values a reviewer checks, read back out of the parsed structure. */
export function readValues(source: string): Record<string, string> | null {
  const parsed = parseFixedPlist(source);
  if (!parsed.ok) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of parsed.entries) {
    if (value.kind === "string") out[key] = value.value;
    if (value.kind === "array") out[key] = value.value.join(" ");
    if (value.kind === "bool") out[key] = value.value ? "true" : "false";
  }
  return out;
}
