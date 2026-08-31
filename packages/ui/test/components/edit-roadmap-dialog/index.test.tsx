import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  decisionRefusalName,
  EditRoadmapDialog,
  GrantedReceipt,
  RefusalOutcome,
  type SubmitState,
} from "../../../src/components/edit-roadmap-dialog/index.js";

const INITIATIVE_ID = "123e4567-e89b-12d3-a456-426614174000";
const DIGEST_A = "a".repeat(64);

const noop = (): void => {
  // open-change/granted/reload are not exercised in a static render
};

describe("EditRoadmapDialog — closed-content mounting is forbidden (C5)", () => {
  it("contributes no dialog content while closed", () => {
    const html = renderToStaticMarkup(
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
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Recorded by");
    expect(html).not.toContain('role="status"');
  });
});

describe("EditRoadmapDialog — the open form (blueprint v2 §3-§4)", () => {
  const html = renderToStaticMarkup(
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

  it("names the dialog with Title and Description", () => {
    expect(html).toContain("Edit the roadmap");
    expect(html).toContain("Records a new version of this initiative&#x27;s roadmap document.");
    expect(html).toContain('id="edit-roadmap-description"');
  });

  it("carries the content textarea and the recordedBy field, each labeled", () => {
    expect(html).toContain('for="edit-roadmap-content"');
    expect(html).toContain('id="edit-roadmap-content"');
    expect(html).toContain('for="edit-roadmap-recorded-by"');
    expect(html).toContain('id="edit-roadmap-recorded-by"');
    expect(html).toContain('placeholder="provider/model/role/instance"');
  });

  it("shows the first-version claim when there is no head to claim against", () => {
    expect(html).toContain("none (first version)");
  });

  it("carries an explicit submit, disabled until content and recordedBy are both filled", () => {
    expect(html).toContain('type="submit"');
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("Record version");
  });
});

describe("EditRoadmapDialog — the rollback variant", () => {
  it("names the dialog after the restored version and claims the current head", () => {
    const html = renderToStaticMarkup(
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
    expect(html).toContain("Restore v2");
    expect(html).toContain("Records a new version carrying v2&#x27;s content.");
    expect(html).toContain("aaaaaaaa"); // the truncated claimed digest
    expect(html).not.toContain("none (first version)");
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
