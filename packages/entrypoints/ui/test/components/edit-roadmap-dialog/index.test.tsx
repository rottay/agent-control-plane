// @vitest-environment jsdom
import { API_CONTRACT_VERSION, LEDGER_CONTRACT_VERSION } from "@acp/api-contracts";
import { useState, type JSX } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setSessionBearerToken } from "../../../src/api/client/index.js";
import {
  decisionRefusalName,
  EditRoadmapDialog,
  GrantedReceipt,
  RefusalOutcome,
  type SubmitState,
} from "../../../src/components/edit-roadmap-dialog/index.js";
import { auditAndReport, cleanupMountedRoots, clickAndSettle, pressKey, renderIntoDocument, settle, typeInto } from "../../live-dom/index.js";

const INITIATIVE_ID = "123e4567-e89b-12d3-a456-426614174000";
const DIGEST_A = "a".repeat(64);

const noop = (): void => {
  // open-change/granted/reload are not exercised in a static render
};

afterEach(() => {
  // P8-8G packet 3: the bearer is module-scoped state in api/client; a test
  // that arms it must not leak an armed token into every test after it.
  setSessionBearerToken(null);
  cleanupMountedRoots();
});

/**
 * The D7/C4 aria-hidden sweep (P8-9-3): does everything outside the open
 * dialog read as hidden to assistive tech, and does the closed dialog
 * contribute nothing at all?
 *
 * Run once against the pre-`Dialog.Portal` shape (recorded in the packet's
 * own report, per the blueprint's instruction) and again after adoption —
 * both runs are this one function, so a regression the Portal migration
 * might introduce shows as a diff between two calls of the same check,
 * not as two differently-shaped assertions that could quietly drift apart.
 */
function ariaHiddenSweep(): {
  readonly siblingHiddenWhileOpen: string | null;
  readonly dialogRoleWhileOpen: string | null;
  readonly bodyHasDialogContentWhileClosed: boolean;
} {
  const sibling = document.createElement("button");
  sibling.type = "button";
  sibling.id = "sweep-sibling";
  sibling.textContent = "sibling control";
  document.body.appendChild(sibling);

  const mounted = renderIntoDocument(
    <EditRoadmapDialog
      open={true}
      onOpenChange={noop}
      initiativeId={INITIATIVE_ID}
      kind="EDIT"
      prefillVersion={null}
      expectedHeadDigest={null}
      restoresVersionId={null}
      restoresVersionLabel={null}
      onGranted={noop}
    />,
  );

  const siblingHiddenWhileOpen = sibling.getAttribute("aria-hidden");
  const dialogRoleWhileOpen = document.body.querySelector('[role="dialog"]')?.getAttribute("role") ?? null;

  mounted.unmount();
  sibling.remove();

  const closedMount = renderIntoDocument(
    <EditRoadmapDialog
      open={false}
      onOpenChange={noop}
      initiativeId={INITIATIVE_ID}
      kind="EDIT"
      prefillVersion={1}
      expectedHeadDigest={DIGEST_A}
      restoresVersionId={null}
      restoresVersionLabel={null}
      onGranted={noop}
    />,
  );
  const bodyHasDialogContentWhileClosed = document.body.querySelector('[role="dialog"]') !== null;
  closedMount.unmount();

  return { siblingHiddenWhileOpen, dialogRoleWhileOpen, bodyHasDialogContentWhileClosed };
}

