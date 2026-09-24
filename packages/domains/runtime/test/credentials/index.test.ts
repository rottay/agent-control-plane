import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountRecord, CONTRACT_VERSION, findCredentialViolations } from "@acp/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CREDENTIAL_REFUSALS, resolveCredential } from "../../src/credentials/index.js";
import type { CredentialResolution } from "../../src/credentials/index.js";

/**
 * Evidence for the one credential resolver (P-15 escalón E, ADR 0108; owner
 * authorization C4, decision E-ND-1).
 *
 * Every credential here is synthetic: a canary built by concatenation and written by
 * this file into a disposable directory under the real temporary root, which the
 * file removes. No real credentials file is read, named or reachable: the resolver
 * takes no path but the accounts file it is handed, and every one handed here is a
 * fixture.
 */

const TMP_ROOT = realpathSync(tmpdir());
const PREFIX = "acp-p15e-cred-";
const created: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of created.splice(0)) {
    if (path.startsWith(join(TMP_ROOT, PREFIX))) rmSync(path, { recursive: true, force: true });
  }
});

function canary(tag: string): string {
  return "sk-" + "ant-" + "api03-" + "C".repeat(40) + tag;
}

const CANARY = canary("RUNTIME01");

interface Fixture {
  readonly dir: string;
  readonly accountsFile: string;
  readonly credentialsFile: string;
}

/** Passed as the document to leave the sibling unwritten. */
const NO_SIBLING = Symbol("no sibling");

/** One account record, on the accounts suite's own fixture, with the reference under test. */
function account(credentialRef: unknown, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    accountId: "acct-api",
    provider: "claude",
    alias: "api",
    authMode: "LOCAL_CREDENTIAL_FALLBACK",
    authProfileRef: "profile://acp-drill-api",
    credentialRef,
    plan: null,
    enabledModels: ["claude-syn-1"],
    knownLimits: {},
    resetSchedule: { kind: "UNKNOWN", nextResetAt: null, timezone: "UTC", confidence: "LOW" },
    quotaEstimate: { remainingRatio: null, estimatedTokensRemaining: null, estimatedAt: "2026-09-23T00:00:00Z", confidence: "LOW" },
    lastHealthProbe: null,
    lastClassifiedError: null,
    status: "AVAILABLE",
    isolatedConfigRoot: "/tmp/acp-p15e-isolated-root",
    contextSwitchCost: { estimatedTokens: 0, estimatedSeconds: 0 },
    ...overrides,
  };
}

/** An owner directory with an accounts file naming `credentialRef` and, unless told otherwise, its sibling. */
function fixture(
  credentials: unknown = { contractVersion: CONTRACT_VERSION, credentials: { "anthropic-main": CANARY } },
  modes: { readonly accounts?: number; readonly credentials?: number } = {},
  credentialRef: unknown = "file://anthropic-main",
): Fixture {
  const dir = join(TMP_ROOT, PREFIX + randomUUID());
  mkdirSync(dir, { mode: 0o700 });
  created.push(dir);
  const accountsFile = join(dir, "accounts.local.json");
  writeFileSync(accountsFile, JSON.stringify({ contractVersion: CONTRACT_VERSION, accounts: [account(credentialRef)] }), "utf8");
  chmodSync(accountsFile, modes.accounts ?? 0o600);
  const credentialsFile = join(dir, "credentials.local.json");
  if (credentials !== NO_SIBLING) {
    writeFileSync(credentialsFile, typeof credentials === "string" ? credentials : JSON.stringify(credentials), "utf8");
    chmodSync(credentialsFile, modes.credentials ?? 0o600);
  }
  return { dir, accountsFile, credentialsFile };
}

/** Resolve the fixture's one account. */
function resolve(accountsFile: unknown, accountId: unknown = "acct-api"): CredentialResolution {
  return resolveCredential({ accountsFile, accountId });
}

function withEntry(value: unknown, name = "anthropic-main"): unknown {
  return { contractVersion: CONTRACT_VERSION, credentials: { [name]: value } };
}

/**
 * Every text a value renders to, walking every own property (enumerable or not),
 * `cause` and `errors[]` recursively. `node:util` is outside the runtime tests'
 * import list, so `util.inspect` is replaced by this walk, which reaches every
 * property `inspect` would print and the non-enumerable ones it hides by default.
 */
