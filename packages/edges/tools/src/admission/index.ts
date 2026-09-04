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
import { TOOL_SERVER_ENV_KEYS, TOOL_TRANSPORT_KINDS } from "../contract/index.js";

/**
 * A server the plane has decided it may talk to.
 *
 * Constructed here and nowhere else — the fence asserts that too. Everything
 * on it is already a decision: the command was admitted, the environment was
 * built from the allowlist, the tool list is non-empty and free of duplicates.
 */
export interface AdmittedToolServer {
  readonly serverId: string;
  readonly kind: ToolTransportKind;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly allowlist: readonly ToolAllowlistEntry[];
}

export type ToolAdmissionOutcome =
  | { readonly ok: true; readonly server: AdmittedToolServer }
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
function refuseUrl(raw: string): ToolAdmissionOutcome {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("TRANSPORT_REFUSED", "descriptor.url");
  }
  if (url.protocol !== "http:") {
    return refuse("TRANSPORT_REFUSED", "descriptor.url.protocol");
  }
  if (url.username !== "" || url.password !== "") {
    return refuse("TRANSPORT_REFUSED", "descriptor.url.credentials");
  }
  // `URL` brackets an IPv6 host; compare against the literal it wraps.
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!TOOL_LOOPBACK_HOSTS.includes(hostname)) {
    return refuse("TRANSPORT_REFUSED", "descriptor.url.hostname");
  }
  const port = Number(url.port);
  if (url.port === "" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return refuse("TRANSPORT_REFUSED", "descriptor.url.port");
  }
  // A well-formed loopback URL, and still refused: no transport in
  // `TOOL_TRANSPORT_KINDS` carries one. This is the honest shape of "not yet"
  // — the parse happened, every field was judged, and the descriptor is
  // refused for the reason that is actually true, rather than for a
  // manufactured one. The stage that adds the transport widens the union and
  // returns this leg's server; it deletes nothing above.
  return refuse("TRANSPORT_REFUSED", "descriptor.url");
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

  // A descriptor that claims STDIO and carries a URL is a remote server that
  // lied about its transport. It is judged as a URL — parsed, field by field —
  // rather than dismissed for having the field at all.
  if (descriptor.url !== undefined) {
    if (typeof descriptor.url !== "string") {
      return refuse("TRANSPORT_REFUSED", "descriptor.url");
    }
    return refuseUrl(descriptor.url);
  }

  if (typeof descriptor.command !== "string" || !admitCommand(descriptor.command)) {
    return refuse("SERVER_NOT_ADMITTED", "descriptor.command");
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

  const names = new Set<string>();
  const allowlist: ToolAllowlistEntry[] = [];
  for (const raw of tools) {
    if (raw === null || typeof raw !== "object") {
      return refuse("SERVER_NOT_ADMITTED", "descriptor.tools");
    }
    const entry = raw as Record<string, unknown>;
    const name = entry["name"];
    const writes = entry["writes"];
    // Every allowlisted name is judged here, before the admitted server is
    // frozen and therefore before any of these names can reach a request. The
    // emptiness check is kept beside the grammar rather than folded into it:
    // it states the intent the grammar happens to imply, and it is the one a
    // reader checks first.
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      !BOUNDED_IDENTIFIER.test(name) ||
      typeof writes !== "boolean"
    ) {
      return refuse("SERVER_NOT_ADMITTED", "descriptor.tools");
    }
    if (names.has(name)) return refuse("SERVER_NOT_ADMITTED", "descriptor.tools");
    names.add(name);
    allowlist.push(Object.freeze({ name, writes }));
  }

  return {
    ok: true,
    server: Object.freeze({
      serverId: descriptor.serverId,
      kind: "STDIO",
      command: descriptor.command,
      args: Object.freeze(args.map(String)),
      env: buildToolServerEnv(),
      allowlist: Object.freeze(allowlist),
    }),
  };
}
