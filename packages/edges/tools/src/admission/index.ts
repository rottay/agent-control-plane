/**
 * Tool server admission — `@acp/tools` (V2-B4b stage 1).
 *
 * The one place a `ToolServerDescriptor` becomes an `AdmittedToolServer`, and
 * therefore the one place that decides what "remote" means. Two modules that
 * both answered that question would be two answers, and the disagreement would
 * be discovered by whichever one was wrong at the moment it mattered.
 *
 * This is also the only module in the package that reads `process.env`, and
 * the only one that touches the filesystem. Everything downstream of it is a
 * pure function of an already-admitted server.
 *
 * The name grammar it judges by is `@acp/contracts`' `BOUNDED_IDENTIFIER`, not
 * a local copy (V2-B4b stage 3A). The durable recorder in `@acp/runtime`
 * refuses to write a receipt whose `serverId` or `toolName` falls outside that
 * grammar, and a door that admitted a name the recorder would later refuse
 * would be a door whose decisions cannot all be written down.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { BOUNDED_IDENTIFIER } from "@acp/contracts";

import type {
  ToolAllowlistEntry,
  ToolRefusal,
  ToolServerDescriptor,
  ToolTransportKind,
} from "../contract/index.js";
import {
  TOOL_SCHEMA_BYTES_MAX,
  TOOL_SCHEMA_DEPTH_MAX,
  TOOL_SERVER_ENV_KEYS,
  TOOL_TRANSPORT_KINDS,
} from "../contract/index.js";
import { toolFrameBytes } from "../jsonrpc/index.js";
import { jsonDepthWithin } from "../schema-equality/index.js";

/**
 * A server the plane has decided it may talk to.
 *
 * Constructed here and nowhere else — the fence asserts that too. Everything
 * on it is already a decision: the command was admitted, the environment was
 * built from the allowlist, the tool list is non-empty and free of duplicates.
 */
interface AdmittedToolServerBase {
  readonly serverId: string;
  readonly kind: ToolTransportKind;
  readonly allowlist: readonly ToolAllowlistEntry[];
}

/**
 * A spawned server: a command, its arguments, and the three-variable
 * environment it will be given.
 *
 * Exported for **one sibling module and no further**: `src/stdio/index.ts`
 * spawns from it and needs the narrowed shape, because the union it used to
 * take no longer carries `command`. It is deliberately **not** re-exported from
 * the package barrel — a type a sibling imports costs no public surface, and
 * the day an outside consumer needs to narrow is the day it earns a barrel row.
 * The loopback sibling below is exported on the same terms and for the same
 * one reader: `src/http-loopback/index.ts`. Neither reaches the barrel.
 */
export interface AdmittedStdioToolServer extends AdmittedToolServerBase {
  readonly kind: "STDIO";
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * A loopback server: one endpoint, stored exactly as the descriptor wrote it.
 *
 * No `command`, no `args`, and **no `env`** — there is no child, so the
 * environment allowlist is not read at all on this branch. The URL is the
 * descriptor's own string, kept verbatim after `classifyUrl` proved it parses:
 * Streamable HTTP uses one endpoint for every method, so there is no path to
 * join and nothing to construct, which is what keeps `new URL(` confined to
 * this file.
 */
export interface AdmittedHttpLoopbackToolServer extends AdmittedToolServerBase {
  readonly kind: "HTTP_LOOPBACK";
  readonly url: string;
}

export type AdmittedToolServer = AdmittedStdioToolServer | AdmittedHttpLoopbackToolServer;

export type ToolAdmissionOutcome =
  | { readonly ok: true; readonly server: AdmittedToolServer }
  | { readonly ok: false; readonly refusal: ToolRefusal; readonly at: string };

/** The whole document's verdict: every server, or the first refusal and where. */
export type ToolDocumentOutcome =
  | { readonly ok: true; readonly servers: readonly AdmittedToolServer[] }
  | { readonly ok: false; readonly refusal: ToolRefusal; readonly at: string };

/** The only two hostnames that are this machine, spelled as literals. */
const TOOL_LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "::1"];

function refuse(refusal: ToolRefusal, at: string): ToolAdmissionOutcome {
  return { ok: false, refusal, at };
}

