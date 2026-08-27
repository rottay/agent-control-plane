#!/usr/bin/env node
/**
 * Explicit operator acquisition of the pinned Restate server binary.
 *
 * This is never a lifecycle hook. `pnpm install`, `pnpm check` and `pnpm test`
 * do not reach it, and nothing downloads at import time: the network call is
 * guarded behind an entry-point check, exactly as the supervisor child guards
 * its run.
 *
 * The whole file exists because the alternative was worse. The npm package
 * `@restatedev/restate-server` depends on `@scarf/scarf`, whose postinstall is
 * a network beacon, and this repository turns install scripts off precisely so
 * nothing phones home while being installed. Rather than adopt a dependency
 * whose build must be declined forever, the server is fetched once, verified
 * against a tracked digest, and unpacked into an ignored local root.
 *
 * Refusals, all of them fail-closed and all of them tested without network:
 *
 * - an unsupported platform;
 * - an absent or placeholder pin (never trust-on-first-use);
 * - an initial URL that is not the exact pinned asset URL;
 * - a redirect that is not exactly one hop, HTTPS, to the one permitted GitHub
 *   release CDN host, with no credentials in it;
 * - a digest that does not match the pin;
 * - an archive containing an absolute path, a parent traversal, a symlink or a
 *   hard link;
 * - a binary already present that no receipt vouches for.
 *
 * Nothing partial survives a failure.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");
export const DEFAULT_PIN_PATH = join(REPO_ROOT, "scripts", "restate-server.pin.json");
export const TOOLS_ROOT = join(REPO_ROOT, ".acp-local", "tools");

/** The only platforms this pin file is allowed to describe. */
const SUPPORTED_PLATFORMS = new Set(["darwin-arm64"]);

/** A digest that has not been established yet. Refused, never fetched. */
const PLACEHOLDER_DIGESTS = new Set(["UNPINNED", "", "TBD"]);

const SHA256_HEX = /^[0-9a-f]{64}$/;

export class AcquisitionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AcquisitionError";
  }
}

export function platformKey(platform = process.platform, arch = process.arch) {
  return platform + "-" + arch;
}

/** Read and validate the pin. A malformed pin is a refusal, not a warning. */
export function readPin(pinPath = DEFAULT_PIN_PATH, key = platformKey()) {
  if (!existsSync(pinPath)) {
    throw new AcquisitionError("no pin file at " + pinPath + "; refusing to fetch anything");
  }
  let pin;
  try {
    pin = JSON.parse(readFileSync(pinPath, "utf8"));
  } catch {
    throw new AcquisitionError("the pin file is not valid JSON");
  }

  if (!SUPPORTED_PLATFORMS.has(key)) {
    throw new AcquisitionError(
      "unsupported platform " + key + "; this pin supports " + [...SUPPORTED_PLATFORMS].join(", "),
    );
  }
  const entry = pin?.platforms?.[key];
  if (entry === undefined) {
    throw new AcquisitionError("the pin file describes no platform " + key);
  }
  if (typeof entry.sha256 !== "string" || PLACEHOLDER_DIGESTS.has(entry.sha256)) {
    throw new AcquisitionError(
      "the pin for " + key + " carries no established digest; record it under review" +
        " and re-run. There is no trust-on-first-use here",
    );
  }
  if (!SHA256_HEX.test(entry.sha256)) {
    throw new AcquisitionError("the pinned digest is not 64 lowercase hex characters");
  }
  if (typeof entry.binarySha256 !== "string" || PLACEHOLDER_DIGESTS.has(entry.binarySha256)) {
    throw new AcquisitionError(
      "the pin for " + key + " carries no established BINARY digest; pinning only" +
        " the archive would leave the extracted binary attested by nothing but" +
        " its own receipt",
    );
  }
  if (!SHA256_HEX.test(entry.binarySha256)) {
    throw new AcquisitionError("the pinned binary digest is not 64 lowercase hex characters");
  }
  if (typeof entry.url !== "string" || typeof entry.asset !== "string") {
    throw new AcquisitionError("the pin entry is missing its url or asset name");
  }
  return { pin, entry, key };
}

/**
 * The initial request must be the exact pinned URL.
 *
 * Not "a github.com URL". The one string in the tracked pin, over HTTPS, with
 * no credentials. Anything else is somebody else's download.
 */
export function assertInitialUrl(url, pin, entry) {
  const parsed = safeUrl(url);
  if (parsed.protocol !== "https:") throw new AcquisitionError("the asset URL must be HTTPS");
  if (parsed.username !== "" || parsed.password !== "") {
    throw new AcquisitionError("the asset URL must carry no credentials");
  }
  if (parsed.hostname !== pin.assetHost) {
    throw new AcquisitionError(
      "the asset URL host must be exactly " + pin.assetHost + ", found " + parsed.hostname,
    );
  }
  if (!parsed.pathname.startsWith(pin.assetPathPrefix)) {
    throw new AcquisitionError("the asset URL path is outside the pinned release path");
  }
  if (url !== entry.url) {
    throw new AcquisitionError("the request URL is not byte-identical to the pinned URL");
  }
}

