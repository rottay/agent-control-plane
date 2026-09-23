# ADR 0099 — A transport, a process and an operation are three facts, and output bytes live on the private side

- Status: accepted (P-07 escalón C, recorded 2026-09-22).
- Supersedes: none.
- Superseded-by: none.
- Amends: none. `L-P07A-1` is amended in its own fence row.

## Context

Contratos §4.2 asks for three facts kept apart and never fused: transport success,
process termination and the operation's result. It also asks that a tool result
flagged as an error produce `FAILED` even when the transport answered and the
process exited 0.

Before this escalón the port said only one thing, `completed`. It also carried
output as a public `text` event. And the Claude parser turned the `result`
record's `subtype` into `state { toState: "SUCCESS" }`, a token a reader could
mistake for a verdict.

The P-07 adjudication v2 fixed the rules this record applies:

- **C6**: the two new facts are not terminal, their order is fixed, an absent
  exit is not observable, and a failed session reports its SIGKILL.
- **C7**: no operation variant is declared without a captured sample.
- **C8**: `text` is retired and the output goes to a private sink passed to
  `start`.

The owner authorized two single-use captures of the real Claude CLI. Their facts,
as recorded:

- **Sample 1.** CLI `2.1.280`, `--model haiku`, the adapter-shaped environment.
  - The CLI did not authenticate, and no model call happened.
  - Three records: `system/init`, then an `assistant` with top-level
    `error: "authentication_failed"`, `is_api_error_message: true` and the text
    `Not logged in · Please run /login`, then a `result`.
  - The result was `subtype: "success"`, `is_error: true`,
    `terminal_reason: "api_error"`.
  - The process exited 1, with an empty stderr.
- **Sample 2.** The same run with `USER` added.
  - The process exited 0.
  - Six records:
    1. `system/commands_changed` (first, before init);
    2. `system/init`;
    3. an `assistant` with a `thinking` block (empty text, opaque signature);
    4. an `assistant` with a `text` block `"ok"`;
    5. `rate_limit_event`;
    6. a `result` with `subtype: "success"`, `is_error: false`, `result: "ok"`,
       `terminal_reason: "completed"`.
  - The model id was `claude-haiku-4-5-20251001` throughout.
- **What the two prove together.** `subtype: "success"` appeared in both, so it
  is not a verdict. `is_error` is, observed as (`true`, exit 1) and (`false`,
  exit 0).
- **What they do not prove.**
  - `is_error: true` with exit 0, or `false` with a non-zero exit.
  - A signal exit, a timeout, a multi-turn or tool-using session.
  - Any other CLI version.
  - The adapter's own argv: both runs passed `--verbose`, which the adapter
    does not.
  - The value space of `terminal_reason`, `stop_reason` or `rate_limit_info`.

## Decision

**One — three facts, in a fixed order, never fused.** `ExecutionEvent` gains two
non-terminal members:

- `processExited { exitCode, signal }`: exactly one of the two is non-null. An
  exit code is 0–255; a signal matches `^SIG[A-Z0-9]+$` and is at most 16
  characters.
- `operationResult { status }`: `status` is the result contract's own
  `RESULT_STATUSES`, imported and never a second enum.

When present they come, in this order, before the one terminal. `completed` stays
transport success only. The terminal law is unchanged: exactly one of `completed`
or `error`, and nothing after it.

**Two — not observable is absent, never a default.** An absent `processExited`
means the exit was not observed. That happens:

- always on the API and local legs, which own no process;
- on the port's throw path, which fails before the process is seen to end;
- when a kill's grace expires with no exit.

It is never exit 0. An absent `operationResult` means the operation said nothing.

On a failed CLI session, `processExited` reports how the child ended: our
ladder's `SIGKILL` on a live child, or the child's own status when it had
already exited. A failed session's verdict is not reported, because the session
did not end in a state that vouches for it.

**Three — `text` retires, and output has one home.** `ExecutionEvent` has no
`text`. `start(route, request, sink?)` takes an optional `ExecutionOutputSink`
that receives output text, delta by delta. It carries no instruction and no
metadata, and whatever it receives enters no event. It is an argument, not a
field of the strict `ExecutionRequest`.

- **CLI leg.** The Claude parser emits a private `output` signal for each
  assistant `text` block, in stream order. It skips a `thinking` block and any
  record flagged `is_api_error_message: true`. `result.result` is not also sent,
  which avoids a duplicate. The session hands each `output` signal to the sink
  in one function that names no recorder. Without a sink the text is dropped:
  that is the legacy path.
- **API and local legs.** They route their clients' `text` chunks the same way.
  Their chunk-to-event mapper is an exhaustive switch over the kinds they admit, so a
  client that emits `processExited`, `completed` or `error` mid-stream fails the
  stream: only the port states those.
