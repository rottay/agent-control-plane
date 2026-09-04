import { CONTRACT_VERSION } from "@acp/contracts";

/**
 * Version of the read-only observation API.
 *
 * This is deliberately a different number from the control plane contract
 * version that `@acp/contracts` stamps on every ledger event. The two version
 * lines move for different reasons and must never be conflated:
 *
 * - `CONTRACT_VERSION` changes when the durable meaning of a ledger event
 *   changes. A change there is a change to recorded history.
 * - `API_CONTRACT_VERSION` changes when the shape a browser or a CLI receives
 *   changes. A change here costs a redeploy of two readers and nothing else.
 *
 * Pinning them together would force a false coupling in both directions: a
 * cosmetic field rename in a DTO would look like a ledger migration, and a
 * genuine ledger migration would look like a UI change. Every response carries
 * both numbers so a reader can tell which one moved.
 *
 * `0.1.0` → `0.2.0` at P8-8A: the initiative data plane adds three routes and
 * their response shapes. **Additive** — no existing route, field or type
 * changed, so a reader pinned to the older shapes still reads every response
 * it read before. The minor moves rather than the patch because new surface is
 * new contract, and a reader that wants to know whether the initiative routes
 * exist should be able to ask this number rather than probe for a 404.
 *
 * `0.2.0` → `0.3.0` at P8-8D-pre: the plane accepts its **first write**. Still
 * additive — no existing route, field or type changed, and every read a pinned
 * reader made before it still answers identically — but the minor moves for a
 * reason no read-only addition ever had: what this API *is* changed. A reader
 * that assumed "every route here is safe to retry, and nothing I send mutates
 * anything" was right at 0.2.0 and is wrong at 0.3.0, and that is precisely
 * what a version number exists to tell it.
 *
 * `0.3.0` → `0.4.0` at P8-8D-c2: a read route that serves the stored roadmap
 * document. Additive, and a read — the plane's write surface is unchanged at
 * exactly one route.
 *
 * `0.8.0` → `0.9.0` at V2-B3a: the durable ledger sequence becomes a
 * reconnectable event stream. Additive in shape — no existing route, field or
 * type changed, and every read a pinned reader made before it still answers
 * identically — but the minor moves for the same reason `0.3.0` did, and only
 * the second time it has ever applied: **what this API *is* changed.** A reader
 * at `0.8.0` was right to assume every response here is a bounded body that
 * ends; at `0.9.0` one route answers with a connection that stays open, carries
 * frames as they are recorded, and expects to be resumed by header after it
 * drops. That is not a new field on an old shape, and a version number exists
 * to say so.
 *
 * The write surface did not move: `API_WRITE_ROUTES` was still exactly two at
 * that release, and `API_ALLOWED_METHODS` is still exactly `["GET"]`.
 * `LEDGER_CONTRACT_VERSION` does not move either — the stream carries the
 * events the ledger already recorded, in the projection the read routes already
 * serve, so nothing about recorded history changed.
 *
 * `0.9.0` → `0.10.0` at V2-B4b stage 3C: the explicit tool call gets a door.
 * Additive in shape — one new route, five new schemas, one new error code, and
 * every read a pinned reader made before still answers identically — and the
 * minor moves for the third time on the reason `0.3.0` and `0.9.0` moved:
 * **what this API *is* changed again.** A reader at `0.9.0` was right that every
 * write here records a decision the caller had already made, and that nothing
 * this process serves starts another one. At `0.10.0` one write route makes
 * this process spawn a child, speak a protocol to it, and reap it before the
 * response returns. That is a different kind of authority to hold, not a new
 * field on an old shape, and a version number exists to say so.
 *
 * `API_WRITE_ROUTES` moves two → three with it, which is the visible half of
 * the same fact. `LEDGER_CONTRACT_VERSION` does not move: the row this route
 * appends is `TOOL_CALL_RECORDED`, which the ledger contract has carried since
 * stage 2 — the door is what was missing, not the shape.
 *
 * `0.10.0` → `0.11.0` at V2 X1b: one new error code, `CLAIM_HELD`. Minor and
 * not patch, on the rule stated at the top of this file and on the precedent
 * `WRITE_REFUSED`, `STREAM_CAPACITY` and `TOOL_SERVERS_UNCONFIGURED` each set: a
 * client can branch on a code, so a code a reader at `0.10.0` has never seen is
 * a shape it did not know about.
 *
 * The route surface is **unchanged** — `API_ROUTES` and `API_WRITE_ROUTES` do
 * not move, because X1b adds a way for an existing door to refuse, not a new
 * door. What changed is that a tool call can now lose a race to a different
 * operating-system process and be told so, rather than both processes running
 * the tool and the ledger absorbing the second receipt.
 *
 * `0.11.0` → `0.12.0` at V2-B3c: the stream's `hello` frame gains one required
 * nullable field, `resumedFrom`, and is now sent on **every** open rather than
 * only on an unanchored one.
 *
 * Minor and not patch, and the reason is mechanical rather than a judgement
 * call: every arm of `StreamFrame` is a `z.strictObject`, so a reader pinned at
 * `0.11.0` parsing a `0.12.0` `hello` **rejects it** on the unknown key. That is
 * a shape a `0.11.0` reader has never seen, which is this file's own rule for
 * the minor. Making the key optional to spare that reader was rejected: it
 * would make "live open" and "an older server that does not say" the same wire
 * shape, and the whole point of the field is that a client can tell which
 * connection it is on without guessing.
 *
 * The route surface does not move — `API_ROUTES` and `API_WRITE_ROUTES` are
 * untouched — and neither does `LEDGER_CONTRACT_VERSION`: no recorded event
 * changes shape, no history is reinterpreted and no migration is implied. What
 * changed is what a connection tells a client about itself, which is API
 * surface and not ledger surface. ADR 0028 carries the reasoning.
 */
export const API_CONTRACT_VERSION = "0.12.0" as const;
export type ApiContractVersionLiteral = typeof API_CONTRACT_VERSION;

/**
 * The control plane contract version this API surface is pinned to.
 *
 * Re-exported under an explicit name so a consumer never has to guess whether
 * a bare `CONTRACT_VERSION` referred to the ledger or to the API.
 */
export const LEDGER_CONTRACT_VERSION = CONTRACT_VERSION;
export type LedgerContractVersionLiteral = typeof CONTRACT_VERSION;
