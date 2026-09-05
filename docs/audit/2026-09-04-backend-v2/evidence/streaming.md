# acp-sse — audit report (snapshot 4569478)

Read-only audit of SSE sequence, ledger identity, `Last-Event-ID`, reconnect/replay and browser vocabulary.
Ran `gateway/test/stream/index.test.ts` (30 passed) and both console stream suites (54 passed) at this snapshot.

## Scores + justification

**SSE/streaming correctness: 8/10.** The "sequence is the only identity" law is structural rather than
remembered. `encodeEventFrame` is the single `id:` producer and asserts `frame.item.sequence === sequence`
(`packages/entrypoints/gateway/src/stream/index.ts:97-107`); `encodeControlFrame` takes no sequence parameter,
so `hello`/`resync` cannot carry one (115-120); the keep-alive is an SSE comment (77). Density is guaranteed at
the source: every append runs in a `.immediate()` transaction
(`packages/persistence/ledger/src/ledger/index.ts:803-807`) and refuses unless
`lastInsertRowid === head.sequence + 1` (885-889), so a poll on `sequence > cursor` cannot straddle a hole. The
cursor is exclusive and advances only to a row actually written (383). There is no in-process queue; a slow
socket pauses the poll at `drain` (410-430). Deductions are S1, S2 and S5.

**Vocabulario seguro hacia el navegador: 9/10.** Redaction is absence, not filtering. `TimelineItem` is a
`z.strictObject` with no payload field at all (`packages/kernel/protocol/src/schemas/index.ts:344-376`) and
`timelineItem` emits only key names plus a byte size
(`packages/entrypoints/gateway/src/mappers/index.ts:110-111`). `attachGuards` re-runs the ledger's credential
and transcript scanners on the way out (142-157), and `payloadKeys` are rebuilt into an object so array values
get scanned as the key names they are (380-400). The path becomes a digest plus a `DatabaseLabel` that rejects
separators, `..`, `~` and dotfiles (169-180). Tests assert on raw wire bytes and carry a positive control: the
sentinel is read back out of the ledger to prove it was there and did not reach the wire
(`gateway/test/stream/index.test.ts:1035-1051`), plus a non-vacuity check on the helper (1054-1059). One point
off: `payloadKeys` are producer-chosen strings up to 80 chars that cross verbatim, scanned only for
credential/transcript shapes, and `payloadByteSize` is a weak content side channel.

## Findings

**S1 — `LedgerDatabaseIdentity.id` is a digest of the path, so a same-path ledger replacement is invisible.**
Class 1 (real, blocking the invariant the packet claims).
Evidence: `packages/entrypoints/gateway/src/database-identity/index.ts:22-28` hashes `resolve(path)` and
nothing else. `ledger_meta` holds only head/count rows and no instance id
(`packages/persistence/ledger/src/migrations/index.ts:154-162`), so no better signal exists today. The client's
foreign-ledger arm compares `frame.database.id` (`packages/entrypoints/console/src/api/stream/index.ts:513`).
A probe confirms two entirely different files at one path yield a byte-identical id.
Impact: ADR 0028's motivating case — "the file behind the URL is now ledger B with a head of 40" — is detected
only when the *path* changed. Restore a backup over the same filename, restart, and a surviving tab holding
sequence 3 gets `database.id` equal, `resumedFrom` equal to its anchor, no halt, then applies ledger B's rows
4..40 into a view rendering ledger A. `ANCHOR_AHEAD_OF_HEAD` catches only the *shorter* replacement. The
console tests use `DATABASE_A`/`DATABASE_B`, i.e. two different paths
(`console/test/api/stream/index.test.ts:648-690`); no test covers same path, different file.
Minimal fix: mint a `ledger_instance_id` uuid into `ledger_meta` at creation and fold it into `id`. Cheaper
interim: have the client verify the chain it already receives, `previousSha256` of row N+1 against
`eventSha256` of row N. Phase: next.

**S2 — On a quiet ledger the console shows Degraded after 30 s, permanently.** Class 2.
Evidence: the heartbeat is a comment no browser delivers (`gateway/src/stream/index.ts:77`). The client's
liveness timer is re-armed only by `onOpen` and `onFrame` (`console/src/api/stream/index.ts:844-868`); at
`STREAM_LIVENESS_TIMEOUT_MS` (30 s) `noteLivenessOverdue` sets `degraded` (714-723), rendered as "Degraded"
and "The live connection is not delivering; … may not be current"
(`console/src/components/stream-status/index.tsx:32,64`). Asserted as intended at
`console/test/api/stream/index.test.ts:1060-1078`.
Impact: an agent control plane is idle between tasks, so Degraded is the steady state and the warning stops
carrying information. The store's own detail text concedes it: "a quiet ledger and a stalled connection look
the same from here."
Minimal fix: a fourth control-frame kind written through `encodeControlFrame` on the same 15 s idle schedule.
It takes no sequence, so it structurally cannot carry an `id:` or move a cursor. Keep the comment for proxies.
Phase: next.

**S3 — Only one of the ledger's three append-only streams is streamed.** Class 4 for correctness, Class 2 for
console completeness.
Evidence: `listEvents` reads `control_plane_events` only
(`packages/persistence/ledger/src/ledger/index.ts:2347-2353`). `initiative_events` and `account_events` are
separate tables with their own `AUTOINCREMENT` sequences (`migrations/index.ts:182-183, 271-272`).
`API_ROUTES` defines exactly one stream route (`packages/kernel/protocol/src/routes/index.ts:63`), and the
channel map is total over `ControlPlaneEventType` only.
Impact: the cursor is one sequence over one stream, so the interleaving hazard does not exist. Equally,
initiative and account activity never reach the console live.
Minimal fix: none for correctness. A live initiative view needs a second route with its own cursor, never a
merged sequence. Phase: later.

