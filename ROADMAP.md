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

### WS-3: Delete with no assumed primary is sent unconditionally

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

### WS-12: Adopt the ecosystem logging library port

- status: in-progress
- priority: medium
- labels: logging, types, api
- touches:
  - shipped: was-sync (`src/log.ts` added; `SyncLogPort` and every `log?:`
    option removed from `controller.ts` and `conflictHandler.ts`;
    ARCHITECTURE.md invariant 13, layout, and Glossary; AGENTS.md; README
    Logging section; CHANGELOG 0.1.2)
  - shipped: freewallet (`syncController.ts` and `contactsConflictHandler.ts`
    pass no `log`; `src/lib/log.ts` wires `setLogger(createLogger('sync'))`
    beside `wc`; the `debug-logs` skill names `sync`; CHANGELOG 0.50.0; pins
    `link:../was-sync` until this version is published)
  - shipped: was-react (its `setLogger` forwards the logger to was-sync, so the
    driver's events arrive under `wr` -- decided 2026-09-06; the `log` options
    in `syncController.ts` and `localStore.ts` are dropped; README and CHANGELOG
    0.22.1; pins `link:../was-sync` until this version is published)
  - shipped: logger (README "Namespaces and the filter" lists `sync:` (was-sync)
    beside `fw:`, `wc:`, `wr:`, `dcw:`)
- acceptance:
  - [x] `src/log.ts` follows wallet-core's `src/log.ts` verbatim in shape: a
        locally declared four-method `Logger` (`debug`, `info`, `warn`, `error`,
        each `(msg, data?: Record<string, unknown>)`), a module-level logger
        defaulting to a `'[was-sync]'`-prefixed console fallback, and
        `setLogger(logger): Logger` exported from the package root, returning
        the previous logger
  - [x] `@interop/logger` is a devDependency only, imported as `import type` in
        tests alone; a mutual-assignability test pins the local `Logger` to the
        package's, and `test:packaging` greps `dist/` for the specifier the way
        wallet-core's `test:dist` does
  - [x] The eslint `no-restricted-imports` rule allows only type imports of
        `@interop/logger` in `src/`, with `src/log.ts` the stated exception
  - [x] `SyncLogPort` and the per-call `log` options are gone; the controller
        and conflict-handler call sites log through the module-level logger. The
        whole package emits under the one `sync` namespace the app wires
        (decided 2026-09-05: the four-method port carries no namespace, so
        per-area sub-namespaces such as `sync:push` are not expressible through
        it; the area is read off the message)
  - [x] The driver's swallow points emit through the seam: the best-effort ack
        patch in `src/wasReplication.ts` warns; a benign 412 delete retry and a
        conflict handed back to RxDB log at `debug`
  - [ ] `touches:` entries resolved; freewallet's and was-react's suites stay
        green against the published version (green against `link:` as of
        2026-09-06; the published-version check remains)

Context: The driver's diagnostics seam is a two-method structural `SyncLogPort`
(`src/types.ts`) threaded per call as an `options.log` on the controller core
and the conflict-handler builders, defaulting to a no-op. The RxDB handlers in
`wasReplication.ts`, `pushWrites.ts`, and `feedPrimaryPort.ts` log nothing,
since threading a port through closures RxDB's `replicateRxCollection`
constructs is clumsy. wallet-core and was-react both follow the logging
package's library-port convention instead: a locally declared `Logger`, a
`setLogger` an app calls once at bootstrap, the package as a devDependency, and
a test pinning the local type to the package's. was-sync is the odd one out on
three counts: its port cannot emit `info` or `debug`, so per-cycle diagnostics
gated behind the namespace filter are impossible; it is threaded rather than set
once; and nothing pins it against drift. The prefix `sync` joins the namespace
list in the logging package's README (`fw`, `wc`, `wr`, `dcw`). One seam
replaces two, per the greenfield stance; consumers lose an option from each
builder.

### WS-13: Pin the resurrection path's `/meta` write against the live server

- status: todo
- priority: medium
- labels: push, metadata, tombstones, integration-test
- touches:
  - was-sync: `test/node/replication.integration.test.ts`
  - was-teaching-server: WAS-89 (the metadata validator across a soft
    delete); the case below is the client-side check that its fix holds
  - wallet-attached-storage-spec: WASS-28 (the lifecycle rule the case
    asserts)
- acceptance:
  - [ ] An integration case resurrects a tombstoned row that carries `custom`
        and asserts both halves land in one push cycle: the content write
        under `If-None-Match: *`, then the `/meta` write under
        `If-None-Match: *`, with no 412 and no conflict-handler invocation
  - [ ] The same case asserts that a `/meta` `If-Match` carrying the
        pre-delete metadata `ETag` is refused with 412 after the re-create,
        so a stale replica cannot clobber the resurrected row's `custom`
  - [ ] ARCHITECTURE.md's push-handler notes record that the `/meta` half of a
        resurrection is a create-if-absent, and that a server keeping the
        metadata object through a tombstone would cost one extra cycle (a
        412, a re-read, a conflict resolution) rather than fail

The current resurrection integration test covers the content half only. The
push handler compares the new local `custom` against the assumed primary's,
and a tombstone entry has none, so the `/meta` write goes out as a
create-if-absent. Against the teaching server that is exactly right, because
its tombstone drops `custom` and `metaVersion`. It also depends on the server
not reusing the pre-delete metadata validator after the re-create, which the
server currently does (WAS-89): the meta `ETag` is `<generation>.<metaVersion>`
with the generation kept through the tombstone and `metaVersion` restarting at
1. The second acceptance point is what catches that class of defect from the
driver's side.
