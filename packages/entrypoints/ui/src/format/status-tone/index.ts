/**
 * Cosmetic tone mapping from a contract state string to a badge color.
 *
 * These are heuristics, not a restatement of the lifecycle. The UI package
 * cannot depend on `@acp/contracts` (only on the browser-safe
 * `@acp/api-contracts`), so it never claims to enumerate every task state —
 * it pattern-matches on the shape of the name and falls back to a neutral
 * tone for anything it does not recognise. A state this heuristic gets wrong
 * is still shown with its correct label; only the color is a best effort.
 */

export type Tone = "good" | "neutral" | "warn" | "bad";

export function overviewStateTone(state: string): Tone {
  switch (state) {
    case "ACTIVE":
      return "good";
    case "EMPTY":
      return "neutral";
    case "DEGRADED":
      return "warn";
    case "UNAVAILABLE":
      return "bad";
    default:
      return "neutral";
  }
}

export function healthStateTone(state: string): Tone {
  switch (state) {
    case "OK":
      return "good";
    case "DEGRADED":
      return "warn";
    case "UNAVAILABLE":
      return "bad";
    default:
      return "neutral";
  }
}

const NEGATIVE_MARKERS = ["FAIL", "REJECT", "CANCEL", "SUSPECT"];
const WAITING_MARKERS = ["WAITING", "BLOCKED", "REQUIRED", "DRAIN"];

export function taskStateTone(state: string, isTerminal: boolean): Tone {
  const upper = state.toUpperCase();
  if (NEGATIVE_MARKERS.some((marker) => upper.includes(marker))) {
    return "bad";
  }
  if (isTerminal) {
    return "good";
  }
  if (WAITING_MARKERS.some((marker) => upper.includes(marker))) {
    return "warn";
  }
  return "neutral";
}

export function integrityTone(ok: boolean | null): Tone {
  if (ok === null) {
    return "neutral";
  }
  return ok ? "good" : "bad";
}

/**
 * The initiative status enum's tones. (P8-8C.)
 *
 * None of the four states — `ACTIVE`, `PAUSED`, `COMPLETED`, `ARCHIVED` — is a
 * failure, so `bad` never appears here: an initiative does not have a failed
 * status, only ones that are moving, resting, finished or shelved. This lives
 * beside every other tone mapping rather than in the portfolio view, which is
 * the law this module exists to hold — a view-local map is a second place a
 * tone could drift from the ones already named here.
 */
export function initiativeStatusTone(status: string): Tone {
  switch (status) {
    case "ACTIVE":
      return "good";
    case "PAUSED":
      return "warn";
    case "COMPLETED":
      return "good";
    case "ARCHIVED":
      return "neutral";
    default:
      return "neutral";
  }
}

/**
 * The roadmap-version kind enum's tones. (P8-8D.)
 *
 * `EDIT` is the ordinary case — a version moving forward — and reads
 * `neutral`, not `good`: recording an edit is not an achievement, only an
 * act. `ROLLBACK` reads `warn`: it is never wrong to restore an earlier
 * version, but it is always worth a second look, since it means the roadmap
 * is moving backward on purpose.
 */
export function roadmapVersionKindTone(kind: string): Tone {
  switch (kind) {
    case "EDIT":
      return "neutral";
    case "ROLLBACK":
      return "warn";
    default:
      return "neutral";
  }
}
