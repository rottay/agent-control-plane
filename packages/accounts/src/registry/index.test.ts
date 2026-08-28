import { randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CONTRACT_VERSION } from "@acp/contracts";

import { ACCOUNTS_REFUSALS } from "../errors.js";
import type { AccountsRefused } from "../errors.js";
import {
  ACCOUNTS_FILE_KEYS,
  ACCOUNTS_FILE_MAX_BYTES,
  buildRegistry,
  loadAccountsFile,
} from "./index.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const TMP_ROOT = realpathSync(tmpdir());
const PREFIX = "acp-p5a-";

const created: string[] = [];

/**
 * A disposable fixture directory under the real temporary root.
 *
 * `realpathSync` matters rather than being tidy: on this platform `/tmp` is a
 * symlink, and a fixture written through the symlinked path would be refused by
 * the loader's canonical check for a reason that has nothing to do with what
 * the test is asserting.
 */
function fixtureDir(): string {
  const path = join(TMP_ROOT, PREFIX + randomUUID());
  mkdirSync(path, { recursive: true, mode: 0o700 });
  created.push(path);
  return path;
}

/**
 * Write an owner-file fixture with the mode the loader demands.
 *
 * Never named `accounts.local.json`. The real owner file lives outside every
 * repository at a path this package's code cannot name, and a fixture wearing
 * its name is one careless `cp` away from being mistaken for it.
 */
function writeFixture(text: string, name = "owner-fixture.json", mode = 0o600): string {
  const path = join(fixtureDir(), name);
  writeFileSync(path, text, "utf8");
  chmodSync(path, mode);
  return path;
}

