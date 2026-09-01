import { type RoadmapVersionDto } from "@acp/api-contracts";
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState, type JSX } from "react";

import { fetchInitiativeRoadmap, fetchRoadmapContent, getSessionBearerToken, writeRoadmapVersion } from "../../api/client/index.js";
import { classifyBearerErrorCode } from "../bearer-field/index.js";
import { classNames, truncateMiddle } from "../../format/index.js";
import { useAsyncResource } from "../../hooks/use-async-resource/index.js";

/**
 * The roadmap edit dialog, on `@radix-ui/react-dialog` (blueprint v2 §3,
 * C6). The plane's second interactive region and its only write surface.
 *
 * **`Dialog.Portal`, adopted (P8-9-3, D7/C4).** The earlier absence was
 * never a claim that a portal was wrong — `ReactDOMServer` does not render
 * portals at all, and this package's only DOM was a string, so a portaled
 * dialog would have been invisible to every assertion this file had.
 * Live-DOM evidence (P8-9-2) removed that constraint, and the DT's own
 * register carried the adoption forward for exactly this cohort to close.
 * The pre-adoption shape was swept for aria-hidden correctness first (its
 * own test, `test/components/edit-roadmap-dialog/index.test.tsx`) and the
 * result — siblings already read `aria-hidden="true"` while the dialog is
 * open, because Radix's isolation walks up to `document.body` and hides
 * siblings there regardless of where the dialog's own content physically
 * mounts — is unchanged after adoption, re-swept by the same function. No
 * `forceMount`, still: the closed dialog contributes no content and no
 * accessibility-isolation cascade, the lesson the switcher's own correction
 * wrote into law, and closed-content mounting stays forbidden by name
 * everywhere in this cohort — Portal changes *where* the open dialog's
 * content lives, never *whether* the closed dialog exists at all.
 *
 * **Fully controlled, no `Dialog.Trigger`.** The workspace opens this one
 * dialog instance from several places — the head version's "Edit" button and
 * every history row's "Restore this version" — each with different pre-fill
 * parameters. A `Dialog.Trigger` models one trigger per one dialog; `open`
 * and `onOpenChange` model any number, so the workspace owns the open state
 * and every trigger is a plain button that sets it.
 *
 * **The body is a separate component, mounted only while open.** Its content
 * fetch (the pre-fill) and its draft state both live there, so opening the
 * dialog is what starts the fetch and closing it is what discards the draft
 * — no state survives a close to leak into the next open, and no fetch runs
 * for a dialog nobody is looking at.
 */

export interface EditRoadmapDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly initiativeId: string;
  readonly kind: "EDIT" | "ROLLBACK";
  /** Which version's content pre-fills the draft. `null` only for the first version — nothing to pre-fill. */
  readonly prefillVersion: number | null;
  /** The current head's digest, the optimistic-concurrency claim. `null` only when no version exists yet. */
  readonly expectedHeadDigest: string | null;
  /** Set exactly when `kind` is `ROLLBACK`: the version being restored. */
  readonly restoresVersionId: string | null;
  /** The label a rollback names, e.g. "v3" — shown in the dialog's title. */
  readonly restoresVersionLabel: string | null;
  /** Called once a version is granted, so the workspace can refresh. */
  readonly onGranted: () => void;
}

export type SubmitState =
  | { readonly phase: "idle" }
  | { readonly phase: "submitting" }
  | { readonly phase: "granted"; readonly version: RoadmapVersionDto; readonly sequence: number }
  | { readonly phase: "refused-schema"; readonly field: string; readonly message: string }
  | { readonly phase: "refused-decision"; readonly name: string | null; readonly message: string }
  // P8-8G packet 3: the bearer's two first-class non-success states, kept
  // apart exactly as the server keeps their codes apart (blueprint v2 §5) —
  // one is a caller problem (the presented token was wrong), the other an
  // operator problem (this server holds no token at all).
  | { readonly phase: "refused-unauthorized"; readonly message: string }
  | { readonly phase: "refused-unarmed"; readonly message: string }
  | { readonly phase: "refused-internal"; readonly message: string }
  | { readonly phase: "refused-other"; readonly message: string };