/**
 * Classify a URL-shaped descriptor field, field by field.
 *
 * Refusing the *presence* of a `url` would be the easy version and the wrong
 * one: it makes a conformant loopback Streamable HTTP descriptor
 * unrepresentable, so the later stage that admits one would have to delete
 * this check rather than widen it, and nothing here would ever have parsed a
 * URL. Refusing a **parsed hostname** is the fact that matters, and it is the
 * mechanism the durability edge already holds for the Restate plane.
 *
 * `localhost` is refused with everything else and is named here because it is
 * the one a reviewer expects to pass: resolving a name means DNS, and a name
 * that resolves on-box today is a remote server tomorrow. Literal addresses
 * only. That is also why no `node:dns` ban would be sufficient on its own —
 * a name is resolved by the network stack, importing nothing.
 */
type UrlClassification =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly refusal: ToolRefusal; readonly at: string };

/**
 * Judge a URL field by field, and say which way it went.
 *
 * A classifier since V2-B4b S4-1, and read in opposite directions by its two
 * consumers: a STDIO descriptor carrying a URL is refused whatever the verdict,
 * because it is a remote server that lied about its transport; an
 * HTTP_LOOPBACK descriptor is admitted on `ok: true`. Every field-exact refusal
 * below is unchanged, which is why the admission suite's table does not move.
 */
function classifyUrl(raw: string): UrlClassification {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, refusal: "TRANSPORT_REFUSED", at: "descriptor.url" };
  }
  // `https:` stays refused, and the reason is worth writing down: a loopback
  // TLS endpoint needs a trust decision this package cannot make honestly, and
  // plaintext to a literal loopback address on this host is what the
  // restriction authorised.
  if (url.protocol !== "http:") {
    return { ok: false, refusal: "TRANSPORT_REFUSED", at: "descriptor.url.protocol" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, refusal: "TRANSPORT_REFUSED", at: "descriptor.url.credentials" };
  }
  // `URL` brackets an IPv6 host; compare against the literal it wraps.
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!TOOL_LOOPBACK_HOSTS.includes(hostname)) {
    return { ok: false, refusal: "TRANSPORT_REFUSED", at: "descriptor.url.hostname" };
  }
  const port = Number(url.port);
  if (url.port === "" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, refusal: "TRANSPORT_REFUSED", at: "descriptor.url.port" };
  }
  // A well-formed loopback URL. Stage 1 refused one here because no transport
  // carried it and said in as many words that "the stage that adds the
  // transport widens the union and returns this leg's server; it deletes
  // nothing above". This is that stage: nothing above was deleted, and the
  // verdict is now returned rather than refused.
  return { ok: true, url: raw };
}

/**
 * Admit an executable the way the provider edge admits a provider binary.
 *
 * Re-implemented rather than imported: taking `admitBinary` from
 * `@acp/providers` would give this package a dependency the layer law does not
 * need and the import law forbids outright. Duplicating twenty lines is the
 * cheaper of the two costs, and the fence pins the import surface so the
 * cheaper one cannot quietly become the other.
 */
function admitCommand(candidate: string): boolean {
  if (!isAbsolute(candidate)) return false;
  if (!existsSync(candidate)) return false;
  if (realpathSync(candidate) !== candidate) return false;
  const stats = statSync(candidate);
  if (!stats.isFile()) return false;
  if (stats.uid !== process.getuid?.()) return false;
  // An executable others can rewrite is not the binary anyone reviewed.
  return (stats.mode & 0o022) === 0;
}

/** The whole environment a tool server child gets: three variables, no more. */
function buildToolServerEnv(): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const key of TOOL_SERVER_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  return Object.freeze(env);
}

/**
 * Admit an operator's schema pin (P-24, ADR 0109), or `null`.
 *
 * Required and never defaulted: a JSON object whose `type` is `"object"` (the
 * revision requires it of every tool, so a pin that cannot match a conformant
 * server is a dead entry), at most {@link TOOL_SCHEMA_DEPTH_MAX} containers deep
 * and at most {@link TOOL_SCHEMA_BYTES_MAX} bytes serialized. The admitted pin is
 * a frozen copy, so nothing the caller still holds can change it after review.
 */