/**
 * Exactly one redirect, to exactly one host.
 *
 * GitHub's browser asset URL legitimately redirects to its release CDN, so a
 * blanket redirect refusal would refuse the real download. One hop, HTTPS, that
 * one hostname, no credentials, and no second hop.
 */
export function assertRedirect(location, pin, hopIndex) {
  if (hopIndex > 1) {
    throw new AcquisitionError("more than one redirect; the pinned asset needs exactly one");
  }
  const parsed = safeUrl(location);
  if (parsed.protocol !== "https:") {
    throw new AcquisitionError("a redirect must stay on HTTPS, found " + parsed.protocol);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new AcquisitionError("a redirect carrying credentials is refused");
  }
  if (parsed.hostname !== pin.redirectHost) {
    throw new AcquisitionError(
      "a redirect may only reach " + pin.redirectHost + ", found " + parsed.hostname,
    );
  }
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    throw new AcquisitionError("not a usable absolute URL");
  }
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Refuse an archive that could write outside where it is unpacked.
 *
 * Listed before it is extracted, because `tar` will happily follow an absolute
 * path or a link if it is asked to.
 */
export function assertArchiveEntriesSafe(entries) {
  for (const entry of entries) {
    const { name, type } = entry;
    if (name.startsWith("/")) {
      throw new AcquisitionError("archive entry is an absolute path: " + name);
    }
    if (name.split("/").includes("..")) {
      throw new AcquisitionError("archive entry contains a parent traversal: " + name);
    }
    if (type === "l" || type === "h") {
      throw new AcquisitionError("archive entry is a link, which is refused: " + name);
    }
  }
}

/** Parse `tar -tvf` output into `{name, type}` records. */
export function parseTarListing(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const type = trimmed[0] === "d" ? "d" : trimmed[0] === "l" ? "l" : trimmed[0] === "h" ? "h" : "f";
    // The name is everything after the timestamp column group; tar prints
    // "-rw-r--r--  0 user group  123 Jan  1 00:00 path".
    const match = /\d{2}:\d{2}\s+(.+)$/.exec(trimmed) ?? /\s(\S+)$/.exec(trimmed);
    const name = match === null ? trimmed : match[1];
    // A symlink line ends with "link -> target"; keep only the link name.
    entries.push({ name: name.split(" -> ")[0], type });
  }
  return entries;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw new AcquisitionError(command + " failed: " + result.error.message);
  return result;
}

export function installRoot(pin) {
  return join(TOOLS_ROOT, "restate-server-" + pin.version);
}

export function receiptPath(pin) {
  return join(installRoot(pin), "verification-receipt.json");
}

export function binaryPath(pin) {
  return join(installRoot(pin), "restate-server");
}

/**
 * Is a verified binary already installed?
 *
 * A binary with no receipt, or whose digest no longer matches its receipt, is
 * treated as unverified and refused rather than used.
 *
 * `entry` and `key` are required, and deliberately have no defaults. A default
 * of `null` made the pin comparison below conditional, so the one caller that
 * omitted the argument silently fell back to checking the binary against its
 * own receipt — which is what a substituted binary would also carry. Refusing
 * outright means that hole cannot be reopened by omission.
 */
export function inspectInstalled(pin, entry, key) {
  if (entry === undefined || entry === null || typeof key !== "string" || key.length === 0) {
    return {
      state: "UNVERIFIED",
      reason: "no tracked pin entry was supplied, so the binary would attest to itself",
    };
  }
  const binary = binaryPath(pin);
  const receipt = receiptPath(pin);
  if (!existsSync(binary)) return { state: "ABSENT" };
  if (!existsSync(receipt)) return { state: "UNVERIFIED", reason: "no verification receipt" };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(receipt, "utf8"));
  } catch {
    return { state: "UNVERIFIED", reason: "unreadable receipt" };
  }

  // The receipt must agree with the tracked pin, field by field. Without this
  // the receipt is only self-consistent, and a substituted binary shipped with
  // a matching receipt would look verified.
  const expectations = [
    ["version", pin.version],
    ["platform", key],
    ["asset", entry.asset],
    ["url", entry.url],
    ["archiveSha256", entry.sha256],
    ["binarySha256", entry.binarySha256],
  ];
  for (const [field, expected] of expectations) {
    if (parsed[field] !== expected) {
      return {
        state: "UNVERIFIED",
        reason: "the receipt's " + field + " does not match the tracked pin",
      };
    }
  }

  const actual = sha256File(binary);
  if (parsed.binarySha256 !== actual) {
    return { state: "UNVERIFIED", reason: "binary digest does not match its receipt" };
  }
  if (actual !== entry.binarySha256) {
    return { state: "UNVERIFIED", reason: "the installed binary does not match the tracked pin" };
  }
  return { state: "VERIFIED", receipt: parsed };
}