export const DECISION_REFUSAL_NAMES = [
  "HEAD_MISMATCH",
  "REQUEST_INVALID",
  "RESTORES_UNKNOWN_VERSION",
  "ROLLBACK_DIGEST_MISMATCH",
  "PARENT_MISMATCH",
  "VERSION_NOT_MONOTONIC",
  "CONTENT_REJECTED",
] as const;

/** The refusal's own vocabulary name, read out of the message that carries it (N2). */
export function decisionRefusalName(message: string): string | null {
  return DECISION_REFUSAL_NAMES.find((name) => message.includes(name)) ?? null;
}

/**
 * The granted receipt: the new version, the digest, the sequence it landed
 * at (blueprint v2 §3). Pure — given only what a `writeRoadmapVersion` call
 * returned — so a test can render every outcome state directly rather than
 * only ever observing a fresh dialog's idle form (submitting a real POST is
 * not something a DOM-less static render can exercise at all).
 */
export function GrantedReceipt({
  version,
  sequence,
  onClose,
}: {
  readonly version: RoadmapVersionDto;
  readonly sequence: number;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <div role="status" aria-live="polite" className="dialog__outcome dialog__outcome--granted">
      <p className="dialog__outcome-title">Recorded as v{version.version}.</p>
      <p>
        Digest <code>{truncateMiddle(version.contentDigest, 8, 6)}</code>, sequence {sequence}.
      </p>
      <button type="button" className="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

/**
 * The refusal-state table's non-schema halves (blueprint v2 §3, C4):
 * a decision's own vocabulary name (with `HEAD_MISMATCH`'s named
 * reload-and-reapply affordance), `INTERNAL`'s distinct retryable wording
 * (N1), and every other classified failure. Renders nothing for `idle` or
 * `submitting` — those have no outcome yet — and nothing for `refused-schema`
 * or `granted`, which live beside the field they mark and above the form
 * respectively. Exported for the same reason `GrantedReceipt` is: a fixture
 * `SubmitState` is the only way this table's static half is reachable in a
 * DOM-less test.
 */
export function RefusalOutcome({
  submit,
  onReloadAndReapply,
}: {
  readonly submit: SubmitState;
  readonly onReloadAndReapply: () => void;
}): JSX.Element | null {
  if (submit.phase === "refused-decision") {
    return (
      <div className="dialog__outcome dialog__outcome--refused">
        <p className="dialog__outcome-title">Refused: {submit.name ?? "unknown"}.</p>
        <p>{submit.message}</p>
        {submit.name === "HEAD_MISMATCH" ? (
          <button type="button" className="button button--quiet" onClick={onReloadAndReapply}>
            Reload the head and reapply
          </button>
        ) : null}
      </div>
    );
  }
  if (submit.phase === "refused-unauthorized") {
    return (
      <div className="dialog__outcome dialog__outcome--refused">
        <p className="dialog__outcome-title">The presented token was not accepted.</p>
        <p>{submit.message}</p>
      </div>
    );
  }
  if (submit.phase === "refused-unarmed") {
    return (
      <div className="dialog__outcome dialog__outcome--refused">
        <p className="dialog__outcome-title">This server holds no write token to check against.</p>
        <p>{submit.message}</p>
      </div>
    );
  }
  if (submit.phase === "refused-internal") {
    return (
      <div className="dialog__outcome dialog__outcome--refused">
        <p className="dialog__outcome-title">Something went wrong. This is retryable.</p>
        <p>{submit.message}</p>
      </div>
    );
  }
  if (submit.phase === "refused-other") {
    return (
      <div className="dialog__outcome dialog__outcome--refused">
        <p className="dialog__outcome-title">The request did not go through.</p>
        <p>{submit.message}</p>
      </div>
    );
  }
  return null;
}

export function EditRoadmapDialog({
  open,
  onOpenChange,
  initiativeId,
  kind,
  prefillVersion,
  expectedHeadDigest,
  restoresVersionId,
  restoresVersionLabel,
  onGranted,
}: EditRoadmapDialogProps): JSX.Element {
  const title = kind === "ROLLBACK" ? "Restore " + (restoresVersionLabel ?? "a version") : "Edit the roadmap";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {open ? (
        <Dialog.Portal>
          <Dialog.Overlay className="dialog__overlay" />
          <Dialog.Content className="dialog__content" aria-describedby="edit-roadmap-description">
            <Dialog.Title className="dialog__title">{title}</Dialog.Title>
            <Dialog.Description id="edit-roadmap-description" className="dialog__description">
              {kind === "ROLLBACK"
                ? "Records a new version carrying " + (restoresVersionLabel ?? "the restored version") + "'s content."
                : "Records a new version of this initiative's roadmap document."}
            </Dialog.Description>
            <EditRoadmapDialogBody
              initiativeId={initiativeId}
              kind={kind}
              prefillVersion={prefillVersion}
              expectedHeadDigest={expectedHeadDigest}
              restoresVersionId={restoresVersionId}
              onGranted={onGranted}
              onClose={() => {
                onOpenChange(false);
              }}
            />
          </Dialog.Content>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  );
}

interface EditRoadmapDialogBodyProps {
  readonly initiativeId: string;
  readonly kind: "EDIT" | "ROLLBACK";
  readonly prefillVersion: number | null;
  readonly expectedHeadDigest: string | null;
  readonly restoresVersionId: string | null;
  readonly onGranted: () => void;
  readonly onClose: () => void;
}

function EditRoadmapDialogBody({
  initiativeId,
  kind,
  prefillVersion,
  expectedHeadDigest,
  restoresVersionId,
  onGranted,
  onClose,
}: EditRoadmapDialogBodyProps): JSX.Element {
  const prefill = useAsyncResource(
    (signal) =>
      prefillVersion === null
        ? Promise.resolve({ kind: "ok" as const, data: null })
        : fetchRoadmapContent(initiativeId, prefillVersion, signal),
    [initiativeId, prefillVersion],
  );

  const [draft, setDraft] = useState("");
  const [recordedBy, setRecordedBy] = useState("");
  const [claim, setClaim] = useState(expectedHeadDigest);
  const [submit, setSubmit] = useState<SubmitState>({ phase: "idle" });
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current) {
      return;
    }
    if (prefillVersion === null) {
      seeded.current = true;
      return;
    }
    if (prefill.resource.status === "success" && prefill.resource.data !== null) {
      setDraft(prefill.resource.data.content);
      seeded.current = true;
    }
  }, [prefill.resource, prefillVersion]);

  async function handleSubmit(): Promise<void> {
    setSubmit({ phase: "submitting" });
    const result = await writeRoadmapVersion(initiativeId, {
      content: draft,
      expectedHeadDigest: claim,
      kind,
      restoresVersionId,
      recordedBy,
    });

    if (result.kind === "ok") {
      setSubmit({ phase: "granted", version: result.data.version, sequence: result.data.sequence });
      onGranted();
      return;
    }
    if (result.kind === "api-error") {
      if (result.code === "BAD_REQUEST") {
        setSubmit({ phase: "refused-schema", field: result.detail ?? "(root)", message: result.message });
        return;
      }
      if (result.code === "WRITE_REFUSED") {
        setSubmit({ phase: "refused-decision", name: decisionRefusalName(result.message), message: result.message });
        return;
      }
      const bearerErrorKind = classifyBearerErrorCode(result.code);
      if (bearerErrorKind === "unauthorized") {
        setSubmit({ phase: "refused-unauthorized", message: result.message });
        return;
      }
      if (bearerErrorKind === "unconfigured") {
        setSubmit({ phase: "refused-unarmed", message: result.message });
        return;
      }
      if (result.code === "INTERNAL") {
        setSubmit({ phase: "refused-internal", message: result.message });
        return;
      }
      setSubmit({ phase: "refused-other", message: result.message });
      return;
    }
    if (result.kind === "network-error") {
      setSubmit({ phase: "refused-other", message: result.detail });
      return;
    }
    setSubmit({ phase: "refused-other", message: "The response did not match the API contract this build expects." });
  }

  /**
   * `HEAD_MISMATCH`'s named affordance: refresh the concurrency claim
   * silently, touching nothing else. The draft is not cleared — it is not
   * even read here — because surviving every refusal (blueprint v2 §3)
   * includes this one: the operator loses nothing but the stale claim.
   */
  async function handleReloadAndReapply(): Promise<void> {
    const history = await fetchInitiativeRoadmap(initiativeId);
    if (history.kind === "ok") {
      const head = history.data.items.find((item) => item.head);
      setClaim(head?.contentDigest ?? null);
    }
    setSubmit({ phase: "idle" });
  }

  if (submit.phase === "granted") {
    return <GrantedReceipt version={submit.version} sequence={submit.sequence} onClose={onClose} />;
  }

  const fieldError = submit.phase === "refused-schema" ? submit : null;
  // P8-8G packet 3: unarmed is a posture the submit button explains, never a
  // surprise 401 mid-flight (blueprint v2 §3). Read fresh at render rather
  // than threaded through a prop: the bearer field mounts at the app root,
  // above every view including this dialog's own workspace, and this dialog
  // is reached through a view outside this packet's write-set, so there is
  // no path to thread the value down through.
  const armed = getSessionBearerToken() !== null;
  const disabled = submit.phase === "submitting" || draft.trim() === "" || recordedBy.trim() === "" || !armed;

  return (
    <form
      className="dialog__form"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <div className="field">
        <label htmlFor="edit-roadmap-content">Content</label>
        <textarea
          id="edit-roadmap-content"
          className={classNames("dialog__textarea", fieldError?.field === "content" ? "has-error" : undefined)}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          rows={14}
          aria-describedby={fieldError?.field === "content" ? "edit-roadmap-content-error" : undefined}
          aria-invalid={fieldError?.field === "content" ? true : undefined}
        />
        {fieldError?.field === "content" ? (
          <p id="edit-roadmap-content-error" className="field-error">
            {fieldError.message}
          </p>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="edit-roadmap-recorded-by">Recorded by</label>
        <input
          id="edit-roadmap-recorded-by"
          type="text"
          value={recordedBy}
          onChange={(event) => {
            setRecordedBy(event.target.value);
          }}
          placeholder="provider/model/role/instance"
          aria-describedby="edit-roadmap-recorded-by-hint"
        />
        <p id="edit-roadmap-recorded-by-hint" className="field-hint">
          Your own worker identity, in the landed format.
        </p>
      </div>

      <p className="dialog__claim">
        Recording against head{" "}
        {claim !== null ? <code>{truncateMiddle(claim, 8, 6)}</code> : <em>none (first version)</em>}.
      </p>

      <div role="status" aria-live="polite" className="dialog__outcome-region">
        <RefusalOutcome
          submit={submit}
          onReloadAndReapply={() => {
            void handleReloadAndReapply();
          }}
        />
      </div>

      {!armed && submit.phase === "idle" ? (
        <p className="dialog__claim">Unarmed — paste an operator token above to record this version.</p>
      ) : null}

      <div className="dialog__actions">
        <button type="button" className="button button--quiet" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="button" disabled={disabled}>
          {submit.phase === "submitting" ? "Recording…" : "Record version"}
        </button>
      </div>
    </form>
  );
}
