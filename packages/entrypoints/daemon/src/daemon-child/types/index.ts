import type { DaemonExecutionLimits } from "../index.js";

/**
 * The local binding's shape (P-15 escalón E, ADR 0108; E-ND-10).
 *
 * A pure type leaf (owner law §7), beside the two binding shapes that stay where
 * they are. An OpenAI-compatible server on this machine: the config names where it
 * listens, which provider word and models it serves, and whether it takes a bearer
 * credential — never the credential itself, which the resolver reads from the
 * owner's credentials file at composition when `auth` is `CREDENTIAL`.
 */
export interface DaemonLocalExecutionBinding {
  readonly accountId: string;
  readonly workdir: string;
  readonly limits: DaemonExecutionLimits;
  readonly transportKind: "LOCAL_OR_SELF_HOSTED";
  /** The provider word the server speaks for; the route must name the same. */
  readonly provider: string;
  /** A loopback `http(s)://127.0.0.1` or `http(s)://[::1]` base, no userinfo, query or fragment. */
  readonly baseUrl: string;
  /** The models the server serves. Required and non-empty; never discovered. */
  readonly models: readonly string[];
  /** `NONE`: no authorization header. `CREDENTIAL`: a bearer credential the resolver reads. */
  readonly auth: "NONE" | "CREDENTIAL";
}
