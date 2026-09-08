# WAS Sync Roadmap -- archived (completed) items

Completed items from [ROADMAP.md](ROADMAP.md), moved here verbatim when they
ship so that item-number references (WS-N) in the active roadmap, commit
messages, and design docs keep resolving. Append-only: newest at the bottom; do
not rewrite or summarize items on the way in. Ids remain permanent and are never
reused. CHANGELOG.md stays the record of _what_ landed; this file preserves each
item's acceptance criteria and context.

---

### WS-11: Replace `FakeWasServer` with a live in-process was-teaching-server

- status: done
- done: 2026-09-05
- priority: high
- labels: testing, integration, fixtures
- touches:
  - was-sync (ARCHITECTURE.md: `./testing` entry description, invariant 15;
    AGENTS.md: Tests section and Project Overview's `FakeWasServer` note; README
    if it names the fixture)
  - was-react (no consumer of `@interop/was-sync/testing` found; confirm and
    waive)
  - freewallet (same)
- acceptance:
  - [x] `test/node/replication.integration.test.ts` runs against `createApp`
        from `was-teaching-server` (devDependency, registry version) listening
        on an ephemeral port, with a throwaway `FileSystemBackend` directory per
        suite, using the `beforeAll` / `listen` pattern was-react's
        `test/node/conditionalWrites.test.ts` already uses
  - [x] The port under test is the real `createWasSyncPort` from was-client
        against that server, on the default configuration, so the port-shape
        findings (WS-1, WS-2, WS-4, WS-7) are reproducible in this repo
  - [x] `FakeWasServer` is deleted from `src/testing.ts`; `stubSyncPort`,
        `memorySchedule`, and `memoryOnlineSource` stay (or move to `test/`) as
        decided during the change
  - [x] Invariant 15 in ARCHITECTURE.md is rewritten for what `./testing` still
        carries, or the subpath is removed if nothing consumer-facing remains
  - [x] Coverage the fake gave for free (feed paging, tombstones in the feed,
        412 on stale `If-Match`, `/meta` writes, server-assigned `createdBy`) is
        asserted against the live server, not lost
  - [x] `touches:` entries resolved

Context: `FakeWasServer` accepts every write and serves a plausible feed. It is
a second implementation of the WAS contract, maintained here, and it has already
diverged from the server in ways that hide bugs: it synthesizes a 412 for a
header-less DELETE (WS-3), never assigns `createdBy` (WS-6), and raises error
shapes the default was-client port does not (WS-1, WS-4). The review findings
WS-1 through WS-7 all involve behavior the fake gets wrong or does not model.
was-teaching-server exports an in-process `createApp` factory, supports the
`changes` query profile, conditional writes with 412 on resources and `/meta`,
tombstones in the feed, and `/meta` writes, and was-react's node tests already
run against it in-process. Running the integration suite on the live server
removes a fixture that would otherwise need to track the spec by hand.

discovered-from: the 2026-09-05 code review that produced WS-1 through WS-10.

### WS-1: Delete 404 on the default port wedges the push batch

- status: done
- done: 2026-09-05
- priority: high
- labels: push, correctness, was-client-port
- acceptance:
  - [x] A not-found error from `deleteContent` is treated as a benign
        already-gone outcome on both port configurations (default and
        `mapAuthErrors: true`), matched by `err.name` (invariant 5)
  - [x] A push test on the default port shape (plain `NotFoundError`, no
        `status`) shows the batch completing and the other rows landing
  - [x] The hazard note in `src/types.ts` (around line 349) is either removed or
        turned into a statement of what the driver guarantees

Context: The push handler treats every `deleteContent` rejection as fatal unless
it matches the conflict or auth predicates. was-client's port only swallows a
delete 404 when it is built with `mapAuthErrors: true`, and Freewallet builds
the default port. Deleting a row the server never held (a create whose push
never landed) or one another replica already deleted throws
`WasSyncNotFoundError`, the whole `Promise.all` rejects, and RxDB re-sends the
identical batch on every retry. The collection pins to `error` and every other
row in that batch never reaches the server. `src/pushWrites.ts:204` is the
rethrow; `src/types.ts:349-353` documents the hazard without enforcing it.

