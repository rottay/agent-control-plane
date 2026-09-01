/**
 * Credential and transcript guards — `@acp/contracts` (P8-T G6).
 *
 * Law 4 made mechanical: the credential and transcript scanners, and the
 * refinement that attaches them to a schema.
 *
 * Subdivided in place from the single `schemas/index.ts`, which is now a pure
 * re-export barrel. Nothing here was rewritten: the definitions are the file's
 * own, moved under the band heading they already carried.
 */

import type { z } from "zod";

/** Maximum object depth the credential and transcript scanners will walk. */
const MAX_SCAN_DEPTH = 12;

/**
 * Keys that may never appear in a checkpoint, event or account record.
 * Comparison is done on a normalized key (lowercased, non alphanumerics
 * stripped) and is exact, so an opaque reference such as credentialRef or
 * secretRef is still permitted while a bare credential or secret is not.
 */
const DENIED_KEYS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "secret",
  "secretvalue",
  "clientsecret",
  "token",
  "tokenvalue",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "bearertoken",
  "apikey",
  "apitoken",
  "authtoken",
  "cookie",
  "cookies",
  "sessioncookie",
  "setcookie",
  "authorization",
  "authheader",
  "privatekey",
  "signingkey",
  "sessionkey",
  "credential",
  "credentials",
  "jwt",
  "otp",
  "otpcode",
  "totp",
  "mfacode",
]);

/**
 * Credential stems matched as a suffix of the normalized key.
 *
 * Exact-key matching alone lets a compound name through: dbPassword,
 * oauthToken and sessionSecret all normalize to something that is not in the
 * exact set but plainly names credential material. Suffix matching closes that
 * without catching opaque locators or policy metadata, because those end in
 * ref or policy rather than in a credential stem.
 *
 * Safe by construction: credentialRef, authProfileRef, secretRef,
 * passwordPolicy, tokenBudget.
 */
const DENIED_KEY_STEMS: readonly string[] = [
  "password",
  "passphrase",
  "secret",
  "token",
  "cookie",
  "apikey",
  "apitoken",
  "privatekey",
  "signingkey",
  "credential",
  "credentials",
];

function isDeniedCredentialKey(normalized: string): boolean {
  if (DENIED_KEYS.has(normalized)) return true;
  return DENIED_KEY_STEMS.some((stem) => normalized.endsWith(stem));
}

/**
 * Keys whose presence would mean the provider conversation itself is being
 * used as continuity. The roadmap forbids that: continuity is digest based.
 */
const DENIED_TRANSCRIPT_KEYS: ReadonlySet<string> = new Set([
  "transcript",
  "transcripts",
  "conversation",
  "conversationhistory",
  "messages",
  "messagehistory",
  "chatlog",
  "chathistory",
  "history",
  "rawoutput",
  "rawresponse",
  "completion",
  "completions",
  "promptlog",
  "turns",
]);

/** Value shapes that look like live credential material regardless of key. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/,
  /\bsk-[A-Za-z0-9-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
];

export interface GuardViolation {
  readonly path: string;
  readonly reason: string;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function formatPath(segments: readonly (string | number)[]): string {
  return segments.length === 0 ? "<root>" : segments.join(".");
}

function scan(
  value: unknown,
  segments: (string | number)[],
  depth: number,
  isDenied: (normalizedKey: string) => boolean,
  checkValues: boolean,
  out: GuardViolation[],
): void {
  if (depth > MAX_SCAN_DEPTH) {
    out.push({
      path: formatPath(segments),
      reason: "structure is nested deeper than the contract scan budget allows",
    });
    return;
  }

  if (typeof value === "string") {
    if (!checkValues) return;
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        out.push({
          path: formatPath(segments),
          reason: "value matches a known credential material shape",
        });
        return;
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      scan(value[index], [...segments, index], depth + 1, isDenied, checkValues, out);
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizeKey(key);
      if (isDenied(normalized)) {
        out.push({
          path: formatPath([...segments, key]),
          reason: "key " + key + " is forbidden by the control plane contract",
        });
        continue;
      }
      scan(child, [...segments, key], depth + 1, isDenied, checkValues, out);
    }
  }
}

/** Report every credential bearing key or secret shaped value in a tree. */
export function findCredentialViolations(value: unknown): GuardViolation[] {
  const out: GuardViolation[] = [];
  scan(value, [], 0, isDeniedCredentialKey, true, out);
  return out;
}

/** Report every key that would smuggle a provider transcript as continuity. */
export function findTranscriptViolations(value: unknown): GuardViolation[] {
  const out: GuardViolation[] = [];
  scan(value, [], 0, (key) => DENIED_TRANSCRIPT_KEYS.has(key), false, out);
  return out;
}

/** Serialized size of a value in bytes, used for the checkpoint budget. */
export function serializedByteLength(value: unknown): number {
  // JSON.stringify yields undefined for undefined, functions and symbols, which
  // this overload does not surface in its type. Narrow at runtime instead.
  //
  // TextEncoder rather than Buffer: this module is reused by the browser-safe
  // observation contract, and Buffer is a Node global. TextEncoder is a Web
  // platform API available in both runtimes, and it measures the same UTF-8
  // bytes, so the checkpoint budget is unchanged.
  const json: unknown = JSON.stringify(value);
  return typeof json === "string" ? new TextEncoder().encode(json).byteLength : 0;
}

type RefinementContext = z.core.$RefinementCtx;

export function attachGuards(
  value: unknown,
  ctx: RefinementContext,
  options: { readonly transcript: boolean },
): void {
  for (const violation of findCredentialViolations(value)) {
    ctx.addIssue({
      code: "custom",
      message: "credential material is forbidden: " + violation.reason,
      path: violation.path === "<root>" ? [] : violation.path.split("."),
    });
  }
  if (!options.transcript) return;
  for (const violation of findTranscriptViolations(value)) {
    ctx.addIssue({
      code: "custom",
      message: "provider transcript continuity is forbidden: " + violation.reason,
      path: violation.path === "<root>" ? [] : violation.path.split("."),
    });
  }
}
