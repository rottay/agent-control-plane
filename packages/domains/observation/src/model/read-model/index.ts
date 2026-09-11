/**
 * The shared observation read model.
 *
 * Structure §4.1 named a real defect: three implementations of the payload-key
 * projection that did not agree — one door listed keys in insertion order
 * with no ceiling, the other sorted them and cut at sixty four, and only the
 * wire contract knew the ceiling was sixty four — so the product answered
 * differently depending on which door was asked. The remedy is one projection
 * with one owner, here. Both doors consume it; neither derives the list
 * anymore, and the architecture fence carries that as a named law rather than
 * as a hope.
 */

/**
 * Ceiling on the payload key names one projected item may carry.
 *
 * The wire contract caps the key array at sixty four names; this package may
 * not import the contract package, so the projection owns the number and the
 * agreement is tested where the contract is reachable: the gateway's mapper
 * suite derives the ceiling empirically from the schema (N names parse, N+1
 * refuse) and asserts it equal to this constant. A number with two equal
 * homes and no test tying them is the drift §4.2 warns against; a number with
 * one home and an empirical test tying it to the contract is a policy.
 */
export const MAX_PAYLOAD_KEYS = 64;

/**
 * The payload-key projection: the key names of one payload, in canonical
 * order, bounded.
 *
 * Order is code-unit order (`Array.prototype.sort`), not locale order: the
 * same bytes sort the same way on every machine, which is what "one
 * projection" means once two doors answer from it. Keys past the ceiling are
 * dropped after sorting, so a pathological payload of very short keys still
 * yields the first sixty four names in canonical order and the item parses on
 * both doors instead of failing one of them.
 */
export function payloadKeys(payload: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(payload).sort().slice(0, MAX_PAYLOAD_KEYS);
}
