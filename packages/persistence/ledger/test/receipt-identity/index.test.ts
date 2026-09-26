import { createHash } from "node:crypto";

import {
  CONTRACT_VERSION,
  CommitAuthorizationReceipt,
  VerificationReceipt,
  WRITER_WORKER_ID_UUID_NAMESPACE,
} from "@acp/contracts";
import { describe, expect, it } from "vitest";

import * as ledgerBarrel from "../../src/index.js";
import { LedgerValidationError } from "../../src/errors/index.js";
import {
  RECEIPT_CHECKS_PREIMAGE_PREFIX_V1,
  RECEIPT_IDENTITY_PREIMAGE_PREFIX_V1,
  RECEIPT_WRITE_SET_PREIMAGE_PREFIX_V1,
  receiptIdentityPreimageV1,
  receiptSha256,
  writerWorkerIdFor,
} from "../../src/receipt-identity/index.js";

/**
 * A receipt's identity, version 1, and the writer's instance id (P-16/A2, ADR 0121).
 *
 * Every pinned hex below was computed OUTSIDE this package, by Python's `hashlib`
 * over the preimage strings written out literally here, and by Python's
 * `uuid.uuid5` for the ids. This file recomputes each with its own `node:crypto`
 * as the second encoder: two encoders agreeing with the module is the claim, not
 * the module agreeing with itself.
 */

const TASK = "00000000-0000-4000-8000-00000000000a";
/** `uuid.uuid5(NAMESPACE, TASK + "/1")`, the providers suite's first vector. */
const WRITER_ID = "39de475b-2696-5df6-b64b-88336de7d72c";
/** `uuid.uuid5(NAMESPACE, "verifier/1")`: any lowercase v5 other than the writer's. */
const VERIFIER_ID = "24a8af45-549e-5137-8d27-03eb76de8b47";

const PASS_CHECKS = [
  { command: "pnpm check", exitCode: 0, ranAt: "2026-09-26T12:00:00.000Z" },
  { command: "pnpm lint", exitCode: 0, ranAt: "2026-09-26T12:01:00.000Z" },
];
const FAIL_CHECKS = [
  { command: "pnpm check", exitCode: 0, ranAt: "2026-09-26T12:00:00.000Z" },
  { command: "pnpm lint", exitCode: 1, ranAt: "2026-09-26T12:01:00.000Z" },
];

/**
 * The write-set in an order that is neither its code-unit order nor a locale's:
 * code-unit order is `B` (0x42) < `_` (0x5f) < `a` (0x61), a locale's would put
 * `_x` first and `B` last.
 */
const DECLARED = ["src/a.ts", "src/_x.ts", "src/B.ts"];

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId: TASK,
    revisionNumber: 1,
    attemptNumber: 1,
    baseSha: "0123456789abcdef0123456789abcdef01234567",
    treeSha: "89abcdef0123456789abcdef0123456789abcdef",
    objectFormat: "sha1",
    policySha256: "c".repeat(64),
    declaredWriteSet: [...DECLARED],
    observedTrackedChanges: [{ path: "src/a.ts", sha256: "a".repeat(64) }],
    observedUntrackedPaths: [],
    writer: { identity: "claude/opus/implementer/01", workerId: WRITER_ID },
    verifier: { identity: "claude/sonnet/verifier/01", workerId: VERIFIER_ID, runId: 1 },
    runStatus: "PASS",
    checks: PASS_CHECKS.map((check) => ({ ...check })),
    commitMessageBody: "feat(runtime): a verified change",
    pushAuthorized: false,
    ...overrides,
  };
}

const WRITE_SET_PREIMAGE = 'acp/receipt-write-set/v1\n["src/B.ts","src/_x.ts","src/a.ts"]';
const WRITE_SET_SHA256 = "db17dc46e31e05ced62d87d93eb756491d63d24f0862b1b4405f19d82cbbc0bf";

