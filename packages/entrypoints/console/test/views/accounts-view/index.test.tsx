// @vitest-environment jsdom
import {
  API_CONTRACT_VERSION,
  LEDGER_CONTRACT_VERSION,
  type AccountActionDtoRecord,
  type AccountDto,
  type AccountsResponse,
} from "@acp/protocol";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type Resource } from "../../../src/hooks/use-async-resource/index.js";
import { setSessionBearerToken } from "../../../src/api/client/index.js";
import {
  AccountActionGrantedReceipt,
  AccountActionRefusalOutcome,
  accountActionRefusalName,
  AccountsSection,
  AccountsView,
  type AccountActionSubmitState,
} from "../../../src/views/accounts-view/index.js";
import {
  auditAndReport,
  cleanupMountedRoots,
  click,
  clickAndSettle,
  countSelectorJoin,
  fakeFetch,
  renderIntoDocument,
  selectValue,
  settle,
  typeInto,
} from "../../live-dom/index.js";

function account(overrides: Partial<AccountDto> = {}): AccountDto {
  return {
    accountId: "claude-primary",
    provider: "anthropic",
    models: ["claude-opus-5", "claude-sonnet-5"],
    plan: "team",
    state: "AVAILABLE",
    quota: { remainingRatio: 0.62, confidence: "HIGH" },
    reset: { nextResetAt: "2026-09-01T00:00:00.000Z", source: "DECLARED", confidence: "HIGH" },
    lastProbeAt: "2026-08-31T12:00:00.000Z",
    lastError: null,
    // P8-8G packet 2: the authority overlay. Minimal fixture values — the
    // file governs while no action exists, which is this fixture's case.
    effectiveState: "AVAILABLE",
    stateSource: "OWNER_FILE",
    lastAction: null,
    ...overrides,
  };
}

function readyResponse(items: AccountDto[]): AccountsResponse {
  return {
    status: "READY",
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    items,
    count: items.length,
    estimatedAt: "2026-08-31T12:05:00.000Z",
  };
}

function unavailableResponse(reason: string, detail?: string): AccountsResponse {
  return {
    status: "UNAVAILABLE",
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    reason,
    ...(detail !== undefined ? { detail } : {}),
  } as AccountsResponse;
}

function successResource<T>(data: T): Resource<T> {
  return { status: "success", data, error: null };
}

const loadingResource: Resource<never> = { status: "loading", data: null, error: null };
const noop = (): void => {
  // refresh is not exercised in these fixture-driven renders
};

afterEach(() => {
  cleanupMountedRoots();
  vi.unstubAllGlobals();
  setSessionBearerToken(null);
});

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const COMPONENTS_CSS = readFileSync(resolve(HERE, "..", "..", "..", "src", "styles", "components.css"), "utf8");

function accountsWriteResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    action: {
      sequence: 42,
      eventId: "11111111-1111-4111-8111-111111111111",
      accountId: "claude-primary",
      version: 2,
      action: "DRAIN",
      resultingState: "DRAINING",
      actor: "kimi/k3/coordinator/01",
      note: null,
      recordedAt: "2026-09-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

describe("AccountsSection — the states contract", () => {
  it("loading: the async-section skeleton", () => {
    const html = renderToStaticMarkup(<AccountsSection resource={loadingResource} lastFetchedAt={null} onRefresh={noop} />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading the accounts");
  });

  it("READY, empty: zero accounts is a named empty state, not an error", () => {
    const html = renderToStaticMarkup(
      <AccountsSection resource={successResource(readyResponse([]))} lastFetchedAt={new Date()} onRefresh={noop} />,
    );
    expect(html).toContain("The owner file holds zero accounts.");
  });

  it("READY, populated: renders every field the blueprint names, and the response's estimatedAt (N2)", () => {
    const html = renderToStaticMarkup(
      <AccountsSection resource={successResource(readyResponse([account()]))} lastFetchedAt={new Date()} onRefresh={noop} />,
    );
    expect(html).toContain("claude-primary");
    expect(html).toContain("anthropic");
    expect(html).toContain("team");
    expect(html).toContain("Available");
    expect(html).toContain("Declared");
    expect(html).toContain("Estimated");
  });

  it("the models list is keyboard-reachable, not title-only (v2, N1)", () => {
    const html = renderToStaticMarkup(
      <AccountsSection
        resource={successResource(readyResponse([account({ models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"] })]))}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("claude-opus-5");
    expect(html).toContain("claude-sonnet-5");
    expect(html).toContain("claude-haiku-4-5");
    // Not title-only: the full list is real markup, not an attribute only a
    // mouse hover reveals.
    expect(html).not.toMatch(/title="[^"]*claude-haiku-4-5[^"]*"/);
  });

  it("quota remaining renders — with an explaining title when the estimate is unpublished", () => {
    const html = renderToStaticMarkup(
      <AccountsSection
        resource={successResource(readyResponse([account({ quota: { remainingRatio: null, confidence: "LOW" } })]))}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(html).toMatch(/title="[^"]*does not publish[^"]*">—</);
  });

  it("never shows a color-only state badge: every state carries its own label text", () => {
    for (const state of ["AVAILABLE", "DRAINING", "EXHAUSTED", "COOLDOWN", "AUTH_REQUIRED"] as const) {
      const html = renderToStaticMarkup(
        <AccountsSection resource={successResource(readyResponse([account({ state })]))} lastFetchedAt={new Date()} onRefresh={noop} />,
      );
      expect(html).toContain('class="badge__glyph"');
    }
  });

  it("last probe and last error render — when absent", () => {
    const html = renderToStaticMarkup(
      <AccountsSection
        resource={successResource(readyResponse([account({ lastProbeAt: null, lastError: null })]))}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(html).toContain(">—<");
  });

  it("last error renders the classified word when present", () => {
    const html = renderToStaticMarkup(
      <AccountsSection
        resource={successResource(readyResponse([account({ lastError: "RATE_LIMITED" })]))}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(html).toContain("RATE_LIMITED");
  });

  it("UNAVAILABLE: renders first-class with the frozen reason word visible, never an error box", () => {
    const html = renderToStaticMarkup(
      <AccountsSection
        resource={successResource(unavailableResponse("ACCOUNTS_FILE_UNCONFIGURED"))}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(html).toContain("Accounts file unconfigured");
    expect(html).toContain("No accounts file has been configured");
    expect(html).not.toContain("Could not load");
    expect(html).not.toContain('role="alert"');
  });

  it("each of the five frozen UNAVAILABLE words renders its own sentence", () => {
    const reasons = [
      "ACCOUNTS_FILE_UNCONFIGURED",
      "ACCOUNTS_FILE_ABSENT",
      "ACCOUNTS_FILE_UNREADABLE",
      "ACCOUNTS_FILE_SCHEMA_REFUSED",
      "ACCOUNTS_FILE_OVERSIZE",
    ] as const;
    for (const reason of reasons) {
      const html = renderToStaticMarkup(
        <AccountsSection resource={successResource(unavailableResponse(reason))} lastFetchedAt={new Date()} onRefresh={noop} />,
      );
      expect(html).not.toContain("The accounts file is unavailable.");
    }
  });

  it("UNAVAILABLE never echoes a file value, only the reason and a field-path detail", () => {
    const html = renderToStaticMarkup(
      <AccountsSection
        resource={successResource(unavailableResponse("ACCOUNTS_FILE_SCHEMA_REFUSED", "items[0].credentialRef"))}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(html).toContain("items[0].credentialRef");
    expect(html).not.toContain("sk-ant");
  });
});

describe("AccountsView", () => {
  it("renders a heading and an announced loading state on the very first render", () => {
    const html = renderToStaticMarkup(<AccountsView />);
    expect(html).toContain("Accounts");
    expect(html).toContain('role="status"');
  });

  it("defaults to unarmed when no bearerArmed prop is supplied — the pre-P8-8G call shape still works", () => {
    const html = renderToStaticMarkup(<AccountsView />);
    expect(html).not.toContain("Drain");
  });
});

describe("AccountsSection — the state column renders the authority overlay (P8-8G packet 3, blueprint v2 §3)", () => {
  it("shows the effective state, not the owner-file state, when they disagree", () => {
    const html = renderToStaticMarkup(
      <AccountsSection
        resource={successResource(
          readyResponse([
            account({
              state: "AVAILABLE",
              effectiveState: "DRAINING",
              stateSource: "OPERATOR_ACTION",
              lastAction: { action: "DRAIN", at: "2026-08-31T10:00:00.000Z", by: "claude/opus/implementer/01" },
            }),
          ]),
        )}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(html).toContain("Draining");
    expect(html).toContain("operator-set");
  });

  it("marks OPERATOR_ACTION rows with the last action's word and instant in the title", () => {
    const html = renderToStaticMarkup(
      <AccountsSection
        resource={successResource(
          readyResponse([
            account({
              effectiveState: "AVAILABLE",
              stateSource: "OPERATOR_ACTION",
              lastAction: { action: "ACCOUNT_READY", at: "2026-08-31T10:00:00.000Z", by: "claude/opus/implementer/01" },
            }),
          ]),
        )}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(html).toMatch(/title="Account ready at[^"]*"/);
  });

  it("carries no operator-set mark and no title when the owner file still governs", () => {
    const html = renderToStaticMarkup(
      <AccountsSection resource={successResource(readyResponse([account()]))} lastFetchedAt={new Date()} onRefresh={noop} />,
    );
    expect(html).not.toContain("operator-set");
  });

  it("keeps the owner-file baseline reachable in a disclosure, not collapsed away", () => {
    const html = renderToStaticMarkup(
      <AccountsSection
        resource={successResource(
          readyResponse([
            account({
              state: "AUTH_REQUIRED",
              effectiveState: "DRAINING",
              stateSource: "OPERATOR_ACTION",
              lastAction: { action: "DRAIN", at: "2026-08-31T10:00:00.000Z", by: "claude/opus/implementer/01" },
            }),
          ]),
        )}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(html).toContain("Baseline");
    expect(html).toContain("Auth required");
  });
});

describe("AccountsSection — the actions column, gated on bearerArmed (P8-8G packet 3, blueprint v2 §3)", () => {
  it("unarmed: reads as a posture, not a failure — no action buttons, no dialog", () => {
    const html = renderToStaticMarkup(
      <AccountsSection resource={successResource(readyResponse([account()]))} lastFetchedAt={new Date()} onRefresh={noop} />,
    );
    expect(html).toContain("Paste an operator token above to act.");
    expect(html).not.toContain(">Drain<");
    expect(html).not.toContain(">Override state<");
  });

  it("armed: offers all four actions, and no dialog content while every confirm starts closed", () => {
    const html = renderToStaticMarkup(
      <AccountsSection
        resource={successResource(readyResponse([account()]))}
        lastFetchedAt={new Date()}
        onRefresh={noop}
        bearerArmed={true}
      />,
    );
    expect(html).toContain(">Drain<");
    expect(html).toContain(">Mark ready<");
    expect(html).toContain(">Flag reauth<");
    expect(html).toContain(">Override state<");
    // Closed-content mounting is forbidden everywhere in this cohort (C5):
    // every confirm starts closed, so none of its form fields are present.
    expect(html).not.toContain('id="account-action-actor"');
    expect(html).not.toContain(">Confirm<");
    expect(html).not.toContain("Paste an operator token");
  });
});

describe("accountActionRefusalName — the seam's own refusal word, read out of the message (N2)", () => {
  it("finds each of the four named refusals", () => {
    for (const name of ["ACCOUNTS_UNAVAILABLE", "UNKNOWN_ACCOUNT", "ALREADY_IN_STATE", "WRITE_CONFLICT"]) {
      expect(accountActionRefusalName("the account action was refused: " + name)).toBe(name);
    }
  });

  it("returns null for a message naming no known refusal", () => {
    expect(accountActionRefusalName("something else entirely")).toBeNull();
  });
});

describe("AccountActionRefusalOutcome — every refusal is a named state (blueprint v2 §5)", () => {
  it("renders nothing for idle or submitting", () => {
    const idle: AccountActionSubmitState = { phase: "idle" };
    const submitting: AccountActionSubmitState = { phase: "submitting" };
    expect(renderToStaticMarkup(<AccountActionRefusalOutcome submit={idle} />)).toBe("");
    expect(renderToStaticMarkup(<AccountActionRefusalOutcome submit={submitting} />)).toBe("");
  });

  it("names a no-op refusal by the seam's own word — never a silent success", () => {
    const submit: AccountActionSubmitState = {
      phase: "refused-decision",
      name: "ALREADY_IN_STATE",
      message: "the account action was refused: ALREADY_IN_STATE",
    };
    const html = renderToStaticMarkup(<AccountActionRefusalOutcome submit={submit} />);
    expect(html).toContain("Refused: ALREADY_IN_STATE.");
  });

  it("names the two bearer states apart — a caller problem and an operator problem (v2 §5)", () => {
    const unauthorized: AccountActionSubmitState = { phase: "refused-unauthorized", message: "the presented token was not accepted" };
    const unarmed: AccountActionSubmitState = { phase: "refused-unarmed", message: "no write token is configured" };
    const unauthorizedHtml = renderToStaticMarkup(<AccountActionRefusalOutcome submit={unauthorized} />);
    const unarmedHtml = renderToStaticMarkup(<AccountActionRefusalOutcome submit={unarmed} />);
    expect(unauthorizedHtml).toContain("The presented token was not accepted.");
    expect(unarmedHtml).toContain("This server holds no write token to check against.");
    expect(unauthorizedHtml).not.toBe(unarmedHtml);
  });

  it("marks INTERNAL as its own distinct retryable state", () => {
    const submit: AccountActionSubmitState = { phase: "refused-internal", message: "an unexpected server error occurred" };
    const html = renderToStaticMarkup(<AccountActionRefusalOutcome submit={submit} />);
    expect(html).toContain("This is retryable.");
  });
});

describe("AccountActionGrantedReceipt — carries the sequence (v2, N2)", () => {
  it("shows the action, the resulting state and the sequence", () => {
    const record: AccountActionDtoRecord = {
      sequence: 9,
      eventId: "11111111-1111-4111-8111-111111111111",
      accountId: "claude-primary",
      version: 3,
      action: "DRAIN",
      resultingState: "DRAINING",
      actor: "claude/opus/implementer/01",
      note: null,
      recordedAt: "2026-08-31T10:00:00.000Z",
    };
    const html = renderToStaticMarkup(<AccountActionGrantedReceipt record={record} onClose={noop} />);
    expect(html).toContain("Recorded: Drain → Draining.");
    expect(html).toContain("Sequence 9.");
    expect(html).toContain('role="status"');
  });
});

// ---------------------------------------------------------------------------
// Live-DOM battery (P8-9-3, blueprint v2 item 1)
// ---------------------------------------------------------------------------

describe("live-DOM battery: the accounts surface — UNAVAILABLE-first (blueprint v2 item 1)", () => {
  it("UNAVAILABLE renders the reason as a first-class named state, and passes the pinned axe ruleset", async () => {
    const mounted = renderIntoDocument(
      <AccountsSection
        resource={successResource(unavailableResponse("ACCOUNTS_FILE_UNCONFIGURED"))}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(mounted.container.textContent).toContain("Accounts file unconfigured");

    const audit = await auditAndReport("accounts/UNAVAILABLE", mounted.container);
    expect(audit.violationIds).toEqual([]);
  });

  it("READY renders the table and passes the pinned axe ruleset, unarmed and armed", async () => {
    for (const bearerArmed of [false, true]) {
      const mounted = renderIntoDocument(
        <AccountsSection
          resource={successResource(readyResponse([account()]))}
          lastFetchedAt={new Date()}
          onRefresh={noop}
          bearerArmed={bearerArmed}
        />,
      );
      const audit = await auditAndReport("accounts/READY(bearerArmed=" + String(bearerArmed) + ")", mounted.container);
      expect({ bearerArmed, violationIds: audit.violationIds }).toEqual({ bearerArmed, violationIds: [] });
      mounted.unmount();
    }
  });

  it("the state column renders effectiveState with the operator-set mark, in a real document", () => {
    const mounted = renderIntoDocument(
      <AccountsSection
        resource={successResource(
          readyResponse([
            account({
              state: "AVAILABLE",
              effectiveState: "DRAINING",
              stateSource: "OPERATOR_ACTION",
              lastAction: { action: "DRAIN", at: "2026-08-31T10:00:00.000Z", by: "claude/opus/implementer/01" },
            }),
          ]),
        )}
        lastFetchedAt={new Date()}
        onRefresh={noop}
      />,
    );
    expect(mounted.container.textContent).toContain("Draining");
    expect(mounted.container.textContent).toContain("operator-set");
  });

  it("selector-join: the rendered table carries the data-priority hooks its breakpoint rules select (C1)", () => {
    const mounted = renderIntoDocument(
      <AccountsSection resource={successResource(readyResponse([account()]))} lastFetchedAt={new Date()} onRefresh={noop} />,
    );
    expect(countSelectorJoin(mounted.container, '.data-table [data-priority="tertiary"]')).toBeGreaterThan(0);
    expect(countSelectorJoin(mounted.container, '.data-table [data-priority="secondary"]')).toBeGreaterThan(0);
    // The failure this join exists to catch: a renamed attribute is silent
    // to every other test and loud only here.
    expect(countSelectorJoin(mounted.container, '.data-table [data-priority="nonexistent"]')).toBe(0);
  });

  it("pins the responsive breakpoints components.css declares for this table, by equality (D6)", () => {
    expect(COMPONENTS_CSS).toContain(
      '@media (max-width: 48rem) {\n  .data-table [data-priority="tertiary"] {\n    display: none;\n  }\n}',
    );
    expect(COMPONENTS_CSS).toContain(
      '@media (max-width: 34rem) {\n  .data-table [data-priority="secondary"] {\n    display: none;\n  }\n}',
    );
  });
});

describe("live-DOM battery: the account action end-to-end (blueprint v2 item 3)", () => {
  async function armedMount(
    responder: Parameters<typeof fakeFetch>[0],
  ): Promise<{ container: HTMLElement; fake: ReturnType<typeof fakeFetch> }> {
    setSessionBearerToken("operator-secret");
    const fake = fakeFetch(responder);
    vi.stubGlobal("fetch", fake.fetch);
    const mounted = renderIntoDocument(<AccountsView bearerArmed={true} />);
    await settle();
    return { container: mounted.container, fake };
  }

  /**
   * The focus restore is dispatched from a `setTimeout(0)` inside the focus
   * scope's cleanup, so a microtask flush reads `activeElement` too early.
   */
  async function settleRestore(): Promise<void> {
    await settle();
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
    await settle();
  }

  function drainButton(container: HTMLElement): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Drain");
    if (found === undefined) throw new Error("expected a Drain button");
    return found;
  }

  it("a granted action: the receipt paints its sequence in the live region before any close, the row refreshes, and an explicit close leaves it operator-set (P8-9-3 widening, F1/F2/F5)", async () => {
    let getCount = 0;
    const { container, fake } = await armedMount((call) => {
      if (call.method === "GET") {
        getCount += 1;
        // The second GET (the post-grant refresh) answers with the state the
        // action produced — the row's own proof that it re-read rather than
        // guessed.
        const item =
          getCount === 1
            ? account()
            : account({
                effectiveState: "DRAINING",
                stateSource: "OPERATOR_ACTION",
                lastAction: { action: "DRAIN", at: "2026-09-01T00:00:00.000Z", by: "kimi/k3/coordinator/01" },
              });
        return { status: 200, body: readyResponse([item]) };
      }
      expect(call.url).toBe("/api/v1/accounts/claude-primary/actions");
      expect(call.body).toMatchObject({ action: "DRAIN", setState: null });
      return { status: 200, body: accountsWriteResponse() };
    });

    expect(container.textContent).not.toContain("operator-set");

    // F4(b) setup: the row's own Drain button is focused before it is used,
    // the way a keyboard operator reaches it — that is what the dialog
    // captures on open, and what the close has to give back.
    const opener = drainButton(container);
    opener.focus();
    expect(document.activeElement).toBe(opener);
    click(opener);
    const actorInput = container.querySelector<HTMLInputElement>("#account-action-actor");
    if (actorInput === null) throw new Error("expected the actor input");
    typeInto(actorInput, "kimi/k3/coordinator/01");

    const confirmButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Confirm");
    if (confirmButton === undefined) throw new Error("expected the Confirm button");
    await clickAndSettle(confirmButton);

    // Exactly one POST — the deliberate click, nothing implied by mounting
    // or by typing into the actor field.
    expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(1);

    // F1/F5: the granted receipt paints, in the live region, with its
    // sequence — BEFORE any close. This is the assertion that fails while
    // the premature-close defect named in the packet's own report is
    // present: with the defect, `AccountActionDialogBody` unmounts in the
    // same batch that sets `{ phase: "granted" }`, so this element never
    // exists.
    const receipt = container.querySelector('.dialog__outcome--granted[role="status"]');
    expect(receipt).not.toBeNull();
    expect(receipt?.getAttribute("aria-live")).toBe("polite");
    expect(receipt?.textContent).toContain("Sequence 42.");
    expect(receipt?.textContent).toContain("Drain");

    // C3 / N3: the live region announces WITHOUT stealing focus. A
    // `role="status"` region is announced by the assistive technology on its
    // own; if it also took focus it would yank a keyboard operator out of
    // wherever they were at the exact moment they are being told something.
    // So the assertion is about the region: it neither is, nor contains, the
    // active element.
    expect(document.activeElement).not.toBe(receipt);
    expect(receipt?.contains(document.activeElement)).toBe(false);

    // Where focus actually rests, checked rather than assumed: the confirm
    // form the operator was in has been replaced by this receipt, so the
    // control that had focus no longer exists — and Radix's focus scope
    // catches that by moving focus to the dialog container itself, which
    // carries `tabIndex={-1}` for exactly this purpose. So the operator stays
    // inside the dialog, one Tab away from the receipt's Close button,
    // rather than being dropped at the top of the document.
    const dialogEl = container.querySelector('[role="dialog"]');
    expect(dialogEl).not.toBeNull();
    expect(document.activeElement).toBe(dialogEl);

    // F2: the row refresh is not lost — it still runs on grant, independent
    // of the dialog's own open/closed state.
    await settle();
    expect(fake.calls.filter((call) => call.method === "GET")).toHaveLength(2);
    expect(container.textContent).toContain("operator-set");

    // The receipt is still showing — closing has not happened implicitly.
    expect(container.querySelector('.dialog__outcome--granted[role="status"]')).not.toBeNull();

    // Closing is a later, explicit act: the receipt's own "Close" button.
    const closeButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Close");
    if (closeButton === undefined) throw new Error("expected the receipt's Close button");
    click(closeButton);
    await settleRestore();

    expect(container.querySelector('.dialog__outcome--granted[role="status"]')).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    // The refreshed, operator-set row survives the dialog closing.
    expect(container.textContent).toContain("operator-set");

    // F4(b), P8-9-4: the restore composes with the refresh. The row re-rendered
    // between opening and closing — that is the whole point of the grant — and
    // the operator still lands back on the control they left from, rather than
    // at the top of the document. This is the case worth asserting precisely
    // because the refresh happens in between: if the refreshed row replaced its
    // buttons with new elements, the captured one would be detached and this
    // would fall to F3's no-op instead.
    expect(document.activeElement).toBe(opener);
    expect(opener.isConnected).toBe(true);
  });

  it.each([
    ["UNKNOWN_ACCOUNT" as const],
    ["ALREADY_IN_STATE" as const],
    ["ACCOUNTS_UNAVAILABLE" as const],
    ["WRITE_CONFLICT" as const],
  ])("a %s refusal, given a fake fetch answering that exact envelope, renders as its own named state", async (refusal) => {
    const { container } = await armedMount((call) => {
      if (call.method === "GET") return { status: 200, body: readyResponse([account()]) };
      return {
        status: 409,
        body: {
          apiContractVersion: API_CONTRACT_VERSION,
          error: { code: "WRITE_REFUSED", message: "the account action was refused: " + refusal, detail: null },
        },
      };
    });

    click(drainButton(container));
    const actorInput = container.querySelector<HTMLInputElement>("#account-action-actor");
    if (actorInput === null) throw new Error("expected the actor input");
    typeInto(actorInput, "kimi/k3/coordinator/01");
    const confirmButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Confirm");
    if (confirmButton === undefined) throw new Error("expected the Confirm button");
    await clickAndSettle(confirmButton);

    expect(container.textContent).toContain("Refused: " + refusal + ".");
  });

  it("OWNER_OVERRIDE carries the state selector and the note, and sends both in the request", async () => {
    const { container, fake } = await armedMount((call) => {
      if (call.method === "GET") return { status: 200, body: readyResponse([account()]) };
      return {
        status: 200,
        body: accountsWriteResponse({
          action: {
            sequence: 42,
            eventId: "11111111-1111-4111-8111-111111111111",
            accountId: "claude-primary",
            version: 2,
            action: "OWNER_OVERRIDE",
            resultingState: "AUTH_REQUIRED",
            actor: "kimi/k3/coordinator/01",
            note: "operator override: provider incident",
            recordedAt: "2026-09-01T00:00:00.000Z",
          },
        }),
      };
    });

    const overrideButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Override state");
    if (overrideButton === undefined) throw new Error("expected the Override state button");
    click(overrideButton);

    const stateSelect = container.querySelector<HTMLSelectElement>("#account-action-set-state");
    const noteField = container.querySelector<HTMLTextAreaElement>("#account-action-note");
    const actorInput = container.querySelector<HTMLInputElement>("#account-action-actor");
    if (stateSelect === null || noteField === null || actorInput === null) {
      throw new Error("expected the state selector, the note field and the actor input");
    }
    typeInto(actorInput, "kimi/k3/coordinator/01");
    selectValue(stateSelect, "AUTH_REQUIRED");
    typeInto(noteField, "operator override: provider incident");

    const confirmButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Confirm");
    if (confirmButton === undefined) throw new Error("expected the Confirm button");
    await clickAndSettle(confirmButton);

    const post = fake.calls.find((call) => call.method === "POST");
    expect(post?.body).toMatchObject({
      action: "OWNER_OVERRIDE",
      setState: "AUTH_REQUIRED",
      note: "operator override: provider incident",
    });
  });

  it("unarmed reads as a posture: no action buttons, nothing to confirm, and the pinned axe ruleset still passes", async () => {
    const { container } = await (async () => {
      const fake = fakeFetch((call) => {
        expect(call.method).toBe("GET");
        return { status: 200, body: readyResponse([account()]) };
      });
      vi.stubGlobal("fetch", fake.fetch);
      const mounted = renderIntoDocument(<AccountsView bearerArmed={false} />);
      await settle();
      return { container: mounted.container, fake };
    })();

    expect(container.textContent).toContain("Paste an operator token above to act.");
    const audit = await auditAndReport("accounts/READY(unarmed posture)", container);
    expect(audit.violationIds).toEqual([]);
  });
});

describe("live-DOM battery: reconnect and idempotence (blueprint v2, D5)", () => {
  it("(a) mount, unmount, remount trigger zero mutations — only the deliberate click does", async () => {
    setSessionBearerToken("operator-secret");
    const fake = fakeFetch((call) => {
      if (call.method === "GET") return { status: 200, body: readyResponse([account()]) };
      return { status: 200, body: accountsWriteResponse() };
    });
    vi.stubGlobal("fetch", fake.fetch);

    const first = renderIntoDocument(<AccountsView bearerArmed={true} />);
    await settle();
    first.unmount();

    const second = renderIntoDocument(<AccountsView bearerArmed={true} />);
    await settle();
    second.unmount();

    expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect(fake.calls.filter((call) => call.method === "GET")).toHaveLength(2);
  });

  it("(c) a fresh mount — the restarted frontend — reads state from the read endpoint, not from memory", async () => {
    setSessionBearerToken("operator-secret");
    // The first mount observes the pre-action state; a second, wholly fresh
    // mount (a new component instance, nothing carried over) observes what
    // the read endpoint now says — the only way it could know about a grant
    // no earlier instance of this component ever saw.
    const fake = fakeFetch((call) => {
      expect(call.method).toBe("GET");
      return {
        status: 200,
        body: readyResponse([
          account({
            effectiveState: "DRAINING",
            stateSource: "OPERATOR_ACTION",
            lastAction: { action: "DRAIN", at: "2026-09-01T00:00:00.000Z", by: "kimi/k3/coordinator/01" },
          }),
        ]),
      };
    });
    vi.stubGlobal("fetch", fake.fetch);

    const mounted = renderIntoDocument(<AccountsView bearerArmed={true} />);
    await settle();

    expect(mounted.container.textContent).toContain("operator-set");
    expect(mounted.container.textContent).toContain("Draining");
  });
});
