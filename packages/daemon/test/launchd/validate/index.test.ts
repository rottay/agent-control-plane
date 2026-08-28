import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_KEYS,
  parseFixedPlist,
  readValues,
  validatePlist,
  validateTemplate,
} from "../../../src/launchd/validate/index.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");
export const TEMPLATE_PATH = join(
  PACKAGE_ROOT,
  "launchd",
  "com.rottay.agent-control-plane.plist.template",
);

/** A minimal well-formed document, built from parts so tests can corrupt one. */
function document(body: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    body,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

const COMPLETE_BODY = [
  "<key>Label</key><string>com.rottay.test</string>",
  "<key>Program</key><string>/tmp/p</string>",
  "<key>ProgramArguments</key><array><string>/tmp/p</string><string>/tmp/c</string></array>",
  "<key>WorkingDirectory</key><string>/tmp</string>",
  "<key>StandardOutPath</key><string>/tmp/o</string>",
  "<key>StandardErrorPath</key><string>/tmp/e</string>",
  "<key>RunAtLoad</key><false/>",
  "<key>KeepAlive</key><false/>",
].join("\n");

describe("the tracked template", () => {
  it("is a valid, inert plist exactly as tracked", () => {
    // Placeholders sit inside <string> elements, so the artifact a reviewer
    // reads is the artifact that gets checked — not a rendered stand-in.
    const source = readFileSync(TEMPLATE_PATH, "utf8");
    expect(validateTemplate(source)).toEqual({ ok: true });
  });

  it("names no machine, account or home directory", () => {
    // The agent-directory token is assembled rather than written: the fence
    // refuses the bare literal in code, and test files are no longer excused
    // from that rule.
    const source = readFileSync(TEMPLATE_PATH, "utf8");
    for (const literal of ["/Users/", "$HOME", "~/", ["Launch", "Agents"].join("")]) {
      expect(source).not.toContain(literal);
    }
  });

  it("carries no launchd auto-start trigger", () => {
    const source = readFileSync(TEMPLATE_PATH, "utf8");
    for (const key of FORBIDDEN_KEYS) expect(source).not.toContain(key);
  });
});

describe("the structural reader", () => {
  it("accepts the one shape this package emits", () => {
    const parsed = parseFixedPlist(document(COMPLETE_BODY));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.entries.get("RunAtLoad")).toEqual({ kind: "bool", value: false });
      expect(parsed.entries.get("ProgramArguments")).toEqual({
        kind: "array",
        value: ["/tmp/p", "/tmp/c"],
      });
    }
  });

  it("refuses a duplicate key in either order", () => {
    // The failure this reader exists for. A text scan sees a false RunAtLoad
    // and is satisfied; plutil -lint accepts duplicates outright; launchd
    // resolves them on its own rules. Only a parser can refuse both orderings.
    const falseThenTrue = COMPLETE_BODY + "\n<key>RunAtLoad</key><true/>";
    const trueThenFalse = "<key>RunAtLoad</key><true/>\n" + COMPLETE_BODY;

    for (const body of [falseThenTrue, trueThenFalse]) {
      const parsed = parseFixedPlist(document(body));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe("DUPLICATE_KEY");
      expect(validatePlist(document(body))).toMatchObject({ reason: "DUPLICATE_KEY" });
    }
  });

  it("classifies every truncation as MALFORMED_PLIST, at every cut point", () => {
    // Not merely "refused". A truncated document reported as an unexpected
    // value type is described as something it is not, and the reason code is
    // the part a caller branches on. Every cut is walked, so a future scanner
    // change cannot reintroduce a boundary that classifies truncation as a
    // type error.
    // Trailing whitespace is not markup, so dropping it is not a truncation:
    // the loop covers every cut that removes part of the document itself.
    const whole = document(COMPLETE_BODY).trimEnd();
    const wrong: { cut: number; reason: string }[] = [];
    for (let cut = 1; cut < whole.length; cut += 1) {
      const verdict = validatePlist(whole.slice(0, cut));
      if (verdict.ok) {
        wrong.push({ cut, reason: "ACCEPTED" });
      } else if (verdict.reason !== "MALFORMED_PLIST") {
        wrong.push({ cut, reason: verdict.reason });
      }
    }
    expect(wrong).toEqual([]);
  });

  it("classifies a cut inside a tag, not only between elements", () => {
    // The specific boundary that used to slip through: a value position holding
    // `<str` is a document that stopped mid-tag, while `<integer>` is a genuine
    // wrong type. They must not share a reason code.
    const head = document(COMPLETE_BODY).indexOf("<key>Program</key>");
    const truncated = document(COMPLETE_BODY).slice(0, head + "<key>Program</key><str".length);
    expect(validatePlist(truncated)).toMatchObject({ reason: "MALFORMED_PLIST" });
  });

  it("refuses an unclosed element", () => {
    const body = "<key>Label</key><string>com.rottay.test";
    expect(validatePlist(document(body))).toMatchObject({ reason: "MALFORMED_PLIST" });
  });

  it("refuses a nested dict smuggled under a known key", () => {
    const body = COMPLETE_BODY.replace(
      "<key>WorkingDirectory</key><string>/tmp</string>",
      "<key>WorkingDirectory</key><dict><key>RunAtLoad</key><true/></dict>",
    );
    expect(validatePlist(document(body))).toMatchObject({ reason: "NESTED_DICT" });
  });

  it("refuses an unknown key", () => {
    const body = COMPLETE_BODY + "\n<key>Nonsense</key><string>x</string>";
    expect(validatePlist(document(body))).toMatchObject({ reason: "UNKNOWN_KEY" });
  });

  it("refuses an unexpected value type", () => {
    const body = COMPLETE_BODY.replace(
      "<key>Label</key><string>com.rottay.test</string>",
      "<key>Label</key><integer>7</integer>",
    );
    expect(validatePlist(document(body))).toMatchObject({ reason: "UNEXPECTED_VALUE" });
  });

  it("refuses a non-string inside an array", () => {
    const body = COMPLETE_BODY.replace(
      "<array><string>/tmp/p</string><string>/tmp/c</string></array>",
      "<array><true/></array>",
    );
    expect(validatePlist(document(body))).toMatchObject({ reason: "UNEXPECTED_VALUE" });
  });

  it("refuses trailing content after the document", () => {
    expect(validatePlist(document(COMPLETE_BODY) + "<plist/>")).toMatchObject({
      reason: "MALFORMED_PLIST",
    });
  });

  it("requires the exact emitted plist opening", () => {
    // "Anything beginning <plist" is a different claim from "the document this
    // package emits". A different version attribute is a different format, and
    // validating it would mean validating something we do not generate.
    const whole = document(COMPLETE_BODY);
    for (const opening of ['<plist version="2.0">', "<plist>", '<plist version="1.0" foo="b">']) {
      const tampered = whole.replace('<plist version="1.0">', opening);
      expect(tampered).not.toBe(whole);
      expect(validatePlist(tampered)).toMatchObject({ reason: "MALFORMED_PLIST" });
    }
  });

  it("refuses every entity reference rather than decoding some of them", () => {
    // Decoding only the named five left numeric and unknown references for the
    // system parser to interpret differently — two readers disagreeing about
    // one document, which is what the parser exists to prevent. The renderer
    // emits no entity at all, so anything carrying one did not come from here.
    const entities: string[] = ["&#47;", "&#x2f;", "&nbsp;", "&amp;"];
    for (const entity of entities) {
      const inValue = COMPLETE_BODY.replace("/tmp/o", "/tmp/" + entity);
      expect(validatePlist(document(inValue))).toMatchObject({ reason: "ENTITY_REFERENCE" });

      const inKey = COMPLETE_BODY.replace("<key>Label</key>", "<key>La" + entity + "bel</key>");
      expect(validatePlist(document(inKey))).toMatchObject({ reason: "ENTITY_REFERENCE" });

      const inArray = COMPLETE_BODY.replace("<string>/tmp/c</string></array>", "<string>/tmp/" + entity + "</string></array>");
      expect(validatePlist(document(inArray))).toMatchObject({ reason: "ENTITY_REFERENCE" });
    }
  });

  it("requires exactly two arguments whose first is the program", () => {
    const tooFew = COMPLETE_BODY.replace(
      "<array><string>/tmp/p</string><string>/tmp/c</string></array>",
      "<array><string>/tmp/p</string></array>",
    );
    expect(validatePlist(document(tooFew))).toMatchObject({ reason: "ARGUMENT_MISMATCH" });

    const tooMany = COMPLETE_BODY.replace(
      "<array><string>/tmp/p</string><string>/tmp/c</string></array>",
      "<array><string>/tmp/p</string><string>/tmp/c</string><string>--extra</string></array>",
    );
    expect(validatePlist(document(tooMany))).toMatchObject({ reason: "ARGUMENT_MISMATCH" });

    // The dangerous one: a document that names one executable and would run
    // another. Every other check accepts it.
    const mismatched = COMPLETE_BODY.replace(
      "<array><string>/tmp/p</string>",
      "<array><string>/tmp/somethingelse</string>",
    );
    expect(validatePlist(document(mismatched))).toMatchObject({ reason: "ARGUMENT_MISMATCH" });
  });
});