describe("EditRoadmapDialog — closed-content mounting is forbidden (C5)", () => {
  // Migrated to live-DOM (P8-9-3, D7): `ReactDOMServer` never renders a
  // portal at all, open or closed, so a static render of this dialog would
  // "prove" the closed state contributes nothing for a reason that has
  // nothing to do with the dialog being closed. Querying `document.body` —
  // where `Dialog.Portal` actually mounts — is what makes this claim about
  // the closed state specifically, not about the renderer.
  it("contributes no dialog content while closed", () => {
    renderIntoDocument(
      <EditRoadmapDialog
        open={false}
        onOpenChange={noop}
        initiativeId={INITIATIVE_ID}
        kind="EDIT"
        prefillVersion={1}
        expectedHeadDigest={DIGEST_A}
        restoresVersionId={null}
        restoresVersionLabel={null}
        onGranted={noop}
      />,
    );
    expect(document.body.querySelector("textarea")).toBeNull();
    expect(document.body.textContent).not.toContain("Recorded by");
    expect(document.body.querySelector('[role="status"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("EditRoadmapDialog — the aria-hidden sweep (P8-9-3, D7/C4)", () => {
  // Run against the pre-`Dialog.Portal` shape and recorded in the packet's
  // own report (blueprint v2 item 10): sibling hidden "true", dialog role
  // present while open, zero dialog content in the body while closed. This
  // same test, run again after Portal adoption below, is the re-sweep — one
  // function, two calls across one edit, so a regression reads as a diff
  // rather than as two assertions that could quietly drift apart.
  it("everything outside the open dialog reads hidden; the closed dialog contributes nothing", () => {
    const sweep = ariaHiddenSweep();
    // The landed idiom for evidence a memo quotes (`process.stdout.write`,
    // not `console.log` — see e.g. the runtime drills' own `RECEIPT` lines).
    process.stdout.write("P8-9-3 aria-hidden sweep: " + JSON.stringify(sweep) + "\n");
    expect(sweep.siblingHiddenWhileOpen).toBe("true");
    expect(sweep.dialogRoleWhileOpen).toBe("dialog");
    expect(sweep.bodyHasDialogContentWhileClosed).toBe(false);
  });
});

describe("EditRoadmapDialog — the open form (blueprint v2 §3-§4)", () => {
  // Migrated to live-DOM (P8-9-3, D7): every assertion below is the same
  // claim the static render made, moved rather than dropped, plus one this
  // renderer can now make that a string never could — the pinned axe
  // ruleset.
  async function openMount(): Promise<HTMLElement> {
    renderIntoDocument(
      <EditRoadmapDialog
        open={true}
        onOpenChange={noop}
        initiativeId={INITIATIVE_ID}
        kind="EDIT"
        prefillVersion={null}
        expectedHeadDigest={null}
        restoresVersionId={null}
        restoresVersionLabel={null}
        onGranted={noop}
      />,
    );
    // The body's own prefill resource resolves through a microtask even
    // with nothing to pre-fill (`prefillVersion === null` still runs
    // through `useAsyncResource`'s async effect) — settling here is what a
    // zero-stderr suite needs, not an optional tidy-up.
    await settle();
    const content = document.body.querySelector('[role="dialog"]');
    if (content === null) throw new Error("expected the portaled dialog content");
    return content as HTMLElement;
  }

  it("names the dialog with Title and Description", async () => {
    const content = await openMount();
    expect(content.textContent).toContain("Edit the roadmap");
    expect(content.textContent).toContain("Records a new version of this initiative's roadmap document.");
    expect(document.body.querySelector("#edit-roadmap-description")).not.toBeNull();
  });

  it("carries the content textarea and the recordedBy field, each labeled", async () => {
    const content = await openMount();
    expect(content.querySelector('label[for="edit-roadmap-content"]')).not.toBeNull();
    expect(content.querySelector("#edit-roadmap-content")).not.toBeNull();
    expect(content.querySelector('label[for="edit-roadmap-recorded-by"]')).not.toBeNull();
    expect(content.querySelector("#edit-roadmap-recorded-by")).not.toBeNull();
    expect(content.querySelector('[placeholder="provider/model/role/instance"]')).not.toBeNull();
  });

  it("shows the first-version claim when there is no head to claim against", async () => {
    const content = await openMount();
    expect(content.textContent).toContain("none (first version)");
  });

  it("carries an explicit submit, disabled until content and recordedBy are both filled", async () => {
    const content = await openMount();
    const submitButton = content.querySelector('button[type="submit"]');
    expect(submitButton).not.toBeNull();
    expect((submitButton as HTMLButtonElement).disabled).toBe(true);
    expect(submitButton?.textContent).toBe("Record version");
  });

  it("unarmed reads as a posture, not a failure — the submit button explains rather than fails mid-flight (v2 §3, N1)", async () => {
    const content = await openMount();
    expect(content.textContent).toContain("Unarmed — paste an operator token above to record this version.");
  });

  it("passes the pinned axe ruleset while open", async () => {
    const content = await openMount();
    const audit = await auditAndReport("edit-roadmap-dialog/open-form", content);
    expect(audit.violationIds).toEqual([]);
  });
});

/**
 * The focus restore is dispatched from a `setTimeout(0)` inside the focus
 * scope's cleanup, so a microtask flush is not enough to observe it — `settle`
 * alone would read `activeElement` before the restore had run and report the
 * defect this packet fixed.
 */
async function settleRestore(): Promise<void> {
  await settle();
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  await settle();
}

describe("EditRoadmapDialog — keyboard (P8-9-3, N3)", () => {
  it("Escape closes the dialog", async () => {
    // A stateful wrapper, not a plain variable reassigned by `onOpenChange`:
    // this dialog is fully controlled, so closing it is only observable if
    // the prop that says so actually changes on a real re-render.
    function ControlledHost(): JSX.Element {
      const [open, setOpen] = useState(true);
      return (
        <EditRoadmapDialog
          open={open}
          onOpenChange={setOpen}
          initiativeId={INITIATIVE_ID}
          kind="EDIT"
          prefillVersion={null}
          expectedHeadDigest={null}
          restoresVersionId={null}
          restoresVersionLabel={null}
          onGranted={noop}
        />
      );
    }
    renderIntoDocument(<ControlledHost />);
    await settle();
    const dialogEl = document.body.querySelector('[role="dialog"]');
    if (dialogEl === null) throw new Error("expected the portaled dialog content");

    pressKey(dialogEl, "Escape");
    await settle();

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  // Tab-cycle containment IS assertable here, and the next test asserts it.
  //
  // What jsdom genuinely cannot do is the *mid-cycle* advance: pressing Tab
  // in the middle of a form moves focus in a browser and moves nothing here,
  // because that step is native browser behaviour with no JavaScript to
  // intercept. The edges are different in kind. Radix's FocusScope receives
  // `loop: true` from Dialog and implements the wrap itself, in its own
  // `onKeyDown` on the content: Tab on the last tabbable calls
  // `preventDefault()` and focuses the first, Shift+Tab on the first focuses
  // the last, and its candidate walk is a layout-free TreeWalker over
  // `disabled`/`hidden`/`tabIndex`. That is ordinary JavaScript, so it runs
  // under this harness exactly as it does in a browser — and containment at
  // the edges is precisely the behaviour the blueprint names.
  //
  // Focus-restore-on-close is a separate matter, and the honest reason it is
  // not asserted is not a jsdom gap at all. Radix's modal content composes a
  // default `onCloseAutoFocus` that always `preventDefault()`s the
  // FocusScope restore and focuses `context.triggerRef.current?.` instead.
  // This dialog is fully controlled and has no `Dialog.Trigger`, so that
  // optional chain is a no-op and nothing is focused on close — in a real
  // browser exactly as here — closing stranded keyboard focus at the document
  // body, in production, for every fully-controlled triggerless Radix dialog
  // in this UI.
  //
  // **Fixed in P8-9-4**, and the tests below assert it. Both dialogs now
  // declare their own `onCloseAutoFocus` that prevents Radix's default and
  // focuses an opener captured in `onOpenAutoFocus` — the one self-contained
  // place whose ordering holds, since the focus scope reads
  // `document.activeElement` there before moving focus into the dialog. The
  // capture was chosen over an opener ref threaded from the workspace because
  // the real topology is multi-opener: this dialog opens from the head
  // version's Edit and from every history row's Restore, and the accounts
  // dialog from each row's buttons. The restore is asynchronous by
  // construction — the focus scope dispatches it from a `setTimeout(0)` in its
  // cleanup — so every assertion below flushes a macrotask after closing
  // before it reads `activeElement`.
  it("contains the Tab cycle at both edges: Tab on the last tabbable wraps to the first, and Shift+Tab on the first wraps to the last", async () => {
    renderIntoDocument(
      <EditRoadmapDialog
        open={true}
        onOpenChange={noop}
        initiativeId={INITIATIVE_ID}
        kind="EDIT"
        prefillVersion={null}
        expectedHeadDigest={null}
        restoresVersionId={null}
        restoresVersionLabel={null}
        onGranted={noop}
      />,
    );
    await settle();
    const dialogEl = document.body.querySelector('[role="dialog"]');
    if (dialogEl === null) throw new Error("expected the portaled dialog content");

    // Computed, not hard-coded: the submit is disabled until the form is
    // complete, so which element is last depends on state, and a hard-coded
    // pair would silently stop testing the edges the moment that changed.
    const tabbables = Array.from(
      dialogEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    // Two distinct elements at minimum, or "wraps to the first" would be
    // satisfied by focus simply staying put.
    expect(tabbables.length).toBeGreaterThan(1);
    const first = tabbables[0];
    const last = tabbables[tabbables.length - 1];
    if (first === undefined || last === undefined) throw new Error("expected two tabbables");
    expect(first).not.toBe(last);

    last.focus();
    expect(document.activeElement).toBe(last);
    pressKey(last, "Tab");
    await settle();
    expect(document.activeElement).toBe(first);

    first.focus();
    expect(document.activeElement).toBe(first);
    pressKey(first, "Tab", { shiftKey: true });
    await settle();
    expect(document.activeElement).toBe(last);
  });

  // F4(a): the multi-opener case, which is the whole reason the opener is
  // captured rather than threaded down as a prop. One dialog instance is
  // opened from two different controls; focus has to come back to the one
  // that actually opened it, not to a single "the" opener the workspace
  // happened to name.
  it("returns focus to the history row's Restore button that opened it, not to the head Edit", async () => {
    function MultiOpenerHost(): JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button
            type="button"
            id="edit-head"
            onClick={() => {
              setOpen(true);
            }}
          >
            Edit
          </button>
          <button
            type="button"
            id="restore-row"
            onClick={() => {
              setOpen(true);
            }}
          >
            Restore this version
          </button>
          <EditRoadmapDialog
            open={open}
            onOpenChange={setOpen}
            initiativeId={INITIATIVE_ID}
            kind="ROLLBACK"
            prefillVersion={null}
            expectedHeadDigest={null}
            restoresVersionId={null}
            restoresVersionLabel="v3"
            onGranted={noop}
          />
        </div>
      );
    }
    const mounted = renderIntoDocument(<MultiOpenerHost />);
    const restoreRow = mounted.container.querySelector<HTMLButtonElement>("#restore-row");
    const editHead = mounted.container.querySelector<HTMLButtonElement>("#edit-head");
    if (restoreRow === null || editHead === null) throw new Error("expected both openers");

    // Opened from the row, with focus on the row — the way a keyboard operator
    // reaches it.
    restoreRow.focus();
    expect(document.activeElement).toBe(restoreRow);
    await clickAndSettle(restoreRow);

    const dialogEl = document.body.querySelector('[role="dialog"]');
    if (dialogEl === null) throw new Error("expected the portaled dialog content");
    // Radix moved focus into the dialog, so the restore has something to undo.
    expect(dialogEl.contains(document.activeElement)).toBe(true);

    pressKey(dialogEl, "Escape");
    await settleRestore();

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(restoreRow);
    expect(document.activeElement).not.toBe(editHead);
  });

  // F4(c): F3's no-op as a test rather than only a comment. If the captured
  // opener is gone by close time — a row that vanished from a refreshed
  // list — the restore does nothing and focus stays where Radix left it. The
  // point is that this is a documented outcome, not a crash.
  it("does not throw when the captured opener has left the document, and invents no destination", async () => {
    function VanishingOpenerHost(): JSX.Element {
      const [open, setOpen] = useState(false);
      const [openerPresent, setOpenerPresent] = useState(true);
      return (
        <div>
          {openerPresent ? (
            <button
              type="button"
              id="vanishing"
              onClick={() => {
                setOpen(true);
              }}
            >
              Open
            </button>
          ) : null}
          <button
            type="button"
            id="remove-opener"
            onClick={() => {
              setOpenerPresent(false);
            }}
          >
            Remove the opener
          </button>
          <EditRoadmapDialog
            open={open}
            onOpenChange={setOpen}
            initiativeId={INITIATIVE_ID}
            kind="EDIT"
            prefillVersion={null}
            expectedHeadDigest={null}
            restoresVersionId={null}
            restoresVersionLabel={null}
            onGranted={noop}
          />
        </div>
      );
    }
    const mounted = renderIntoDocument(<VanishingOpenerHost />);
    const vanishing = mounted.container.querySelector<HTMLButtonElement>("#vanishing");
    const remove = mounted.container.querySelector<HTMLButtonElement>("#remove-opener");
    if (vanishing === null || remove === null) throw new Error("expected both buttons");

    vanishing.focus();
    await clickAndSettle(vanishing);
    const dialogEl = document.body.querySelector('[role="dialog"]');
    if (dialogEl === null) throw new Error("expected the portaled dialog content");

    // The opener is unmounted while the dialog is open.
    await clickAndSettle(remove);
    expect(vanishing.isConnected).toBe(false);

    pressKey(dialogEl, "Escape");
    await settleRestore();

    // Closed, and no throw reached the test — `focus()` on a detached element
    // is a no-op, which is exactly the documented outcome.
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    // Focus is wherever Radix left it, and specifically not on the element
    // that no longer exists. Nothing synthetic was invented for it.
    expect(document.activeElement).not.toBe(vanishing);
    expect(document.activeElement).not.toBeNull();
  });
});

describe("EditRoadmapDialog — armed (P8-8G packet 3, blueprint v2 §3)", () => {
  it("carries no unarmed note once a token is held, though the submit stays disabled until content and recordedBy are filled too", async () => {
    setSessionBearerToken("operator-secret");
    renderIntoDocument(
      <EditRoadmapDialog
        open={true}
        onOpenChange={noop}
        initiativeId={INITIATIVE_ID}
        kind="EDIT"
        prefillVersion={null}
        expectedHeadDigest={null}
        restoresVersionId={null}
        restoresVersionLabel={null}
        onGranted={noop}
      />,
    );
    await settle();
    const content = document.body.querySelector('[role="dialog"]');
    if (content === null) throw new Error("expected the portaled dialog content");
    expect(content.textContent).not.toContain("Unarmed — paste an operator token");
    const submitButton = content.querySelector('button[type="submit"]');
    expect((submitButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("a filled, armed form submits: exactly one POST, and the granted receipt shows the sequence (N2)", async () => {
    setSessionBearerToken("operator-secret");
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          apiContractVersion: API_CONTRACT_VERSION,
          ledgerContractVersion: LEDGER_CONTRACT_VERSION,
          version: {
            roadmapVersionId: "9f2e4567-e89b-12d3-a456-426614174333",
            initiativeId: INITIATIVE_ID,
            version: 4,
            contentDigest: DIGEST_A,
            parentVersionId: null,
            kind: "EDIT",
            restoresVersionId: null,
            recordedBy: "kimi/k3/coordinator/01",
            recordedAt: "2026-09-01T00:00:00.000Z",
            sequence: 12,
            head: true,
          },
          sequence: 12,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    renderIntoDocument(
      <EditRoadmapDialog
        open={true}
        onOpenChange={noop}
        initiativeId={INITIATIVE_ID}
        kind="EDIT"
        prefillVersion={null}
        expectedHeadDigest={null}
        restoresVersionId={null}
        restoresVersionLabel={null}
        onGranted={noop}
      />,
    );
    await settle();
    const content = document.body.querySelector('[role="dialog"]');
    if (content === null) throw new Error("expected the portaled dialog content");

    const textarea = content.querySelector<HTMLTextAreaElement>("#edit-roadmap-content");
    const recordedBy = content.querySelector<HTMLInputElement>("#edit-roadmap-recorded-by");
    if (textarea === null || recordedBy === null) throw new Error("expected both fields");
    typeInto(textarea, "## Roadmap\n\nfirst content");
    typeInto(recordedBy, "kimi/k3/coordinator/01");

    const submitButton = content.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submitButton === null) throw new Error("expected the submit button");
    expect(submitButton.disabled).toBe(false);
    await clickAndSettle(submitButton);

    const postCalls = fetchSpy.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "POST");
    expect(postCalls).toHaveLength(1);

    const region = document.body.querySelector('.dialog__outcome--granted[role="status"]');
    expect(region?.textContent).toContain("Recorded as v4.");
    expect(region?.textContent).toContain("sequence 12");
    vi.unstubAllGlobals();
  });
});

describe("EditRoadmapDialog — the rollback variant", () => {
  it("names the dialog after the restored version and claims the current head", async () => {
    // A real prefill target (`prefillVersion={2}`): stub `fetch` to a
    // classified contract-mismatch rather than let a real network call
    // happen under jsdom. The title/description/claim below are drawn from
    // props, not from the pre-fill response, so they render correctly
    // regardless of how the pre-fill resolves.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404, headers: { "content-type": "application/json" } })));
    renderIntoDocument(
      <EditRoadmapDialog
        open={true}
        onOpenChange={noop}
        initiativeId={INITIATIVE_ID}
        kind="ROLLBACK"
        prefillVersion={2}
        expectedHeadDigest={DIGEST_A}
        restoresVersionId="9f2e4567-e89b-12d3-a456-426614174111"
        restoresVersionLabel="v2"
        onGranted={noop}
      />,
    );
    await settle();
    const content = document.body.querySelector('[role="dialog"]');
    if (content === null) throw new Error("expected the portaled dialog content");
    expect(content.textContent).toContain("Restore v2");
    expect(content.textContent).toContain("Records a new version carrying v2's content.");
    expect(content.textContent).toContain("aaaaaaaa"); // the truncated claimed digest
    expect(content.textContent).not.toContain("none (first version)");
  });
});

describe("decisionRefusalName — the vocabulary read out of the message (N2)", () => {
  it("finds each of the six landed names plus the seam's own CONTENT_REJECTED", () => {
    for (const name of [
      "HEAD_MISMATCH",
      "REQUEST_INVALID",
      "RESTORES_UNKNOWN_VERSION",
      "ROLLBACK_DIGEST_MISMATCH",
      "PARENT_MISMATCH",
      "VERSION_NOT_MONOTONIC",
      "CONTENT_REJECTED",
    ]) {
      expect(decisionRefusalName("the roadmap version was refused: " + name)).toBe(name);
    }
  });

  it("returns null for a message naming no known refusal", () => {
    expect(decisionRefusalName("something else entirely")).toBeNull();
  });
});

describe("RefusalOutcome — the refusal-state table's non-schema halves (C4)", () => {
  it("renders nothing for idle or submitting — there is no outcome yet", () => {
    const idle: SubmitState = { phase: "idle" };
    const submitting: SubmitState = { phase: "submitting" };
    expect(renderToStaticMarkup(<RefusalOutcome submit={idle} onReloadAndReapply={noop} />)).toBe("");
    expect(renderToStaticMarkup(<RefusalOutcome submit={submitting} onReloadAndReapply={noop} />)).toBe("");
  });

  it("names a decision refusal by its own vocabulary word, in the detail line (N2)", () => {
    const submit: SubmitState = {
      phase: "refused-decision",
      name: "RESTORES_UNKNOWN_VERSION",
      message: "the roadmap version was refused: RESTORES_UNKNOWN_VERSION",
    };
    const html = renderToStaticMarkup(<RefusalOutcome submit={submit} onReloadAndReapply={noop} />);
    expect(html).toContain("Refused: RESTORES_UNKNOWN_VERSION.");
    expect(html).not.toContain("Reload the head and reapply");
  });

  it("offers reload-and-reapply only for HEAD_MISMATCH", () => {
    const submit: SubmitState = {
      phase: "refused-decision",
      name: "HEAD_MISMATCH",
      message: "the roadmap version was refused: HEAD_MISMATCH",
    };
    const html = renderToStaticMarkup(<RefusalOutcome submit={submit} onReloadAndReapply={noop} />);
    expect(html).toContain("Refused: HEAD_MISMATCH.");
    expect(html).toContain("Reload the head and reapply");
  });

  it("names the presented-token-refused state apart from the operator-unconfigured state (P8-8G packet 3, blueprint v2 §5)", () => {
    const unauthorized: SubmitState = { phase: "refused-unauthorized", message: "the presented token was not accepted" };
    const unarmed: SubmitState = { phase: "refused-unarmed", message: "this server was started without a write token" };
    const unauthorizedHtml = renderToStaticMarkup(<RefusalOutcome submit={unauthorized} onReloadAndReapply={noop} />);
    const unarmedHtml = renderToStaticMarkup(<RefusalOutcome submit={unarmed} onReloadAndReapply={noop} />);
    expect(unauthorizedHtml).toContain("The presented token was not accepted.");
    expect(unarmedHtml).toContain("This server holds no write token to check against.");
    expect(unauthorizedHtml).not.toBe(unarmedHtml);
  });

  it("marks INTERNAL as its own distinct retryable state (N1)", () => {
    const submit: SubmitState = { phase: "refused-internal", message: "an unexpected server error occurred" };
    const html = renderToStaticMarkup(<RefusalOutcome submit={submit} onReloadAndReapply={noop} />);
    expect(html).toContain("This is retryable.");
    expect(html).not.toContain("Refused:");
  });

  it("renders every other classified failure as the generic refused-other state", () => {
    const submit: SubmitState = { phase: "refused-other", message: "the configured ledger database is not currently available" };
    const html = renderToStaticMarkup(<RefusalOutcome submit={submit} onReloadAndReapply={noop} />);
    expect(html).toContain("The request did not go through.");
  });
});

describe("GrantedReceipt — the granted state shows the receipt (blueprint v2 §3)", () => {
  it("shows the new version number, the digest and the sequence", () => {
    const html = renderToStaticMarkup(
      <GrantedReceipt
        version={{
          roadmapVersionId: "9f2e4567-e89b-12d3-a456-426614174333",
          initiativeId: INITIATIVE_ID,
          version: 4,
          contentDigest: DIGEST_A,
          parentVersionId: "9f2e4567-e89b-12d3-a456-426614174111",
          kind: "EDIT",
          restoresVersionId: null,
          recordedBy: "claude/opus/implementer/01",
          recordedAt: "2026-08-30T23:58:00.000Z",
          sequence: 12,
          head: true,
        }}
        sequence={12}
        onClose={noop}
      />,
    );
    expect(html).toContain("Recorded as v4.");
    expect(html).toContain("sequence 12");
    expect(html).toContain("aaaaaaaa");
    expect(html).not.toContain(DIGEST_A);
    expect(html).toContain('role="status"');
  });
});
