/**
 * Worker identity — `@acp/contracts` (P8-T G6).
 *
 * `<provider>/<model>/<role>/<instance>` — the identity grammar and its parser.
 *
 * Subdivided in place from the single `schemas/index.ts`, which is now a pure
 * re-export barrel. Nothing here was rewritten: the definitions are the file's
 * own, moved under the band heading they already carried.
 */

import { z } from "zod";

/**
 * Control plane roles. Roles are a control plane concept and therefore closed.
 * Providers and models are open, because the roadmap forbids assuming that
 * current model preferences are permanent.
 */
export const WORKER_ROLES = [
  "coordinator",
  "implementer",
  "reviewer",
  "consultant",
  "verifier",
] as const;

export const WorkerRole = z.enum(WORKER_ROLES);
export type WorkerRole = z.infer<typeof WorkerRole>;

const IDENTITY_SEGMENT = "[a-z0-9][a-z0-9._-]*";

/** Canonical identity string: <provider>/<model>/<role>/<instance>. */
export const WORKER_IDENTITY_PATTERN = new RegExp(
  "^(" +
    IDENTITY_SEGMENT +
    ")/(" +
    IDENTITY_SEGMENT +
    ")/(" +
    WORKER_ROLES.join("|") +
    ")/([0-9]{2,4})$",
);

export const WorkerIdentityString = z
  .string()
  .regex(
    WORKER_IDENTITY_PATTERN,
    "identity must be <provider>/<model>/<role>/<instance>, lowercase, instance 2 to 4 digits",
  );
export type WorkerIdentityString = z.infer<typeof WorkerIdentityString>;

export const WorkerIdentity = z.strictObject({
  provider: z.string().regex(new RegExp("^" + IDENTITY_SEGMENT + "$")).max(40),
  model: z.string().regex(new RegExp("^" + IDENTITY_SEGMENT + "$")).max(60),
  role: WorkerRole,
  instance: z.string().regex(/^[0-9]{2,4}$/),
});
export type WorkerIdentity = z.infer<typeof WorkerIdentity>;

export function formatWorkerIdentity(identity: WorkerIdentity): WorkerIdentityString {
  return (
    identity.provider + "/" + identity.model + "/" + identity.role + "/" + identity.instance
  );
}

export function parseWorkerIdentity(value: string): WorkerIdentity {
  const match = WORKER_IDENTITY_PATTERN.exec(WorkerIdentityString.parse(value));
  if (match === null) {
    throw new Error("unreachable: identity passed the pattern but did not match");
  }
  return WorkerIdentity.parse({
    provider: match[1],
    model: match[2],
    role: match[3],
    instance: match[4],
  });
}
