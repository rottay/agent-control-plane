/**
 * Shared references — `@acp/contracts` (P8-T G6).
 *
 * The two reference shapes more than one contract needs: a path digest and an
 * artifact reference.
 *
 * Subdivided in place from the single `schemas/index.ts`, which is now a pure
 * re-export barrel. Nothing here was rewritten: the definitions are the file's
 * own, moved under the band heading they already carried.
 */

import { z } from "zod";
import { RepoRelativePath, Sha256Hex, Uuid } from "../primitives/index.js";

export const PathDigest = z.strictObject({
  path: RepoRelativePath,
  sha256: Sha256Hex,
});
export type PathDigest = z.infer<typeof PathDigest>;

export const ArtifactRef = z.strictObject({
  artifactId: Uuid,
  kind: z.enum(["DIFF", "LOG", "REPORT", "SCREENSHOT", "RECEIPT", "FIXTURE"]),
  sha256: Sha256Hex,
  byteSize: z.number().int().nonnegative().max(1_073_741_824),
  mediaType: z.string().max(100),
  label: z.string().max(200),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;