const PASS_CHECKS_PREIMAGE =
  "acp/receipt-checks/v1\n" +
  '[{"command":"pnpm check","exitCode":0,"ranAt":"2026-09-26T12:00:00.000Z"},' +
  '{"command":"pnpm lint","exitCode":0,"ranAt":"2026-09-26T12:01:00.000Z"}]';
const PASS_CHECKS_SHA256 = "76a6ce2d44ede84f9f37d755c1a64f1d0c6f75e651fac16b0c171c6dac99f07c";
const FAIL_CHECKS_PREIMAGE =
  "acp/receipt-checks/v1\n" +
  '[{"command":"pnpm check","exitCode":0,"ranAt":"2026-09-26T12:00:00.000Z"},' +
  '{"command":"pnpm lint","exitCode":1,"ranAt":"2026-09-26T12:01:00.000Z"}]';
const FAIL_CHECKS_SHA256 = "210969e7478014b084224f60401f67e88c09e63942f717d211aa6e650ba78e0b";

/** The thirteen members, keys in code-unit order, written out by hand. */
function preimage(runStatus: string, checksSha256: string): string {
  return (
    "acp/receipt-identity/v1\n" +
    '{"attemptNumber":1,' +
    '"baseSha":"0123456789abcdef0123456789abcdef01234567",' +
    '"checksSha256":"' + checksSha256 + '",' +
    '"commitMessageBody":"feat(runtime): a verified change",' +
    '"objectFormat":"sha1",' +
    '"policySha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",' +
    '"revisionNumber":1,' +
    '"runStatus":"' + runStatus + '",' +
    '"taskId":"00000000-0000-4000-8000-00000000000a",' +
    '"treeSha":"89abcdef0123456789abcdef0123456789abcdef",' +
    '"verifier":{"identity":"claude/sonnet/verifier/01","runId":1,"workerId":"24a8af45-549e-5137-8d27-03eb76de8b47"},' +
    '"writeSetSha256":"db17dc46e31e05ced62d87d93eb756491d63d24f0862b1b4405f19d82cbbc0bf",' +
    '"writer":{"identity":"claude/opus/implementer/01","workerId":"39de475b-2696-5df6-b64b-88336de7d72c"}}'
  );
}

const PASS_SHA256 = "13f80972c7059a49dc27530768d6747c80920dffdcf9cd59a5cd8a8a60d222e3";
const FAIL_SHA256 = "6f80ac84747ced4a459d903e00e7860c3605aff3877609f3da26dc591e6a70e5";

/** The class name of what `run` throws: the contract's parse throws zod's `ZodError`. */
function thrownName(run: () => unknown): string | null {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.name : "non-error";
  }
  return null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** RFC 4122 §4.3, restated here independently of the module. */