function renderings(value: unknown, seen = new Set<unknown>()): string {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return String(value);
  if (seen.has(value)) return "";
  seen.add(value);
  const out: string[] = [rendered(value), (JSON.stringify(value) as string | undefined) ?? ""];
  for (const key of Object.getOwnPropertyNames(value)) {
    if (typeof value === "function" && (key === "caller" || key === "arguments")) continue;
    out.push(key, renderings((value as Record<string, unknown>)[key], seen));
  }
  return out.join("\n");
}

/** A value's own string form, or nothing when it has none. */
function rendered(value: unknown): string {
  try {
    return (value as { toString(): string }).toString();
  } catch {
    return "";
  }
}

function refused(resolution: CredentialResolution): { readonly refusal: string; readonly at: string } {
  if (resolution.ok) throw new Error("expected a refusal");
  expect(renderings(resolution)).not.toContain(CANARY);
  return { refusal: resolution.refusal, at: resolution.at };
}

describe("the resolver admits one entry from the derived sibling", () => {
  it("detects its own canary, so every absence below is evidence (positive control)", () => {
    expect(findCredentialViolations({ value: CANARY }).length).toBeGreaterThan(0);
    expect(findCredentialViolations({ value: "Bearer " + CANARY }).length).toBeGreaterThan(0);
  });

  it("answers a closure over the value, and the resolution itself serializes to nothing of it", () => {
    const { accountsFile } = fixture();
    const resolution = resolve(accountsFile);
    if (!resolution.ok) throw new Error("expected an admission, got " + resolution.refusal + " at " + resolution.at);
    expect(resolution.credential()).toBe(CANARY);
    // The value is in the closure, where the client calls it; the answer a caller
    // holds renders to none of it (sink 8b's mould).
    expect(JSON.stringify(resolution)).toBe('{"ok":true}');
    expect(renderings(resolution)).not.toContain(CANARY);
    expect(Object.isFrozen(resolution)).toBe(true);
  });

  it("reads the sibling of the accounts file it was handed, and no other path", () => {
    const one = fixture(withEntry(canary("ONE")));
    const two = fixture(withEntry(canary("TWO")));
    const first = resolve(one.accountsFile);
    const second = resolve(two.accountsFile);
    expect(first.ok && first.credential()).toBe(canary("ONE"));
    expect(second.ok && second.credential()).toBe(canary("TWO"));
  });

  it("writes nothing: both files and the directory are unchanged after a resolution", () => {
    const { dir, accountsFile, credentialsFile } = fixture();
    const before = [readdirSync(dir).sort(), readFileSync(accountsFile, "utf8"), readFileSync(credentialsFile, "utf8"), statSync(credentialsFile).mtimeMs, statSync(credentialsFile).mode];
    resolve(accountsFile);
    resolve(accountsFile, "acct-absent");
    const after = [readdirSync(dir).sort(), readFileSync(accountsFile, "utf8"), readFileSync(credentialsFile, "utf8"), statSync(credentialsFile).mtimeMs, statSync(credentialsFile).mode];
    expect(after).toEqual(before);
  });

  it("reads no environment variable, whatever a decoy offers (N-E-20)", () => {
    const { accountsFile } = fixture();
    const original = process.env;
    let reads = 0;
    const decoy = new Proxy(
      { ...original, ANTHROPIC_API_KEY: canary("ENV"), ACP_CREDENTIALS_FILE: "/decoy" },
      {
        get(target, key, receiver) {
          reads += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
        has(target, key) {
          reads += 1;
          return Reflect.has(target, key);
        },
        ownKeys(target) {
          reads += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    let resolution: CredentialResolution;
    process.env = decoy;
    try {
      resolution = resolve(accountsFile);
    } finally {
      process.env = original;
    }
    expect(reads).toBe(0);
    expect(resolution.ok && resolution.credential()).toBe(CANARY);
  });

  it("declares its refusal words, closed and sorted", () => {
    expect([...CREDENTIAL_REFUSALS]).toEqual([...CREDENTIAL_REFUSALS].sort());
    for (const word of [
      "ACCOUNTS_PATH_INVALID",
      "CREDENTIAL_ENTRY_ABSENT",
      "CREDENTIAL_ENTRY_INVALID",
      "CREDENTIAL_NOT_A_SECRET",
      "CREDENTIAL_REF_INVALID",
      "CREDENTIAL_SCHEME_UNSUPPORTED",
      "CREDENTIAL_NOT_DECLARED",
      "OWNER_FILE_ABSENT",
      "OWNER_FILE_UNSAFE_PERMISSIONS",
      "PATH_NOT_CANONICAL",
    ]) {
      expect(CREDENTIAL_REFUSALS).toContain(word);
    }
  });
});

describe("the account and its reference are judged before the credentials file is touched", () => {
  it("refuses an env:// or inline reference at the account contract, through the accounts loader (N-E-3, N-E-11)", () => {
    expect(AccountRecord.shape.credentialRef.safeParse("env://ANTHROPIC_API_KEY").success).toBe(false);
    for (const credentialRef of ["env://ANTHROPIC_API_KEY", "", 7]) {
      const { accountsFile } = fixture(NO_SIBLING, {}, credentialRef);
      expect(refused(resolve(accountsFile)), String(credentialRef)).toEqual({
        refusal: "OWNER_FILE_INVALID",
        at: "accountsFile.accounts[0].credentialRef",
      });
    }
    // Credential material in the record is its own word, and the value never travels.
    const { accountsFile } = fixture(NO_SIBLING, {}, CANARY);
    const inline = refused(resolve(accountsFile));
    expect(["OWNER_FILE_CREDENTIAL_MATERIAL", "OWNER_FILE_INVALID"]).toContain(inline.refusal);
    const material = fixture(NO_SIBLING);
    writeFileSync(
      material.accountsFile,
      JSON.stringify({ contractVersion: CONTRACT_VERSION, accounts: [account("file://anthropic-main", { alias: CANARY })] }),
      "utf8",
    );
    expect(refused(resolve(material.accountsFile))).toEqual({
      refusal: "OWNER_FILE_CREDENTIAL_MATERIAL",
      at: "accountsFile.accounts[0].alias",
    });
  });

  it("refuses an account the file does not carry", () => {
    const { accountsFile } = fixture(NO_SIBLING);
    for (const accountId of ["acct-absent", "", null, 7, "toString"]) {
      expect(refused(resolve(accountsFile, accountId)), String(accountId)).toEqual({ refusal: "ACCOUNT_ABSENT", at: "accountId" });
    }
  });

  it("resolves only for the stored-credential mode; every other authMode is refused, whatever reference it carries (Fable C2)", () => {
    for (const authMode of ["PREAUTHENTICATED_PROFILE", "DEVICE_AUTHORIZATION"]) {
      for (const credentialRef of ["file://anthropic-main", null]) {
        const owner = fixture();
        writeFileSync(
          owner.accountsFile,
          JSON.stringify({ contractVersion: CONTRACT_VERSION, accounts: [account(credentialRef, { authMode })] }),
          "utf8",
        );
        expect(refused(resolve(owner.accountsFile)), authMode + " " + String(credentialRef)).toEqual({
          refusal: "CREDENTIAL_NOT_DECLARED",
          at: "authMode",
        });
      }
    }
  });

  it("refuses keychain:// as unsupported and profile:// as not a secret (N-E-4, N-E-5)", () => {
    expect(refused(resolve(fixture(NO_SIBLING, {}, "keychain://anthropic-main").accountsFile))).toEqual({
      refusal: "CREDENTIAL_SCHEME_UNSUPPORTED",
      at: "credentialRef",
    });
    expect(refused(resolve(fixture(NO_SIBLING, {}, "profile://anthropic-main").accountsFile))).toEqual({
      refusal: "CREDENTIAL_NOT_A_SECRET",
      at: "credentialRef",
    });
  });

  it("refuses a reference that escapes or is not one entry name, without reaching the sibling (N-E-6)", () => {
    // No sibling exists: a refusal naming the reference, not OWNER_FILE_ABSENT, is
    // the proof that the credentials file was never reached (the sealed directory).
    for (const credentialRef of ["file://../x", "file://a/b", "file://.", "file://..", "file://" + "a".repeat(129), "file://a/../../etc"]) {
      expect(refused(resolve(fixture(NO_SIBLING, {}, credentialRef).accountsFile)), credentialRef).toEqual({
        refusal: "CREDENTIAL_REF_INVALID",
        at: "credentialRef",
      });
    }
    // The longest admitted name passes the reference and fails only at the absent sibling.
    expect(refused(resolve(fixture(NO_SIBLING, {}, "file://" + "a".repeat(128)).accountsFile))).toEqual({
      refusal: "OWNER_FILE_ABSENT",
      at: "credentials.local.json",
    });
  });
});

describe("both owner files climb the ladder", () => {
  it("refuses an accounts path that is not an absolute accounts.local.json (N-E-C6)", () => {
    const { dir } = fixture();
    for (const accountsFile of [join(dir, "credentials.local.json"), join(dir, "accounts.json"), "accounts.local.json", "./accounts.local.json", "", null, 7]) {
      expect(refused(resolve(accountsFile)), String(accountsFile)).toEqual({
        refusal: "ACCOUNTS_PATH_INVALID",
        at: "accountsFile",
      });
    }
  });

  it("refuses an absent accounts file and an absent sibling, each at its own path (N-E-1)", () => {
    const absent = join(TMP_ROOT, PREFIX + randomUUID(), "accounts.local.json");
    expect(refused(resolve(absent))).toEqual({
      refusal: "OWNER_FILE_ABSENT",
      at: "accountsFile",
    });
    const { accountsFile } = fixture(NO_SIBLING);
    expect(refused(resolve(accountsFile))).toEqual({
      refusal: "OWNER_FILE_ABSENT",
      at: "credentials.local.json",
    });
  });

  it("refuses any mode but 0600 on either file (N-E-2)", () => {
    for (const mode of [0o644, 0o640, 0o400]) {
      const accounts = fixture(NO_SIBLING, { accounts: mode });
      expect(refused(resolve(accounts.accountsFile))).toEqual({
        refusal: "OWNER_FILE_UNSAFE_PERMISSIONS",
        at: "accountsFile",
      });
      const sibling = fixture(NO_SIBLING, {});
      writeFileSync(sibling.credentialsFile, JSON.stringify(withEntry(CANARY)), "utf8");
      chmodSync(sibling.credentialsFile, mode);
      expect(refused(resolve(sibling.accountsFile))).toEqual({
        refusal: "OWNER_FILE_UNSAFE_PERMISSIONS",
        at: "credentials.local.json",
      });
    }
  });

  it("refuses files owned by another uid (N-E-2)", () => {
    const { accountsFile } = fixture();
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("POSIX only");
    vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(uid + 1);
    expect(refused(resolve(accountsFile))).toEqual({
      refusal: "OWNER_FILE_NOT_OWNED",
      at: "accountsFile",
    });
  });

  it("refuses a symlinked accounts file or sibling rather than following it (N-E-10)", () => {
    const real = fixture();
    const linkDir = join(TMP_ROOT, PREFIX + randomUUID());
    mkdirSync(linkDir, { mode: 0o700 });
    created.push(linkDir);
    symlinkSync(real.accountsFile, join(linkDir, "accounts.local.json"));
    expect(refused(resolve(join(linkDir, "accounts.local.json")))).toEqual({
      refusal: "PATH_NOT_CANONICAL",
      at: "accountsFile",
    });
    const linked = fixture(NO_SIBLING);
    symlinkSync(real.credentialsFile, linked.credentialsFile);
    expect(refused(resolve(linked.accountsFile))).toEqual({
      refusal: "PATH_NOT_CANONICAL",
      at: "credentials.local.json",
    });
  });

  it("refuses a sibling that is not JSON without quoting it", () => {
    const { accountsFile } = fixture("{ " + CANARY);
    expect(refused(resolve(accountsFile))).toEqual({
      refusal: "OWNER_FILE_NOT_JSON",
      at: "credentials.local.json",
    });
  });
});

describe("the credentials document is strict and versioned (E-ND-11)", () => {
  it("refuses a third key without naming it (N-E-11b)", () => {
    const { accountsFile } = fixture({ contractVersion: CONTRACT_VERSION, credentials: {}, [CANARY]: 1 });
    expect(refused(resolve(accountsFile))).toEqual({
      refusal: "OWNER_FILE_UNEXPECTED_KEY",
      at: "credentials.local.json",
    });
  });

  it("refuses a missing or wrong contractVersion, never reporting it (N-E-11c)", () => {
    for (const document of [
      { credentials: { "anthropic-main": CANARY } },
      { contractVersion: CANARY, credentials: { "anthropic-main": CANARY } },
      { contractVersion: "0.0.0", credentials: { "anthropic-main": CANARY } },
      { contractVersion: null, credentials: { "anthropic-main": CANARY } },
    ]) {
      const { accountsFile } = fixture(document);
      expect(refused(resolve(accountsFile))).toEqual({
        refusal: "OWNER_FILE_INVALID",
        at: "credentials.local.json.contractVersion",
      });
    }
  });

  it("refuses a document or credentials section of the wrong shape (N-E-9)", () => {
    for (const document of [[], "text", null, 7]) {
      const { accountsFile } = fixture(JSON.stringify(document));
      expect(refused(resolve(accountsFile))).toEqual({
        refusal: "OWNER_FILE_INVALID",
        at: "credentials.local.json",
      });
    }
    for (const section of [null, [], CANARY, 7]) {
      const { accountsFile } = fixture({ contractVersion: CONTRACT_VERSION, credentials: section });
      expect(refused(resolve(accountsFile))).toEqual({
        refusal: "OWNER_FILE_INVALID",
        at: "credentials.local.json.credentials",
      });
    }
  });
});

describe("the entry is an own property, held to the value grammar", () => {
  it("answers ENTRY_ABSENT for a missing name and for an inherited one (N-E-7, N-E-7b)", () => {
    // `__proto__` is nameable: the reference class `[A-Za-z0-9._~@-]` includes `_`.
    for (const name of ["absent", "constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
      const { accountsFile } = fixture(undefined, {}, "file://" + name);
      expect(refused(resolve(accountsFile)), name).toEqual({
        refusal: "CREDENTIAL_ENTRY_ABSENT",
        at: "credentials." + name,
      });
    }
    // An own `__proto__` key, which `JSON.parse` does create, is an ordinary entry.
    const own = fixture(
      JSON.stringify({ contractVersion: CONTRACT_VERSION, credentials: {} }).replace("{}", '{"__proto__":"' + CANARY + '"}'),
      {},
      "file://__proto__",
    );
    const resolution = resolve(own.accountsFile);
    expect(resolution.ok && resolution.credential()).toBe(CANARY);
  });

  it("refuses an entry that is not a bounded string (N-E-8)", () => {
    for (const value of [null, "", 7, true, [], [CANARY], {}, { value: CANARY }, "x".repeat(4097)]) {
      const { accountsFile } = fixture(withEntry(value));
      expect(refused(resolve(accountsFile)), ((JSON.stringify(value) as string | undefined) ?? "").slice(0, 40)).toEqual({
        refusal: "CREDENTIAL_ENTRY_INVALID",
        at: "credentials.anthropic-main",
      });
    }
    const { accountsFile } = fixture(withEntry("x".repeat(4096)));
    expect(resolve(accountsFile).ok).toBe(true);
  });

  it("refuses every byte a header API would refuse or trim, before any Headers exists (N-E-8b, C-E7.1)", () => {
    const RealHeaders = globalThis.Headers;
    let constructed = 0;
    globalThis.Headers = new Proxy(RealHeaders, {
      construct(target, args, newTarget) {
        constructed += 1;
        return Reflect.construct(target, args, newTarget) as object;
      },
    });
    try {
      const head = CANARY.slice(0, 20);
      const tail = CANARY.slice(20);
      for (const value of [
        head + "\n" + tail,
        head + "\r" + tail,
        head + "\u0000" + tail,
        " " + CANARY,
        CANARY + " ",
        head + " " + tail,
        head + "\t" + tail,
        head + "Ā" + tail,
        head + "é" + tail,
        head + "�" + tail,
        head + "\u007f" + tail,
      ]) {
        const { accountsFile } = fixture(withEntry(value));
        const refusal = refused(resolve(accountsFile));
        expect(refusal, JSON.stringify(value.slice(18, 23))).toEqual({ refusal: "CREDENTIAL_ENTRY_INVALID", at: "credentials.anthropic-main" });
        // No fragment of the value either.
        expect(JSON.stringify(refusal)).not.toContain(head);
        expect(JSON.stringify(refusal)).not.toContain(tail);
      }
      // Invalid UTF-8 in the file decodes to U+FFFD and is refused the same way.
      const { accountsFile, credentialsFile } = fixture(NO_SIBLING);
      const text = JSON.stringify(withEntry(head + "@@" + tail));
      const bytes = Buffer.from(text, "utf8");
      const at = bytes.indexOf("@@");
      bytes[at] = 0xff;
      bytes[at + 1] = 0xfe;
      writeFileSync(credentialsFile, bytes);
      chmodSync(credentialsFile, 0o600);
      expect(refused(resolve(accountsFile))).toEqual({
        refusal: "CREDENTIAL_ENTRY_INVALID",
        at: "credentials.anthropic-main",
      });
    } finally {
      globalThis.Headers = RealHeaders;
    }
    expect(constructed).toBe(0);
  });
});
