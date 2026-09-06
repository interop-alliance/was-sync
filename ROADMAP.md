# WAS Sync Roadmap (open items)

nextAvailableId: 12

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

### WS-2: Resurrect-after-remote-delete livelocks on the plain port

- status: todo
- priority: high
- labels: push, conflict, correctness
- acceptance:
  - [ ] On the plain was-client port, a 412 followed by a null re-read is
        classified (tombstone vs absence) before a conflict entry is built, and
        a tombstoned assumed master takes the create path rather than `If-Match`
  - [ ] A push test passes an `assumedMasterState` with `_deleted: true` and
        asserts the write converges in one cycle instead of re-issuing
        `If-Match` with a fabricated version
  - [ ] `primaryOrTombstone` no longer fabricates the conflict entry's version
        from local state

Context: When a conditional write 412s, the push path re-reads the primary. On
the plain port (no `withFeedPrimaryRead`) a tombstone and an absence both
resolve to null, and `primaryOrTombstone` (`src/pushWrites.ts:97`) fills in a
conflict entry using the local version. Replica B deletes X (server version 2).
Replica A, at assumed version 1, edits X: 412, null re-read, fabricated entry
`{version: 1, _deleted: true}`, the resolver picks local, RxDB stores that
fabricated entry as assumed master and re-pushes with `If-Match "1"` (line 246)
rather than a create. Each conflict write bumps the fork revision and retriggers
upstream, so this is a hot loop rather than a per-poll retry. Freewallet runs
this port.

### WS-3: Delete with no assumed master is sent unconditionally

- status: todo
- priority: high
- labels: push, correctness, conditional-writes
- acceptance:
  - [ ] A delete whose `assumedMasterState` is undefined carries a precondition
        or is skipped, symmetric with the create path's `ifNoneMatch` guard; the
        chosen mechanism is recorded in ARCHITECTURE.md
  - [ ] The push test for this branch (`test/node/pushWrites.test.ts` around
        lines 1068-1082) is rewritten so the fake port no longer synthesizes a
        412 that a real server would not send for a header-less DELETE
  - [ ] A test shows a create-then-delete on replica B, before B's first push,
        leaving replica A's live copy of the same content-addressed id intact

Context: Ids are content-addressed and identical across replicas (invariant 2).
Replica A creates row r and pushes it. Replica B creates the same r locally and
deletes it before its first push. RxDB coalesces that to a delete with no
assumed master, and `src/pushWrites.ts:197` issues `deleteContent({ id })` with
no `If-Match`. The server returns 204 and A's live resource is tombstoned by a
replica that never synced it. The create path guards itself with `ifNoneMatch`;
the delete path has no symmetric guard.

### WS-4: The `/meta` 404 delete-race recovery is unreachable on the default port

- status: todo
- priority: high
- labels: push, metadata, correctness, was-client-port
- acceptance:
  - [ ] The `/meta` write's not-found branch matches the plain `NotFoundError`
        shape as well as the `mapAuthErrors: true` shape, by `err.name`
  - [ ] A push test on the default port shape shows a metadata-only edit against
        a tombstoned resource resolving as the comment at
        `src/pushWrites.ts:290-299` describes, rather than rejecting the batch
  - [ ] Shared with WS-1: one predicate or helper classifies not-found across
        both port configurations, so the two branches cannot drift again

Context: The recovery branch at `src/pushWrites.ts:302` is gated on
`isSyncAuthError && status === 404`, a shape only a `mapAuthErrors: true` port
raises. With the flag off, was-client's `putMeta` throws a plain `NotFoundError`
that matches neither branch and falls through to `throw err`. Replica A deletes
contact X; replica B, offline, edits only X's metadata. B reconnects,
`contentChanged` is false so no content write runs, `PUT /X/meta` 404s against
the tombstone, the batch rejects, and RxDB retries the same write forever. This
is exactly the wedge the surrounding comment says the branch exists to prevent,
on the default port configuration. WS-1 settled the shared predicate as
was-client's `isSyncNotFoundError` (`err.name === 'WasSyncNotFoundError'`); note
the default port's `putMeta` currently raises a plain `NotFoundError` that this
predicate does not match, so the `/meta` half likely needs was-client to raise
the sync signal there (an in-house change).

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

### WS-10: Drop the port cast and `putMeta` probe once was-client's port type is complete

- status: todo
- priority: low
- labels: controller, types, was-client-port
- touches:
  - was-client (`createWasSyncPort` return type gains a required `putMeta`, or a
    full-port type is exported)
  - was-sync (remove the cast and probe in `src/controller.ts`)
  - was-react (remove the identical workaround in `wasSyncPort.ts:64-74`)
- acceptance:
  - [ ] was-client's port type matches what `createWasSyncPort` implements
        (in-house change; reference the was-client item)
  - [ ] `src/controller.ts` (around line 300) has no
        `as unknown as     WasSyncPort` cast and no runtime
        `typeof basePort.putMeta` probe
  - [ ] was-react's copy of the workaround is removed
  - [ ] `touches:` entries resolved

Context: was-client types `putMeta` as optional on its `WasSyncPort` while
`createWasSyncPort` always implements it. Both this driver and was-react cast
through `unknown` and probe at runtime. The cast silences every future
divergence in `query` / `putContent` / `deleteContent` / `get`, not just
`putMeta`: a was-client rename type-checks clean here and fails only inside a
push or pull cycle as an `error$` event. Two consumers carrying the same
cast-and-probe is the signal that the fix belongs upstream, after which the
divergence becomes a compile error at the seam.
