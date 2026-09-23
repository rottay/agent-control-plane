import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AdapterError } from "../../src/errors/index.js";
import { CLAUDE_SESSION_UUID_NAMESPACE, claudeSessionId } from "../../src/session-name/index.js";

/**
 * The Claude session name (P-15 escalón A, ADR 0101).
 *
 * The vectors below were computed OUTSIDE this package, by Python's `uuid.uuid5`
 * over the same namespace and names, and are pinned as literals; the second
 * recomputation is this file's own RFC 4122 construction over `node:crypto`. Two
 * encoders agreeing with the module is the claim, not the module agreeing with
 * itself.
 */

const TASK = "00000000-0000-4000-8000-00000000000a";

const VECTORS: readonly (readonly [string, number, string])[] = [
  [TASK, 1, "39de475b-2696-5df6-b64b-88336de7d72c"],
  [TASK, 2, "796cc136-89af-53a4-b947-3d0609c12f60"],
  [TASK, 10, "e23c7ae1-9982-59c5-adae-c3a2e2454156"],
  ["tâche", 3, "ef3ecd81-f680-5120-9c8f-c5c64d815bed"],
];

/** RFC 4122 §4.3, restated here independently of the module. */
function independentV5(namespace: string, name: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
    .update(Buffer.from(name, "utf8"))
    .digest()
    .subarray(0, 16);
  const six = bytes.readUInt8(6);
  const eight = bytes.readUInt8(8);
  bytes.writeUInt8((six & 0x0f) | 0x50, 6);
  bytes.writeUInt8((eight & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

describe("the Claude session name is a version 5 UUID per attempt", () => {
  it("equals the externally computed vectors, and this file's own RFC 4122 construction", () => {
    for (const [taskId, attempt, expected] of VECTORS) {
      expect(claudeSessionId(taskId, attempt)).toBe(expected);
      expect(independentV5(CLAUDE_SESSION_UUID_NAMESPACE, taskId + "/" + String(attempt))).toBe(expected);
    }
  });

  it("differs between attempts of one task, and is the same on every call", () => {
    expect(claudeSessionId(TASK, 1)).not.toBe(claudeSessionId(TASK, 2));
    expect(claudeSessionId(TASK, 1)).toBe(claudeSessionId(TASK, 1));
  });

  it("is never the task id, and carries the version 5 nibble and the RFC 4122 variant", () => {
    const id = claudeSessionId(TASK, 1);
    expect(id).not.toBe(TASK);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("is derived under its own namespace, not the runtime's coordinate namespace", () => {
    // The runtime's `ACP_UUID_NAMESPACE`, as a literal: providers may not import
    // the runtime, and the point is that the two differ.
    const runtimeNamespace = "6f2a1e14-3f8b-5c2d-9a47-2b6d1c8e5f30";
    expect(CLAUDE_SESSION_UUID_NAMESPACE).not.toBe(runtimeNamespace);
    expect(claudeSessionId(TASK, 1)).not.toBe(independentV5(runtimeNamespace, TASK + "/1"));
  });

  it("refuses a task id or an attempt that is present and invalid, never coercing it", () => {
    const invalid: readonly (readonly [unknown, unknown])[] = [
      ["", 1],
      [null, 1],
      [undefined, 1],
      [42, 1],
      [TASK, 0],
      [TASK, -1],
      [TASK, 1.5],
      [TASK, Number.NaN],
      [TASK, Number.MAX_SAFE_INTEGER + 1],
      [TASK, "1"],
      [TASK, null],
      [TASK, undefined],
    ];
    for (const [taskId, attempt] of invalid) {
      let refusal: unknown = null;
      try {
        claudeSessionId(taskId as string, attempt as number);
      } catch (error) {
        refusal = error;
      }
      expect(refusal, JSON.stringify([taskId, attempt])).toBeInstanceOf(AdapterError);
      expect((refusal as AdapterError).code).toBe("PROTOCOL_UNSUPPORTED");
    }
  });
});
