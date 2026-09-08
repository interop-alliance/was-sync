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
