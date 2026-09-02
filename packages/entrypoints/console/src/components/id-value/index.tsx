import { useState, type JSX } from "react";

import { truncateMiddle } from "../../format/index.js";

export interface IdValueProps {
  readonly value: string;
  /** Noun used in the disclosure control's accessible name, e.g. "task id". */
  readonly kind?: string;
  readonly headLength?: number;
  readonly tailLength?: number;
}

/**
 * A long opaque value (uuid, digest, identity) that wraps safely and never
 * hides its full form behind a hover-only tooltip.
 *
 * The value is truncated visually so it cannot blow out a table column. The
 * full value reaches assistive technology unconditionally, in a visually
 * hidden span, because a `title` attribute alone is unreachable without a
 * mouse and is not reliably announced. Sighted keyboard users get a separate
 * disclosure toggle to reveal the full string visually, for copying it.
 */
export function IdValue({ value, kind = "value", headLength, tailLength }: IdValueProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const truncated = truncateMiddle(value, headLength, tailLength);
  const isTruncated = truncated !== value;

  if (!isTruncated) {
    return <code className="id-value">{value}</code>;
  }

  return (
    <span className="id-value">
      <code aria-hidden={!expanded}>{expanded ? value : truncated}</code>
      {expanded ? null : <span className="sr-only">{value}</span>}
      <button
        type="button"
        className="id-value__toggle"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((previous) => !previous);
        }}
      >
        {expanded ? "Show less" : "Show full " + kind}
      </button>
    </span>
  );
}
