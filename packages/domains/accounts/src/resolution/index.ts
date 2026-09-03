import { ResolvedRoute } from "@acp/contracts";

import type { PolicyRefused, PolicyRegistry, PolicyRouteRequest } from "../policy/index.js";
import { routeWithPolicy } from "../policy/index.js";
import type { RoutingRecommendation, RoutingRefused } from "../routing/index.js";

/**
 * The resolution entry point: the policy's choice becomes a route an adapter
 * can execute (V2-B1a).
 *
 * `routeWithPolicy` answers two questions — which model, and which account —
 * and stamps the policy version that answered the first. What it returns is
 * this package's own `PolicyRouteChoice`, and that is not the seam shape. The
 * execution boundary types against `ResolvedRoute`, owned by `@acp/contracts`,
 * which also names the provider, the transport kind and the instant of
 * resolution. This module is the one place the two are joined: provider from
 * the chosen registry entry, account from the head of the ranking, transport
 * from the request, model and policy version from the choice, and the instant
 * from the caller. The join is the whole of what it does.
 *
 * Three laws hold it in shape.
 *
 * **The type is imported, never re-exported and never redeclared.** Contracts
 * owns `ResolvedRoute`; a consumer takes the type from the kernel and the
 * function from here. A second barrel carrying the name would be a second
 * home for the seam type, and two homes is how an adapter and a router come to
 * disagree about what a route is.
 *
 * **The instant is the caller's.** `resolvedAt` is a parameter, exactly as
 * `now` is a parameter of every quota and routing entry point in this package.
 * No clock is read here: a route lands in a ledger event, and no value that
 * lands in a ledger event may depend on when the code happened to run. It is
 * deliberately not defaulted from `routing.now` either — that instant is when
 * the ranking was evaluated, this one is when the route was resolved, and a
 * default would let the two silently become one.
 *
 * **The route that leaves is the route the contract admitted.** The composed
 * value is parsed through contracts' own `ResolvedRoute` schema, refinement
 * included, and what is returned is the parsed value. A composition the
 * contract refuses — a CLI-subscription route naming a provider the kernel
 * does not list as one, a transport kind the kernel does not know, an instant
 * without an offset — is a classified refusal, never a route with a field
 * quietly repaired. The seam refuses closed; it does not improvise.
 *
 * **The two provider vocabularies agree, or nothing routes (F1, V2-B1b D7).**
 * The policy entry names the provider the route will carry; the ranked
 * account's own record names the provider it belongs to. They are checked
 * against each other here, and a disagreement is `RESOLUTION_PROVIDER_MISMATCH`
 * at `route.provider` -- never an alias, never a translation table, because a
 * mapping would be a second authority on a question the policy entry already
 * answers. The ranking cannot see the disagreement: `rankAccounts` gates on
 * enabled models, not on providers.
 *
 * What it does **not** do is read the registry's version. The version travels
 * on the choice, because `routeWithPolicy` is the only producer of it; reading
 * it here as well would be two readers of one document.
 */

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export type ResolutionRefusal =
  // the choice the policy returned cannot be composed into a route
  | "RESOLUTION_CHOICE_INCOMPLETE"
  // the ranked account's record names a provider other than the chosen entry's
  | "RESOLUTION_PROVIDER_MISMATCH"
  // the composed route does not satisfy the contracts-owned schema
  | "RESOLUTION_ROUTE_INVALID";

export const RESOLUTION_REFUSALS: readonly ResolutionRefusal[] = Object.freeze([
  "RESOLUTION_CHOICE_INCOMPLETE",
  "RESOLUTION_PROVIDER_MISMATCH",
  "RESOLUTION_ROUTE_INVALID",
]);

export interface ResolutionRefused {
  readonly ok: false;
  readonly reason: ResolutionRefusal;
  /** A field path on the choice or the route. Never a value from either. */
  readonly at: string;
}

function deny(reason: ResolutionRefusal, at: string): ResolutionRefused {
  return Object.freeze({ ok: false as const, reason, at });
}

// ---------------------------------------------------------------------------
// The outcome
// ---------------------------------------------------------------------------

export interface RouteResolution {
  readonly ok: true;
  /** The contracts-owned route, exactly as the schema admitted it. Frozen. */
  readonly route: ResolvedRoute;
  /** Set when the chosen model came from another entry's declared fallbacks. Carried, never silent. */
  readonly viaFallbackFrom: string | null;
  /** The ranking the account was taken from, for the evidence a caller records. */
  readonly recommendation: RoutingRecommendation;
}

/**
 * A refusal from either seam beneath travels untranslated: the policy and the
 * router each already name what failed and where, and restating it in this
 * module's vocabulary would be a second authority on a question already
 * answered. Only what this module itself decides carries its own reason.
 */
export type RouteResolutionOutcome =
  | RouteResolution
  | ResolutionRefused
  | PolicyRefused
  | RoutingRefused;

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Resolve a route: choose by policy, rank by quota, compose onto the contract.
 *
 * The order of operations is the order of the seams. The policy chooses the
 * model and stamps its version; the router chooses the account; this function
 * looks the provider up on the entry the policy chose, takes the transport
 * from the request and the instant from the caller, and hands the whole to
 * the contract to admit. Nothing is chosen here, and nothing chosen beneath is
 * revisited.
 */
export function resolveRoute(
  request: PolicyRouteRequest,
  registry: PolicyRegistry,
  resolvedAt: string,
): RouteResolutionOutcome {
  const choice = routeWithPolicy(request, registry);
  if (!choice.ok) return choice;

  // The policy chooses only from the registry it was handed and the router
  // never returns an empty ranking, so neither branch below is reachable
  // through the seams' contracts. They are refused by name rather than trusted
  // as types: a route composed from a missing entry or an absent account would
  // be a crash where the contract promises a classified refusal.
  const entry = registry.models.find((candidate) => candidate.model === choice.model);
  if (entry === undefined) return deny("RESOLUTION_CHOICE_INCOMPLETE", "choice.model");
  const best = choice.recommendation.ranked[0];
  if (best === undefined) return deny("RESOLUTION_CHOICE_INCOMPLETE", "choice.recommendation.ranked");

  // F1: the record is looked up in the request the caller already handed over
  // -- the records are in scope, so no second source is consulted. A ranked
  // head absent from those records is an incomplete choice, not a route; a
  // head whose record names another provider than the entry is refused closed.
  const record = request.routing.records.find((candidate) => candidate.accountId === best.accountId);
  if (record === undefined) return deny("RESOLUTION_CHOICE_INCOMPLETE", "choice.recommendation.ranked");
  if (record.provider !== entry.provider) return deny("RESOLUTION_PROVIDER_MISMATCH", "route.provider");

  // The contract admits the route, or nothing leaves. The refusal carries the
  // first failing field as a path and never the value that failed there.
  const parsed = ResolvedRoute.safeParse({
    provider: entry.provider,
    model: choice.model,
    accountId: best.accountId,
    transportKind: request.transportKind,
    capabilityPolicyVersion: choice.capabilityPolicyVersion,
    resolvedAt,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined ? [] : issue.path.map((segment) => String(segment));
    return deny("RESOLUTION_ROUTE_INVALID", ["route", ...path].join("."));
  }

  return Object.freeze({
    ok: true as const,
    route: Object.freeze(parsed.data),
    viaFallbackFrom: choice.viaFallbackFrom,
    recommendation: choice.recommendation,
  });
}
