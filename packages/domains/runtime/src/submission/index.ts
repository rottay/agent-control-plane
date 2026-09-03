import { resolveRoute } from "@acp/accounts";
import type { PolicyRegistry, PolicyRouteRequest } from "@acp/accounts";
import type { ResolvedRoute } from "@acp/contracts";
import { canonicalJsonStringify, sha256Hex } from "@acp/ledger";

/**
 * The submission path: where a route is elected, and what binds it (V2-B7S).
 *
 * This module is the home D5 named. Its own words
 * (`.acp-local/v2-b1b-brief.md:83-93`, carried into commit `0418cae`) are that
 * `RoutingRequest` composition "belongs to the submission path, not the walk",
 * and that "the production resolver arrives with the CLI/API submission path".
 * So D5 is not reversed here and not reinterpreted: it forbade **the walk**
 * resolving and pointed at this file's job. What lands here is that job.
 *
 * **The producer moved; the door did not.** `canonicalSubmission` and
 * `canonicalSubmissionDigest` used to be declared in the daemon's config
 * module. They are declared here now, and the daemon re-exports them, for one
 * reason: the elector must compute the digest the door will compare against,
 * and an elector that had to depend on `@acp/daemon` to do it would be an
 * entrypoint depending on an entrypoint for one function. The comparison — the
 * `!==` and its refusal — stays exactly where it was. A door that moved would
 * be a door that changed; a producer that moved is a declaration that changed
 * address, and the relocation is drilled as non-semantic against a digest
 * literal lifted from before the move.
 *
 * **Nothing here reads a clock, a file or an environment.** `composeSubmission`
 * takes values and returns a value. `resolvedAt` is a parameter for the same
 * reason it is a parameter of `resolveRoute` and of every quota entry point in
 * `@acp/accounts`: a route lands in a ledger event, and no value that lands in
 * a ledger event may depend on when the code happened to run. Loading the
 * accounts file and the policy document is the composition root's job, one
 * layer out, where a filesystem is allowed to exist.
 *
 * **No credential is read, ever.** `credentialRef` and `authProfileRef` are
 * fields of the landed `AccountRecord` and this module never touches either —
 * not read, not nulled, not redacted. A function that never reads a field
 * cannot leak it, which is a stronger property than one that handles it
 * carefully, and it is the same property the gateway's accounts read model
 * already holds.
 *
 * **The refusal vocabulary is inherited, not invented.** A composition that
 * cannot elect returns the seams' own refusal untranslated — the policy's or
 * the router's or the resolver's. Restating them in a fourth vocabulary would
 * be a fourth authority on a question already answered three times, and this
 * repository's rule is that an enum member is earned by the drill that needs
 * it. `SubmissionRefused` is therefore derived from `resolveRoute`'s own return
 * type rather than declared.
 */

// ---------------------------------------------------------------------------
// The submission
// ---------------------------------------------------------------------------

/**
 * What this run was asked to do, as one value (V2-B1c stage 2; relocated here
 * by V2-B7S).
 *
 * The type keeps its name across the move so the daemon's five test files,
 * which import it and the two functions below through
 * `src/daemon-child/index.js`, keep resolving unchanged. Renaming it would have
 * been a cosmetic improvement bought with edits to a file B2-4a certifies as
 * untouched.
 *
 * **Only safe provenance enters the preimage.** Task coordinates, the instant,
 * the initiative, and the six contract fields of the admitted route: every one
 * an identifier or a timestamp. No credential, no prompt, no tool argument, no
 * environment value, no path. The preimage is hashed and discarded — it is
 * never logged, never persisted and never carried on an event; what travels is
 * the digest.
 */
export interface DaemonSubmission {
  readonly taskId: string;
  readonly attempt: number;
  readonly submittedAt: string;
  readonly initiativeId: string;
  /** The route as the contract admitted it. Never a wider or laxer value. */
  readonly route: ResolvedRoute;
}

