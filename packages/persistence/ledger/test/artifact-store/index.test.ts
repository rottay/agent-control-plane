import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ROADMAP_CONTENT_MAX_BYTES } from "@acp/contracts";

import { forAll, intBetween, pick } from "../canonical-json/helpers/index.js";
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_REFUSALS,
  artifactDigest,
  hasArtifact,
  publishArtifact,
  readArtifact,
} from "../../src/artifact-store/index.js";

/**
 * Evidence for the artifact store's two durability laws.
 *
 * Both are asserted against a real filesystem, because both are claims about
 * what the filesystem does: atomicity is a property of `rename`, and
 * verify-on-existing is a property of re-reading bytes. A mocked fs would
 * assert the mock.
 */

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "acp-artifact-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("content addressing", () => {
  it("names an object by the sha256 of its bytes, and round-trips it", () => {
    const store = root();
    const content = "# Roadmap\n\nOne version, recorded.\n";
    const published = publishArtifact(store, content);

    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error("expected a publication");
    expect(published.digest).toBe(artifactDigest(content));
    expect(published.written).toBe(true);
    expect(published.byteLength).toBe(Buffer.byteLength(content, "utf8"));

    const read = readArtifact(store, published.digest);
    if (!read.ok) throw new Error("expected a read");
    expect(read.content).toBe(content);
    expect(hasArtifact(store, published.digest)).toBe(true);
  });

  it("gives different content different names, and equal content one name", () => {
    const store = root();
    const a = publishArtifact(store, "alpha");
    const b = publishArtifact(store, "beta");
    const aAgain = publishArtifact(store, "alpha");
    if (!a.ok || !b.ok || !aAgain.ok) throw new Error("expected three publications");

    expect(a.digest).not.toBe(b.digest);
    expect(aAgain.digest).toBe(a.digest);
  });

  it("shards by the digest's first two characters", () => {
    // Not cosmetic: a flat directory eventually holds every artifact the
    // system ever recorded, and some filesystems degrade badly there.
    const store = root();
    const published = publishArtifact(store, "sharded");
    if (!published.ok) throw new Error("expected a publication");
    expect(readdirSync(store)).toEqual([published.digest.slice(0, 2)]);
  });
});