function admitPin(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if ((value as Record<string, unknown>)["type"] !== "object") return null;
  // Depth before bytes: the depth walk ends at the bound, so a cycle a caller
  // built by hand is refused before anything serializes it.
  if (!jsonDepthWithin(value, TOOL_SCHEMA_DEPTH_MAX)) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (toolFrameBytes(serialized) > TOOL_SCHEMA_BYTES_MAX) return null;
  return deepFreeze(JSON.parse(serialized) as Record<string, unknown>);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Decide whether the plane may talk to this server, and refuse field-exactly.
 *
 * Every failure names the descriptor field that caused it. A refusal that said
 * only "not admitted" would make an operator guess, and guessing is how a
 * loosened field ends up in a config.
 */
export function admitToolServer(descriptor: ToolServerDescriptor): ToolAdmissionOutcome {
  // The name is judged before the transport, before the URL parse and before
  // `admitCommand` opens anything, so a server id outside the grammar is
  // refused ahead of every read, spawn and call this package can reach.
  // `typeof` still guards the `.test()`, which would otherwise stringify
  // whatever it was handed and judge the string it produced. The grammar
  // subsumes the emptiness check it replaces: `""` has no leading character.
  if (typeof descriptor.serverId !== "string" || !BOUNDED_IDENTIFIER.test(descriptor.serverId)) {
    return refuse("SERVER_NOT_ADMITTED", "descriptor.serverId");
  }

  // First, and before anything is read off the descriptor's transport-specific
  // fields: an unknown transport is the remote refusal. "HTTP", "SSE",
  // "STREAMABLE_HTTP", "WEBSOCKET", "LOOPBACK" and "" all land here.
  if (!(TOOL_TRANSPORT_KINDS as readonly string[]).includes(descriptor.transport)) {
    return refuse("TRANSPORT_REFUSED", "descriptor.transport");
  }

  // V2-B4b S4-1. The two legs part here, and the allowlist below is shared:
  // the whole substance of the loopback packet is that everything after this
  // branch is transport-independent.
  const isLoopback = descriptor.transport === "HTTP_LOOPBACK";
  // Captured where each is proved, rather than re-asserted at the return. A
  // value narrowed in one branch is not narrowed at the bottom of a function,
  // and a cast there would be re-stating a check instead of carrying it.
  let admittedUrl = "";
  let admittedCommand = "";

  if (isLoopback) {
    // A descriptor asking to spawn AND to connect is refused, never
    // disambiguated: guessing which half the operator meant is how a config
    // that says two things becomes a child nobody asked for.
    if (descriptor.command !== undefined) {
      return refuse("SERVER_NOT_ADMITTED", "descriptor.command");
    }
    if (descriptor.args !== undefined) {
      return refuse("SERVER_NOT_ADMITTED", "descriptor.args");
    }
    if (typeof descriptor.url !== "string") {
      return refuse("TRANSPORT_REFUSED", "descriptor.url");
    }
    const classified = classifyUrl(descriptor.url);
    if (!classified.ok) return refuse(classified.refusal, classified.at);
    admittedUrl = classified.url;
  } else {
    // A descriptor that claims STDIO and carries a URL is a remote server that
    // lied about its transport. It is judged as a URL — parsed, field by field
    // — rather than dismissed for having the field at all, and it stays refused
    // whether or not the URL turns out to be loopback.
    if (descriptor.url !== undefined) {
      if (typeof descriptor.url !== "string") {
        return refuse("TRANSPORT_REFUSED", "descriptor.url");
      }
      const classified = classifyUrl(descriptor.url);
      return classified.ok
        ? refuse("TRANSPORT_REFUSED", "descriptor.url")
        : refuse(classified.refusal, classified.at);
    }

    if (typeof descriptor.command !== "string" || !admitCommand(descriptor.command)) {
      return refuse("SERVER_NOT_ADMITTED", "descriptor.command");
    }
    admittedCommand = descriptor.command;
  }

  // Read back through `unknown` before validating. The declared type says
  // these are already an array of entries; the descriptor is untrusted input
  // and the runtime is the only place that knows. Going through `unknown`
  // keeps the narrowing honest rather than borrowing a guarantee from the type
  // that was never checked.
  const rawArgs: unknown = descriptor.args ?? [];
  if (!Array.isArray(rawArgs)) return refuse("SERVER_NOT_ADMITTED", "descriptor.args");
  const args = rawArgs as readonly unknown[];
  if (args.some((arg) => typeof arg !== "string")) {
    return refuse("SERVER_NOT_ADMITTED", "descriptor.args");
  }

  // An empty allowlist is a server nothing can ever call. Admitting one would
  // leave a live child that no request can reach — a process with no purpose
  // and no path to being noticed.
  const rawTools: unknown = descriptor.tools;
  if (!Array.isArray(rawTools)) return refuse("SERVER_NOT_ADMITTED", "descriptor.tools");
  const tools = rawTools as readonly unknown[];
  if (tools.length === 0) return refuse("SERVER_NOT_ADMITTED", "descriptor.tools");

  // P-24 (C7): one `at` grammar for the loop, indexed. The array itself is
  // `descriptor.tools`; an entry that is not an object is `descriptor.tools[i]`;
  // a field defect names the field.
  const names = new Set<string>();
  const allowlist: ToolAllowlistEntry[] = [];
  for (let index = 0; index < tools.length; index += 1) {
    const at = "descriptor.tools[" + String(index) + "]";
    const raw = tools[index];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return refuse("SERVER_NOT_ADMITTED", at);
    }
    const entry = raw as Record<string, unknown>;
    const name = entry["name"];
    const writes = entry["writes"];
    // Every allowlisted name is judged here, before the admitted server is
    // frozen and therefore before any of these names can reach a request. The
    // emptiness check is kept beside the grammar rather than folded into it:
    // it states the intent the grammar happens to imply, and it is the one a
    // reader checks first.
    if (typeof name !== "string" || name.length === 0 || !BOUNDED_IDENTIFIER.test(name)) {
      return refuse("SERVER_NOT_ADMITTED", at + ".name");
    }
    if (typeof writes !== "boolean") return refuse("SERVER_NOT_ADMITTED", at + ".writes");
    const inputSchema = admitPin(entry["inputSchema"]);
    if (inputSchema === null) return refuse("SERVER_NOT_ADMITTED", at + ".inputSchema");
    if (names.has(name)) return refuse("SERVER_NOT_ADMITTED", at + ".name");
    names.add(name);
    allowlist.push(Object.freeze({ name, writes, inputSchema }));
  }

  if (isLoopback) {
    return {
      ok: true,
      server: Object.freeze({
        serverId: descriptor.serverId,
        kind: "HTTP_LOOPBACK",
        // The descriptor's own string, verbatim. Nothing is normalized: a URL
        // this package rewrote would be a URL the operator did not review.
        url: admittedUrl,
        allowlist: Object.freeze(allowlist),
      }),
    };
  }

  return {
    ok: true,
    server: Object.freeze({
      serverId: descriptor.serverId,
      kind: "STDIO",
      command: admittedCommand,
      args: Object.freeze(args.map(String)),
      env: buildToolServerEnv(),
      allowlist: Object.freeze(allowlist),
    }),
  };
}

