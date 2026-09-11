import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ACCOUNT_INTEGRITY_GENESIS_SHA256,
  ACCOUNT_INTEGRITY_PREIMAGE_PREFIX_V1,
  accountIntegrityDigestV1,
  accountIntegrityPreimageV1,
} from "../../src/account-integrity/index.js";
import { LedgerValidationError } from "../../src/errors/index.js";
import type { AccountEventRow } from "../../src/types/index.js";

/**
 * The account sidecar's preimage, pinned by vector before a row exists (P-08/A1).
 *
 * This suite is the reason the encoding is its own module and its own step. The
 * sidecar hashes `account_events` rows `1..H` retroactively, and the contract
 * forbids re-anchoring a chain once it is written: an error here produces a
 * chain that is internally consistent and **wrong**, over history, permanently.
 * No later test catches that, because every later test would compute the wrong
 * digest the same wrong way.
 *
 * So the suite does two things a normal fold suite does not:
 *
 * 1. It asserts the *encoding* rather than round-tripping it — byte lengths,
 *    the NULL marker, the LF in the prefix — because a self-consistent encoder
 *    round-trips perfectly while being wrong about all of them.
 * 2. It pins two complete rows to literal digests, computed by an
 *    **independently written** encoder below. Agreement between two
 *    implementations that share no code is the only evidence available before
 *    there is a ledger to compare against.
 */

// ---------------------------------------------------------------------------
// The independent encoder.
//
// Deliberately built differently from the module under test: ASCII fragments
// appended one at a time, its own helpers, and the prefix's newline written as
// the byte 0x0a rather than as an escape in a string literal. If the two agree,
// the agreement is about the encoding and not about a shared mistake.
// ---------------------------------------------------------------------------

const ascii = (value: string): Buffer => Buffer.from(value, "ascii");
const utf8 = (value: string): Buffer => Buffer.from(value, "utf8");

function textOf(value: string): Buffer {
  const bytes = utf8(value);
  return Buffer.concat([ascii("T"), ascii(String(bytes.length)), ascii(":"), bytes]);
}

function integerOf(value: number): Buffer {
  return Buffer.concat([ascii("I"), ascii(String(value)), ascii(";")]);
}

const NULL_OF = ascii("N;");

function independentPreimage(previousSha256: string, row: AccountEventRow): Buffer {
  return Buffer.concat([
    Buffer.concat([utf8("acp/account-event-integrity/v1"), Buffer.from([0x0a])]),
    textOf(previousSha256),
    integerOf(row.sequence),
    textOf(row.event_id),
    textOf(row.idempotency_key),
    textOf(row.account_id),
    integerOf(row.version),
    textOf(row.action),
    textOf(row.resulting_state),
    textOf(row.actor),
    row.note === null ? NULL_OF : textOf(row.note),
    textOf(row.occurred_at),
    textOf(row.recorded_at),
    textOf(row.contract_version),
    textOf(row.event_json),
  ]);
}

