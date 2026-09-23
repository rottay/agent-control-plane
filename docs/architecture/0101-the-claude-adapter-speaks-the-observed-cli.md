# ADR 0101 — The Claude adapter speaks the observed CLI

- Status: accepted (P-15 escalón A, recorded 2026-09-23).
- Supersedes: none.
- Superseded-by: none.
- Amends: none. The providers environment allowlist is amended in its own fence
  row.

## Context

P-07/C captured the real Claude CLI twice (ADR 0099). Both runs used CLI `2.1.280`
and `--model haiku`, and passed the prompt on stdin. The first run did not
authenticate. The second authenticated and exited 0. Both runs passed flags the
adapter did not: `--verbose`, `--no-session-persistence`, `--strict-mcp-config`
with an empty `--mcp-config`, plus a smoke profile (`--tools ""`, `--safe-mode`,
`--max-budget-usd`). The adapter's argv was `-p --output-format stream-json
--model <alias> --session-id <taskId>`.

A later diagnosis used only `claude auth status`, with no model call. It found why
the first run failed:

- under the adapter-shaped environment (`env -i HOME PATH CLAUDE_CONFIG_DIR`) the
  CLI reports `loggedIn: false`;
- adding `USER` alone flips it to `true`, twice;
- a wrong `USER` stays `false`, and so does adding any one of the other 51 parent
  variables;
- the binary reads the keychain account from `process.env.USER` first.

Three more facts shaped the design:

- **The session name.** `--session-id` must be a valid UUID (stated in the
  recorded `--help` (2.1.280), behaviour not observed). Every
  attempt of a task passed the same task id, and the execution session id
  (`taskId/attempt/accountId`) is not a UUID.
- **No hashing available.** Providers may not import `node:crypto`, the runtime or
  anything that reaches a `node:` builtin through the kernel, so the adapter had no
  way to hash a name.
- **Resume.** The port never sets `resumeSessionId`: a reattach is an in-process
  rejoin, and a cross-process one is `REATTACH_UNAVAILABLE` (ADR 0019).

The P-15 adjudication v2 fixed the direction: ND-8 (`USER` for Claude only), ND-9
(`--verbose` and the captures' safety flags, with no session reuse across
attempts) and C8 (a version 5 session id per attempt, with `--resume` taking the
same id). The DT answered Q-A1 to Q-A4 and declined a third capture.

## Decision

**One — `USER` for Claude, and nothing else anywhere.** `config-root` gains
`PROVIDER_EXTRA_ENV`: `claude: ["USER"]`, `kimi: []`, `codex: []`. The pieces that
read it:

- `allowedEnvKeys` is the base, the configuration variable and the extras, sorted;
- `buildEnv` copies the extras from the parent key by key, as it copies the base,
  and never spreads;
- an extra the parent lacks stays absent: never an empty string, never invented.

A present value is copied as it is, which is the base keys' rule. `USER` is a login
name, not a secret. Kimi and Codex never receive it.

**Two — the argv, flag by flag.** Every Claude session is started with:

```
-p --output-format stream-json --verbose --model <alias>
--session-id <claudeSessionId(taskId, attempt)> --no-session-persistence
--strict-mcp-config --mcp-config {"mcpServers":{}}
```

- `--verbose`, always. The binary carries the string `requires --verbose` for
  `stream-json` under `-p`, and both captures passed it and produced a well-formed
  stream.
- `--no-session-persistence`. Sessions are not saved and cannot be resumed (stated
  in the recorded `--help` (2.1.280), behaviour not observed). So no provider transcript is kept under the account's
  configuration root. Both captures passed it.
- `--strict-mcp-config` with an empty configuration: no MCP server configured on
  the account reaches a worker. Both captures reported `init.mcp_servers: []`.
- A reviewer adds `--tools Glob,Grep,Read,WebFetch,WebSearch` after the unchanged
  `--permission-mode plan --restricted`. It is a CLI-side copy of the read-only
  allowlist. The structural scan before spawn and the kill during the stream stay
  the load-bearing layer, and `descriptorEnablesWrites` still answers false.

These flags stay out of the adapter:

- `--tools ""` and `--max-turns 1`: smoke-profile flags, and an implementer needs
  tools and turns.
- `--safe-mode`: it disables `CLAUDE.md`, hooks and skills, and a worker in this
  repository must read `AGENTS.md` and `CLAUDE.md`.
- `--max-budget-usd` (Q-A3): it is not a hard cap, and no admitted value exists.

**Three — one session name per attempt.** The name comes from
`claudeSessionId(taskId, attempt)`:

- it is an RFC 4122 version 5 UUID over `taskId + "/" + attempt`;
- the namespace is its own constant, `CLAUDE_SESSION_UUID_NAMESPACE`, distinct from
  the runtime's coordinate namespace;
- it is pinned by vectors computed outside the package;
- a task id that is not a non-empty string, or an attempt that is not a positive
  safe integer, is refused with `PROTOCOL_UNSUPPORTED`, never coerced.

The leaf `providers/src/session-name/` is the one providers file admitted to
`node:crypto`, for the one SHA-1 that version 5 is defined over. Computing the name
in the runtime and carrying it in `ExecutionRequest` was rejected: that would be a
kernel contract change for a transport detail.

**Four — `--resume` with the attempt's own name, or not at all (Q-A1).** When a
`SessionRequest` carries `resumeSessionId`:

- a value equal to `claudeSessionId(taskId, attempt)` gives `--resume <that id>`
  and no `--session-id`;
- any other value is refused before the argv exists: another attempt's id, the task
  id, an empty string, a value of another type. `describe` throws
  `AdapterError("PROTOCOL_UNSUPPORTED")`, and `startSession` calls `describe` first,
  so no process is spawned.

Through the port, such a refusal would surface as `TRANSPORT_UNAVAILABLE` at
`startSession/PROTOCOL_UNSUPPORTED`. No vocabulary member is added.
`REATTACH_UNAVAILABLE` stays the port's word for every reattach the port can see.

The adapter branch is unreachable from the port today: `resumeSessionId` is always
null there. An adapter-level negative covers it, and a drill shows that a
mismatched `--resume` is refused before any spawn.

With persistence off, a resume would find nothing. The branch is the typed,
id-checked shape and nothing proven. Reattach after a daemon's death stays
**not proven and refused**.

**Five — the laws.**

- **`L-P15A-1`** (new, path-scoped). `providers/src/session-name/index.ts` is the
  only providers source that imports `node:crypto`. It calls `createHash("sha1")`
  once, and it names no randomness, clock or environment. Every other providers
  source is refused `node:crypto` and every hashing or minting name. Tests keep
  `node:crypto` through the test-only imports.
- **The environment allowlist**, amended in its row. `PROVIDERS_ENV_ALLOWLIST.claude`
  gains `USER`. The equality check now also reads `PROVIDER_EXTRA_ENV`, and checks
  provider by provider that each one's extras are exactly its pinned allowlist
  minus the base and its configuration variable.

## Unproven claims

Neither capture observed the following. The DT declined a third capture. The S1
smoke, which the owner authorizes separately, is where they are to be proven.

1. That the adapter's **exact** argv runs. Neither capture passed `--session-id`,
   and both also passed the smoke profile's flags.
2. That `--session-id <v5>` is accepted together with `--no-session-persistence`,
   and that `init.session_id` echoes the id passed.
3. The reviewer's `--tools <list>` form, and how it interacts with `--restricted`.
   `--restricted` removes WebFetch unless `--tools` names it (stated in the recorded
   `--help` (2.1.280), behaviour not observed).
4. That the production daemon's environment carries `USER` under launchd. If it
   does not, the child reports "Not logged in", as in the first capture. That is a
   classified `FAILED` operation, not a silent success.
5. Any behaviour of `--resume`. It is unreachable from the port.
6. Multi-turn or tool-using sessions, `terminal_reason` values beyond `completed`
   and `api_error`, and signal exits.
7. Any model other than `claude-haiku-4-5-20251001`, and any CLI other than
   `2.1.280`.
8. That nothing is written under the account's configuration root when
   persistence is off. The recorded `--help` says so, but no file listing was taken.
9. The behaviour of the flags whose existence and meaning only the recorded
   `--help` supports, in this adapter's combination:
   - the reviewer's `--permission-mode plan` with `--restricted` and the `--tools`
     list, together;
   - `--session-id`: that the CLI accepts the id and echoes it;
   - `--resume`, in any form.

## The recorded `--help`

The existence and stated semantics of `--permission-mode` (including `plan`),
`--restricted`, `--session-id`, `--resume` and the `--tools` list form rest on one
zero-spend transcript. It is the output of `claude --help` from CLI `2.1.280` on
the claude-admin account, with no model call, sha256
`cafad5b30679625714744f44d7b8c420075e2ed6311a31370a28e0a1b96e3de0`. Like the
captures ADR 0099 cites, the file is kept as evidence outside the tree and is
identified here by its digest:

| Flag | What the transcript states |
| --- | --- |
| `--permission-mode <mode>` | the session's permission mode, with `plan` among the choices |
| `--restricted` | removes the built-in tools that run commands or code, and WebFetch unless `--tools` names them |
| `-r, --resume [value]` | resume a conversation by session id |
| `--session-id <uuid>` | use a specific session id for the conversation, which must be a valid UUID |
| `--tools <tools...>` | the list of available tools, in list form |

It states what the flags are. It observes nothing about how they behave, which is
item 9 above.

## Why usage is not in this record

ND-4 puts the widened usage member and "Claude takes usage once, from
`result.usage`" in the escalón that retires L-P32C-1: P-15/D (Q-A4). Reading usage
from `result.usage` alone would remove the usage event from every synthetic
Claude stream that puts usage on `assistant` records, in files the port widening
would reshape again. The per-record double count named in ADR 0099 stays open
until then.

## Consequences

- `PATH_SCOPED_LAWS` 149 → **150**.
- `PROVIDERS_PUBLIC_EXPORTS` 88 → **91**: `claudeSessionId`,
  `CLAUDE_SESSION_UUID_NAMESPACE` and `PROVIDER_EXTRA_ENV`.
- The Claude environment allowlist goes from 4 to **5**, and the ADR corpus from
  100 to 101.
- These do not move:
  - `CONTRACT_VERSION`, `CONTRACTS_SCHEMA_EXPORTS`, `RUNTIME_PUBLIC_EXPORTS`,
    `MIGRATIONS`;
  - `ADAPTER_ERROR_CODES`, since no word is added;
  - the API and local client shapes;
  - L-B4A-3, L-P07C-1 and L-P32C-1.
- A Claude session's argv changes shape, and each attempt names a different
  session. A test fake that rewrites `describe` is unaffected.

## Not in this record

- **P-15/D:** usage once from `result.usage`, and the widened port member.
- **The S1 smoke**, owner-authorized: the unproven claims above.
- **Real API and local clients, and the credential resolver:** P-15/E, and P-19.
