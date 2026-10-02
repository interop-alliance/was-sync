# WAS Sync Roadmap (open items)

nextAvailableId: 17

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

2026-09-28: seen again while adding writerId push stamping. The mixed-feed
convergence case in `test/node/replication.integration.test.ts`, run against the
live server, compares the writing replica on every field except `updatedAt` and
`createdBy`, with a comment saying why. That exclusion is the check to remove
when this lands. The observation there named the ack write-back as the cause: it
is a local write, so the echo lands behind a push cycle with nothing to send
while the checkpoint moves on. Confirm which of the two mechanisms (that one, or
the `isEqual` skip above) actually drops the fields before fixing.

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
