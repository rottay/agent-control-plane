import { createHash } from "node:crypto";

import { ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1, TaskEnvelope } from "@acp/contracts";
import { describe, expect, it } from "vitest";

import { LedgerCanonicalizationError } from "../../src/errors/index.js";
import {
  envelopeIdentityPreimageV1,
  envelopeSha256,
} from "../../src/envelope-identity/index.js";

/**
 * The envelope revision preimage, pinned before anything depends on it (P-05/A).
 *
 * This suite exists for the reason the account sidecar's does: the digest is an
 * identity, and an identity computed one way today and another way tomorrow
 * identifies nothing. Once a revision digest has been written down, changing
 * these bytes silently reinterprets every recorded revision.
 *
 * The audit's finding N01 is the concrete motive. Today two packets with
 * different objectives and different authorities reach the daemon carrying the
 * same digest, because the only digest on that path covers the task
 * coordinates, the instant and the elected route — and not one field of the
 * envelope. Negatives 1 and 2 below are that finding's own probe, made
 * executable. **This packet does not close N01**: nothing here is wired into
 * the submission path yet, and `daemon-child` still compares the submission
 * digest. What it closes is the half that can be a pure function.
 *
 * The suite asserts the *encoding* and not merely its self-consistency: a
 * careless encoder round-trips perfectly while being wrong about the prefix,
 * about key order and about which fields it covers.
 */

// ---------------------------------------------------------------------------
// Fixtures. No fixture carries a secret-shaped value.
// ---------------------------------------------------------------------------

const CONTRACT = "2.2.0";
const ISSUER = "kimi/k3/coordinator/01";
const AT = "2026-09-11T09:00:00.000Z";
const TASK_ID = "6f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
const INITIATIVE_ID = "7a2c3d4e-5f60-4b7c-9d8e-1f2a3b4c5d6e";
const DIGEST_A = "a".repeat(64);

/** A complete, lawful envelope. Every field present, none of them defaulted. */
function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: CONTRACT,
    taskId: TASK_ID,
    initiativeId: INITIATIVE_ID,
    title: "Pin the envelope revision preimage",
    objective: "Compute one digest over every field of the contract, and freeze it.",
    classification: "SEMANTIC",
    issuedBy: ISSUER,
    issuedAt: AT,
    authority: [{ path: "docs/audit/architecture/database/index.md", sha256: DIGEST_A }],
    readSet: ["packages/kernel/contracts/src/schemas/task-envelope/index.ts"],
    writeSet: ["packages/persistence/ledger/src/envelope-identity/index.ts"],
    conflictKeys: ["ledger:envelope-identity"],
    allowedCommands: ["pnpm test"],
    forbiddenActions: ["git push"],
    output: { kind: "DIFF", description: "one pure module and its suite" },
    validation: { commands: ["pnpm test"], independentVerifierRequired: true },
    eligibility: {
      roles: ["implementer"],
      providers: null,
      requiredCapabilities: ["typescript"],
    },
    budget: {
      maxTokens: 400_000,
      maxWallClockSeconds: 3_600,
      reserveTokensForCheckpoint: 40_000,
    },
    visualEvidenceRequired: false,
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    checkpointPolicy: { onEveryAtomicStep: false, maxStepsWithoutCheckpoint: 8 },
    ...overrides,
  };
}

/**
 * The same envelope with a different objective, and nothing else changed.
 *
 * Written as its own function rather than as an override so the two probes of
 * N01 read as what the finding describes: two packets, differing in the one
 * thing that decides what the work IS.
 */
function withObjective(objective: string): Record<string, unknown> {
  return envelope({ objective });
}

