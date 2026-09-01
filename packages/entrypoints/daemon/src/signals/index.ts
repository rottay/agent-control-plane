/**
 * Signal handling, installed explicitly and never on import.
 *
 * Installing a handler is a side effect, and this package promises that
 * importing any of its modules has none. So nothing here runs until a caller
 * asks, and the binding hands back the means to undo itself: a test that left
 * handlers installed would leak them into every later test in the process.
 */

export type HandledSignal = "SIGTERM" | "SIGINT";

export const HANDLED_SIGNALS: readonly HandledSignal[] = Object.freeze(["SIGTERM", "SIGINT"]);

export interface SignalBinding {
  /** Remove the handlers. Idempotent. */
  release(): void;
  /** How many signals arrived, including the ones ignored as duplicates. */
  readonly received: () => number;
}

/**
 * Route SIGTERM and SIGINT into one bounded drain.
 *
 * The handler fires **once**. A second signal during draining is counted and
 * dropped rather than starting a concurrent shutdown: two unwinds racing over
 * the same resources is how a cleanup ends up unlinking a lock another path
 * already replaced.
 */
export function installSignalHandlers(
  onFirstSignal: (signal: HandledSignal) => void,
): SignalBinding {
  let count = 0;
  let fired = false;
  const handlers = new Map<HandledSignal, () => void>();

  for (const signal of HANDLED_SIGNALS) {
    const handler = (): void => {
      count += 1;
      if (fired) return;
      fired = true;
      onFirstSignal(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  let releasedAlready = false;
  return {
    release(): void {
      if (releasedAlready) return;
      releasedAlready = true;
      for (const [signal, handler] of handlers) process.off(signal, handler);
    },
    received: () => count,
  };
}