/**
 * The canonical preimage, as bytes.
 *
 * `canonicalJsonStringify` is the ledger's own canonicalizer, the same one the
 * event chain is digested over, so key order here is a property of the
 * function rather than of how this literal happens to be written: two callers
 * spelling the fields in different orders produce identical bytes. The route's
 * six fields are projected one by one rather than spread, so a wider object
 * cannot widen the preimage and silently change every digest.
 */
export function canonicalSubmission(submission: DaemonSubmission): string {
  return canonicalJsonStringify({
    taskId: submission.taskId,
    attempt: submission.attempt,
    submittedAt: submission.submittedAt,
    initiativeId: submission.initiativeId,
    route: {
      provider: submission.route.provider,
      model: submission.route.model,
      accountId: submission.route.accountId,
      transportKind: submission.route.transportKind,
      capabilityPolicyVersion: submission.route.capabilityPolicyVersion,
      resolvedAt: submission.route.resolvedAt,
    },
  });
}

/** The digest of the canonical preimage. One producer, one algorithm. */
export function canonicalSubmissionDigest(submission: DaemonSubmission): string {
  return sha256Hex(canonicalSubmission(submission));
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Where and when the submission sits, as values.
 *
 * The four coordinates are the caller's — they identify the attempt, and a
 * composer that invented them would be composing a different attempt from the
 * one it was asked about. `resolvedAt` is separate from `submittedAt` on
 * purpose, and is deliberately not defaulted from it: one is when the work was
 * submitted and the other is when the route was elected, and a default would
 * let the two silently become one.
 */
export interface SubmissionCoordinates {
  readonly taskId: string;
  readonly attempt: number;
  readonly submittedAt: string;
  readonly initiativeId: string;
  /** The instant of election. Injected; this module reads no clock. */
  readonly resolvedAt: string;
}

export interface SubmissionComposed {
  readonly ok: true;
  readonly submission: DaemonSubmission;
  /** The digest the daemon's door will recompute and compare against. */
  readonly submissionDigest: string;
  /** Set when the chosen model came from another entry's declared fallbacks. Carried, never silent. */
  readonly viaFallbackFrom: string | null;
}

/**
 * Every way an election can fail, and not one word more.
 *
 * Derived from `resolveRoute`'s own return type rather than declared, so this
 * module cannot widen the refusal vocabulary even by accident: a member added
 * to the policy, the router or the resolver appears here automatically, and a
 * member this packet wanted but nobody earned cannot be added here at all.
 */
export type SubmissionRefused = Exclude<ReturnType<typeof resolveRoute>, { readonly ok: true }>;

export type SubmissionOutcome = SubmissionComposed | SubmissionRefused;

/**
 * Elect a route and bind it to the attempt it was elected for.
 *
 * Pure: values in, a value out. The order of operations is the order of the
 * seams beneath — the policy chooses the model and stamps its version, the
 * router chooses the account, the resolver composes them onto the contract —
 * and this function adds exactly one thing on top: the digest that makes the
 * elected route part of what the attempt *is*, rather than a field that rode
 * along beside it.
 *
 * That digest is why election belongs above the walk and not inside it. It
 * rides the base payload of every event, and `assertInvocationContinuity`
 * rebuilds step 0 from it on every resume; so a route re-elected under a new
 * policy produces a different digest, different step-0 bytes, and a refusal.
 * A walk that elected for itself would be a walk that could re-elect on resume
 * and never notice.
 */
export function composeSubmission(
  request: PolicyRouteRequest,
  registry: PolicyRegistry,
  coordinates: SubmissionCoordinates,
): SubmissionOutcome {
  const resolution = resolveRoute(request, registry, coordinates.resolvedAt);
  if (!resolution.ok) return resolution;

  const submission: DaemonSubmission = Object.freeze({
    taskId: coordinates.taskId,
    attempt: coordinates.attempt,
    submittedAt: coordinates.submittedAt,
    initiativeId: coordinates.initiativeId,
    route: resolution.route,
  });

  return Object.freeze({
    ok: true as const,
    submission,
    submissionDigest: canonicalSubmissionDigest(submission),
    viaFallbackFrom: resolution.viaFallbackFrom,
  });
}