describe("the envelope revision preimage is pinned, not merely consistent", () => {
  // -------------------------------------------------------------------------
  // N01, made executable
  // -------------------------------------------------------------------------

  it("two envelopes differing only in objective produce different digests", () => {
    const first = withObjective("Compute one digest over every field of the contract.");
    const second = withObjective("Delete the production ledger.");

    // Every other field is identical, which is what makes this the finding's
    // own probe rather than a general statement about hashing: the digest the
    // submission path uses today would be byte-identical for these two, and a
    // caller could reuse the first one's approval for the second one's work.
    expect(Object.keys(first)).toEqual(Object.keys(second));
    expect(envelopeSha256(first)).not.toBe(envelopeSha256(second));
  });

  it("two envelopes differing only in authority produce different digests", () => {
    // The other half of N01, and the sharper half. Authority is what a packet
    // was allowed to touch; two envelopes that agree on the objective and
    // disagree on the authority are two different grants, and a digest that
    // could not tell them apart would let a narrow approval carry a wide one.
    const narrow = envelope();
    const wide = envelope({
      authority: [
        { path: "docs/audit/architecture/database/index.md", sha256: DIGEST_A },
        { path: "docs/ROADMAP.md", sha256: "b".repeat(64) },
      ],
    });

    expect(envelopeSha256(narrow)).not.toBe(envelopeSha256(wide));

    // And the digest of the authority document is part of it, not only its
    // path: the same path at a different content digest is a different grant.
    const restated = envelope({
      authority: [{ path: "docs/audit/architecture/database/index.md", sha256: "c".repeat(64) }],
    });
    expect(envelopeSha256(narrow)).not.toBe(envelopeSha256(restated));
  });

  // -------------------------------------------------------------------------
  // "Every field", without a list of fields anywhere
  // -------------------------------------------------------------------------

  it("every field of the envelope changes the digest", () => {
    // §6.2's actual requirement, and the only test that makes it unviolatable
    // by forgetting. The keys are DERIVED from the schema rather than written
    // out: a list of names here would be exactly the parallel enumeration §6.2
    // refuses to keep, and it would go stale the day a field is added — which
    // is the day this test most needs to fail.
    const base = envelope();
    const parsed = TaskEnvelope.parse(base);
    const keys = Object.keys(TaskEnvelope.shape);

    // The schema's own key set and the parsed value's agree, so walking one is
    // walking the other. Without this the derivation could silently narrow.
    expect([...keys].sort()).toEqual(Object.keys(parsed).sort());
    expect([...keys].sort()).toEqual(Object.keys(base).sort());
    expect(keys.length).toBeGreaterThan(0);

    const baseline = envelopeSha256(base);

    /** A different lawful value for one field, whatever that field holds. */
    function mutate(key: string, value: unknown): unknown {
      if (typeof value === "string") return value + " (revised)";
      if (typeof value === "boolean") return !value;
      if (typeof value === "number") return value - 1;
      if (Array.isArray(value)) return value.slice(0, Math.max(0, value.length - 1));
      return value;
    }

    for (const key of keys) {
      const current = base[key];
      let candidate: Record<string, unknown>;

      if (key === "contractVersion") {
        // Pinned to a literal by the schema, so it cannot be mutated into
        // another lawful value from here. What it CAN do is prove it is in the
        // preimage, by appearing in the bytes. That is the same claim.
        expect(envelopeIdentityPreimageV1(base)).toContain(CONTRACT);
        continue;
      }
      if (key === "budget") {
        candidate = envelope({ budget: { ...envelope()["budget"] as object, maxTokens: 399_999 } });
      } else if (key === "output") {
        candidate = envelope({ output: { kind: "REPORT", description: "a report instead" } });
      } else if (key === "validation") {
        candidate = envelope({
          validation: { commands: ["pnpm test"], independentVerifierRequired: false },
        });
      } else if (key === "eligibility") {
        candidate = envelope({
          eligibility: { roles: ["implementer"], providers: ["anthropic"], requiredCapabilities: [] },
        });
      } else if (key === "checkpointPolicy") {
        candidate = envelope({
          checkpointPolicy: { onEveryAtomicStep: true, maxStepsWithoutCheckpoint: 8 },
        });
      } else if (key === "classification") {
        candidate = envelope({ classification: "MECHANICAL" });
      } else if (key === "commitPolicy") {
        candidate = envelope({ commitPolicy: "NO_COMMIT", writeSet: [], conflictKeys: [] });
      } else if (key === "taskId" || key === "initiativeId") {
        candidate = envelope({ [key]: "8b3d4e5f-6071-4c8d-ae9f-2a3b4c5d6e7f" });
      } else if (key === "issuedBy") {
        candidate = envelope({ issuedBy: "anthropic/claude-opus-5/implementer/01" });
      } else if (key === "issuedAt") {
        // V2: the instant is a field, so re-issuing the same packet later is a
        // new revision. That is the intended consequence, stated as a test.
        candidate = envelope({ issuedAt: "2026-09-11T09:00:01.000Z" });
      } else if (key === "authority") {
        candidate = envelope({ authority: [] });
      } else if (key === "writeSet") {
        // Not shrunk to empty: the contract refuses a commit policy on an empty
        // write-set, so emptying it would test the refine and not the digest.
        candidate = envelope({ writeSet: ["packages/persistence/ledger/src/index.ts"] });
      } else {
        candidate = envelope({ [key]: mutate(key, current) });
      }

      // `commitPolicy` drags two fields with it, because the contract refuses a
      // commit policy on an empty write-set; the mutation is still one
      // semantic change and the digest must still move.
      expect(envelopeSha256(candidate), key).not.toBe(baseline);
    }
  });

  it("the account, the attempt and the resolved model are not in the preimage", () => {
    // §6.2's exclusions, and they are enforced from a direction a reader may
    // not expect: `TaskEnvelope` is a `z.strictObject`, so none of these can be
    // smuggled into the digest at all. Carrying one is not "ignored" — it is
    // refused, which is the stronger property.
    for (const key of ["accountId", "attempt", "attemptNumber", "modelVersionId", "pid"]) {
      expect(() => envelopeSha256(envelope({ [key]: "anything" })), key).toThrow();
    }

    // And the same envelope submitted under a different account, a different
    // attempt and a re-elected model is the SAME revision. Those values live
    // beside the envelope on the submission, never inside it, so nothing about
    // them can move this digest.
    const digest = envelopeSha256(envelope());
    const submissions = [
      { accountId: "acct-primary", attempt: 1, model: "claude-opus-5" },
      { accountId: "acct-standby", attempt: 7, model: "claude-sonnet-5" },
    ];
    for (const submission of submissions) {
      expect(envelopeSha256({ ...envelope() }), JSON.stringify(submission)).toBe(digest);
    }
  });

  // -------------------------------------------------------------------------
  // The encoding itself
  // -------------------------------------------------------------------------

  it("refuses to digest a value that is not a parsed envelope", () => {
    // The function takes `unknown` and parses, rather than trusting a
    // `TaskEnvelope`-typed parameter. The difference is this test: a signature
    // that trusted its caller would hash an object with an extra key, a missing
    // key or a wrong type, and hand back a digest of something that is not an
    // envelope at all.
    expect(() => envelopeSha256(undefined)).toThrow();
    expect(() => envelopeSha256(null)).toThrow();
    expect(() => envelopeSha256("not an envelope")).toThrow();
    expect(() => envelopeSha256([envelope()])).toThrow();
    expect(() => envelopeSha256({})).toThrow();

    // One extra key, everything else lawful. This is the shape a hand-built
    // config reaches the door as.
    expect(() => envelopeSha256(envelope({ surprise: 1 }))).toThrow();

    // One key missing, everything else lawful.
    const incomplete = envelope();
    delete incomplete["objective"];
    expect(() => envelopeSha256(incomplete)).toThrow();

    // And a field that is present with the wrong type rather than absent.
    expect(() => envelopeSha256(envelope({ writeSet: "src/index.ts" }))).toThrow();

    // What is hashed is the parse OUTPUT: the envelope a caller could have
    // corrupted after parsing is re-parsed here, so the digest is always of a
    // value the contract accepted.
    expect(envelopeSha256(TaskEnvelope.parse(envelope()))).toBe(envelopeSha256(envelope()));
  });

  it("a reordered envelope produces the same digest", () => {
    // Key order is a property of how a literal happens to be written, and it is
    // not part of the identity of the work. `canonicalJsonStringify` is what
    // makes that true, and this test is what keeps it true: two doors that
    // spelled the same envelope in different orders must agree.
    const forward = envelope();
    const reversed: Record<string, unknown> = {};
    for (const key of Object.keys(forward).reverse()) {
      reversed[key] = forward[key];
    }
    expect(Object.keys(reversed)).not.toEqual(Object.keys(forward));
    expect(envelopeSha256(reversed)).toBe(envelopeSha256(forward));

    // Nested objects too, which is where a shallow canonicalizer would fail.
    const nested = envelope({
      budget: {
        reserveTokensForCheckpoint: 40_000,
        maxWallClockSeconds: 3_600,
        maxTokens: 400_000,
      },
      output: { description: "one pure module and its suite", kind: "DIFF" },
    });
    expect(envelopeSha256(nested)).toBe(envelopeSha256(forward));

    // But array order is NOT key order. A write-set in a different order is a
    // different envelope, because the list is the packet's own declaration.
    const reorderedList = envelope({
      readSet: ["packages/kernel/contracts/src/schemas/task-envelope/index.ts", "docs/ROADMAP.md"],
    });
    const otherOrder = envelope({
      readSet: ["docs/ROADMAP.md", "packages/kernel/contracts/src/schemas/task-envelope/index.ts"],
    });
    expect(envelopeSha256(reorderedList)).not.toBe(envelopeSha256(otherOrder));
  });

  it("the preimage prefix is one LF byte", () => {
    // The byte that separates the namespace from the JSON, asserted as a byte
    // rather than as an escape someone could later write as two characters.
    const prefix = Buffer.from(ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1, "utf8");
    expect(prefix[prefix.length - 1]).toBe(0x0a);
    expect(prefix.filter((byte) => byte === 0x0a)).toHaveLength(1);
    expect(ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1).toBe("acp/task-envelope/v1\n");

    // Exactly one LF before the first byte of the JSON, and no separator of its
    // own: the LF belongs to the prefix. A formula that added its own would
    // produce two, and every pinned digest below would move.
    const preimage = Buffer.from(envelopeIdentityPreimageV1(envelope()), "utf8");
    const firstLf = preimage.indexOf(0x0a);
    expect(firstLf).toBe(prefix.length - 1);
    expect(preimage[firstLf + 1]).toBe(0x7b); // `{`, the first byte of the JSON
    expect(preimage.subarray(0, prefix.length)).toEqual(prefix);

    // The namespace is versioned, and `v1` is never edited in place: a change
    // to the encoding is a new constant with a new name.
    expect(ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1).toMatch(/^acp\/[a-z-]+\/v1\n$/);
  });

  it("refuses an envelope with a non-finite or negative-zero number", () => {
    // Two values, and two DIFFERENT channels of refusal. A test that expected
    // one error class would either fail or be weakened to "throws something".
    //
    // `Infinity` and `NaN` never reach the canonicalizer: `z.number()` refuses
    // them in the parse, as `invalid_type`.
    for (const value of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      const bad = envelope({ budget: { ...(envelope()["budget"] as object), maxTokens: value } });
      const parsed = TaskEnvelope.safeParse(bad);
      expect(parsed.success, String(value)).toBe(false);
      expect(() => envelopeSha256(bad), String(value)).toThrow();
    }

    // Negative zero DOES parse — `int().nonnegative()` accepts it, and
    // `Object.is(-0, 0)` is false while `-0 === 0` is true, so nothing in the
    // schema notices. It is the canonicalizer that refuses, because
    // `JSON.stringify(-0)` is `"0"` and the value would come back a different
    // value. `reserveTokensForCheckpoint` is the one field that admits it.
    const negativeZero = envelope({
      budget: { ...(envelope()["budget"] as object), reserveTokensForCheckpoint: -0 },
    });
    const parsedNegativeZero = TaskEnvelope.safeParse(negativeZero);
    expect(parsedNegativeZero.success).toBe(true);
    expect(Object.is(parsedNegativeZero.success && parsedNegativeZero.data.budget.reserveTokensForCheckpoint, -0)).toBe(true);
    expect(() => envelopeSha256(negativeZero)).toThrow(LedgerCanonicalizationError);

    // Not coerced: the refusal is the answer, and there is no digest for it.
    // A coercing encoder would give `-0` and `0` one digest, and two budgets
    // that a reader can distinguish would become one revision.
    const zero = envelope({
      budget: { ...(envelope()["budget"] as object), reserveTokensForCheckpoint: 0 },
    });
    expect(() => envelopeSha256(zero)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Positives
  // -------------------------------------------------------------------------

  it("pinned vectors: three envelopes, three digests, written out", () => {
    // Literals, not derivations. This is the only test that fails when the
    // encoding changes while staying internally consistent — every other test
    // here would compute the new bytes the new way and agree with itself.
    const vectors: readonly (readonly [Record<string, unknown>, string])[] = [
      [envelope(), "f5f8240b7ada7d255ed72dc34fc0472287a0c5d25d4063cd7664cb7d891efda2"],
      [
        withObjective("Delete the production ledger."),
        "57904fd602697fdcc4cff3d3f3d1dc24666b2806f9d74e8b7ec7ea3e94a75c62",
      ],
      [
        envelope({
          commitPolicy: "NO_COMMIT",
          writeSet: [],
          conflictKeys: [],
          visualEvidenceRequired: true,
          eligibility: { roles: ["reviewer"], providers: ["anthropic"], requiredCapabilities: [] },
        }),
        "aa66aca3b3c28b59f9dd2311f2fd99699c3146fccf123170735863a5dc24cb42",
      ],
    ];

    for (const [value, pinned] of vectors) {
      expect(envelopeSha256(value)).toBe(pinned);
    }

    // The digest is sha-256 of the preimage and of nothing else, checked
    // against `node:crypto` directly rather than through the ledger's own
    // helper — so the two steps of the formula are pinned independently.
    for (const [value] of vectors) {
      expect(envelopeSha256(value)).toBe(
        createHash("sha256").update(envelopeIdentityPreimageV1(value), "utf8").digest("hex"),
      );
    }

    // Three distinct envelopes, three distinct digests. A vector set that
    // happened to collide would pass the loop above and prove nothing.
    expect(new Set(vectors.map(([value]) => envelopeSha256(value))).size).toBe(3);
  });

  it("two independent computations over one envelope agree", () => {
    // Determinism, and the property two doors depend on: the digest is a
    // function of the value and of nothing else — no clock, no process, no
    // order of construction. Two objects assembled from separate literals, in
    // separate orders, are one revision.
    const first = envelope();
    const second: Record<string, unknown> = {};
    for (const key of Object.keys(first).sort()) {
      second[key] = structuredClone(first[key]);
    }

    expect(envelopeSha256(first)).toBe(envelopeSha256(second));
    expect(envelopeIdentityPreimageV1(first)).toBe(envelopeIdentityPreimageV1(second));

    // And repeated calls do not drift.
    const repeated = new Set(Array.from({ length: 5 }, () => envelopeSha256(first)));
    expect(repeated.size).toBe(1);
  });

  it("the digest survives a JSON round trip of the envelope", () => {
    // The envelope crosses process boundaries as JSON — a config file, a
    // request body, a child process's stdin. If the digest moved across that
    // trip, the door and the submitter would disagree about which revision they
    // were holding, which is the failure the digest exists to prevent.
    const original = envelope();
    const roundTripped: unknown = JSON.parse(JSON.stringify(original));

    expect(envelopeSha256(roundTripped)).toBe(envelopeSha256(original));
    expect(envelopeIdentityPreimageV1(roundTripped)).toBe(envelopeIdentityPreimageV1(original));

    // Through the parse as well, which is the shape the door actually holds.
    const reparsed: unknown = JSON.parse(JSON.stringify(TaskEnvelope.parse(original)));
    expect(envelopeSha256(reparsed)).toBe(envelopeSha256(original));
  });
});