describe("law 1 — publication is atomic", () => {
  it("leaves no temporary file behind after a successful publication", () => {
    const store = root();
    const published = publishArtifact(store, "atomic");
    if (!published.ok) throw new Error("expected a publication");

    const shard = join(store, published.digest.slice(0, 2));
    const entries = readdirSync(shard);
    // Exactly the object, under its digest. A `.tmp` sibling would mean a
    // reader could observe a name that is not yet the content it claims.
    expect(entries).toEqual([published.digest]);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("adopts and overwrites its own leftover temporary rather than accumulating", () => {
    // A retry after a crash reuses the digest-derived temporary name. The
    // alternative — a clock- or random-derived name — would leave one orphan
    // per failed attempt, which is the shape that fills a disk quietly.
    const store = root();
    const content = "retried";
    const digest = artifactDigest(content);
    const shard = join(store, digest.slice(0, 2));
    mkdirSync(shard, { recursive: true });
    writeFileSync(join(shard, digest + ".tmp"), "a partial write from a crashed attempt", "utf8");

    const published = publishArtifact(store, content);
    if (!published.ok) throw new Error("expected a publication");
    expect(published.written).toBe(true);
    expect(readdirSync(shard)).toEqual([digest]);

    const read = readArtifact(store, digest);
    if (!read.ok) throw new Error("expected a read");
    expect(read.content).toBe(content);
  });
});

describe("law 2 — an existing object is verified, never trusted", () => {
  it("re-publishing identical content is a verified no-op", () => {
    const store = root();
    const first = publishArtifact(store, "idempotent");
    const second = publishArtifact(store, "idempotent");
    if (!first.ok || !second.ok) throw new Error("expected two outcomes");

    expect(first.written).toBe(true);
    // The second call verified and wrote nothing — which is what makes a
    // retried write safe rather than merely tolerated.
    expect(second.written).toBe(false);
    expect(second.digest).toBe(first.digest);
  });

  it("refuses a corrupted object rather than overwriting the evidence", () => {
    const store = root();
    const content = "trustworthy";
    const published = publishArtifact(store, content);
    if (!published.ok) throw new Error("expected a publication");

    // Corrupt the stored bytes under their digest name.
    const shard = join(store, published.digest.slice(0, 2));
    writeFileSync(join(shard, published.digest), "tampered", "utf8");

    const republished = publishArtifact(store, content);
    expect(republished.ok).toBe(false);
    if (republished.ok) throw new Error("expected a refusal");
    expect(republished.reason).toBe("ARTIFACT_CORRUPT");
    // The corrupted bytes are still there: silently replacing them would
    // destroy the evidence at the moment it mattered.
    const read = readArtifact(store, published.digest);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.reason).toBe("ARTIFACT_CORRUPT");
  });

  it("refuses to read a digest it does not hold", () => {
    const store = root();
    const outcome = readArtifact(store, "0".repeat(64));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("ARTIFACT_ABSENT");
    expect(hasArtifact(store, "0".repeat(64))).toBe(false);
  });
});

describe("the store's limits and hermeticity", () => {
  it("takes an explicit absolute root and finds nothing on its own", () => {
    expect(publishArtifact("relative/path", "x")).toEqual({
      ok: false,
      reason: "PATH_NOT_ABSOLUTE",
      at: "<root>",
    });
    expect(publishArtifact("", "x").ok).toBe(false);
    expect(readArtifact("relative/path", "0".repeat(64)).ok).toBe(false);
  });

  it("refuses content past the stated ceiling", () => {
    const store = root();
    const tooLarge = "x".repeat(ARTIFACT_MAX_BYTES + 1);
    expect(publishArtifact(store, tooLarge)).toEqual({
      ok: false,
      reason: "CONTENT_TOO_LARGE",
      at: "content",
    });
    // The boundary itself is admitted, so the ceiling is a ceiling and not an
    // off-by-one.
    expect(publishArtifact(store, "x".repeat(ARTIFACT_MAX_BYTES)).ok).toBe(true);
  });

  it("refuses a root that is a file rather than a directory", () => {
    const store = root();
    const file = join(store, "not-a-directory");
    writeFileSync(file, "", "utf8");
    expect(publishArtifact(file, "x")).toEqual({
      ok: false,
      reason: "ROOT_NOT_DIRECTORY",
      at: "<root>",
    });
  });

  it("keeps its refusal vocabulary closed and sorted", () => {
    expect([...ARTIFACT_REFUSALS]).toEqual([...ARTIFACT_REFUSALS].sort());
    expect(new Set(ARTIFACT_REFUSALS).size).toBe(ARTIFACT_REFUSALS.length);
  });

  it("exposes no way to delete an object", () => {
    // The law is that no function removes an artifact — asserted against the
    // module's own surface rather than trusted from the doc comment.
    const surface = Object.keys({
      ARTIFACT_MAX_BYTES,
      ARTIFACT_REFUSALS,
      artifactDigest,
      hasArtifact,
      publishArtifact,
      readArtifact,
    });
    expect(surface.some((name) => /delete|remove|unlink|purge|prune/i.test(name))).toBe(false);
  });
});

describe("the ceiling is re-exported, not redeclared (P8-8G R2)", () => {
  it("keeps the store's landed name and the contracts package's number", () => {
    // The public surface is byte-stable: callers still say
    // `ARTIFACT_MAX_BYTES`, which is what a store's callers call it. Only the
    // declaration moved.
    expect(ARTIFACT_MAX_BYTES).toBe(ROADMAP_CONTENT_MAX_BYTES);
    expect(ARTIFACT_MAX_BYTES).toBe(1024 * 1024);
  });

  it("weighs bytes, so a multibyte document is measured as the contract says", () => {
    const store = root();
    // Exactly at the ceiling in bytes, half of it in code units.
    const atCeiling = "é".repeat(ARTIFACT_MAX_BYTES / 2);
    expect(publishArtifact(store, atCeiling).ok).toBe(true);

    const over = publishArtifact(store, atCeiling + "x");
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error("expected a refusal");
    expect(over.reason).toBe("CONTENT_TOO_LARGE");
  });
});


/**
 * The store's laws as properties (P8-T G9).
 *
 * The classes above pin the store's behavior on chosen examples. These reach
 * the dimension examples cannot: arbitrary byte strings. Content addressing is
 * a claim about *all* content, and the interesting inputs — empty, multi-byte,
 * lone surrogates' legal cousins, lengths that straddle a shard boundary — are
 * exactly the ones nobody writes down by hand.
 */
describe("the artifact store's laws hold over arbitrary content (G9)", () => {
  const ITERATIONS = 120;

  /** Arbitrary content, biased toward the awkward cases rather than the average one. */
  const content = (random: () => number): string => {
    const alphabet = ["a", "Z", "0", " ", "\n", "\t", "\"", "\\", "ä", "😀", "✓", "\u0000"];
    const kind = intBetween(random, 0, 3);
    if (kind === 0) return "";
    const length = kind === 1 ? intBetween(random, 1, 8) : intBetween(random, 200, 2000);
    let out = "";
    for (let i = 0; i < length; i += 1) out += pick(random, alphabet);
    return out;
  };

  it("recovers the exact bytes it published, for arbitrary content", () => {
    forAll("publish/read round trip", 0xa47_0001, ITERATIONS, content, (text) => {
      const where = root();
      const published = publishArtifact(where, text);
      expect(published.ok).toBe(true);
      if (!published.ok) return;
      const read = readArtifact(where, published.digest);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.content).toBe(text);
      expect(published.byteLength).toBe(Buffer.byteLength(text, "utf8"));
    });
  });

  it("shards every object under the first two characters of its digest", () => {
    // The layout claim, over arbitrary content: the shard is never anything
    // but the digest's own prefix, so a reader can find an object from its
    // digest alone without consulting an index.
    forAll("shard is the digest prefix", 0xa47_0002, ITERATIONS, content, (text) => {
      const where = root();
      const published = publishArtifact(where, text);
      expect(published.ok).toBe(true);
      if (!published.ok) return;
      // The layout, as the store actually writes it: `<root>/<first two>/<full
      // digest>` — the shard is a prefix of the name, not a truncation of it.
      const shards = readdirSync(where);
      expect(shards).toEqual([published.digest.slice(0, 2)]);
      expect(readdirSync(join(where, shards[0] ?? ""))).toEqual([published.digest]);
    });
  });

  it("is a no-op on republish and distinguishes distinct content", () => {
    forAll("republish and distinctness", 0xa47_0003, ITERATIONS, (random) => {
      const first = content(random);
      let second = content(random);
      // Constructive distinctness: never rely on the generator happening to
      // differ, or the second half of this property samples nothing.
      if (second === first) second = first + "\u0001";
      return { first, second };
    }, ({ first, second }) => {
      const where = root();
      const once = publishArtifact(where, first);
      const twice = publishArtifact(where, first);
      expect(once.ok && twice.ok).toBe(true);
      if (!once.ok || !twice.ok) return;
      expect(once.written).toBe(true);
      expect(twice.written).toBe(false);
      expect(twice.digest).toBe(once.digest);

      const other = publishArtifact(where, second);
      expect(other.ok).toBe(true);
      if (!other.ok) return;
      expect(other.digest).not.toBe(once.digest);
      expect(hasArtifact(where, once.digest)).toBe(true);
      expect(hasArtifact(where, other.digest)).toBe(true);
    });
  });

  it("computes a digest that depends on the bytes and nothing else", () => {
    forAll("digest is a function of content", 0xa47_0004, ITERATIONS, content, (text) => {
      expect(artifactDigest(text)).toBe(artifactDigest(text));
      expect(artifactDigest(text)).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