/**
 * The whole tool document, admitted or refused as one (V2-B4b stage 3C).
 *
 * The door reads and JSON-parses the operator's file and hands the **already
 * parsed value** here, as `unknown`. This module may not read a file — the law
 * confines `node:fs` to the command check above — and that division is the
 * right one anyway: reading is the entrypoint's job, deciding is this one's.
 *
 * `unknown` rather than a declared array is the same discipline
 * {@link admitToolServer} applies to `descriptor.args` and `descriptor.tools`:
 * the value came off a disk an operator edits, so the runtime is the only place
 * that knows its shape, and borrowing a guarantee from a declared type that was
 * never checked is how a malformed document becomes a live child.
 *
 * **All or nothing.** One bad descriptor refuses the document. A partial
 * admission would start a plane whose reachable tools depend on which entries
 * happened to parse, and an operator would have no way to tell a working
 * configuration from a half-working one.
 *
 * Refusals name the index, so `servers[2].serverId` points at the entry that
 * caused it rather than making an operator bisect the file.
 */
export function admitToolServers(raw: unknown): ToolDocumentOutcome {
  if (!Array.isArray(raw)) return { ok: false, refusal: "SERVER_NOT_ADMITTED", at: "servers" };
  const entries = raw as readonly unknown[];
  if (entries.length === 0) {
    return { ok: false, refusal: "SERVER_NOT_ADMITTED", at: "servers" };
  }

  const admitted: AdmittedToolServer[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const at = "servers[" + String(index) + "]";
    const entry = entries[index];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, refusal: "SERVER_NOT_ADMITTED", at };
    }
    const outcome = admitToolServer(entry as ToolServerDescriptor);
    if (!outcome.ok) {
      // The per-descriptor refusal already names its field; prefixing the index
      // keeps that precision and adds which entry it was about.
      return { ok: false, refusal: outcome.refusal, at: at + "." + outcome.at.replace(/^descriptor\./, "") };
    }
    // Two servers under one id would make `sessionId + "/" + serverId` name two
    // different children, so the connection key would stop identifying one.
    if (seen.has(outcome.server.serverId)) {
      return { ok: false, refusal: "SERVER_NOT_ADMITTED", at: at + ".serverId" };
    }
    seen.add(outcome.server.serverId);
    admitted.push(outcome.server);
  }

  return { ok: true, servers: Object.freeze(admitted) };
}