function fail(message) {
  process.stderr.write("acquire-restate-server: " + message + "\n");
  process.exitCode = 1;
}

async function download(entry, pin, destination) {
  assertInitialUrl(entry.url, pin, entry);

  let url = entry.url;
  let response = null;
  for (let hop = 0; hop <= 1; hop += 1) {
    response = await fetch(url, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) throw new AcquisitionError("a redirect carried no location");
      assertRedirect(location, pin, hop + 1);
      url = location;
      continue;
    }
    break;
  }
  if (response === null || !response.ok) {
    throw new AcquisitionError("the asset request failed with status " + String(response?.status));
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(destination, bytes, { mode: 0o600 });
}

export async function acquire({ verifyOnly = false, pinPath = DEFAULT_PIN_PATH } = {}) {
  const { pin, entry, key } = readPin(pinPath);
  const installed = inspectInstalled(pin, entry, key);

  process.stdout.write("platform: " + key + "\n");
  process.stdout.write("expected sha256: " + entry.sha256 + "\n");
  process.stdout.write("installed: " + installed.state + "\n");

  if (installed.state === "VERIFIED") {
    process.stdout.write("already verified at " + binaryPath(pin) + "\n");
    return { state: "VERIFIED", binary: binaryPath(pin) };
  }
  if (installed.state === "UNVERIFIED") {
    throw new AcquisitionError(
      "a binary is present but unverified (" + installed.reason + "); remove " +
        installRoot(pin) + " and re-run rather than trusting it",
    );
  }
  if (verifyOnly) {
    throw new AcquisitionError("no verified binary is installed and --verify-only will not fetch");
  }

  mkdirSync(TOOLS_ROOT, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(TOOLS_ROOT, ".staging-"));
  const archive = join(staging, entry.asset);

  try {
    await download(entry, pin, archive);

    const actual = sha256File(archive);
    process.stdout.write("actual   sha256: " + actual + "\n");
    if (actual !== entry.sha256) {
      throw new AcquisitionError(
        "digest mismatch: expected " + entry.sha256 + " but the download hashed to " + actual,
      );
    }

    const listing = run("tar", ["-tvf", archive]);
    if (listing.status !== 0) throw new AcquisitionError("could not list the archive");
    assertArchiveEntriesSafe(parseTarListing(listing.stdout));

    const unpacked = join(staging, "unpacked");
    mkdirSync(unpacked, { recursive: true, mode: 0o700 });
    const extract = run("tar", ["-xf", archive, "-C", unpacked, "--no-same-owner"]);
    if (extract.status !== 0) {
      throw new AcquisitionError("extraction failed: " + extract.stderr);
    }

    const found = findBinary(unpacked, "restate-server");
    if (found === null) throw new AcquisitionError("the archive contained no restate-server binary");

    const target = installRoot(pin);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const finalDir = join(staging, "final");
    mkdirSync(finalDir, { recursive: true, mode: 0o700 });
    renameSync(found, join(finalDir, "restate-server"));

    const binarySha256 = sha256File(join(finalDir, "restate-server"));
    writeFileSync(
      join(finalDir, "verification-receipt.json"),
      JSON.stringify(
        {
          version: pin.version,
          platform: key,
          asset: entry.asset,
          url: entry.url,
          archiveSha256: actual,
          binarySha256,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );

    // Atomic: the install root appears complete or not at all.
    renameSync(finalDir, target);
    process.stdout.write("binary   sha256: " + binarySha256 + "\n");
    process.stdout.write("installed at: " + binaryPath(pin) + "\n");
    return { state: "VERIFIED", binary: binaryPath(pin), archiveSha256: actual, binarySha256 };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function findBinary(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findBinary(candidate, name);
      if (nested !== null) return nested;
      continue;
    }
    if (entry.name === name && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const invoked = process.argv[1];
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  const verifyOnly = process.argv.includes("--verify-only");
  const pinFlag = process.argv.find((argument) => argument.startsWith("--pin="));
  const pinPath = pinFlag === undefined ? DEFAULT_PIN_PATH : resolve(pinFlag.slice("--pin=".length));
  acquire({ verifyOnly, pinPath }).catch((error) => {
    fail(error instanceof Error ? error.message : "unknown failure");
  });
}

export { sep };