function independentDigest(previousSha256: string, row: AccountEventRow): string {
  return createHash("sha256").update(independentPreimage(previousSha256, row)).digest("hex");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The first row of the vector. Chosen to exercise what a careless encoder gets
 * wrong: a note whose byte length differs from its character length, and an
 * `event_json` whose spacing a canonicalizer would rewrite.
 */
const ROW_ONE: AccountEventRow = {
  sequence: 1,
  event_id: "6f1a3c2e-0000-4000-8000-000000000001",
  idempotency_key: "acct-primary/1/action.1",
  account_id: "acct-primary",
  version: 1,
  action: "DRAIN",
  resulting_state: "DRAINING",
  actor: "kimi/k3/coordinator/01",
  note: "café — quota exhausted",
  occurred_at: "2026-09-10T12:00:00.000Z",
  recorded_at: "2026-09-10T12:00:00.500Z",
  contract_version: "1.0.0",
  event_json: '{"a":1,"b":"  spaced  "}',
};

/** The second, with a NULL note, chained onto the first. */
const ROW_TWO: AccountEventRow = {
  sequence: 2,
  event_id: "6f1a3c2e-0000-4000-8000-000000000002",
  idempotency_key: "acct-primary/1/action.2",
  account_id: "acct-primary",
  version: 2,
  action: "RESTORE",
  resulting_state: "ACTIVE",
  actor: "kimi/k3/coordinator/01",
  note: null,
  occurred_at: "2026-09-10T13:00:00.000Z",
  recorded_at: "2026-09-10T13:00:00.250Z",
  contract_version: "1.0.0",
  event_json: "{}",
};

/**
 * The pinned digests.
 *
 * Computed by the independent encoder above and written here as literals. A
 * change to the encoding that both implementations made together would still
 * move these, which is what makes the literal worth having: it is the only
 * assertion in this file that survives somebody "fixing" both encoders at once.
 */
const ROW_ONE_SHA256 = "98367204673355d5e62023038503ade290f405047c43505403ee27e8f80ca2f8";
const ROW_TWO_SHA256 = "e5eabc99c295c448c598f81bc1b7efb47edd00159eee9b424f291a9d396931ff";

function digestOf(previousSha256: string, row: AccountEventRow): string {
  return accountIntegrityDigestV1({ accountSequence: row.sequence, previousSha256, row });
}

function preimageOf(previousSha256: string, row: AccountEventRow): Buffer {
  return accountIntegrityPreimageV1({ accountSequence: row.sequence, previousSha256, row });
}

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

// ---------------------------------------------------------------------------

describe("the account sidecar preimage is pinned, not merely consistent", () => {
  it("matches two fixed vectors, digit for digit", () => {
    expect(digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, ROW_ONE)).toBe(ROW_ONE_SHA256);
    expect(digestOf(ROW_ONE_SHA256, ROW_TWO)).toBe(ROW_TWO_SHA256);
  });

  it("agrees with an independently written encoder on both vectors", () => {
    expect(preimageOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, ROW_ONE)).toEqual(
      independentPreimage(ACCOUNT_INTEGRITY_GENESIS_SHA256, ROW_ONE),
    );
    expect(digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, ROW_ONE)).toBe(
      independentDigest(ACCOUNT_INTEGRITY_GENESIS_SHA256, ROW_ONE),
    );
    expect(preimageOf(ROW_ONE_SHA256, ROW_TWO)).toEqual(
      independentPreimage(ROW_ONE_SHA256, ROW_TWO),
    );
    expect(digestOf(ROW_ONE_SHA256, ROW_TWO)).toBe(independentDigest(ROW_ONE_SHA256, ROW_TWO));
  });

  it("opens with the version prefix, whose newline is one LF byte", () => {
    // "In the prefix, `\n` is a single LF byte (0x0a), not two characters."
    // Written as an escape in a document, it is easy to land as a backslash and
    // an `n`, which would be 32 prefix bytes instead of 31.
    const prefix = Buffer.from(ACCOUNT_INTEGRITY_PREIMAGE_PREFIX_V1, "utf8");
    expect(prefix).toHaveLength(31);
    expect(prefix.at(-1)).toBe(0x0a);
    expect(prefix.includes(Buffer.from("\\n", "ascii"))).toBe(false);

    const preimage = preimageOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, ROW_ONE);
    expect(preimage.subarray(0, 31)).toEqual(prefix);
  });

  it("is a pure function: the same row hashes the same every time", () => {
    expect(digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, ROW_ONE)).toBe(
      digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, ROW_ONE),
    );
  });

  it("chains: the same row under a different previous digest hashes differently", () => {
    expect(digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, ROW_TWO)).not.toBe(
      digestOf(ROW_ONE_SHA256, ROW_TWO),
    );
  });
});

