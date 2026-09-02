import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApiError } from "@acp/protocol";
import { openLedger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { loadBearerGuard } from "../../src/bearer/index.js";
import { buildServer } from "../../src/build-server/index.js";

/**
 * Evidence for the write door's bearer (P8-8G).
 *
 * Two properties matter here and neither can be mocked into existence: that an
 * unconfigured door is **shut**, and that the token never appears anywhere a
 * caller can see. Both are driven against a real server over real files.
 */

const roots: string[] = [];
const TOKEN = "p8-8g-" + "a".repeat(40);
const INITIATIVE = "44444444-4444-4444-8444-444444444444";

function root(): string {
  // Canonical: the loader refuses a non-canonical path, and on macOS
  // `mkdtemp` hands back the uncanonical `/var/...` form.
  const created = realpathSync(mkdtempSync(join(tmpdir(), "acp-bearer-")));
  roots.push(created);
  return created;
}

function tokenFile(dir: string, contents = TOKEN + "\n", mode = 0o600): string {
  const path = join(dir, "write.token");
  writeFileSync(path, contents, "utf8");
  chmodSync(path, mode);
  return path;
}

/** A real, created ledger: reads answer 200 rather than 503. */
function ledgerPath(dir: string): string {
  const nested = join(dir, "ledger");
  mkdirSync(nested, { recursive: true });
  const path = join(nested, "acp.sqlite3");
  openLedger(path).close();
  return path;
}

const WRITE_URL = "/api/v1/initiatives/" + INITIATIVE + "/roadmap";

afterEach(() => {
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // already gone
    }
  }
});

describe("the loader's ladder, on the accounts loader's own rungs", () => {
  it("accepts a canonical, owned, 0600 token file", () => {
    const dir = root();
    const outcome = loadBearerGuard(tokenFile(dir));
    expect(outcome.ok).toBe(true);
  });

  it("refuses every rung, each by its own name", () => {
    const dir = root();
    expect(loadBearerGuard(undefined)).toEqual({ ok: false, reason: "PATH_NOT_SUPPLIED" });
    expect(loadBearerGuard("")).toEqual({ ok: false, reason: "PATH_NOT_SUPPLIED" });
    expect(loadBearerGuard("relative/token")).toEqual({ ok: false, reason: "PATH_NOT_ABSOLUTE" });
    expect(loadBearerGuard(join(dir, "absent.token"))).toEqual({
      ok: false,
      reason: "TOKEN_FILE_ABSENT",
    });
    expect(loadBearerGuard(dir)).toEqual({ ok: false, reason: "TOKEN_FILE_NOT_REGULAR" });

    // World-readable. A credential anyone can read has already failed at the
    // only thing it is for.
    const loose = tokenFile(root(), TOKEN + "\n", 0o644);
    expect(loadBearerGuard(loose)).toEqual({
      ok: false,
      reason: "TOKEN_FILE_UNSAFE_PERMISSIONS",
    });

    // A file of whitespace is not a token, and must not become the empty
    // string that matches an empty presented value.
    const blank = tokenFile(root(), "   \n\n");
    expect(loadBearerGuard(blank)).toEqual({ ok: false, reason: "TOKEN_FILE_EMPTY" });

    const huge = tokenFile(root(), "z".repeat(5000));
    expect(loadBearerGuard(huge)).toEqual({ ok: false, reason: "TOKEN_FILE_TOO_LARGE" });
  });

  it("takes the token as the line, not the file", () => {
    // An editor's trailing newline is not part of the credential.
    const outcome = loadBearerGuard(tokenFile(root(), TOKEN + "\n\n"));
    if (!outcome.ok) throw new Error("expected a guard");
    expect(outcome.guard.accepts("Bearer " + TOKEN)).toBe(true);
  });
});

describe("the guard compares without leaking", () => {
  it("accepts the right token and refuses everything else", () => {
    const outcome = loadBearerGuard(tokenFile(root()));
    if (!outcome.ok) throw new Error("expected a guard");
    const { guard } = outcome;

    expect(guard.accepts("Bearer " + TOKEN)).toBe(true);
    // The scheme is case-insensitive, as RFC 7235 requires.
    expect(guard.accepts("bearer " + TOKEN)).toBe(true);
    expect(guard.accepts("BEARER " + TOKEN)).toBe(true);

    expect(guard.accepts(undefined)).toBe(false);
    expect(guard.accepts("")).toBe(false);
    expect(guard.accepts(TOKEN)).toBe(false); // no scheme
    expect(guard.accepts("Basic " + TOKEN)).toBe(false); // wrong scheme
    expect(guard.accepts("Bearer ")).toBe(false);
    expect(guard.accepts("Bearer " + TOKEN + "x")).toBe(false);
    // A prefix must not pass: the comparison is over digests, not prefixes.
    expect(guard.accepts("Bearer " + TOKEN.slice(0, -1))).toBe(false);
  });

  it("holds a digest, not the token — there is nothing on it to leak", () => {
    const outcome = loadBearerGuard(tokenFile(root()));
    if (!outcome.ok) throw new Error("expected a guard");
    // Serialising the guard cannot produce the secret, because the secret is
    // not a property of it. "Nothing to log" is a stronger property than
    // "we are careful not to log it".
    expect(JSON.stringify(outcome.guard)).not.toContain(TOKEN);
    expect(Object.values(outcome.guard).join("|")).not.toContain(TOKEN);
  });
});

