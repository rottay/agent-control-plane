import { useState, type JSX } from "react";

/**
 * The write surface's session-only credential field (P8-8G packet 3,
 * blueprint v2 §3).
 *
 * `App` (the app root) owns the `useState` that actually holds the token and
 * mounts this component controlled — `armed` names whether one is currently
 * held, `onArm` is called with a freshly-pasted token, `onClear` drops it.
 * This component itself holds only the draft text mid-paste; the moment a
 * paste is armed the draft is discarded, so the token sits in this input's
 * DOM node for the shortest time this UI can manage rather than staying
 * mounted back into the field after submission.
 *
 * **Unarmed is a posture, not a failure (v2 §3, N1).** Nothing here reads as
 * an error state: an unarmed field is what every fresh session starts in, and
 * the paragraph below says so plainly rather than with warning color.
 */

export interface BearerFieldProps {
  readonly armed: boolean;
  readonly onArm: (token: string) => void;
  readonly onClear: () => void;
}

export function BearerField({ armed, onArm, onClear }: BearerFieldProps): JSX.Element {
  const [draft, setDraft] = useState("");

  return (
    <form
      className="bearer-field"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim() === "") {
          return;
        }
        onArm(draft);
        setDraft("");
      }}
      aria-label="Operator write token"
    >
      <div className="field bearer-field__input">
        <label htmlFor="bearer-token">Operator token</label>
        <input
          id="bearer-token"
          type="password"
          autoComplete="off"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          placeholder={armed ? "Armed — paste a new token to replace it" : "Paste a token to arm writes"}
        />
      </div>
      <div className="bearer-field__actions">
        <button type="submit" className="button button--quiet" disabled={draft.trim() === ""}>
          Arm
        </button>
        {armed ? (
          <button
            type="button"
            className="button button--quiet"
            onClick={() => {
              setDraft("");
              onClear();
            }}
          >
            Clear
          </button>
        ) : null}
      </div>
      <p className="bearer-field__posture" role="status" aria-live="polite">
        {armed
          ? "Armed. Write actions send this token; it is never shown again here."
          : "Unarmed. Reads still work. Writes will explain themselves rather than fail."}
      </p>
    </form>
  );
}

/**
 * The write-door bearer's two first-class non-success states, read out of an
 * `ApiResult`'s classified code (blueprint v2 §5). `null` for every other
 * code, which each write surface still has its own generic handling for.
 */
export type BearerErrorKind = "unauthorized" | "unconfigured";

export function classifyBearerErrorCode(code: string): BearerErrorKind | null {
  if (code === "AUTH_REQUIRED") {
    return "unauthorized";
  }
  if (code === "WRITE_BEARER_UNCONFIGURED") {
    return "unconfigured";
  }
  return null;
}