describe("the encoding refuses every ambiguity it was written to remove", () => {
  it("distinguishes a null note from an empty one and from the text null", () => {
    // The distinction the specification states with emphasis, and the first one
    // a careless encoder collapses: `N;` is not `T0:` and not `T4:null`.
    const asNull = digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, { ...ROW_ONE, note: null });
    const asEmpty = digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, { ...ROW_ONE, note: "" });
    const asText = digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, { ...ROW_ONE, note: "null" });

    expect(new Set([asNull, asEmpty, asText]).size).toBe(3);

    // And at the byte level, so the reason is visible rather than inferred.
    const nullBytes = preimageOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, { ...ROW_ONE, note: null });
    const emptyBytes = preimageOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, { ...ROW_ONE, note: "" });
    expect(nullBytes.includes(Buffer.from("N;", "ascii"))).toBe(true);
    expect(emptyBytes.includes(Buffer.from("T0:", "ascii"))).toBe(true);
    expect(emptyBytes.length - nullBytes.length).toBe(1);
  });

  it("encodes the length of a text in bytes, not in code points", () => {
    // The note is 22 characters and 25 UTF-8 bytes: `é` is two and `—` is
    // three. An encoder that used `value.length` would declare 22 and then emit
    // 25, which is an encoding a second reader cannot parse and a length a
    // second encoder would not reproduce.
    expect(ROW_ONE.note).not.toBeNull();
    expect(ROW_ONE.note?.length).toBe(22);
    expect(Buffer.from(ROW_ONE.note ?? "", "utf8")).toHaveLength(25);

    const preimage = preimageOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, ROW_ONE);
    expect(preimage.includes(Buffer.from("T25:café — quota exhausted", "utf8"))).toBe(true);
    // The note's own prefix is never the character count. Asserted against the
    // note's first bytes rather than against a bare `T22:`, because `T22:` also
    // introduces `actor`, which really is 22 bytes long — a bare search would
    // have failed here for a reason that has nothing to do with the claim.
    expect(preimage.includes(Buffer.from("T22:café", "utf8"))).toBe(false);

    // A one-character, four-byte value is the same claim at the other extreme.
    const emoji = preimageOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, { ...ROW_ONE, note: "\u{1F512}" });
    expect(emoji.includes(Buffer.from("T4:\u{1F512}", "utf8"))).toBe(true);
  });

  it("refuses to reserialize the stored event_json", () => {
    // `event_json` enters as complete TEXT: never parsed, never re-ordered,
    // never re-spaced. Two rows whose JSON differs only in whitespace, or only
    // in key order, are two different stored byte strings and must hash
    // differently. A canonicalizer would make all three of these equal, which
    // is exactly the bug this module exists to not have.
    const spaced = digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, {
      ...ROW_ONE,
      event_json: '{"a":1,"b":"  spaced  "}',
    });
    const respaced = digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, {
      ...ROW_ONE,
      event_json: '{ "a": 1, "b": "  spaced  " }',
    });
    const reordered = digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, {
      ...ROW_ONE,
      event_json: '{"b":"  spaced  ","a":1}',
    });

    expect(new Set([spaced, respaced, reordered]).size).toBe(3);

    // The stored text appears in the preimage verbatim, spacing included.
    const preimage = preimageOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, {
      ...ROW_ONE,
      event_json: '{ "a": 1 }',
    });
    expect(preimage.includes(Buffer.from('T10:{ "a": 1 }', "utf8"))).toBe(true);
  });

  it("separates two rows that a naive concatenation would collide", () => {
    // Without a length prefix, `("ab", "c")` and `("a", "bc")` produce the same
    // bytes. Two different accounts would then share a digest, and the chain
    // would prove nothing about which of them was recorded.
    const left = digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, {
      ...ROW_ONE,
      account_id: "ab",
      action: "c",
    });
    const right = digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, {
      ...ROW_ONE,
      account_id: "a",
      action: "bc",
    });
    expect(left).not.toBe(right);

    // The same trap one field further along, where the boundary is a tag
    // rather than a length.
    const shifted = digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, {
      ...ROW_ONE,
      actor: "x",
      note: "y",
    });
    const shiftedBack = digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, {
      ...ROW_ONE,
      actor: "xy",
      note: "",
    });
    expect(shifted).not.toBe(shiftedBack);
  });

  it("hashes the integer version exactly, without floating point", () => {
    // `Number.MAX_SAFE_INTEGER` is exact and encodes.
    const atCeiling = preimageOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, {
      ...ROW_ONE,
      version: Number.MAX_SAFE_INTEGER,
    });
    expect(atCeiling.includes(Buffer.from("I9007199254740991;", "ascii"))).toBe(true);

    // One past it is not. `2**53` and `2**53 + 1` are the SAME JavaScript
    // value, so any decimal rendered from one of them is a guess about which
    // 64-bit integer was stored — and two different stored integers would
    // receive the same digest. The encoder refuses instead of guessing.
    expect(2 ** 53 + 1).toBe(2 ** 53);
    for (const version of [2 ** 53, 2 ** 53 + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = caught(() =>
        digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, { ...ROW_ONE, version }),
      );
      expect(error, String(version)).toBeInstanceOf(LedgerValidationError);
      expect((error as Error).message, String(version)).toContain("exact integer");
    }
  });

  it("does not include computed_at in the preimage", () => {
    // `computed_at` is metadata of the sidecar row, not a field of the historic
    // account row. If it were hashed, the same history recomputed at a
    // different instant would produce a different chain, and the retroactive
    // baseline could never be reproduced.
    const preimage = preimageOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, ROW_ONE);
    const withMetadata = { ...ROW_ONE, computed_at: "2026-09-10T14:00:00.000Z" };
    const alsoWithMetadata = { ...ROW_ONE, computed_at: "2031-01-01T00:00:00.000Z" };

    expect(preimageOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, withMetadata)).toEqual(preimage);
    expect(preimageOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, alsoWithMetadata)).toEqual(preimage);
    // And the pinned vector is unmoved, which is the same claim against a
    // literal rather than against itself.
    expect(digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, withMetadata)).toBe(ROW_ONE_SHA256);
  });

  it("refuses to hash a row whose sequence disagrees with the sidecar key", () => {
    // The sidecar is one-to-one with the stream. A digest filed under a
    // position other than the row's own would link correctly and describe a
    // history that never happened.
    const error = caught(() =>
      accountIntegrityDigestV1({
        accountSequence: 7,
        previousSha256: ACCOUNT_INTEGRITY_GENESIS_SHA256,
        row: ROW_ONE,
      }),
    );
    expect(error).toBeInstanceOf(LedgerValidationError);
    expect((error as Error).message).toContain("does not match the row's own sequence");

    // And it accepts the agreeing case, so the guard is not a blanket refusal.
    expect(
      accountIntegrityDigestV1({
        accountSequence: 1,
        previousSha256: ACCOUNT_INTEGRITY_GENESIS_SHA256,
        row: ROW_ONE,
      }),
    ).toBe(ROW_ONE_SHA256);
  });

  it("refuses a previous digest that is not a lowercase sha-256", () => {
    for (const previous of ["", "not-a-digest", "A".repeat(64), "a".repeat(63), "a".repeat(65)]) {
      const error = caught(() => digestOf(previous, ROW_ONE));
      expect(error, JSON.stringify(previous)).toBeInstanceOf(LedgerValidationError);
    }
    // Genesis is sixty-four zeros and is accepted.
    expect(ACCOUNT_INTEGRITY_GENESIS_SHA256).toBe("0".repeat(64));
    expect(digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, ROW_ONE)).toBe(ROW_ONE_SHA256);
  });

  it("refuses a sidecar position below one", () => {
    for (const accountSequence of [0, -1, 1.5]) {
      const error = caught(() =>
        accountIntegrityDigestV1({
          accountSequence,
          previousSha256: ACCOUNT_INTEGRITY_GENESIS_SHA256,
          row: { ...ROW_ONE, sequence: accountSequence },
        }),
      );
      expect(error, String(accountSequence)).toBeInstanceOf(LedgerValidationError);
    }
  });

  it("changes the digest when any single field changes", () => {
    // The closed field list, asserted as a list: a field the encoder forgot
    // would leave two different rows sharing a digest, and no other test here
    // would notice which one it was.
    const base = digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, ROW_ONE);
    const mutations: readonly AccountEventRow[] = [
      { ...ROW_ONE, event_id: "6f1a3c2e-0000-4000-8000-00000000ffff" },
      { ...ROW_ONE, idempotency_key: "acct-other/1/action.1" },
      { ...ROW_ONE, account_id: "acct-other" },
      { ...ROW_ONE, version: 9 },
      { ...ROW_ONE, action: "RESTORE" },
      { ...ROW_ONE, resulting_state: "ACTIVE" },
      { ...ROW_ONE, actor: "claude/opus/implementer/01" },
      { ...ROW_ONE, note: "something else" },
      { ...ROW_ONE, occurred_at: "2026-09-10T12:00:00.001Z" },
      { ...ROW_ONE, recorded_at: "2026-09-10T12:00:00.501Z" },
      { ...ROW_ONE, contract_version: "1.0.1" },
      { ...ROW_ONE, event_json: '{"a":2,"b":"  spaced  "}' },
    ];
    const digests = mutations.map((row) => digestOf(ACCOUNT_INTEGRITY_GENESIS_SHA256, row));
    for (const [index, digest] of digests.entries()) {
      expect({ index, same: digest === base }).toEqual({ index, same: false });
    }
    // All twelve differ from each other too, not merely from the base.
    expect(new Set([base, ...digests]).size).toBe(13);
  });
});
