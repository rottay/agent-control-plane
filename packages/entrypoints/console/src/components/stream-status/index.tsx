import { type JSX } from "react";

import { type StreamConnectionState, type StreamSnapshot } from "../../api/stream/index.js";

export interface StreamStatusProps {
  readonly status: StreamSnapshot;
  /** Noun phrase for the surface this stream feeds, e.g. "the timeline". */
  readonly label: string;
}

/**
 * The live stream's own state, rendered (V2-B3b).
 *
 * The whole point of this component is that there is no silent state. Each of
 * the five is a visible sentence in a live region, so an operator watching a
 * control plane is never looking at a screen that stopped updating without
 * saying so — which is the failure mode a live view has and a paged view does
 * not.
 *
 * **What is rendered is a closed vocabulary.** The heading comes from the
 * table below and the sentence from either this file or `api/stream`'s own
 * detail strings. Nothing here interpolates a server-supplied message, a
 * payload, a path or a token: `detail` is written by the reconciler out of
 * fixed sentences plus sequence numbers and closed error codes, and a frame's
 * body never reaches this component at all — the views render rows through
 * `TimelineList`, from `TimelineItem` alone.
 */
const STATE_HEADING: Readonly<Record<StreamConnectionState, string>> = Object.freeze({
  connecting: "Connecting",
  live: "Live",
  recovering: "Recovering",
  degraded: "Degraded",
  disconnected: "Disconnected",
});

const STATE_TONE: Readonly<Record<StreamConnectionState, "good" | "neutral" | "warn" | "bad">> =
  Object.freeze({
    connecting: "neutral",
    live: "good",
    recovering: "warn",
    degraded: "warn",
    disconnected: "bad",
  });

function sentence(status: StreamSnapshot, label: string): string {
  if (status.detail !== null) {
    return status.detail;
  }
  if (status.state === "connecting") {
    return "Opening the live connection for " + label + ".";
  }
  if (status.state === "live") {
    return status.lastApplied === 0
      ? "Following " + label + ". No new event has arrived yet."
      : "Following " + label + ", applied in order through sequence " + String(status.lastApplied) + ".";
  }
  if (status.state === "recovering") {
    return (
      "A gap was detected after sequence " +
      String(status.lastApplied) +
      ". Filling it from the events route before applying anything further."
    );
  }
  return "The live connection is not delivering; " + label + " may not be current.";
}

export function StreamStatus({ status, label }: StreamStatusProps): JSX.Element {
  const tone = STATE_TONE[status.state];
  return (
    <div
      className={"stream-status stream-status--" + tone}
      data-stream-state={status.state}
      role="status"
      aria-live="polite"
    >
      <span className="stream-status__dot" aria-hidden="true" />
      <span className="stream-status__heading">{STATE_HEADING[status.state]}</span>
      <span className="stream-status__message">{sentence(status, label)}</span>
      {status.droppedFrames > 0 ? (
        <span className="stream-status__counter">
          {status.droppedFrames} replayed frame{status.droppedFrames === 1 ? "" : "s"} dropped
        </span>
      ) : null}
    </div>
  );
}
