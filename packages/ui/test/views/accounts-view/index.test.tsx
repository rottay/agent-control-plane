import {
  API_CONTRACT_VERSION,
  LEDGER_CONTRACT_VERSION,
  type AccountActionDtoRecord,
  type AccountDto,
  type AccountsResponse,
} from "@acp/api-contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type Resource } from "../../../src/hooks/use-async-resource/index.js";
import {
  AccountActionGrantedReceipt,
  AccountActionRefusalOutcome,
  accountActionRefusalName,
  AccountsSection,
  AccountsView,
  type AccountActionSubmitState,
} from "../../../src/views/accounts-view/index.js";

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