afterEach(() => {
  while (created.length > 0) {
    const path = created.pop();
    if (path?.startsWith(join(TMP_ROOT, PREFIX)) === true) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

// --- fixtures ---------------------------------------------------------------

type RecordOverrides = Readonly<Record<string, unknown>>;

function account(overrides: RecordOverrides = {}): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    accountId: "acct-primary",
    provider: "anthropic",
    alias: "primary",
    authMode: "PREAUTHENTICATED_PROFILE",
    authProfileRef: "profile://acp-drill-primary",
    credentialRef: null,
    plan: "max",
    enabledModels: ["opus", "sonnet"],
    knownLimits: { weekly: 1_000_000 },
    resetSchedule: {
      kind: "DECLARED",
      nextResetAt: "2026-09-01T00:00:00Z",
      timezone: "UTC",
      confidence: "MEDIUM",
    },
    quotaEstimate: {
      remainingRatio: 0.5,
      estimatedTokensRemaining: 500_000,
      estimatedAt: "2026-08-28T00:00:00Z",
      confidence: "MEDIUM",
    },
    lastHealthProbe: null,
    lastClassifiedError: null,
    status: "AVAILABLE",
    isolatedConfigRoot: "/tmp/acp-p5a-isolated-root",
    contextSwitchCost: { estimatedTokens: 1_000, estimatedSeconds: 30 },
    ...overrides,
  };
}

function file(accounts: readonly unknown[], envelope: RecordOverrides = {}): string {
  return JSON.stringify({ contractVersion: CONTRACT_VERSION, accounts, ...envelope });
}

/**
 * Shapes the contract's own guards recognise as credential material.
 *
 * Deliberately just over the contract's threshold and deliberately under the
 * repository credential scanner's. `@acp/contracts` refuses a provider-key
 * shape at sixteen characters; `scripts/check-architecture.mjs` refuses one at
 * twenty, because its job is to keep live material out of the repository rather
 * than to recognise a fixture. Sixteen exercises the guard under test without
 * putting anything key-shaped enough to matter into a tracked file — which is
 * why this file needs no credential-fixture exemption.
 */
const SECRET_VALUE = "sk-abcdefghijklmnop";
const SECRET_BEARER = "Bearer abcdefghijklmnopqrst";

function refusal(outcome: ReturnType<typeof loadAccountsFile>): AccountsRefused {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome;
}

describe("the loader admits an owner file, or refuses it with a reason", () => {
  it("loads a well-formed file into a registry", () => {
    const path = writeFixture(
      file([account(), account({ accountId: "acct-second", alias: "second", provider: "openai" })]),
    );
    const outcome = loadAccountsFile(path);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { registry } = outcome;
    expect(registry.accountIds).toEqual(["acct-primary", "acct-second"]);
    expect(registry.get("acct-primary")?.alias).toBe("primary");
    expect(registry.byProvider("openai").map((r) => r.accountId)).toEqual(["acct-second"]);
    expect(registry.byProvider("nobody")).toEqual([]);
  });

  it("carries the opaque references through without resolving anything", () => {
    const path = writeFixture(
      file([
        account({
          authMode: "LOCAL_CREDENTIAL_FALLBACK",
          authProfileRef: "profile://acp-drill-primary",
          credentialRef: "keychain://acp-drill-fallback",
        }),
      ]),
    );
    const outcome = loadAccountsFile(path);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const record = outcome.registry.get("acct-primary");
    // Byte-for-byte what the file said. A locator is a name, not a lookup.
    expect(record?.authProfileRef).toBe("profile://acp-drill-primary");
    expect(record?.credentialRef).toBe("keychain://acp-drill-fallback");
  });

  it("hands back frozen collections", () => {
    const path = writeFixture(file([account()]));
    const outcome = loadAccountsFile(path);
    if (!outcome.ok) return;
    expect(Object.isFrozen(outcome.registry)).toBe(true);
    expect(Object.isFrozen(outcome.registry.accounts)).toBe(true);
    expect(Object.isFrozen(outcome.registry.accountIds)).toBe(true);
  });

  it("answers an unknown id with null, including an inherited member name", () => {
    // An object index lookup would answer `toString` with a function. A lookup
    // that can be walked off the end of is not a lookup.
    const registry = buildRegistry([]);
    for (const id of ["missing", "toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect({ id, found: registry.get(id) }).toEqual({ id, found: null });
    }
  });

  it("is deterministic: the same bytes give the same answer", () => {
    const path = writeFixture(file([account()]));
    const first = loadAccountsFile(path);
    const second = loadAccountsFile(path);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("the path itself must be admitted first", () => {
  it("refuses to be called without an explicit path", () => {
    // The whole point: there is no default. A loader that could be called with
    // nothing is a loader that could read somebody's real accounts by accident.
    for (const supplied of [undefined, null, "", 0, {}, [], Symbol.iterator]) {
      const outcome = loadAccountsFile(supplied);
      expect({ supplied: typeof supplied, reason: refusal(outcome).reason }).toEqual({
        supplied: typeof supplied,
        reason: "PATH_NOT_SUPPLIED",
      });
    }
    expect(refusal(loadAccountsFile()).reason).toBe("PATH_NOT_SUPPLIED");
  });

  it("refuses a relative path", () => {
    for (const path of ["owner-fixture.json", "./owner-fixture.json", "../../etc/passwd"]) {
      expect(refusal(loadAccountsFile(path)).reason).toBe("PATH_NOT_ABSOLUTE");
    }
  });

  it("refuses a path that does not exist", () => {
    expect(refusal(loadAccountsFile(join(fixtureDir(), "absent.json"))).reason).toBe(
      "OWNER_FILE_ABSENT",
    );
  });

  it("refuses a symlink rather than following it", () => {
    const real = writeFixture(file([account()]));
    const link = join(fixtureDir(), "link.json");
    symlinkSync(real, link);
    expect(refusal(loadAccountsFile(link)).reason).toBe("PATH_NOT_CANONICAL");
  });

  it("refuses a directory", () => {
    expect(refusal(loadAccountsFile(fixtureDir())).reason).toBe("OWNER_FILE_NOT_REGULAR");
  });

  it("refuses any mode that is not exactly 0600", () => {
    // Not "no group or world write": an owner file anyone can *read* has
    // already failed at the only thing it is for.
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o700, 0o601, 0o666]) {
      const path = writeFixture(file([account()]), "owner-fixture.json", mode);
      expect({ mode: mode.toString(8), reason: refusal(loadAccountsFile(path)).reason }).toEqual({
        mode: mode.toString(8),
        reason: "OWNER_FILE_UNSAFE_PERMISSIONS",
      });
    }
  });

  it("refuses a file owned by another account, where that can be simulated", () => {
    const path = writeFixture(file([account()]));
    let simulated = false;
    try {
      chownSync(path, 1, 1);
      simulated = true;
    } catch {
      // Unprivileged processes cannot give a file away. Recorded, not skipped
      // silently, so the gap is visible rather than implied by a passing test.
    }
    if (!simulated) {
      expect({ ownershipSimulable: false, codeDeclared: ACCOUNTS_REFUSALS.includes("OWNER_FILE_NOT_OWNED") }).toEqual({
        ownershipSimulable: false,
        codeDeclared: true,
      });
      return;
    }
    expect(refusal(loadAccountsFile(path)).reason).toBe("OWNER_FILE_NOT_OWNED");
  });

  it("refuses a file past the size bound", () => {
    const padding = "x".repeat(ACCOUNTS_FILE_MAX_BYTES);
    const path = writeFixture(JSON.stringify({ contractVersion: CONTRACT_VERSION, accounts: [], padding }));
    expect(refusal(loadAccountsFile(path)).reason).toBe("OWNER_FILE_TOO_LARGE");
  });
});

describe("the bytes must be an accounts file", () => {
  it("refuses text that is not JSON, without quoting it", () => {
    const path = writeFixture("{ this is not json: " + SECRET_VALUE);
    const refused = refusal(loadAccountsFile(path));
    expect(refused.reason).toBe("OWNER_FILE_NOT_JSON");
    // The parser's own message would have quoted the input.
    expect(JSON.stringify(refused)).not.toContain(SECRET_VALUE);
  });

  it("refuses a document that is not an object", () => {
    for (const body of ["[]", '"a string"', "null", "42"]) {
      const path = writeFixture(body);
      expect({ body, reason: refusal(loadAccountsFile(path)).reason }).toEqual({
        body,
        reason: "OWNER_FILE_INVALID",
      });
    }
  });

  it("refuses an unexpected envelope key, naming the path only", () => {
    const path = writeFixture(file([account()], { extra: SECRET_VALUE }));
    const refused = refusal(loadAccountsFile(path));
    expect(refused).toEqual({ ok: false, reason: "OWNER_FILE_UNEXPECTED_KEY", at: "extra" });
    expect(JSON.stringify(refused)).not.toContain(SECRET_VALUE);
  });

  it("refuses an unexpected key inside a record, naming the path only", () => {
    const path = writeFixture(file([{ ...account(), sidecar: SECRET_VALUE }]));
    const refused = refusal(loadAccountsFile(path));
    expect(refused).toEqual({
      ok: false,
      reason: "OWNER_FILE_UNEXPECTED_KEY",
      at: "accounts[0].sidecar",
    });
    expect(JSON.stringify(refused)).not.toContain(SECRET_VALUE);
  });

  it("refuses a key name that is itself secret-shaped, without echoing it", () => {
    // A key name is attacker-controlled text. It is reported because the name
    // *is* the JSON path — but only when it looks like a name.
    const smuggled = SECRET_BEARER + " " + "y".repeat(200);
    const path = writeFixture(file([account()], { [smuggled]: 1 }));
    const refused = refusal(loadAccountsFile(path));
    expect(refused).toEqual({ ok: false, reason: "OWNER_FILE_UNEXPECTED_KEY", at: "<key>" });
    expect(JSON.stringify(refused)).not.toContain("Bearer");
  });

  it("refuses a contract version it does not implement, without reporting it", () => {
    const path = writeFixture(
      JSON.stringify({ contractVersion: "9.9.9-" + SECRET_VALUE, accounts: [] }),
    );
    const refused = refusal(loadAccountsFile(path));
    expect(refused).toEqual({ ok: false, reason: "OWNER_FILE_INVALID", at: "contractVersion" });
    expect(JSON.stringify(refused)).not.toContain(SECRET_VALUE);
  });

  it("refuses a missing envelope field and a non-array accounts field", () => {
    const missing = writeFixture(JSON.stringify({ accounts: [] }));
    expect(refusal(loadAccountsFile(missing)).at).toBe("contractVersion");

    const notArray = writeFixture(JSON.stringify({ contractVersion: CONTRACT_VERSION, accounts: {} }));
    const refused = refusal(loadAccountsFile(notArray));
    expect(refused).toEqual({ ok: false, reason: "OWNER_FILE_INVALID", at: "accounts" });
  });

  it("refuses a duplicate account id", () => {
    const path = writeFixture(file([account(), account({ alias: "clone" })]));
    expect(refusal(loadAccountsFile(path))).toEqual({
      ok: false,
      reason: "DUPLICATE_ACCOUNT_ID",
      at: "accounts[1].accountId",
    });
  });

  it("refuses an invalid record, naming the field and not its value", () => {
    // A locator that is not one of the three opaque schemes. Deliberately not
    // credential-shaped: this asserts the plain shape branch, and a secret in
    // the fixture would be reported as credential material instead — which is
    // correct behaviour, and a different test.
    const path = writeFixture(file([account({ authProfileRef: "https://example.invalid/p" })]));
    const refused = refusal(loadAccountsFile(path));
    expect(refused.reason).toBe("OWNER_FILE_INVALID");
    expect(refused.at).toBe("accounts[0].authProfileRef");
    expect(JSON.stringify(refused)).not.toContain("example.invalid");
  });

  it("enforces the contract's own cross-field rules", () => {
    // An account that needs reauthentication has no trustworthy quota reading.
    const path = writeFixture(file([account({ status: "AUTH_REQUIRED" })]));
    const refused = refusal(loadAccountsFile(path));
    expect(refused.reason).toBe("OWNER_FILE_INVALID");
    expect(refused.at).toBe("accounts[0].quotaEstimate.remainingRatio");
  });
});

describe("no byte of a credential ever leaves this boundary", () => {
  it("refuses a credential-shaped value with none of it in the refusal", () => {
    for (const secret of [SECRET_VALUE, SECRET_BEARER]) {
      const path = writeFixture(file([account({ alias: secret })]));
      const refused = refusal(loadAccountsFile(path));
      expect({ secret, reason: refused.reason }).toEqual({
        secret,
        reason: "OWNER_FILE_CREDENTIAL_MATERIAL",
      });
      expect(refused.at).toBe("accounts[0].alias");
      // The whole refusal, serialized. Not just the field a reader remembered.
      expect(JSON.stringify(refused)).not.toContain(secret);
    }
  });

  it("refuses a credential-shaped key on the open-key surface", () => {
    // `knownLimits` is a record with free keys, so it is the one place a
    // forbidden key reaches the contract's guard rather than the strict-object
    // check. The guard's message names the key; this refusal does not.
    const path = writeFixture(file([account({ knownLimits: { apiToken: 10 } })]));
    const refused = refusal(loadAccountsFile(path));
    expect(refused.reason).toBe("OWNER_FILE_CREDENTIAL_MATERIAL");
    expect(refused.at).toBe("accounts[0].knownLimits.apiToken");
  });

  it("refuses a transcript-shaped key on the same surface", () => {
    const path = writeFixture(file([account({ knownLimits: { messages: 10 } })]));
    const refused = refusal(loadAccountsFile(path));
    expect(refused.reason).toBe("OWNER_FILE_TRANSCRIPT_MATERIAL");
    expect(refused.at).toBe("accounts[0].knownLimits.messages");
  });

  it("reports the credential violation even when a shape error precedes it", () => {
    // Validators emit issues in their own order. A credential violation sitting
    // behind a missing-field complaint must not be reported as a shape problem.
    const path = writeFixture(
      file([account({ alias: SECRET_VALUE, knownLimits: { apiToken: 1 }, plan: "max" })]),
    );
    expect(refusal(loadAccountsFile(path)).reason).toBe("OWNER_FILE_CREDENTIAL_MATERIAL");
  });

  it("lets no marker escape through any refusal path", () => {
    // Ten ways to put credential-shaped text into the file. Every one of them
    // must be refused, and no refusal may carry a byte of it — including the
    // three where the marker arrives as a *key*. Two of those are where the
    // first draft of this loader leaked into the JSON path it reported; the
    // third, on the open-map surface, is where the first draft *admitted* the
    // record entirely.
    const marker = SECRET_VALUE;
    const bodies: readonly string[] = [
      "not json " + marker,
      JSON.stringify({ contractVersion: CONTRACT_VERSION, accounts: [], [marker]: 1 }),
      JSON.stringify({ contractVersion: marker, accounts: [] }),
      file([{ ...account(), [marker]: 1 }]),
      file([account({ alias: marker })]),
      file([account({ plan: marker })]),
      file([account({ lastClassifiedError: marker })]),
      file([account({ isolatedConfigRoot: marker })]),
      file([account({ enabledModels: [marker] })]),
      file([account({ knownLimits: { [marker]: 1 } })]),
    ];
    for (const body of bodies) {
      const path = writeFixture(body);
      const outcome = loadAccountsFile(path);
      const serialized = JSON.stringify(outcome);
      expect({ body: body.slice(0, 24), ok: outcome.ok }).toEqual({
        body: body.slice(0, 24),
        ok: false,
      });
      expect({ body: body.slice(0, 24), leaked: serialized.includes(marker) }).toEqual({
        body: body.slice(0, 24),
        leaked: false,
      });
      // And the refusal still says something useful.
      expect(serialized.length).toBeGreaterThan(20);
    }
  });

  it("refuses a secret-shaped key on the open-map surface", () => {
    // The one place a caller chooses the key. `findCredentialViolations` runs
    // its value patterns over string *values* and a stem match over *keys*, and
    // never the value patterns over a key name — so a key that is itself
    // live-credential-shaped passed the record's own guard. The loader now
    // makes the call its refusal path was always making, and the record is
    // refused rather than admitted into a registry that P5C, P5D and the P8 UI
    // will consume.
    //
    // The path leaks nothing: `safeSegment` renders the offending key `<key>`.
    const path = writeFixture(file([account({ knownLimits: { [SECRET_VALUE]: 1 } })]));
    const refused = refusal(loadAccountsFile(path));
    expect(refused).toEqual({
      ok: false,
      reason: "OWNER_FILE_CREDENTIAL_MATERIAL",
      at: "accounts[0].knownLimits.<key>",
    });
    expect(JSON.stringify(refused)).not.toContain(SECRET_VALUE);
  });

  it("still admits an ordinary open-map key", () => {
    // The correction is narrow: a limit name that is not credential-shaped is
    // untouched, so the guard cannot be mistaken for a ban on dynamic keys.
    const path = writeFixture(file([account({ knownLimits: { weeklyTokenBudget: 5, daily: 1 } })]));
    const outcome = loadAccountsFile(path);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.registry.get("acct-primary")?.knownLimits).toEqual({
      weeklyTokenBudget: 5,
      daily: 1,
    });
  });
});

describe("the package keeps its own laws", () => {
  const sources = ["errors.ts", "registry/index.ts", "index.ts"];

  function production(name: string): string {
    const path = name === "errors.ts" || name === "index.ts" ? join(HERE, "..", name) : join(HERE, "index.ts");
    return readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
  }

  it("reads no environment, not even HOME", () => {
    for (const name of sources) {
      const code = production(name);
      expect({ name, env: code.includes("process.env") }).toEqual({ name, env: false });
      expect({ name, home: code.includes("HOME") }).toEqual({ name, home: false });
    }
  });

  it("names no default owner-file path", () => {
    // The conventional location belongs in the README and the ADR, in prose,
    // where a reader can see it and no code can reach it.
    for (const name of sources) {
      const code = production(name);
      for (const token of ["accounts.local.json", ".rottay-agent-control-plane", "homedir"]) {
        expect({ name, token, present: code.includes(token) }).toEqual({
          name,
          token,
          present: false,
        });
      }
    }
  });

  it("appends nothing and spawns nothing", () => {
    for (const name of sources) {
      const code = production(name);
      for (const token of [".append(", "node:child_process", "writeFileSync", "mkdirSync", "rmSync"]) {
        expect({ name, token, present: code.includes(token) }).toEqual({
          name,
          token,
          present: false,
        });
      }
    }
  });

  it("declares a closed, sorted refusal set", () => {
    expect(Object.isFrozen(ACCOUNTS_REFUSALS)).toBe(true);
    expect([...ACCOUNTS_REFUSALS]).toEqual([...ACCOUNTS_REFUSALS].sort());
    expect(new Set(ACCOUNTS_REFUSALS).size).toBe(ACCOUNTS_REFUSALS.length);
  });

  it("declares exactly the two envelope keys", () => {
    expect([...ACCOUNTS_FILE_KEYS]).toEqual(["accounts", "contractVersion"]);
    expect(Object.isFrozen(ACCOUNTS_FILE_KEYS)).toBe(true);
  });

  it("leaves no fixture behind", () => {
    // The afterEach hook removes what each test made; this asserts the sweep
    // list is empty rather than trusting that it ran.
    expect(created).toEqual([]);
  });
});
