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
 *
 * `0.12.0` → `0.13.0` at V2 L3: the plane's fourth write door,
 * `taskLifecycle`, and **two** new error codes with it —
 * `CAPABILITY_UNSUPPORTED` and `SCENARIO_UNCONFIGURED`.
 *
 * Minor rather than major on this file's own rule: everything a `0.12.0`
 * client knew is still true and still shaped the same way. Minor rather than
 * patch for two independent reasons, either of which would be enough — the
 * route surface **does** move here, unlike at `0.11.0` and `0.12.0`
 * (`API_ROUTES` gains a route and `API_WRITE_ROUTES` goes from three to four),
 * and a client can branch on an error code, so two codes a `0.12.0` reader has
 * never seen are shapes it did not know about.
 *
 * `LEDGER_CONTRACT_VERSION` does not move. The lifecycle door appends only
 * rows the cancellation settlement already produced at `0.12.0`: no event type,
 * payload key or migration is added, and no history is reinterpreted. What
 * changed is that the API can now ask for the settlement the CLI could already
 * ask for. ADR 0031 carries the reasoning.
 *
 * `0.13.0` → `0.14.0` at P-10/id-B: the `hello` frame and the status response
 * each gain one required field, `instance` — which ledger FILE this is, and
 * which restore of it, beside the `database` digest that says which PATH.
 *
 * Minor for exactly the mechanical reason `0.12.0` was, and the precedent is
 * the field two paragraphs up: both are `z.strictObject`, so a reader pinned at
 * `0.13.0` parsing a `0.14.0` `hello` **rejects it** on the unknown key. That is
 * a shape a `0.13.0` reader has never seen, which is this file's own rule for
 * the minor. Making the key optional to spare that reader was rejected for the
 * same reason it was rejected then: it would make "this server does not know
 * its file identity" and "this file has none yet" the same wire shape, and
 * telling those apart is the entire point of the field.
 *
 * The route surface does not move: `API_ROUTES` and `API_WRITE_ROUTES` are
 * untouched. Neither does `LEDGER_CONTRACT_VERSION` — no recorded event changes
 * shape and no migration is implied; the three rows this publishes are additive
 * keys in a table that has held `(key, value)` since migration 3. What changed
 * is what a connection tells a client about the file behind it. ADR 0064
 * carries the reasoning, and extends ADR 0028 rather than replacing it.
 *
 * `0.14.0` → `0.15.0` at P-08/B: the integrity result gains one required field,
 * `coverage` — one entry per stream saying **from when** its chain is evidence
 * and **how that coverage came to be**, which is a different question from
 * whether the check passed.
 *
 * Minor for the mechanical reason every one of these has been: `IntegrityResult`
 * is a `z.strictObject`, so a reader pinned at `0.14.0` parsing a `0.15.0`
 * result **rejects it** on the unknown key. Optional was rejected for the
 * reason it keeps being rejected — it would make "an older server that does not
 * say" and "a ledger with no coverage" the same wire shape, and telling those
 * apart is the entire point of a field whose three values include
 * `NOT_ACTIVATED`.
 *
 * The route surface does not move: `API_ROUTES` and `API_WRITE_ROUTES` are
 * untouched. Neither does `LEDGER_CONTRACT_VERSION`, and here that deserves
 * saying out loud because this packet's sibling added a migration: migration 10
 * creates the account integrity sidecar, which is **ledger schema**, not the
 * shape of a recorded event. No event type, payload key or history is
 * reinterpreted. ADR 0065 carries the reasoning.
 *
 * `0.15.0` → `0.16.0` at P-14/B: the plane's fifth write door. `initiatives`
 * answers POST beside its GET and registers one initiative, and two schemas
 * arrive with it — `InitiativeRegistrationRequest` and
 * `InitiativeRegistrationResponse`.
 *
 * Minor for the reason `0.13.0` gave first: the route surface moves.
 * `API_WRITE_ROUTES` goes from four to five, and a reader at `0.15.0` that
 * asked this table what can mutate was told something that is no longer the
 * whole answer. `API_ALLOWED_METHODS` stays exactly `["GET"]`, and no error code
 * is added: a registration refuses with `BAD_REQUEST` and `WRITE_REFUSED`, which
 * a `0.15.0` reader already branches on. No existing DTO changes shape either —
 * `InitiativeSummary` still serves `objective`, now read back from the private
 * plane by reference for a registration that published one.
 *
 * `CONTRACT_VERSION` does not move: the event this door appends is the
 * `INITIATIVE_REGISTERED` the contract has carried since P8, with its bounded
 * payload unchanged. `LEDGER_CONTRACT_VERSION` does not move either, and here too
 * it deserves saying because this packet adds a migration: migration 18 adds
 * three nullable columns to a read model, which is ledger schema and not the
 * shape of a recorded event. ADR 0086 carries the reasoning.
 *
 * `0.16.0` → `0.17.0` at P-14/C: the plane's sixth write door. `tasks` answers
 * POST beside its GET and enters one task — the envelope published to the
 * private plane, one revision, the resolution of its role — and two schemas
 * arrive with it: `TaskIntakeRequest` and `TaskIntakeResponse`.
 *
 * Minor for the reason `0.13.0` gave first: the route surface moves.
 * `API_WRITE_ROUTES` goes from five to six. `API_ALLOWED_METHODS` stays exactly
 * `["GET"]`, and no error code is added: an intake refuses with `BAD_REQUEST`
 * and `WRITE_REFUSED`, the second carrying the refusal's class, its code and the
 * field. No existing DTO changes shape: `TaskSummary` and `TaskDetail` still read
 * what they read, and a task that entered by the door is `DISCOVERED` in both.
 *
 * `CONTRACT_VERSION` does not move: the event this door appends is the
 * `TASK_DISCOVERED` the contract has always carried, its payload a bounded
 * record, and the envelope's preimage is untouched — nothing the intake needs
 * lives inside the envelope. `LEDGER_CONTRACT_VERSION` does not move either,
 * though this packet adds a migration: migration 19 creates a derived table,
 * which is ledger schema and not the shape of a recorded event. ADR 0087 carries
 * the reasoning.
 *
 * `0.18.0` → `0.19.0` at P-15/F: two routes and one error word. `taskEffects`
 * lists a task's effects — ids, coordinates, outcome words and whether a result
 * exists, never a reference, a digest or a byte of one — and `taskEffectResult`
 * reads one effect's result back by reference, the first GET of this plane that
 * is not free: it answers model output, so it is named in the new closed table
 * `API_PRIVATE_READ_ROUTES` and answered only behind the bearer. Four schemas
 * arrive with them (`TaskEffectsResponse`, `TaskEffectResultQuery`,
 * `TaskEffectResultResponse`, and `EFFECT_RESULT_STATES`), and
 * `PRIVATE_READ_UNCONFIGURED` joins the error vocabulary, fifteen words to
 * sixteen, for a server started without a bearer.
 *
 * Minor for the reason `0.13.0` gave first: the route surface moves.
 * `API_ALLOWED_METHODS` stays `["GET"]` and `API_WRITE_ROUTES` stays at six —
 * both routes are reads. No existing DTO changes shape: a task's detail does not
 * grow an effects list, which is a sibling route of its own so the console's
 * reading of `TaskDetail` stays untouched. `CONTRACT_VERSION` and
 * `LEDGER_CONTRACT_VERSION` do not move: a read adds no recorded shape. ADR 0107
 * carries the reasoning.
 *
 * `0.19.0` → `0.20.0` at P-26 cut B: a roadmap version declares its steps. The
 * contract's `INITIATIVE_EVENT_TYPES` gains `ROADMAP_STEP_DECLARED`, so the timeline
 * DTO's type enum widens by derivation; `RoadmapVersionWriteRequest` gains an
 * optional `steps` manifest; `RoadmapVersionDto` gains `stepCount` and
 * `stepManifestSha256`, never a reference or a step's text; and the write route's
 * transport limit grows by `ROADMAP_STEP_MANIFEST_MAX_BYTES`. Minor: the route
 * surface is unchanged and no existing field changes meaning. `CONTRACT_VERSION`
 * moves too, 2.9.0 → 2.10.0, so `LEDGER_CONTRACT_VERSION` follows by derivation.
 * ADR 0111 carries the reasoning.
 *
 * `0.20.0` → `0.21.0` at P-26 cut C: two reads, the semantic diff of requirement
 * A10. `initiativeRoadmapSteps` lists one version's declared steps — title,
 * position, rank, state and dependencies, never a digest or a reference — and
 * `initiativeRoadmapDiff` answers the diff between two versions of one initiative
 * by `stepId`, with the changed fields by name, the dependency pairs, whether the
 * content changed, the version a rollback restores, and `roles` as a named absence
 * derived from the rows. Both select by version number, as the content read does.
 * Four schemas arrive with them (`RoadmapStepsQuery`, `RoadmapStepsResponse`,
 * `RoadmapDiffQuery`, `RoadmapDiffResponse`). Minor for the reason `0.13.0` gave
 * first: the route surface moves. `API_ALLOWED_METHODS`, `API_WRITE_ROUTES` and
 * `API_PRIVATE_READ_ROUTES` do not, and no error word moves. `CONTRACT_VERSION` and
 * `LEDGER_CONTRACT_VERSION` do not move: a read adds no recorded shape. ADR 0113
 * carries the reasoning.
 */
export const API_CONTRACT_VERSION = "0.21.0" as const;
export type ApiContractVersionLiteral = typeof API_CONTRACT_VERSION;

/**
 * The control plane contract version this API surface is pinned to.
 *
 * Re-exported under an explicit name so a consumer never has to guess whether
 * a bare `CONTRACT_VERSION` referred to the ledger or to the API.
 */
export const LEDGER_CONTRACT_VERSION = CONTRACT_VERSION;
export type LedgerContractVersionLiteral = typeof CONTRACT_VERSION;
