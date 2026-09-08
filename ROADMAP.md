# WAS Sync Roadmap (open items)

nextAvailableId: 14

Status as of 2026-09-05. Uses the formalized item structure shared across the
`@interop/*` repos.

Scope: open work items only. This document tracks the **remaining** items;
completed items move verbatim to [archived-roadmap.md](archived-roadmap.md) as
they land, so WS-N references keep resolving (CHANGELOG.md remains the record of
what landed).

## Item format

Each work item is a `### WS-N: Title` heading followed by a field block and free
prose context. Ids are permanent and never reused; the `nextAvailableId` line
above is the sole source of the next id, rewritten in the same edit that takes
it. Statuses: `todo`, `in-progress`, `draft` (no actionable done-state yet --
blocked externally or a parking record); `done` items move to
[archived-roadmap.md](archived-roadmap.md) once shipped. Full conventions live
in [AGENTS.md](AGENTS.md) under "Roadmap & Task Conventions".

---

### WS-5: Benign-412 delete retry can delete an independently re-created resource

- status: todo
- priority: medium
- labels: push, conditional-writes, correctness
- acceptance:
  - [ ] The "my own revision drift" decision for a delete retry uses a signal
        with discriminating power on content-addressed rows (for example a
        version or createdBy comparison, or feed-based provenance), not data
        equality alone
  - [ ] A test shows: stale assumed version on replica A, delete-then-recreate
        of the same id by another writer, A's delete surfacing as a conflict
        instead of tombstoning the re-created resource

Context: On a content-addressed collection the body is fixed per id, so
comparing the primary's data against the assumed data (`src/pushWrites.ts:210`)
cannot tell "my own stale version" from "someone deleted and re-created this".
Freewallet's revoke/re-add and purge-undecryptable/resync paths do exactly that.
Replica A's delete 412s, the re-read shows equal data, and the retry re-issues
DELETE against the fresh ETag, tombstoning the re-created resource without the
412 ever reaching RxDB as a conflict. The metadata-edit variant is not reachable
(a `/meta` write leaves content version unchanged) and a live tombstone is
correctly rethrown; only delete-then-recreate is exposed.

### WS-6: Default `isEqual` hides server-only fields on the feed echo

- status: todo
- priority: medium
- labels: conflict-handler, pull, correctness
- touches:
  - was-sync (ARCHITECTURE.md conflict-handler section)
  - was-react (uses the default `isEqual`)
  - freewallet (already overrides with deepEqual; may drop the override)
- acceptance:
  - [ ] The default equality used by RxDB's downstream to decide whether to
        write the master state includes `updatedAt`, `createdBy`, and `epoch`
        (or ARCHITECTURE.md states why the driver deliberately excludes them and
        each consumer is told to override)
  - [ ] An integration test creates a row locally, lets the echo arrive with a
        server-assigned `createdBy`, and asserts it lands in the local row
  - [ ] The test server used by the integration suite assigns `createdBy` so the
        case is observable
  - [ ] `touches:` entries resolved

Context: `statesEqual` (`src/conflictHandler.ts:84`), the default `isEqual`,
omits `updatedAt`, `createdBy`, and `epoch`. RxDB's downstream skips writing the
master state to the fork when `isEqual` is true, so server-only fields on the
feed echo of this replica's own write never land locally. Every row a replica
created keeps the client's `updatedAt` and no `createdBy`. Freewallet documents
this and overrides `isEqual` with deepEqual
(`contactsConflictHandler.ts:19-24`); was-react uses the default and is exposed.
No current test asserts `createdBy` on a locally created row, and the fake
server never assigns one (see WS-11).

### WS-7: Ack write-back accepts version 0

- status: todo
- priority: medium
- labels: push, ack, was-client-port
- touches:
  - was-client (`putContent` / `deleteContent` resolve
    `readContent(id)?.version ?? 0` when the ETag is hidden; the contract should
    reject or signal, not fall back to 0)
  - was-sync (ARCHITECTURE.md ack section)
- acceptance:
  - [ ] The ack guard in `src/wasReplication.ts` (around line 44) rejects 0 as
        well as undefined, and states in a comment that 0 is never a legitimate
        revision
  - [ ] was-client's port no longer resolves a fabricated 0 when the ETag header
        is not exposed (in-house change; reference the was-client item)
  - [ ] A test with a port that resolves 0 shows the local row's version left
        untouched and no 412 on the following edit
  - [ ] `touches:` entries resolved

Context: The ack write-back stamps any number that is not undefined. was-client
never resolves undefined: when a cross-origin server does not expose the ETag
header, it falls back to version 0. was-react's deployment
(`feedPrimaryRead: true`, cross-origin) is exactly this case. Every accepted
write acks 0, the local row is patched to 0, the next edit sends `If-Match "0"`,
412s, the feed re-read repairs it, and the row re-pushes. Every edit costs an
extra 412, a feed walk, and a conflict resolution. `withFeedPrimaryRead` wraps
only `get`, leaving the ack path exposed to the same bug its header describes.

### WS-8: Status reports `synced` before any pull or push has run

- status: todo
- priority: medium
- labels: controller, status, correctness
- acceptance:
  - [ ] The controller does not translate the initial replayed `active$` value
        into `synced`; the first `synced` follows a completed cycle
  - [ ] The controller test's fake replication replays `false` on subscribe the
        way RxDB's `BehaviorSubject` does, and the test asserts the status
        sequence `idle` then (`syncing` | `error`) with no early `synced`

Context: RxDB's `state.active$` is a `BehaviorSubject(false)`, so subscribing at
`src/controller.ts:327` replays `false` synchronously and the handler reports
`synced`, overwriting the `idle` set two lines earlier. With the WAS server
unreachable the app's indicator shows `synced` for a session that has replicated
nothing, until the first `error$` emission after the network attempt times out.
The controller test's fake replication does not replay, so the suite cannot see
it.

### WS-9: The feed-walk memo only helps rows earlier in the feed than the first walked id

- status: todo
- priority: low
- labels: feed-primary-read, efficiency, docs
- acceptance:
  - [ ] Either the memo is reworked so a batch of k conflicting rows costs one
        walk regardless of arrival order and feed position, or the doc claims at
        `src/feedPrimaryPort.ts:126-127` and `src/pushWrites.ts:333-334` are
        corrected to state what is actually guaranteed
  - [ ] A test places ids across several feed pages and asserts the walk count
        for a batch whose `get` calls arrive out of feed order

Context: `walkFeedFor` returns as soon as it finds its own target, and every
waiting row loops on `inFlight`. A row whose resource sits past the previous
walk's stopping point starts its own origin walk, serialized behind the loop, so
a batch of k conflicting rows can cost on the order of H_k sequential full scans
rather than one. That is slower than k concurrent unmemoized walks. The existing
"walks again for an id the memo never saw" test demonstrates the re-walk, and
both "one walk" tests place every id on one page.