Outcome: `pushRow` reads was-client's not-found signal (`isSyncNotFoundError`,
by `err.name`) from either `deleteContent` call (the first delete and the
benign-412 retry) as the already-gone outcome, so both port configurations
complete the batch. One correction to the premise above: per the WAS spec an
authorized DELETE of an absent resource returns `204` (the teaching server
does), so a delete `404` on a conformant server is the masked authorization
refusal rather than the never-pushed row. The driver now swallows it on the
default port the same way was-client already does under `mapAuthErrors`, and
revoked access still surfaces on the next feed pull. The integration suite pins
the spec-conformant `204` path; the `404` shape is covered by the push unit
suite.

### WS-2: Resurrect-after-remote-delete livelocks on the plain port

- status: done (2026-09-07)
- priority: high
- labels: push, conflict, correctness
- acceptance:
  - [x] On the plain was-client port, a 412 followed by a null re-read builds a
        tombstone conflict entry (a tombstone and an absence take the same next
        write, so the entry does not tell them apart), and a tombstoned assumed
        primary takes the create path rather than `If-Match`
  - [x] A push test passes an `assumedMasterState` with `_deleted: true` and
        asserts the write converges in one cycle instead of re-issuing
        `If-Match` with a fabricated version
  - [x] `primaryOrTombstone` no longer fabricates the conflict entry's version
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

Outcome: The picture shifted under the item before it was implemented. Once
`If-Match` became the opaque `etag` echoed verbatim, a fabricated `version`
could no longer feed a precondition, and the re-push after the conflict sent an
unconditional `PUT` instead of looping: it converged, but could overwrite a
concurrent re-create. The fix is the same either way. A null re-read now builds
`{ version: 0, _deleted: true }` with no `etag` (zero being the value a fresh
local row already carries for "no server revision known"), and an assumed
primary with `_deleted: true` routes a content write to `If-None-Match: *` and a
delete to an unconditional `DELETE`. Classification on the plain port is neither
possible (a tombstone `GET` is a `404`, and the server never sends `410`) nor
needed: the server treats a tombstone as absent for preconditions, so
create-if-absent is the one path that resurrects it and `If-Match` against a
tombstone is refused whatever validator is sent, the surviving generation ETag
included. The integration suite drives the scenario against the live server on
the plain port and asserts one refused update followed by exactly one create.

### WS-13: Pin the resurrection path's `/meta` write against the live server

- status: done
- done: 2026-09-07
- priority: medium
- labels: push, metadata, tombstones, integration-test
- touches:
  - was-sync: `test/node/replication.integration.test.ts`
  - was-teaching-server: WAS-89 (the metadata validator across a soft delete);
    the case below is the client-side check that its fix holds
  - wallet-attached-storage-spec: WASS-28 (the lifecycle rule the case asserts)
- acceptance:
  - [x] An integration case resurrects a tombstoned row that carries `custom`
        and asserts both halves land in one push cycle: the content write under
        `If-None-Match: *`, then the `/meta` write under `If-None-Match: *`,
        with no 412 and no conflict-handler invocation
  - [x] The same case asserts that a `/meta` `If-Match` carrying the pre-delete
        metadata `ETag` is refused with 412 after the re-create, so a stale
        replica cannot clobber the resurrected row's `custom`
  - [x] ARCHITECTURE.md's push-handler notes record that the `/meta` half of a
        resurrection is a create-if-absent, and that a server keeping the
        metadata object through a tombstone would cost one extra cycle (a 412, a
        re-read, a conflict resolution) rather than fail

The current resurrection integration test covers the content half only. The push
handler compares the new local `custom` against the assumed primary's, and a
tombstone entry has none, so the `/meta` write goes out as a create-if-absent.
Against the teaching server that is exactly right, because its tombstone drops
`custom` and `metaVersion`. It also depends on the server not reusing the
pre-delete metadata validator after the re-create. The server used to (WAS-89):
the meta `ETag` was `<generation>.<metaVersion>` with the generation kept
through the tombstone and `metaVersion` restarting at 1. The server now gives
the metadata object a generation of its own, dropped with the tombstone. The
second acceptance point is what catches that class of defect from the driver's
side.

