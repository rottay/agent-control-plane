import { type JSX } from "react";

export interface BarBreakdownItem {
  readonly label: string;
  readonly count: number;
}

export interface BarBreakdownProps {
  readonly caption: string;
  readonly items: readonly BarBreakdownItem[];
  readonly total: number;
}

/**
 * A proportional bar breakdown with no charting dependency.
 *
 * The bar itself is a decorative, `aria-hidden` fill inside each row; the
 * information it visualizes — label, count, share of the total — is plain
 * text in the same row, so a screen reader gets the same facts a sighted
 * reader gets from the bar, just read instead of seen.
 */
export function BarBreakdown({ caption, items, total }: BarBreakdownProps): JSX.Element {
  const sorted = [...items].sort((a, b) => b.count - a.count);
  return (
    <figure className="bar-breakdown">
      <figcaption>{caption}</figcaption>
      <ul className="bar-breakdown__list">
        {sorted.map((item) => {
          const share = total > 0 ? (item.count / total) * 100 : 0;
          const rounded = Math.round(share * 10) / 10;
          return (
            <li key={item.label} className="bar-breakdown__row">
              <span className="bar-breakdown__label">{item.label}</span>
              <span className="bar-breakdown__track" aria-hidden="true">
                <span className="bar-breakdown__fill" style={{ width: `${rounded}%` }} />
              </span>
              <span className="bar-breakdown__value">
                {item.count} <span className="bar-breakdown__percent">({rounded}%)</span>
              </span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