describe("the door, per state", () => {
  it("unconfigured: every write answers 403, and says whose problem it is", async () => {
    const dir = root();
    const app = buildServer({ ledgerPath: ledgerPath(dir) });
    const response = await app.inject({ method: "POST", url: WRITE_URL, payload: {} });

    // Fail-closed. Not 401: a caller cannot fix this with a better header, so
    // inviting a retry would send it round a loop that cannot end.
    expect(response.statusCode).toBe(403);
    expect(ApiError.parse(response.json()).error.code).toBe("WRITE_BEARER_UNCONFIGURED");
    await app.close();
  });

  it("configured, no header: 401", async () => {
    const dir = root();
    const app = buildServer({ ledgerPath: ledgerPath(dir), writeBearerPath: tokenFile(dir) });
    const response = await app.inject({ method: "POST", url: WRITE_URL, payload: {} });
    expect(response.statusCode).toBe(401);
    expect(ApiError.parse(response.json()).error.code).toBe("AUTH_REQUIRED");
    await app.close();
  });

  it("configured, wrong token: 401 — the same answer as no header", async () => {
    const dir = root();
    const app = buildServer({ ledgerPath: ledgerPath(dir), writeBearerPath: tokenFile(dir) });
    const response = await app.inject({
      method: "POST",
      url: WRITE_URL,
      payload: {},
      headers: { authorization: "Bearer " + randomUUID() },
    });
    // Deliberately indistinguishable from the missing-header case: telling
    // them apart would confirm to an unauthenticated caller that a header it
    // guessed had the right shape.
    expect(response.statusCode).toBe(401);
    expect(ApiError.parse(response.json()).error.code).toBe("AUTH_REQUIRED");
    await app.close();
  });

  it("configured, right token: the guard is passed and the handler answers", async () => {
    const dir = root();
    const app = buildServer({ ledgerPath: ledgerPath(dir), writeBearerPath: tokenFile(dir) });
    const response = await app.inject({
      method: "POST",
      url: WRITE_URL,
      payload: {},
      headers: { authorization: "Bearer " + TOKEN },
    });
    // Past the guard. What the handler then says is its own business — here a
    // 404, because the initiative is invented — and the point is only that a
    // handler answered at all: neither of the guard's two refusals appears.
    expect(response.statusCode).not.toBe(401);
    expect(response.statusCode).not.toBe(403);
    const code = ApiError.parse(response.json()).error.code;
    expect(code).not.toBe("AUTH_REQUIRED");
    expect(code).not.toBe("WRITE_BEARER_UNCONFIGURED");
    await app.close();
  });
});

describe("reads are never guarded, and that is the design", () => {
  it("answers every read with no credential at all", async () => {
    const dir = root();
    const app = buildServer({ ledgerPath: ledgerPath(dir), writeBearerPath: tokenFile(dir) });
    for (const url of ["/api/v1/health", "/api/v1/initiatives", "/api/v1/accounts"]) {
      const response = await app.inject({ method: "GET", url });
      expect({ url, status: response.statusCode }).toEqual({ url, status: 200 });
    }
    // Even the write route's own GET half: the asymmetry is per method, not
    // per route.
    const readHalf = await app.inject({ method: "GET", url: WRITE_URL });
    expect(readHalf.statusCode).not.toBe(401);
    expect(readHalf.statusCode).not.toBe(403);
    await app.close();
  });
});

describe("the token appears on no surface a caller can see", () => {
  it("is absent from every response the door produces", async () => {
    const dir = root();
    const app = buildServer({ ledgerPath: ledgerPath(dir), writeBearerPath: tokenFile(dir) });

    const surfaces: string[] = [];
    for (const attempt of [
      { headers: undefined },
      { headers: { authorization: "Bearer wrong-" + TOKEN } },
      { headers: { authorization: "Bearer " + TOKEN } },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: WRITE_URL,
        payload: {},
        ...(attempt.headers === undefined ? {} : { headers: attempt.headers }),
      });
      surfaces.push(response.body, JSON.stringify(response.headers));
    }
    for (const url of ["/api/v1/health", "/api/v1/initiatives", "/api/v1/accounts"]) {
      const response = await app.inject({ method: "GET", url });
      surfaces.push(response.body, JSON.stringify(response.headers));
    }

    const all = surfaces.join("\n");
    expect(all).not.toContain(TOKEN);
    // Not even the prefix that would confirm the token's shape.
    expect(all).not.toContain("p8-8g-");
    await app.close();
  });
});