**S4 — `#open()` runs a full diagnostic to read one scalar.** Class 2.
Evidence: `gateway/src/stream/index.ts:282` calls `ledger.status().headSequence`. `status()` issues a
`SELECT COUNT(*)` per projection table, reads the applied-migration set and makes five pragma calls
(`ledger/index.ts:2675-2726`). `#readHead()` is a single `ledger_meta` read but is private (551-569), and
`status()` is the only public exposure of `headSequence`.
Impact: paid once per connection open, and `retry: 3000` means a reconnecting tab repeats it every three
seconds. Unindexed counts grow with the projection.
Minimal fix: expose `headSequence(): number` on `Ledger`, backed by `#readHead()`. Phase: next.

**S5 — The headline reconnect test can pass without exercising a replay.** Class 2.
Evidence: `gateway/test/stream/index.test.ts:566-616`. The default seed is 24 rows; the first connection waits
for 5 and aborts, but the server drains a whole 200-row page without sleeping between pages
(`gateway/src/stream/index.ts:389`), so the client has almost certainly buffered all 24 before the predicate
observes 5. Then `resumeFrom === headSequence`, the second connection replays nothing, and the union assertion
at 615 still passes. The test's own comment concedes the case (590-596: "in which case
`headSequence - resumeFrom` is ZERO").
Impact: the composed claim is probabilistically covered. The mechanism itself is proven deterministically
elsewhere — anchor 3 on a 6-row seed yields first row 4 and never 3 (618-634).
Minimal fix: seed past one page, or append during the disconnect window and assert the second connection's ids
equal exactly the missed range. Phase: next.

**S6 — "There is no buffer to grow" overstates the backpressure story.** Class 3.
Evidence: `gateway/src/stream/index.ts:408` and 42-43. Node buffers the frame that made `write` return false in
the socket's writable queue.
Impact: none practical. The bound is roughly one frame past the 16 KB high-water mark, which is correct. Only
the comment is absolute where the code is not.
Minimal fix: reword to "at most one frame past the high-water mark". Phase: opportunistic.

## Adversarial coverage table

| Case | Status | Evidence |
| --- | --- | --- |
| LEID > head | COVERED | one `resync`, no `hello`, close, never a restart from zero — `stream/index.ts:284-296`, asserted `test/stream/index.test.ts:811-825` |
| LEID non-numeric / `0x10` / `1e3` / 40 digits | COVERED | `parseStreamAnchor` 144-163; `BAD_REQUEST` before hijack, header bytes never echoed — `routes/index.ts:493-500`, asserted 834-846 |
| LEID from another ledger (different path) | COVERED | client resets to the foreign head and drops every replayed row — `api/stream/index.ts:513-534`, asserted `console/test/api/stream/index.test.ts:648-690` |
| LEID from another ledger (same path) | **UNCOVERED** | S1 — identity is a path digest, so the compare cannot fire |
| Ledger file swapped under a running server | UNCOVERED / partly moot | S1. A rename leaves the server on the old inode; an in-place overwrite is undefined for the open handle. No test, no detection |
| Three streams interleaving on one cursor | NOT APPLICABLE | S3 — only `control_plane_events` streams |
| Server restart mid-stream (same file) | COVERED | native reconnect sends the anchor; `hello` restates identity before any replayed row — asserted 719-747 |
| Client behind by > MAX_PAGE_LIMIT | COVERED | server pages 200 without sleeping (`stream/index.ts:389`); client backfill is 10 × 200 then halts visibly — asserted `console/…:330-360` |
| Duplicate delivery after an append retry | COVERED | `idempotency_key` UNIQUE plus the sequence assertion; client drops by sequence — asserted `console/…:275-307` |
| Reconnect storm | COVERED | ceiling 8, refused with 503 `STREAM_CAPACITY` before hijack, open connections untouched, slot releases — asserted 1084-1116 |
| Head moved backwards under one identity | COVERED | client halts — `api/stream/index.ts:571-580`, asserted `console/…:623-635` |
| Anchor behind what the view applied | COVERED | one-directional halt — 560-568, asserted `console/…:729-745` |

## Verified claims that hold

- Exactly one expression writes an `id:` line, and it is `String(sequence)`; control frames structurally cannot
  carry one. `hello` before any replayed row on a resumed open (`stream/index.ts:315-332`).
- Ordering across a reconnect measured against the ledger itself, not a fixture: sorted, unique, and equal to
  `sequencesInLedger(path)` (`test/stream/index.test.ts:612-615`).
- Filters narrow without renumbering, so a filtered id stays a valid anchor against the unfiltered log (934-942).
- The stream and the paged route produce byte-equal items and the same channel (878-887); all five channels are
  reached in fact, not on paper (890-906).
- No absolute path, payload value, tool argument or transcript on the wire, asserted on raw bytes with a
  positive control (974-1051).
- Shutdown drains streams before closing the ledger; the client sees a clean end (1123-1169).
- `EventSource` native reconnect is honoured: `retry: 3000` is sent once, carries no `data:` and no `id:` (66, 557).
- The client persists no cursor across reload. No `localStorage`, `sessionStorage` or IndexedDB anywhere in
  `console/src`; a reload builds a new scope and opens live.

## Open questions

1. Is a same-path ledger restore an accepted operational procedure? If yes, S1 needs a database-borne instance id.
2. Was `retry: 3000` chosen against `STREAM_MAX_CONNECTIONS = 8`? Eight tabs at a 3 s retry is the only path to
   sustained `status()` load (S4), though a 503 permanently closes an `EventSource` and so cannot loop.
3. Should the console verify the hash chain it already receives? `previousSha256`/`eventSha256` are on every
   frame and unused, and would independently close S1 and any future seam defect.
