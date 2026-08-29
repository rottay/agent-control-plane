import { type JSX } from "react";

import { classNames } from "../../format/index.js";
import { type Tone } from "../../format/status-tone/index.js";

export interface StatusBadgeProps {
  readonly label: string;
  readonly tone: Tone;
  /** Extra context read by assistive technology but not shown visually. */
  readonly srPrefix?: string;
}

/**
 * A status badge that never relies on color alone.
 *
 * Tone changes the badge's border and a small leading glyph, but the label
 * text is what actually carries the meaning, and it is always rendered.
 */
export function StatusBadge({ label, tone, srPrefix }: StatusBadgeProps): JSX.Element {
  return (
    <span className={classNames("badge", "badge--" + tone)}>
      {srPrefix !== undefined && srPrefix !== "" ? <span className="sr-only">{srPrefix + ": "}</span> : null}
      <span className="badge__glyph" aria-hidden="true">
        {TONE_GLYPH[tone]}
      </span>
      {label}
    </span>
  );
}

const TONE_GLYPH: Record<Tone, string> = {
  good: "●",
  neutral: "○",
  warn: "▲",
  bad: "✗",
};