function independentV5(namespace: string, name: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
    .update(Buffer.from(name, "utf8"))
    .digest()
    .subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

describe("the receipt identity preimage and its digest", () => {
  it("equals the hand-written preimage and the externally computed digest, for a PASS and a FAIL", () => {
    // The two vectors differ only in `runStatus` and the checks, so the digest
    // difference is attributable to exactly those.
    expect(sha256(WRITE_SET_PREIMAGE)).toBe(WRITE_SET_SHA256);
    expect(sha256(PASS_CHECKS_PREIMAGE)).toBe(PASS_CHECKS_SHA256);
    expect(sha256(FAIL_CHECKS_PREIMAGE)).toBe(FAIL_CHECKS_SHA256);

    const pass = receipt();
    expect(receiptIdentityPreimageV1(pass)).toBe(preimage("PASS", PASS_CHECKS_SHA256));
    expect(sha256(preimage("PASS", PASS_CHECKS_SHA256))).toBe(PASS_SHA256);
    expect(receiptSha256(pass)).toBe(PASS_SHA256);

    const fail = receipt({ runStatus: "FAIL", checks: FAIL_CHECKS.map((check) => ({ ...check })) });
    expect(receiptIdentityPreimageV1(fail)).toBe(preimage("FAIL", FAIL_CHECKS_SHA256));
    expect(sha256(preimage("FAIL", FAIL_CHECKS_SHA256))).toBe(FAIL_SHA256);
    expect(receiptSha256(fail)).toBe(FAIL_SHA256);
  });

  it("ends each prefix in exactly one LF, with the JSON's first byte right after it", () => {
    expect(RECEIPT_IDENTITY_PREIMAGE_PREFIX_V1).toBe("acp/receipt-identity/v1\n");
    expect(RECEIPT_CHECKS_PREIMAGE_PREFIX_V1).toBe("acp/receipt-checks/v1\n");
    expect(RECEIPT_WRITE_SET_PREIMAGE_PREFIX_V1).toBe("acp/receipt-write-set/v1\n");
    for (const prefix of [
      RECEIPT_IDENTITY_PREIMAGE_PREFIX_V1,
      RECEIPT_CHECKS_PREIMAGE_PREFIX_V1,
      RECEIPT_WRITE_SET_PREIMAGE_PREFIX_V1,
    ]) {
      expect(prefix.charCodeAt(prefix.length - 1)).toBe(0x0a);
      expect(prefix.split("\n")).toHaveLength(2);
    }
    const text = receiptIdentityPreimageV1(receipt());
    expect(text.slice(RECEIPT_IDENTITY_PREIMAGE_PREFIX_V1.length, RECEIPT_IDENTITY_PREIMAGE_PREFIX_V1.length + 1)).toBe("{");
    expect(text.indexOf("\n")).toBe(RECEIPT_IDENTITY_PREIMAGE_PREFIX_V1.length - 1);
    expect(WRITE_SET_PREIMAGE.slice(RECEIPT_WRITE_SET_PREIMAGE_PREFIX_V1.length, RECEIPT_WRITE_SET_PREIMAGE_PREFIX_V1.length + 1)).toBe("[");
    expect(PASS_CHECKS_PREIMAGE.slice(RECEIPT_CHECKS_PREIMAGE_PREFIX_V1.length, RECEIPT_CHECKS_PREIMAGE_PREFIX_V1.length + 1)).toBe("[");
  });

  it("moves when any one of the thirteen members moves alone", () => {
    const base = receiptSha256(receipt());
    const OTHER_ID = independentV5(WRITER_WORKER_ID_UUID_NAMESPACE, "another/1");
    const variants: readonly (readonly [string, Record<string, unknown>])[] = [
      ["taskId", { taskId: "00000000-0000-4000-8000-00000000000b" }],
      ["revisionNumber", { revisionNumber: 2 }],
      ["attemptNumber", { attemptNumber: 2 }],
      ["baseSha", { baseSha: "1123456789abcdef0123456789abcdef01234567" }],
      ["treeSha", { treeSha: "99abcdef0123456789abcdef0123456789abcdef" }],
      ["policySha256", { policySha256: "d".repeat(64) }],
      ["writeSetSha256", { declaredWriteSet: [...DECLARED, "src/c.ts"] }],
      ["writer.identity", { writer: { identity: "claude/opus/implementer/02", workerId: WRITER_ID } }],
      ["writer.workerId", { writer: { identity: "claude/opus/implementer/01", workerId: OTHER_ID } }],
      ["verifier.identity", { verifier: { identity: "claude/sonnet/verifier/02", workerId: VERIFIER_ID, runId: 1 } }],
      ["verifier.workerId", { verifier: { identity: "claude/sonnet/verifier/01", workerId: OTHER_ID, runId: 1 } }],
      ["verifier.runId", { verifier: { identity: "claude/sonnet/verifier/01", workerId: VERIFIER_ID, runId: 2 } }],
      ["runStatus", { runStatus: "FAIL" }],
      ["checksSha256", { checks: [{ command: "pnpm check", exitCode: 0, ranAt: "2026-09-26T12:00:00.000Z" }] }],
      ["commitMessageBody", { commitMessageBody: "feat(runtime): another change" }],
    ];
    const seen = new Set([base]);
    for (const [member, override] of variants) {
      const digest = receiptSha256(receipt(override));
      expect({ member, moved: digest !== base }).toEqual({ member, moved: true });
      seen.add(digest);
    }
    expect(seen.size).toBe(variants.length + 1);
    // `objectFormat` has one lawful value, so it moves nothing it could move to;
    // that it is in the preimage is the hand-written vector's.
  });

  it("does not move with the observed lists, the contract version or the write-set's order: the stated limit", () => {
    const base = receiptSha256(receipt());
    expect(receiptSha256(receipt({ observedTrackedChanges: [] }))).toBe(base);
    expect(receiptSha256(receipt({ observedUntrackedPaths: ["src/B.ts"] }))).toBe(base);
    expect(receiptSha256(receipt({ declaredWriteSet: ["src/B.ts", "src/a.ts", "src/_x.ts"] }))).toBe(base);
    expect(receiptSha256(receipt({ declaredWriteSet: [...DECLARED].reverse() }))).toBe(base);
  });

  it("sorts the write-set by code unit, not by a locale", () => {
    const localeOrder = [...DECLARED].sort((left, right) => left.localeCompare(right, "en"));
    expect(localeOrder).not.toEqual([...DECLARED].sort());
    expect(receiptIdentityPreimageV1(receipt())).toContain('"writeSetSha256":"' + WRITE_SET_SHA256 + '"');
    expect(sha256(RECEIPT_WRITE_SET_PREIMAGE_PREFIX_V1 + JSON.stringify(localeOrder))).not.toBe(WRITE_SET_SHA256);
  });

  it("keeps the checks in execution order: reordering them is another run", () => {
    const reordered = receipt({ checks: [...PASS_CHECKS].reverse().map((check) => ({ ...check })) });
    expect(receiptSha256(reordered)).not.toBe(PASS_SHA256);
    expect(receiptIdentityPreimageV1(reordered)).not.toContain(PASS_CHECKS_SHA256);
  });

  it("digests a CommitAuthorizationReceipt as the VerificationReceipt it is", () => {
    const parsedAsAuthorization = CommitAuthorizationReceipt.parse(receipt());
    const parsedAsVerification = VerificationReceipt.parse(receipt());
    expect(receiptSha256(parsedAsAuthorization)).toBe(PASS_SHA256);
    expect(receiptSha256(parsedAsVerification)).toBe(PASS_SHA256);
  });

  it("refuses before hashing: a body carrying a trailer, and anything that is not a receipt", () => {
    const trailered = receipt({ commitMessageBody: "feat: x\n\nACP-Receipt: " + "a".repeat(64) });
    expect(thrownName(() => receiptSha256(trailered))).toBe("ZodError");
    for (const value of [null, undefined, 7, "receipt", {}, receipt({ extra: 1 }), receipt({ objectFormat: "sha256" })]) {
      expect(thrownName(() => receiptSha256(value)), JSON.stringify(value)).toBe("ZodError");
      expect(thrownName(() => receiptIdentityPreimageV1(value)), JSON.stringify(value)).toBe("ZodError");
    }
  });

  it("refuses a negative-zero exit code at the contract, never at canonicalization (verification N-1)", () => {
    // Without the contract's refine, `-0` would parse and then throw
    // `LedgerCanonicalizationError`: a receipt value with no `receipt_sha256`.
    const negativeZero = receipt({
      runStatus: "FAIL",
      checks: [{ command: "pnpm check", exitCode: -0, ranAt: "2026-09-26T00:00:00.000Z" }],
    });
    expect(thrownName(() => receiptSha256(negativeZero))).toBe("ZodError");
    expect(thrownName(() => receiptIdentityPreimageV1(negativeZero))).toBe("ZodError");
  });
});

describe("the writer's instance id", () => {
  const VECTORS: readonly (readonly [string, number, string])[] = [
    [TASK, 1, "39de475b-2696-5df6-b64b-88336de7d72c"],
    [TASK, 2, "796cc136-89af-53a4-b947-3d0609c12f60"],
    [TASK, 10, "e23c7ae1-9982-59c5-adae-c3a2e2454156"],
    ["tâche", 3, "ef3ecd81-f680-5120-9c8f-c5c64d815bed"],
  ];

  it("equals the Claude session name's four external vectors, and this file's RFC 4122 construction", () => {
    expect(WRITER_WORKER_ID_UUID_NAMESPACE).toBe("7108affe-18e1-427e-8a44-493bb4a3af92");
    for (const [taskId, attempt, expected] of VECTORS) {
      expect(writerWorkerIdFor(taskId, attempt)).toBe(expected);
      expect(independentV5(WRITER_WORKER_ID_UUID_NAMESPACE, taskId + "/" + String(attempt))).toBe(expected);
    }
  });

  it("differs per flat attempt, and is the same on every call", () => {
    expect(writerWorkerIdFor(TASK, 1)).not.toBe(writerWorkerIdFor(TASK, 2));
    expect(writerWorkerIdFor(TASK, 1)).toBe(writerWorkerIdFor(TASK, 1));
    expect(writerWorkerIdFor(TASK, 1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("gives two revisions of one task two ids, because they are two flat attempts (ND-3)", () => {
    // Revision 1 attempt 1 is flat attempt 1; revision 2 attempt 1 is flat
    // attempt 2. The per-revision number would collide at 1; the flat one does not.
    const revisionOne = writerWorkerIdFor(TASK, 1);
    const revisionTwo = writerWorkerIdFor(TASK, 2);
    expect(revisionOne).not.toBe(revisionTwo);
  });

  it("refuses a task id or an attempt that is present and invalid, naming the argument", () => {
    const invalid: readonly (readonly [unknown, unknown, string])[] = [
      ["", 1, "taskId"],
      [null, 1, "taskId"],
      [undefined, 1, "taskId"],
      [42, 1, "taskId"],
      [TASK, 0, "attempt"],
      [TASK, -1, "attempt"],
      [TASK, 1.5, "attempt"],
      [TASK, Number.NaN, "attempt"],
      [TASK, Number.MAX_SAFE_INTEGER + 1, "attempt"],
      [TASK, "1", "attempt"],
      [TASK, null, "attempt"],
      [TASK, undefined, "attempt"],
    ];
    for (const [taskId, attempt, path] of invalid) {
      let refusal: unknown = null;
      try {
        writerWorkerIdFor(taskId as string, attempt as number);
      } catch (error) {
        refusal = error;
      }
      expect(refusal, JSON.stringify([taskId, attempt])).toBeInstanceOf(LedgerValidationError);
      expect((refusal as LedgerValidationError).issues.map((issue) => issue.path)).toEqual([path]);
    }
  });
});

describe("the ledger barrel", () => {
  it("exports the three functions and the identity prefix, and keeps the sub-prefixes in the module", () => {
    expect(ledgerBarrel.RECEIPT_IDENTITY_PREIMAGE_PREFIX_V1).toBe(RECEIPT_IDENTITY_PREIMAGE_PREFIX_V1);
    expect(ledgerBarrel.receiptIdentityPreimageV1).toBe(receiptIdentityPreimageV1);
    expect(ledgerBarrel.receiptSha256).toBe(receiptSha256);
    expect(ledgerBarrel.writerWorkerIdFor).toBe(writerWorkerIdFor);
    expect(Object.keys(ledgerBarrel)).not.toContain("RECEIPT_CHECKS_PREIMAGE_PREFIX_V1");
    expect(Object.keys(ledgerBarrel)).not.toContain("RECEIPT_WRITE_SET_PREIMAGE_PREFIX_V1");
  });
});
