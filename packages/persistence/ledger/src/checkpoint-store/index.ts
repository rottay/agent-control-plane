import { Checkpoint } from "@acp/contracts";

import { artifactRootFor, publishArtifact, readArtifact } from "../artifact-store/index.js";
import type { ArtifactRefusal } from "../artifact-store/index.js";
import { canonicalJsonStringify } from "../canonical-json/index.js";

/**
 * The checkpoint store (V2-B1f/F3).
 *
 * Parse, canonically serialize, publish. Three verbs, in that order, and the
 * order is the whole design:
 *
 * 1. **Parse first.** The contract owns the 16 KiB budget and the credential
 *    guards, so an over-budget or credential-bearing checkpoint is refused by
 *    `Checkpoint` itself, before a byte is written. It also makes the artifact
 *    store's own 1 MiB `CONTENT_TOO_LARGE` unreachable from this path — a
 *    checkpoint that passed the smaller budget cannot fail the larger one.
 * 2. **Serialize canonically.** One value, one serialization, so a replayed
 *    walk assembles the same bytes and publishes to the same digest.
 * 3. **Publish, then let the caller append.** The event names the digest the
 *    store returned; the digest is never re-derived here or anywhere else. A
 *    publish that crashed before the append leaves an unreferenced artifact,
 *    which is correct and cheap because the store is content-addressed. The
 *    forbidden order — *"an event naming a digest the store does not hold"* —
 *    cannot arise, because nothing here appends.
 *
 * Idempotency is inherited rather than re-implemented: identical bytes publish
 * to the same digest with `written:false`, and unequal bytes under an existing
 * digest are refused, never overwritten.
 *
 * **The store neither observes nor assembles.** It is handed a source and asks
 * it for the checkpoint of one step. The source is where the facts come from,
 * and it is in the daemon and the drill children because that is where the
 * facts are; this package holds the bytes and the digest, which is what it has
 * always held.
 */

/** A refusal, in the artifact store's own shape. Never stored content. */
export interface CheckpointStoreRefused<TReason extends string> {
  readonly ok: false;
  readonly reason: TReason;
  readonly at: string;
}

export interface CheckpointStorePublished {
  readonly ok: true;
  readonly digest: string;
  readonly bytes: number;
}

export interface CheckpointStoreRead {
  readonly ok: true;
  readonly digest: string;
  readonly content: string;
}

/**
 * The step and the refusal vocabulary are the CALLER's, not this package's.
 *
 * `PlanStep` and the runtime's refusal names live in `@acp/runtime`, which sits
 * above this package and may never be imported from it. So both travel as type
 * parameters: the caller's own step type reaches its own source unchanged, and
 * whatever that source refuses is carried through verbatim rather than
 * translated into a second vocabulary that could disagree with the first.
 */
export function createCheckpointStore<TStep, TRefusal extends string>(input: {
  /** The opened ledger's path. The artifacts resolve as its sibling. */
  readonly ledgerPath: string;
  readonly source: {
    assemble(step: TStep): Checkpoint | CheckpointStoreRefused<TRefusal>;
  };
}): {
  persist(
    step: TStep,
  ):
    | CheckpointStorePublished
    | CheckpointStoreRefused<TRefusal | ArtifactRefusal | "CHECKPOINT_INVALID">;
  read(digest: string): CheckpointStoreRead | CheckpointStoreRefused<ArtifactRefusal>;
} {
  const root = (): string => artifactRootFor(input.ledgerPath);

  return {
    persist(step) {
      const assembled = input.source.assemble(step);
      // A `Checkpoint` is a strict object with no `ok` member, so the refusal
      // is discriminated by a key the success value cannot have.
      if ("ok" in assembled) return assembled;

      const parsed = Checkpoint.safeParse(assembled);
      if (!parsed.success) {
        return { ok: false, reason: "CHECKPOINT_INVALID", at: firstIssue(parsed.error.issues) };
      }

      const published = publishArtifact(root(), canonicalJsonStringify(parsed.data));
      if (!published.ok) return { ok: false, reason: published.reason, at: published.at };
      return { ok: true, digest: published.digest, bytes: published.byteLength };
    },

    /**
     * Read one back. **Declared for F5's rehydrate and not called by F3.**
     *
     * It is declared now rather than added later because a port whose reader
     * arrives in a different packet is a port two packets disagree about, and
     * the read side is the artifact store's own `readArtifact` — verifying on
     * the way out, so a corrupted object never travels under a name that says
     * it is something else.
     */
    read(digest) {
      const outcome = readArtifact(root(), digest);
      if (!outcome.ok) return { ok: false, reason: outcome.reason, at: outcome.at };
      return { ok: true, digest: outcome.digest, content: outcome.content };
    },
  };
}

/**
 * The contract's own words about what it refused, and nothing of the value.
 *
 * The message is zod's — for the budget case it is the `Checkpoint` schema's
 * own sentence naming the byte count and the budget — and the path names the
 * field. Neither carries the checkpoint's content, which is the property that
 * keeps a refusal from putting the bytes the budget exists to bound into a log
 * line.
 */
function firstIssue(issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[]): string {
  const issue = issues[0];
  if (issue === undefined) return "<checkpoint>";
  const where = issue.path.map((segment) => String(segment)).join(".");
  return where === "" ? issue.message : where + ": " + issue.message;
}
