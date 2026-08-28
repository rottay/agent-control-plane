import type {
  CapabilityOutcome,
  ParseCursor,
  ParseOutcome,
  ProviderAdapter,
  ProviderSignal,
  SessionDescriptor,
  SessionRequest,
} from "../contract.js";
import { EMPTY_CURSOR, unknownCapabilities } from "../contract.js";

/**
 * A scripted stand-in for a provider.
 *
 * Every negative in this package is driven by this rather than by a real
 * provider: no auth, no network, no account, no product path. What it proves
 * is *our* machinery — the parser, the budget, the ladder, the state machine.
 *
 * It deliberately proves nothing about any real provider, and the capability
 * model refuses to let it: evidence produced here carries `subject: "FAKE"`,
 * which can never confirm a provider capability. This module is **not** part
 * of the package's closed public surface; tests import it by relative path.
 */

/** One newline-delimited JSON record per signal, which is all the fake speaks. */
export interface FakeScript {
  readonly lines: readonly string[];
  readonly exitCode: number;
  /** Emit to stderr instead of stdout, to exercise the shared budget. */
  readonly toStderr?: boolean;
  /** Ignore SIGINT, so the escalation ladder has to do real work. */
  readonly ignoreSigint?: boolean;
  /** Delay before exiting, in milliseconds. */
  readonly lingerMs?: number;
}

/** The Node program the fake runs. Written as argv, never as a shell string. */
export function fakeProviderArgv(script: FakeScript): readonly string[] {
  const program = [
    script.ignoreSigint === true ? "process.on('SIGINT', () => {});" : "",
    "const out = " + (script.toStderr === true ? "process.stderr" : "process.stdout") + ";",
    "const lines = " + JSON.stringify([...script.lines]) + ";",
    "for (const line of lines) out.write(line + '\\n');",
    script.lingerMs !== undefined && script.lingerMs > 0
      ? "setTimeout(() => process.exit(" + String(script.exitCode) + "), " + String(script.lingerMs) + ");"
      : "process.exit(" + String(script.exitCode) + ");",
  ].join("\n");
  return Object.freeze(["-e", program]);
}

/** Turn one JSON record into a provider signal, or refuse it. */
function readRecord(raw: string): ProviderSignal | "UNKNOWN" | "MALFORMED" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return "MALFORMED";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "MALFORMED";
  const record = parsed as Record<string, unknown>;
  const type = record["type"];
  if (typeof type !== "string") return "MALFORMED";

  switch (type) {
    case "started": {
      const model = record["resolvedModel"];
      const version = record["protocolVersion"];
      if (typeof model !== "string" || typeof version !== "string") return "MALFORMED";
      return { kind: "started", resolvedModel: model, protocolVersion: version };
    }
    case "step": {
      const tokens = record["tokensUsed"];
      const index = record["stepIndex"];
      if (typeof tokens !== "number" || typeof index !== "number") return "MALFORMED";
      return { kind: "step", tokensUsed: tokens, stepIndex: index };
    }
    case "checkpoint": {
      const digest = record["digest"];
      if (typeof digest !== "string") return "MALFORMED";
      return { kind: "checkpoint", digest };
    }
    case "authRequired": {
      const reason = record["reason"];
      if (typeof reason !== "string") return "MALFORMED";
      return { kind: "authRequired", reason };
    }
    case "state": {
      const toState = record["toState"];
      if (typeof toState !== "string") return "MALFORMED";
      return { kind: "state", toState };
    }
    case "write": {
      const target = record["target"];
      if (typeof target !== "string") return "MALFORMED";
      return { kind: "write", target };
    }
    default:
      return "UNKNOWN";
  }
}

/**
 * The fake's adapter: newline-framed JSON, with a carry-over partial record.
 *
 * The partial is what makes the framing honest. A chunk boundary lands wherever
 * the operating system put it, not where a record ends, so a parser that
 * assumed whole records per chunk would work in every test and fail in every
 * real stream.
 */
export const fakeAdapter: ProviderAdapter = {
  provider: "claude",

  describe(request: SessionRequest): SessionDescriptor {
    return {
      provider: "claude",
      argv: ["-e", "process.exit(0);"],
      env: { PATH: "/usr/bin:/bin" },
      cwd: request.workdir,
    };
  },

  parse(chunk: string, cursor: ParseCursor): ParseOutcome {
    const buffered = cursor.partial + chunk;
    const parts = buffered.split("\n");
    const partial = parts.pop() ?? "";
    const events: ProviderSignal[] = [];
    let index = cursor.recordIndex;

    for (const line of parts) {
      if (line.trim() === "") continue;
      const outcome = readRecord(line);
      if (outcome === "UNKNOWN") {
        return { ok: false, code: "UNKNOWN_EVENT", detail: "record " + String(index) };
      }
      if (outcome === "MALFORMED") {
        return { ok: false, code: "MALFORMED_EVENT", detail: "record " + String(index) };
      }
      events.push(outcome);
      index += 1;
    }
    return { ok: true, events, cursor: { partial, recordIndex: index } };
  },

  negotiate(): CapabilityOutcome {
    // A fake never confirms a provider capability. Everything stays UNKNOWN.
    return { ok: true, capabilities: unknownCapabilities(), protocolVersion: "fake-1" };
  },
};

export { EMPTY_CURSOR };
