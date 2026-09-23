/**
 * The payload the switch player appends for one candidate (P-15 escalón B,
 * ADR 0102).
 *
 * The plan's string fields, the `LEASE_REVOKED` enrichment, and — for a V2 walk —
 * the two integers of the payload coordinate. The integers come from the walk's
 * revision alone: a candidate that names either key is refused before any append,
 * so a plan can never key an event into another coordinate.
 */
export type SwitchEventPayload = Readonly<Record<string, string | number>>;