Shipped 2026-09-07: the case `resurrects a row carrying custom` in
`test/node/replication.integration.test.ts`, pinned against the local server
checkout (the `link:` dependency), plus the push-handler note in
ARCHITECTURE.md.

### WS-4: The `/meta` 404 delete-race recovery is unreachable on the default port

- status: done
- done: 2026-09-08
- priority: high
- labels: push, metadata, correctness, was-client-port
- acceptance:
  - [x] The `/meta` write's not-found branch matches the plain `NotFoundError`
        shape as well as the `mapAuthErrors: true` shape, by `err.name`
  - [x] A push test on the default port shape shows a metadata-only edit against
        a tombstoned resource resolving as the comment at
        `src/pushWrites.ts:290-299` describes, rather than rejecting the batch
  - [x] Shared with WS-1: one predicate or helper classifies not-found across
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

---

### WS-3: Delete with no assumed primary is sent unconditionally

- status: done
- done: 2026-09-08
- priority: high
- labels: push, correctness, conditional-writes
- acceptance:
  - [x] A delete whose `assumedMasterState` is undefined carries a precondition
        or is skipped, symmetric with the create path's `ifNoneMatch` guard; the
        chosen mechanism is recorded in ARCHITECTURE.md
  - [x] The push test for this branch (`test/node/pushWrites.test.ts` around
        lines 1068-1082) is rewritten so the fake port no longer synthesizes a
        412 that a real server would not send for a header-less DELETE
  - [x] A test shows a create-then-delete on replica B, before B's first push,
        leaving replica A's live copy of the same content-addressed id intact

Context: Ids are content-addressed and identical across replicas (invariant 2).
Replica A creates row r and pushes it. Replica B creates the same r locally and
deletes it before its first push. RxDB coalesces that to a delete with no
assumed primary, and `src/pushWrites.ts:197` issues `deleteContent({ id })` with
no `If-Match`. The server returns 204 and A's live resource is tombstoned by a
replica that never synced it. The create path guards itself with `ifNoneMatch`;
the delete path has no symmetric guard.

### WS-10: Drop the port cast and `putMeta` probe once was-client's port type is complete

- status: done (2026-09-08)
- priority: low
- labels: controller, types, was-client-port
- touches:
  - was-client: shipped -- `WasSyncPort.putMeta` is required and `WireDoc` /
    `SyncPage` type the feed bodies as `Json` (WCL-39, 0.54.0)
  - was-sync: shipped -- `src/controller.ts` assigns the client's port directly;
    `WireDoc` aliases was-client's
  - was-react: shipped -- `src/storage/wasSyncPort.ts` returns the client's port
    as is
- acceptance:
  - [x] was-client's port type matches what `createWasSyncPort` implements
        (in-house change; was-client WCL-39)
  - [x] `src/controller.ts` (around line 300) has no
        `as unknown as     WasSyncPort` cast and no runtime
        `typeof basePort.putMeta` probe
  - [x] was-react's copy of the workaround is removed
  - [x] `touches:` entries resolved

Context: was-client types `putMeta` as optional on its `WasSyncPort` while
`createWasSyncPort` always implements it. Both this driver and was-react cast
through `unknown` and probe at runtime. The cast silences every future
divergence in `query` / `putContent` / `deleteContent` / `get`, not just
`putMeta`: a was-client rename type-checks clean here and fails only inside a
push or pull cycle as an `error$` event. Two consumers carrying the same
cast-and-probe is the signal that the fix belongs upstream, after which the
divergence becomes a compile error at the seam.

### WS-12: Adopt the ecosystem logging library port

- status: done
- done: 2026-09-08
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
  - [x] `touches:` entries resolved; freewallet's and was-react's suites stay
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