- **A sink must not throw.** A throwing sink fails the session, classified
  `MALFORMED_EVENT`.
- **Reattach.** A rejoin that asks for a sink is refused inside the existing
  reattach conjunction, because the sink was bound at spawn and a tail-only sink
  would feed an incomplete result.

**Four — Claude's verdict, on the evidence and nothing else.** `result.is_error`
is read as follows:

| `is_error` | Verdict | Evidence |
| --- | --- | --- |
| `true` | `FAILED` | sample 1 |
| `false` | `SUCCEEDED` | sample 2 |
| absent | none | every earlier synthetic stream |
| any other value | `MALFORMED_EVENT`, never read as absent (ADR 0079) | — |

`is_api_error_message` is read the same way: present and not boolean is refused.
The session holds the verdict once, and a second verdict fails it with
`MALFORMED_EVENT` rather than overwriting it. `system/commands_changed` and
`rate_limit_event` are recognized no-signal records, grounded in sample 2 — the
latter only with the observed `rate_limit_info.status: "allowed"`; any other status
fails closed. `rate_limit_event` is never mapped to quota pressure: mapping a value
space seen only as `"allowed"` would be a capability claim. Any other unknown record
still fails closed, and so does a present value of the wrong shape: a `content` that
is not an array or a content block that is not an object. The fixture holds both sanitized samples as TypeScript
literals, byte-equal to the sanitized files, identified by their digests.

**Five — the API and local legs may report the verdict.** Their chunk unions
gain `operationResult`. The port holds it, at most once, and emits it in the
fixed order. No client produces it in P-07; the real ones are P-15's.

**Six — Codex and Kimi claim nothing.** Both refuse before a spawn. Their
`ERROR_<code>` and `TURN_<status>` stay `state` tokens. For them the operation's
verdict and the exit are not observable through the port.

**Seven — the laws.**

- **`L-P07C-1`** (new, path-scoped) holds three things:
  - exactly seven `src/` files may name the output signal or the sink type, plus
    the two contracts barrels, which re-export it as a type;
  - the session's router names no recorder, event builder or error;
  - the boundary keeps the sentence the ban enforces.

  A bare `sink(` call is not the test, because an unrelated edge calls its own
  frame sinks by that name. A function reaches output only through the sink's
  type. Escalón D amends this row to admit its assembler.
- **`L-P07A-1`** is amended in its own row. `execution-boundary/index.ts` is
  admitted for `RESULT_STATUSES` alone, in its one import form.

**Eight — no bump.** `ExecutionEvent` is a port shape with no contract version,
which is `INSTRUCTIONS_MAX_CHARS`' reasoning. `CONTRACT_VERSION` stays 2.8.0.

## Named finding, not resolved here — per-record usage double count

In sample 2, the two assistant records of one message share one `message.id` and
one `request_id`. Each one repeats the same `message.usage` (`output_tokens: 4`),
while `result.usage.output_tokens` is 44, of which 37 are thinking tokens. The
parser's per-record `step` therefore counts a partial figure twice and never sees
the final one. Fixing it means deduplicating by message or reading
`result.usage`, which is a usage-contract decision. It belongs to P-15: real class
normalization and the retirement of L-P32C-1. Escalón D must not treat those step
counts as settlement. The sanitized fixture holds placeholder numbers, so a test
of the defect must build it synthetically.

## Why `result.result` was not chosen as the output source

It is one final string and would duplicate the last text block. The assistant
`text` blocks are streamed, ordered and the observed shape. Taking both would
send the answer twice.

## Consequences

- `CONTRACTS_SCHEMA_EXPORTS` 160 → **161** (`ExecutionOutputSink`, a type).
- `PATH_SCOPED_LAWS` 147 → **148**.
- The ADR corpus 98 → 99.
- `PROVIDERS_PUBLIC_EXPORTS` and `RUNTIME_PUBLIC_EXPORTS` do not move, and
  L-B4A-3 stays at three.
- A CLI trail gains `processExited` directly before its terminal. Comparisons
  across legs set the two per-leg facts aside and assert them per leg.
- `AdapterSession` gains `exit()` and `operation()`, and `ProcessHandle` gains
  `exitStatus()`. The fake child can end by its own signal.

## Not in this record

- **Escalón D.** It assembles the result document from the sink, publishes it,
  and decides the effect outcome from the three facts.
- **P-15:**
  - the adapter's environment allowlist (sample 1's authentication finding,
    solved in sample 2 by `USER`);
  - whether the adapter's argv needs `--verbose` (the binary contains
    `requires --verbose`; unobserved);
  - the productive smoke;
  - the usage double count above.
- A success sample for any provider other than Claude.
