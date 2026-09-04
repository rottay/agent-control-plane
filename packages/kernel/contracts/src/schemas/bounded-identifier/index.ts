/**
 * The bounded identifier grammar — `@acp/contracts` (V2-B4b stage 3A).
 *
 * One grammar for the configured tool-side names the plane admits, records or
 * refuses: a tool server id, a tool name. It exists because the same
 * pattern was declared twice for two different jobs — `@acp/tools` admitted a
 * server on "is a non-empty string", and `@acp/runtime` refused to record one
 * unless it matched this exact expression — so a name could pass the door and
 * then be refused by the recorder. Two grammars for one vocabulary is a
 * disagreement waiting for the value that lands between them; this module is
 * the one place that answers.
 *
 * **Not the account-id grammar.** Account ids are `AccountRecord.accountId`'s,
 * declared `min(1).max(80)` with no character class, and this module neither
 * replaces nor narrows it. The tool-receipt recorder does hold its own
 * `accountId` field to this pattern before it writes a receipt, but that is one
 * recorder guarding its own payload; it does not make this the grammar an
 * account id is admitted or stored by, and nothing here governs accounts.
 *
 * **What the bound is for.** A configured name has no reason to hold a space,
 * a quote, a brace, a slash or a newline, and a value that holds one is not a
 * name — it is content wearing a name's field. The upper bound of 120
 * characters is the same one the transition-id grammar carries, so a name that
 * fits here still fits every durable coordinate composed from it.
 *
 * **No `g` flag, deliberately.** A global RegExp carries `lastIndex` across
 * `.test()` calls, so a single shared instance would answer differently
 * depending on what was tested before it. This constant is shared by an
 * admission gate and a durable recorder; order-dependence there would be a
 * bug that reproduces only under a particular sequence of calls.
 *
 * The module imports `zod` and nothing else. It opens no file, reads no clock
 * and knows nothing about tools: it is a grammar, and the packages that need
 * one import it rather than restating it.
 */

import { z } from "zod";

/**
 * The grammar itself, as a RegExp, for the callers that test rather than parse.
 *
 * Admission and the durable recorder both hold a value they have not yet
 * decided to accept, so they ask a predicate rather than run a parser. The
 * shape is: one leading letter or digit, then up to 119 more characters drawn
 * from letters, digits, dot, underscore, colon and hyphen.
 */
export const BOUNDED_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

/** The same grammar as a schema, for the wire shapes that parse rather than test. */
export const BoundedIdentifier = z
  .string()
  .regex(
    BOUNDED_IDENTIFIER,
    "expected a bounded identifier: at most 120 characters of letters, digits," +
      " dot, underscore, colon or hyphen, beginning with a letter or a digit",
  );

export type BoundedIdentifier = z.infer<typeof BoundedIdentifier>;