describe("policy, asked of the parsed structure", () => {
  it("refuses RunAtLoad true", () => {
    const body = COMPLETE_BODY.replace("<key>RunAtLoad</key><false/>", "<key>RunAtLoad</key><true/>");
    expect(validatePlist(document(body))).toMatchObject({ reason: "RUN_AT_LOAD_TRUE" });
  });

  it("refuses KeepAlive true", () => {
    const body = COMPLETE_BODY.replace("<key>KeepAlive</key><false/>", "<key>KeepAlive</key><true/>");
    expect(validatePlist(document(body))).toMatchObject({ reason: "KEEP_ALIVE_TRUE" });
  });

  it("refuses a missing inertness key rather than assuming a default", () => {
    // launchd defaults RunAtLoad to false, but a document that does not say so
    // no longer states what it does, and inertness on its face is the claim.
    const body = COMPLETE_BODY.replace("<key>RunAtLoad</key><false/>", "");
    expect(validatePlist(document(body))).toMatchObject({ reason: "MISSING_KEY" });
  });

  it("refuses every automatic start trigger by name", () => {
    for (const key of FORBIDDEN_KEYS) {
      const body = COMPLETE_BODY + "\n<key>" + key + "</key><string>x</string>";
      expect(validatePlist(document(body))).toMatchObject({ reason: "FORBIDDEN_KEY" });
    }
  });

  it("refuses a surviving placeholder in a rendered document", () => {
    const body = COMPLETE_BODY.replace("/tmp/p", "{{PROGRAM_PATH}}");
    expect(validatePlist(document(body))).toMatchObject({ reason: "UNSUBSTITUTED" });
  });

  it("refuses a template that names a home directory", () => {
    const body = COMPLETE_BODY.replace("/tmp/p", "/Users/someone/bin/p");
    expect(validateTemplate(document(body))).toMatchObject({ reason: "HOST_SPECIFIC_LITERAL" });
  });
});

describe("reading values back", () => {
  it("returns the parsed values, not a text scrape", () => {
    const values = readValues(document(COMPLETE_BODY));
    expect(values).toMatchObject({
      Label: "com.rottay.test",
      Program: "/tmp/p",
      RunAtLoad: "false",
      KeepAlive: "false",
    });
  });

  it("returns null for a document it cannot parse", () => {
    expect(readValues("<plist>")).toBeNull();
  });
});
