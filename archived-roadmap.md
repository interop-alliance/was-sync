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

### WS-15: Push retries a permanent `NotSupportedError` forever

- status: done
- done: 2026-09-16
- priority: medium
- labels: push, errors, was-client-port, conditional-writes
- touches:
  - was-client: the `isNotSupportedError` predicate added on the `./sync`
    subpath (with the `NotSupportedError` class re-exported there), shipping in
    0.67.0; its AGENTS/ARCHITECTURE files state the `err.name` rule generally
    and needed no edit. The refusal itself shipped in 0.66.0: the sync port's
    `putContent`, `deleteContent`, and `putMeta` throw `NotSupportedError`
    before any request when they carry `ifMatch` / `ifNoneMatch` and the
    collection's backend does not advertise `conditional-writes`.
- acceptance:
  - [x] `src/pushWrites.ts` classifies `NotSupportedError` (by `name`) as
        permanent rather than letting it fall into the retry-with-backoff bucket
  - [x] `src/controller.ts` stops the collection's replication on it and reports
        the collection as `error` with the refusal as the cause
  - [x] A test with a port that throws `NotSupportedError` on a guarded push
        shows no retry

Context: `pushWrites.ts` (around line 361) lets every non-conflict error
propagate so RxDB retries the batch with backoff, and `controller.ts` only
special-cases `WasSyncAuthError`. The new refusal is permanent: a backend that
does not advertise `conditional-writes` will not start enforcing preconditions
on a retry. Against the reference server every server-managed backend advertises
the token, so only a client-registered external backend reaches this today.
Decide whether a dedicated predicate on was-client's `./sync` subpath is wanted,
or a local name check is enough.

Settled: the predicate goes upstream, so invariant 5 holds unchanged and no
was-client error-name string is hard-coded here. The push handler cannot stop a
replication (RxDB's push contract has no "give up" return and the handler holds
no replication handle), so it logs the refusal at `error` and rethrows it; the
controller's `isPermanentRefusal` finds the name under RxDB's wrapping and
releases that ONE collection, leaving its siblings replicating and the instance
startable. Recorded as ARCHITECTURE.md invariant 17.

discovered-from: was-client WCL-50.

### WS-14: Conflict handler's decrypt closure needs the row id and an integrity bucket

- status: done
- done: 2026-09-16
- priority: high
- labels: conflict-handler, encryption, correctness
- touches:
  - freewallet: FW-537 (DONE). Not the closure the original list expected --
    `contactsConflictHandler.ts` wires the generic `makeConflictHandler` and
    hands the whole `DocCipher` to wallet-core's `resolveContactHeadConflict`,
    so it owns no decrypt closure. It is still affected: that resolver takes
    bodies and no ids, so widening it to address each side by row id means the
    caller passes `realMasterState.id` / `newDocumentState.id`, which it already
    has in scope. FW-537 is blocked-by WC-236
  - wallet-core: WC-236 (DONE). `src/sync/contactsConflict.ts:80` calls
    `cipher.decrypt({ envelope: data })` with no `id`, so it stops typechecking
    under the new `DocCipher` and skips the binding check; and
    `contactHeadPayloadOf` (`:78-83`) catches every decrypt failure into
    `undefined`, which would swallow an `IntegrityError` as "no payload here"
  - was-react: WR-50 (DONE). `src/storage/localStore.ts:307-310` passes
    `envelope => decryptEnvelope(key, envelope)` to `makeLwwConflictHandler`,
    whose single parameter now infers as the whole options object -- a type
    error, and wrong at runtime besides. `decryptEnvelope` (`:825-830`) needs
    the row id threaded through to `#decryptWithRefresh`. Its
    `createPlaintextDocCodec.decrypt` (`src/storage/docCipher.ts:99-112`) still
    typechecks (an object-literal method is exempt from strict parameter
    variance) but ignores `id`, so it can never raise `IntegrityError` --
    deliberate or not, that wants deciding
- acceptance:
  - [x] `lwwFieldsOf`, `lwwResolver`, and `makeLwwConflictHandler` accept a
        `decrypt` shaped like was-client 0.66.0's `DocCipher.decrypt`:
        `(options: { id: string; envelope: Json; context?: CodecRequestContext })     => Promise<Json | Blob>`
  - [x] Both calls in `lwwFieldsOf` pass the row's own `id`
        (`realMasterState.id` / `newDocumentState.id`, the WAS resourceId
        already on `SyncedDoc`) as the addressed id, not any id read out of the
        decrypted envelope
  - [x] `isIntegrityError` is imported from `@interop/was-client/sync` and
        checked before the existing catch classifies a decrypt failure as
        `undecryptable`: an integrity failure propagates out of the resolver (a
        fatal replication error, per this module's existing throw contract)
        instead of being folded into rule 3's "presumed newer" handling, since a
        tampered envelope is not an absent key
  - [x] A test resolves a conflict where one side's `decrypt` throws
        `IntegrityError` and asserts the resolver throws rather than returning a
        winner
  - [x] A test resolves a conflict where `decrypt` throws `UnknownEpochError` /
        `KeyUnwrapError` and asserts the existing undecryptable-side rules are
        unaffected
  - [x] Whether a `decrypt` that resolves a `Blob` here is in scope is decided
        and recorded: both halves. It is documented as unreachable through
        was-client's own ciphers (the resolver supplies no `context`, so a
        chunked envelope raises rather than resolving a `Blob`), and
        `lwwFieldsOf` still handles one explicitly -- scored `undecryptable`
        rather than falling through to `none`, since a body whose stamp cannot
        be read is something this client cannot compare rather than nothing to
        compare, and `none` would silently lose the write. Recorded as
        ARCHITECTURE.md invariant 16
  - [x] `touches:` entries resolved: freewallet FW-537, wallet-core WC-236, and
        was-react WR-50, all filed 2026-09-16. wallet-core was absent from the
        original list, and freewallet is affected through it rather than in the
        way the list anticipated
  - [x] Depends on `@interop/was-client` 0.66.0 being published and the
        dependency bumped in `package.json`. The devDependency is on
        `link:../was-client` in the meantime, so the suites run against the
        unpublished 0.66.0 surface; it goes back to `^0.66.0` once that is on
        the registry, and was-sync 0.3.0 does not publish before it
  - [x] `package.json` raises the `@interop/was-client` peer range from
        `>=0.59.1 <1.0.0` to `>=0.66.0 <1.0.0`, and the devDependency from
        `^0.60.0` to `^0.66.0`. A was-sync build whose closure calls
        `decrypt(envelope)` next to was-client 0.66.0 passes no id: the EDV
        binding check is silently skipped again, and the plaintext cipher throws
        `IntegrityError` on every read. The raised range keeps an app from
        installing that pair

Context: was-client 0.66.0 (not yet published) makes the resource id a required
argument of `DocCipher.decrypt` and adds an `IntegrityError` thrown when the
envelope was written for a different id than the one it was read under; see
`discovered-from: was-client WCL-43, 2026-09-15`. This module's `decrypt`
closure type is still the old two-argument shape --
`(envelope: Json) => Promise<Json>` -- at `src/conflictHandler.ts:164-169`
(`lwwFieldsOf`), `:246-261` (`lwwResolver`'s `options.decrypt`), and `:349-361`
(`makeLwwConflictHandler`). The row id the new signature needs is already on
hand: `SyncedDoc.id` is the WAS resourceId carried off the feed
(`src/types.ts:192-193`, `:220-221`), and `lwwFieldsOf`'s two call sites already
have `realMasterState` / `newDocumentState` in scope. `lwwFieldsOf`'s blanket
`try`/`catch` (`:174-179`) currently folds every decrypt failure into the
`undecryptable` `LwwSide`, and rule 3 in `lwwResolver` (`:291-330`) treats an
undecryptable side as presumed newer rather than absent. Left unchanged, a
tampered envelope would read the same as an unseen key epoch: adopted or
re-asserted with a `warn` log, never rejected. This item threads the id through
and gives `IntegrityError` its own path -- a thrown, fatal error, matching how
this module already treats a resolver that cannot make a sound decision.

Discovered while implementing: the integration suite's pinned
`was-teaching-server@^0.29.0` predates WAS v0.5, and was-client 0.62.0 made
service discovery mandatory, so every integration test failed with
`IncompatibleServerError` as soon as the was-client devDependency moved off
0.60.0. The devDependency is now `^0.35.1`. Too small for an item of its own,
but it is why the server bump rides this change.

---

### WS-16: Remove the permanent-refusal give-up path once conditional writes are baseline

- status: done
- done: 2026-09-17
- priority: medium
- labels: push, controller, errors, conditional-writes, cleanup
- blocked-by: WASS-40 shipped 2026-09-16; sequenced after was-client WCL-106 (it
  needs the was-client release that removes the refusal)
- touches:
  - [x] was-client -- WCL-106 removes the affordance gate, the
        `NotSupportedError` refusal for preconditions, and the `/sync` re-export
        of `isNotSupportedError`. SHIPPED (0.67.0, 2026-09-16), with one
        correction: WCL-106 removed only the `no-feature` reason. The
        `no-validator` refusal survives (a guarded write pinned to a read that
        returned no `ETag`, which CORS can hide from a browser client), and so
        does the `/sync` re-export of `isNotSupportedError`, for the consumers
        that still meet it. Neither reaches this driver: the three surviving
        raise sites are `src/log/logStore.ts`,
        `src/edv/logGovernedDescriptorStore.ts`, and `src/internal/cas.ts`,
        while `src/sync/port.ts` passes `ifMatch` / `ifNoneMatch` straight into
        `writeHeaders` with no gate, and `createWasSyncPort` bypasses the codec
        (so the chunked-envelope refusal is out of reach too). The give-up path
        is dead code here even though the predicate lives on
  - [x] ARCHITECTURE.md invariant 17 and the "Permanent refusal" glossary entry.
        DONE: both removed, and invariant 5's sentence now names `isAuthError`
        alone as the walker of RxDB's error graph
  - [x] README paragraph. DONE: removed
  - [x] wallet-core WC-237 -- the sibling item being retired on the same spec
        change. ALREADY SHIPPED: WC-237 is
        `done (2026-09-16; withdrawn without     implementation)`, closed on
        this same spec change before its classification was ever written, so
        nothing is left to remove there
- acceptance:
  - [x] `notePermanentRefusal` (`src/pushWrites.ts`) and both call sites are
        removed
  - [x] `isPermanentRefusal` and `releaseCollection` (`src/controller.ts`) and
        the `error$` branch that calls them are removed
  - [x] `someErrorIn` (`src/controller.ts`) collapses into `isAuthError`, its
        only remaining caller, with no behavior change to auth-error detection
  - [x] the `key` / `id` fields on the replication registry entries
        (`src/controller.ts`) are removed if nothing else needs per-collection
        lookup by then; kept with a note if something else has since started
        using them. REMOVED: `releaseCollection` was the only reader; every
        other use of the registry walks it whole, and `onStatus` is called with
        the loop's own `key` / `id`
  - [x] `withFeedPrimaryRead` (`src/feedPrimaryPort.ts`) is untouched: it
        addresses a CORS ETag problem, not the backend feature, and survives the
        spec change
  - [x] ARCHITECTURE.md invariant 17 and the "Permanent refusal" glossary entry
        are removed
  - [x] the README paragraph describing the give-up behavior is removed
  - [x] a CHANGELOG entry records the removal as breaking (the exported
        `isPermanentRefusal` and the give-up behavior it names are gone)
  - [x] `touches:` entries resolved

Context: WS-15 taught this driver to recognize was-client's `NotSupportedError`
as permanent and stop the collection rather than let RxDB retry it forever. If
conditional writes become a requirement of every backend a Collection can be
created on, no backend can raise that refusal and the whole path is dead code.

What comes out: `notePermanentRefusal` and its two call sites in
`src/pushWrites.ts`, `isPermanentRefusal` and `releaseCollection` in
`src/controller.ts`, the `error$` branch that calls it, and the `key` / `id`
fields added to the replication registry entries to support per-collection
release. `someErrorIn` collapses back into `isAuthError`, its only remaining
caller. ARCHITECTURE.md invariant 17 and the "Permanent refusal" glossary entry
go, as does the README paragraph. Roughly 117 source and 300 test lines.

What stays: everything else the 412 machinery does. The conflict assembler, the
benign-412 delete retry, and the tombstone routing exist because conditional
writes are used, not because they were optional. `withFeedPrimaryRead` also
stays: it handles a server that hides the ETag behind CORS, which is a separate
problem from the backend feature and survives the spec change.

discovered-from: WS-15.

2026-09-17: implemented. The premise was checked against was-client 0.68.0
before anything was deleted, because WCL-106 turned out to keep both the
predicate and a narrower refusal (see the `touches:` annotation). The refusal
that survives cannot reach this driver's port, so the path is dead here and the
removal stands as filed. 151 node tests and the packaging suite are green with
it gone.

2026-09-17: follow-up filed. was-client WCL-110 carries what is left there: the
predicate now has no consumer anywhere in the ecosystem, and its doc comments
(`src/sync/predicates.ts`, `src/sync/index.ts`) still tell a replication driver
to build the give-up path this item removed. Whether the export itself goes is a
decision recorded on that item, not here.

### WS-5: Benign-412 delete retry can delete an independently re-created resource

- status: done
- done: 2026-10-01
- priority: medium
- labels: push, conditional-writes, correctness
- acceptance:
  - [x] The "my own revision drift" decision for a delete retry compares the
        re-read primary's `writerId` against the replica's own injected
        `writerId`, and a mismatch is a real conflict; body equality alone
        decides only when either side carries no label
  - [x] The feed-walking primary read carries the feed's `writerId` into the
        primary state, so the comparison holds on both port configurations
  - [x] A test shows: stale assumed version on replica A, delete-then-recreate
        of the same id by another writer, A's delete surfacing as a conflict
        instead of tombstoning the re-created resource

Context: On a content-addressed collection the body is fixed per id, so
comparing the primary's data against the assumed data in `src/pushWrites.ts`
cannot tell "my own stale version" from "someone deleted and re-created this".
Freewallet's revoke/re-add and purge-undecryptable/resync paths do exactly that.
Replica A's delete 412s, the re-read shows equal data, and the retry re-issues
DELETE against the fresh ETag, tombstoning the re-created resource without the
412 ever reaching RxDB as a conflict. The metadata-edit variant is not reachable
(a `/meta` write leaves content version unchanged) and a live tombstone is
correctly rethrown; only delete-then-recreate is exposed.

The discriminating signal is the writer label. Since writer attribution on push
(0.6.0) the handler holds the replica's own `writerId`, the server records the
`Writer-Id` header of every content write and delete into the resource's
metadata, and the re-read (`get` and the feed walk alike) surfaces it as
`writerId` on the primary state. Neither of the originally suggested signals
works: the server's content version is monotonic across a delete and re-create,
and the benign case is itself a version drift, so a version comparison has no
discriminating power; `createdBy` is the invoking DID, which two replicas of the
same wallet share. When the replica was given no `writerId`, or the server holds
none for the revision, equality remains the only rule, so an unlabeled
deployment keeps the pre-existing behavior.

### WS-6: Default `isEqual` hides server-only fields on the feed echo

- status: done
- done: 2026-10-01
- priority: medium
- labels: conflict-handler, pull, correctness
- touches:
  - was-sync (ARCHITECTURE.md): done in this change, as invariant 18.
  - was-react (uses the default `isEqual`): WR-54. No code change; it picks the
    fix up by consuming `@interop/was-sync` 0.8.0.
  - freewallet (already overrides with deepEqual): FW-626, which drops the
    `deepEqual` override in `src/stores/contactsConflictHandler.ts` once on
    0.8.0.
- acceptance:
  - [x] The default equality used by RxDB's downstream to decide whether to
        write the master state includes `updatedAt`, `createdBy`, and `epoch`
        (or ARCHITECTURE.md states why the driver deliberately excludes them and
        each consumer is told to override)
  - [x] An integration test creates a row locally, lets the echo arrive with a
        server-assigned `createdBy`, and asserts it lands in the local row
  - [x] The test server used by the integration suite assigns `createdBy` so the
        case is observable
  - [x] `touches:` entries resolved

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

2026-10-01: both mechanisms were confirmed. The `isEqual` skip is fixed here.
`statesEqual` now compares every member of the synced document, and
ARCHITECTURE.md invariant 18 records why. The `createdBy` integration case now
asserts that the echo lands locally, and the convergence case compares every
member with no `updatedAt` / `createdBy` exclusion. The live
`was-teaching-server` already assigns `createdBy` (WS-11). The ack write-back
window is real too, and it made the convergence case fail on its first run. RxDB
defers an echo pulled between the write-back and the push cycle it triggers, and
never pulls it again. Closing that needs a reshaped ack path, so it is split out
as WS-17. Until then, both integration cases wait for pushes to settle before
they nudge a pull.

### WS-7: Ack write-back accepts version 0

- status: done
- done: 2026-10-02
- priority: medium
- labels: push, ack, was-client-port
- touches:
  - was-client: WCL-75, implemented 2026-10-02 (`putContent` / `deleteContent`
    resolve `readContent(id)?.version ?? 0` when the ETag is hidden; the
    contract should reject or signal, not fall back to 0)
  - was-sync (ARCHITECTURE.md ack section): shipped here (the Ack glossary entry
    states the `0` rejection and why; invariant 18 notes the echo then differs
    in `version`)
- acceptance:
  - [x] The ack guard in `src/wasReplication.ts` (around line 44) rejects 0 as
        well as undefined, and states in a comment that 0 is never a legitimate
        revision
  - [x] was-client's port no longer resolves a fabricated 0 when the ETag header
        is not exposed (in-house change; reference the was-client item)
  - [x] A test with a port that resolves 0 shows the local row's version left
        untouched and no 412 on the following edit
  - [x] `touches:` entries resolved

Context: The ack write-back stamped any `version` that was not undefined.
was-client's port never resolved undefined: when a revision could not be read
off the response, it fell back to `version: 0`. That happens when a cross-origin
server does not expose the `ETag` header, and when the `ETag` is a
spec-conformant opaque validator such as `"a1b2c3"` rather than the reference
server's `gen.version` form. was-react's deployment (`feedPrimaryRead: true`,
cross-origin) is the first case. The row then recorded an invented revision in
place of its last real one, which the feed's echo of the write had to repair.
The conditional write itself is built from the stored `etag`, so the `0` did not
reach `If-Match`. The repeated 412 on every edit under a hidden `ETag` comes
from the ack carrying no `etag` at all, so the row keeps its stale validator.
That part is not curable in this driver. It needs the server to expose `ETag`
cross-origin, and was-client to leave the revision absent rather than fabricate
one (WCL-75). This item's own guard keeps a `0` out of the local row, and the
was-client follow-up removes the fabrication at its source. The original premise
that the edit sent `If-Match "0"` was wrong and is corrected here.
`withFeedPrimaryRead` wraps only `get`, so it does not touch the ack path.

### WS-18: Consume an absent primary `version` from was-client 0.86.0

- status: done
- done: 2026-10-02
- priority: medium
- labels: push, conflict, was-client-port, schema
- acceptance:
  - [x] `src/pushWrites.ts` compiles against was-client 0.86.0 and the conflict
        assembler gives a primary with no `version` a defined local value with a
        comment stating what that value means
  - [x] A delete ack that carries an `etag` but no `version` is still reported
        as an ack, so the `etag` reaches the ack write-back
  - [x] The integration suite has a case driven by a port whose `get`, `put`,
        and `delete` return an opaque validator and no `version`, and the row
        edits twice with no 412
  - [x] ARCHITECTURE.md states which local `version` value stands for "no known
        revision" and how it relates to the ack rule from WS-7

Context: was-client 0.86.0 (WCL-75) stops substituting `version: 0` when the
`ETag` carries no parseable revision. `WriteAck.version` and
`MasterState.version` are now optional. This driver's local row keeps `version`
required (`src/types.ts`, `src/syncedDocSchema.ts`), and the conflict assembler
copies `primary.version` into it at `src/pushWrites.ts` (around line 192), which
is a type error against 0.86.0. The delete path at `src/pushWrites.ts` (around
line 373) reports an ack only when `version` is defined, so an opaque
validator's `etag` is dropped and the next delete-related write sends a stale
precondition. The driver already uses `0` as its own "fresh or tombstoned row"
value, and WS-7 made the ack write-back skip `0`, so the two conventions need to
be stated together. discovered-from: WS-7, via WCL-75.

### WS-24: Map the widened `changes` feed at the pull boundary

- status: done
- done: 2026-10-04
- priority: high
- labels: pull, feed, correctness, was-96
- touches:
  - was-sync (ARCHITECTURE.md Glossary `Wire doc`, invariant 4's feed primary
    read, README): Glossary and Ownership heuristics updated 2026-10-04; README
    needed no change
  - was-client (whether the sync port filters the feed to `kind: resource` and
    renames `deleted` before the driver sees it, or exposes the raw document;
    `WireDoc` vocabulary; ARCHITECTURE/AGENTS): was-client: WCL-122 (the port
    filters and renames; 0.89.0, publish pending)
  - wallet-core (the engine applies the same feed; its own filter): unaffected:
    wallet-core (it reads `WireDoc` off the sync port and calls no `changes()`
    of its own)
  - dcw, was-react (named by WAS-96 as consumers that filter on `kind`):
    was-react: WR-55 (its `SharedCollectionReader` reads `changes()` directly);
    unaffected: dcw (it reads the feed only through the sync port, driven by
    wallet-core's engine)
- acceptance:
  - [x] The ownership of the `kind` filter and the `deleted` rename is settled
        with was-client, and recorded in both repos' ARCHITECTURE files
  - [x] The pull handler and the feed primary read skip every change document
        whose `kind` is not `resource`, and a `kind` they do not know. The pull
        handler keeps following the server checkpoint until the page it hands
        RxDB holds at least one resource document or the feed ends: RxDB drops
        an empty page before persisting its checkpoint, so a page filtered to
        zero would be re-fetched on every poll (found in the WS-23 review)
  - [x] A unit case drives the pull handler with an all-filtered page followed
        by a resource page and asserts the resource page's checkpoint is the one
        returned
  - [x] A `kind: resource` entry whose `contentType` is not JSON (no inline
        `data`) takes a documented outcome: skipped, or stored as a bodiless row
  - [x] The feed's `deleted` member reaches RxDB as `_deleted`, on the pulled
        row and on the primary state the push path re-reads
  - [x] Unit cases drive the pull handler and the feed primary read with
        `collection-metadata`, `policy`, `log`, an unknown kind, and a binary
        resource
  - [x] CHANGELOG.md entry
  - [x] `touches:` entries resolved

Context: WAS-96 widens the `changes` profile (its WAS-182). Every change
document carries a required `kind` from the closed set `resource`,
`collection-metadata`, `policy`, `log`, and a `contentType` on resources. Binary
resources and their tombstones now appear, with `data` inline only when the
content is JSON. The tombstone member is renamed from `_deleted` to `deleted` on
every object, and the design states that was-sync maps it to RxDB's `_deleted`
at its boundary. Today `wireDocToRxDoc` and the feed primary read assume every
entry is a JSON resource carrying `_deleted`. Without the filter a Collection
Metadata write or a policy write would be stored as a row under its own id, and
a binary resource as a row with no body. The wire vocabulary is was-client's,
and RxDB's view of the feed is this driver's, so where the filter lives is the
first question. WS-23 depends on this item: its schema work needs the pull
boundary to deliver resource documents only.

Resolution of the ownership question (2026-10-04): was-client's sync port owns
the filter and the rename (was-client 0.89.0). Its `query` hands on JSON
`resource` entries and their tombstones only, maps `deleted` to `_deleted`, and
resumes past a page it skipped entirely, so the driver's handlers filter
nothing. A non-JSON Resource is skipped. The open boxes are met once was-client
0.89.0 is consumed. That lands with WS-23's source change, since the source here
still read `version` and did not compile against was-client 0.87.0 or later.
was-client 0.89.0 was consumed with WS-23's source change on 2026-10-04, which
met the filter, rename, and checkpoint boxes above; the unit cases for the
skipped kinds live in was-client's sync port tests. Here the integration suite
runs against was-teaching-server 0.41.1, whose feed is the widened one, so the
boundary is pinned end to end by every case that pulls.

### WS-23: Adopt the WAS-96 stamp data model in the replica schema and the push path

- status: done
- done: 2026-10-04
- priority: high
- labels: schema, push, pull, conflict, breaking, was-96
- blocked-by: WS-24
- design: designs/WS-23-stamp-data-model.md
- design-approved: 2026-10-03
- touches:
  - was-sync (ARCHITECTURE.md invariants 4, 7, 18, Glossary `Ack`, README,
    CHANGELOG breaking note): updated 2026-10-04 with the source change
  - was-client (the sync port's `WireDoc`, `MasterState`, and `WriteAck` drop
    `version` / `metaVersion` for the stamp members; `parseEtag` is retired or
    reads the new layout; ARCHITECTURE/AGENTS): shipped in 0.87.0 (2026-10-03);
    the `ResourceMetaStamp` / `WriteStamp` re-export from `./sync` was added
    2026-10-04 for 0.89.1 (publish pending), after which `src/types.ts` imports
    the type directly in place of its `MasterState['meta']` alias
  - was-teaching-server: WAS-189 (the write response body as a WAS-96 wire
    item), WAS-190 (a `/meta`-only write leaves the content stamp unchanged),
    filed 2026-10-03; the model ships under WAS-172 and the widened feed under
    WAS-182, and the integration suite here follows the registry release
  - storage-core (`WriteStamp`, `ResourceMetaStamp`, the reshaped
    `ChangeDocument`; shipped in 0.28.0, 2026-10-03)
  - was-conformance-suite (a "Parties to this contract" row; its feed cases
    assert `metaVersion` and fail against a WAS-172 server; ships before the
    server): PWSCS-18 (done 2026-10-03, the stamp assertions), PWSCS-20 (the
    widened feed, in progress), PWSCS-21 (gains the absent-`meta` assertions,
    2026-10-04)
  - wallet-attached-storage-spec (the `changes` profile and tie-break text still
    describe `version` / `metaVersion`; the stamp text is WAS-96's spec work):
    WASS-47, extended 2026-10-04 with the `/meta`-only `updatedAt` rule, the
    write response body, the absent-`meta` rules, and the restated tie-break
  - wallet-core (the `ack.version` sites stop compiling against was-client
    0.87.0, and the `replica.version > 0` / `=== 0` reads in `src/sync/push.ts`
    and `src/sync/remint.ts` become a silent never-acked state; the engine needs
    a durable acked flag of its own; ARCHITECTURE/AGENTS): shipped in
    wallet-core 0.101.0 (2026-10-04, `acked: boolean` replaces `version`);
    WC-274 for the stale peer range and comment
  - freewallet, was-react (each persists the replica schema and inserts rows
    with `version: 0`; a reshaped schema forgets every existing replica, which
    must take the replication meta with it; ARCHITECTURE/AGENTS): freewallet:
    FW-645; was-react: WR-57 (blocked by its WR-54 was-sync bump)
  - dcw (not a was-sync consumer; drives wallet-core's engine over its own
    SQLite `version` / `metaVersion` columns and fake ports returning
    `{ version, etag }`): DCW-89
- acceptance:
  - [x] `SyncedDoc` and the replica schema carry `updatedAtCounter`, `originId`,
        and the nested `meta` stamp in place of `version` / `metaVersion`, with
        the schema's `required` list and `maxLength`s settled in the design
  - [x] No site in `src/` reads or writes `version` / `metaVersion`: the push
        handler's routing and `hasAck`, the conflict and tombstone entries, the
        feed primary read, `statesEqual`, and the ack write-back, whose
        revision-`0` skip is removed with the member
  - [x] The conflict entries carry the same stamp members the feed document
        carries. The ack write-back stamps them once WS-17 puts the stamp in the
        write response (decided 2026-10-03); this item lands against
        was-client's `etag`-only ack with the echo as the stamp's source for
        accepted writes
  - [x] The default resolver's rules are unchanged and a test pins that rule 1
        and rule 2 compare bodies, not stamps
  - [x] The integration suite runs against the server release that ships the
        stamp model, from the registry
  - [x] ARCHITECTURE.md invariant 7's breaking-change note is applied: the
        CHANGELOG entry says every existing replica is forgotten and re-pulled
  - [x] CHANGELOG.md entry
  - [x] `touches:` entries resolved

Context: The server's approved multi-primary design (was-teaching-server
`designs/WAS-96-multi-primary-spaces.md`, approved 2026-10-02) replaces the
per-record revision counters with an origin-minted stamp. On the wire,
`updatedAt`, `updatedAtCounter`, and `originId` replace `version`, a nested
`meta` object replaces `metaVersion`, and the validator becomes
`<generation>.<ms>.<counter>.<originId>`, so was-client's `parseEtag` no longer
yields a revision number. `etag` and `metaEtag` stay. This driver stores
`version` as a required schema member, reads it in the push handler
(`src/pushWrites.ts`), the conflict and tombstone entries, the feed primary read
(`src/feedPrimaryPort.ts`), `statesEqual` (`src/conflictHandler.ts`), the pull
mapping (`src/changesQuery.ts`), and the ack write-back
(`src/wasReplication.ts`). The `0` sentinel for "no known revision" and the WS-7
skip-zero rule have no meaning once no revision exists. Changing the schema
shape is a breaking change for every existing replica (invariant 7).

The design is gated because the schema and the ack both become permanent stored
shapes, and because the resolver's premise moves. The spec's client tie-break
sentence is restated under WAS-96: stamped records order by
`(ms, counter, originId)`, and the `(updatedAt, writerId)` rule survives only
for an unstamped local edit against a stamped remote. That is the only case this
driver's conflict path sees (the local side never holds a server stamp), so
`remotePayloadWins` stays valid, and the design records why rather than changing
it. The design doc is at `reviewed` (2026-10-03) with its seven stored-shape
decisions signed off. WS-17 follows this item and changes the ack: the write
response body carries the full stamp beside `createdBy`, was-client's `WriteAck`
grows to carry it, and the write-back stamps it under the unit rule the design
fixes (the content ack supplies the top-level triple, the `/meta` ack supplies
`meta`, neither partial). WAS-96 needs two amendments for this: a wire item for
the write response body, and an explicit sentence that a `/meta`-only write
leaves the content record's `updatedAt` unchanged.

### WS-8: Status reports `synced` before any pull or push has run

- status: done
- done: 2026-10-04
- priority: medium
- labels: controller, status, correctness
- acceptance:
  - [x] The controller does not translate the initial replayed `active$` value
        into `synced`; the first `synced` follows a completed cycle
  - [x] The controller test's fake replication replays `false` on subscribe the
        way RxDB's `BehaviorSubject` does, and the test asserts the status
        sequence `idle` then (`syncing` | `error`) with no early `synced`

Context: RxDB's `state.active$` is a `BehaviorSubject(false)`, so subscribing at
`src/controller.ts:327` replays `false` synchronously and the handler reports
`synced`, overwriting the `idle` set two lines earlier. With the WAS server
unreachable the app's indicator shows `synced` for a session that has replicated
nothing, until the first `error$` emission after the network attempt times out.
The controller test's fake replication does not replay, so the suite cannot see
it.

### WS-19: `pushRow` never sees `_deleted` under a non-default `deletedField`

- status: done
- done: 2026-10-04
- priority: medium
- labels: push, correctness, rxdb
- acceptance:
  - [x] The push handler reads the deleted flag under the `deletedField` the
        replication was configured with, or `createWasReplication` rejects a
        non-default `deletedField` (resolved by removing the option: the
        replication always runs under RxDB's default `_deleted`)
  - [x] A unit case holds the returned replication state to `_deleted` and the
        option absent from the signature (in place of driving the handler with a
        non-default field, which no longer exists)

Context: `createWasReplication` accepts a `deletedField` option and hands it to
RxDB. RxDB's replication plugin swaps `_deleted` for that field on every row
before the push handler sees it (`swapDefaultDeletedTodeletedField`), but
`pushRow` branches on `newDocumentState._deleted`. With any field other than the
default the delete branch never fires and a local delete is pushed as a content
write of the tombstone's body. Nothing exercises the option today, so the gap is
latent.

discovered-from: WS-17

### WS-25: Stop sending `writerId` on the `/meta` write

- status: done
- done: 2026-10-04
- priority: medium
- labels: push, writer-id, was-96
- blocked-by: WS-23
- touches:
  - was-sync (ARCHITECTURE.md invariant 17, Glossary `Writer id`, README):
    updated 2026-10-04 with the source change
  - was-client (`putMeta` drops its `writerId` option; ARCHITECTURE/AGENTS):
    WCL-125, filed 2026-10-04
  - unaffected: wallet-core (the engine issues no `/meta` write; its metadata
    push half lives in this driver)
- acceptance:
  - [x] The push handler sends no `writerId` member on a `/meta` write, and
        keeps the `Writer-Id` header on content writes, deletes, and the
        benign-412 re-issue
  - [x] The unit cases that assert the body member are inverted
  - [x] ARCHITECTURE.md invariant 17 and the Glossary describe the label as a
        content-record member only
  - [x] CHANGELOG.md entry
  - [x] `touches:` entries resolved

Context: WAS-96's open point 2 moves `writerId` to the content record alone. A
`/meta` write no longer touches it, and the spec's declare-or-clear rule for
Update Resource Metadata is withdrawn. Invariant 17 and the 0.6.0 CHANGELOG
entry say every metadata write declares the label in its body. Once the server
ignores the member, sending it is harmless but misleading, and once the port
drops the option it no longer compiles. The benign-412 delete retry reads the
label off the re-read primary's content record, which WAS-96 keeps, so WS-5's
rule is unaffected.

### WS-22: A local delete during a create's push goes out as a header-less `DELETE`

- status: done
- done: 2026-10-04
- priority: medium
- labels: push, delete, correctness
- acceptance:
  - [x] A row inserted and removed while its create `PUT` is in flight is
        deleted on the server with an `If-Match` carrying the create's
        validator, or the delete is deferred until the row holds one
  - [x] An integration case pins the race against the live server and asserts
        the `DELETE` request's precondition

Context: When the user removes a row while its create is still in flight, RxDB
records the pushed row as the assumed primary (`upstream.js:309`) and the ack
write-back then skips the tombstone (`src/wasReplication.ts:58-61`), so the
assumed primary never gains the create's `etag`. The next push sends the delete
with no `If-Match` (`src/pushWrites.ts:341-344`). Invariant 4 calls a
header-less `DELETE` unsafe: under a content-addressed id another replica may
hold a live copy of the same resource, and the unconditional delete tombstones
it. The ack is known at the time the write-back runs, so one candidate is to
carry it onto the tombstone, or to hold the delete until the row's assumed
primary carries a validator. The case exists today and is unchanged by WS-17,
which only widens what the write-back stamps on a live row.

discovered-from: WS-17

WAS-96 raises the cost of the unconditional `DELETE`. With Collection tombstones
replicating under delete-wins and Resources byte-identical across replicas, the
live copy another replica holds may now be on another server, and the tombstone
this delete writes propagates to every peer. The priority should move to high
once a consumer runs against a replicated Space.

### WS-21: A dropped echo on a hidden-`ETag` deployment leaves the next `PUT` unconditional

- status: done
- done: 2026-10-04
- priority: medium
- labels: push, ack, conditional-writes, correctness
- touches:
  - wallet-attached-storage-spec: WASS-54 (a MUST that `ETag` and `Location` are
    named in `Access-Control-Expose-Headers`; no validator members in the write
    response body)
  - unaffected: was-client (`WriteAck` already reads the `ETag` header)
  - was-teaching-server: already exposes `ETag` and `Location`
  - was-conformance-suite: PWSCS-24
- acceptance:
  - [x] The fix is decided and filed where it lands: the spec requires `ETag`
        exposed cross-origin, so a hidden-`ETag` server is non-conforming
  - [x] ARCHITECTURE.md states that the driver keeps the hidden-`ETag` path as
        best-effort, and that an echo dropped there leaves the next content edit
        unconditional

Context: When a server does not expose `ETag` to a cross-origin caller, the ack
carries no validator and the row learns it only from the feed echo. That is the
deployment `withFeedPrimaryRead` exists for, and the one was-react always runs.
If the echo is pulled inside the WS-17 window it is dropped, the row keeps no
validator, and the next content edit goes out without an `If-Match`, which would
overwrite a concurrent writer's content with no `412` for the resolver to see.
WS-17 deliberately does not widen this: on that deployment its write-back stamps
nothing (the ack carries no validator), so no new window opens, and the
validators stay out of the body. The candidate fix is `etag` / `metaEtag`
members in the write response body, following the changes-feed precedent; the
spec says a Resource's version is exposed only as an `ETag`, so that is a wire
decision for the user.

discovered-from: WS-17

WAS-96 keeps the problem and removes the shortcut. Its validator is
`<generation>.<ms>.<counter>.<originId>`, and its wire item 12 puts the
generation inside the `ETag` only, so even a write response body carrying the
three stamp members (WS-17 under WS-23) cannot rebuild the validator a
hidden-`ETag` deployment is missing. The fix has to carry `etag` and `metaEtag`
members in the body outright, which stays the wire decision above.

Resolution (2026-10-04): closed as a spec conformance matter. The spec's CORS
requirements named only `Link` in `Access-Control-Expose-Headers`, so the
validator the conditional-write design rests on was optional cross-origin.
WASS-54 adds `ETag` and `Location` to that requirement; the write response body
gains no validator members, and the driver code is unchanged.

### WS-17: Echo pulled during the ack write-back window is dropped

- status: done
- done: 2026-10-05
- priority: medium
- labels: push, ack, pull, correctness, rxdb
- design: designs/WS-17-ack-carries-server-state.md
- design-approved: 2026-10-04
- touches:
  - was-sync: shipped here (ARCHITECTURE.md invariants 2 and 18, Glossary `Ack`
    / `Echo`, README)
  - was-client: WCL-128, shipped in 0.90.0 (`WriteAck` carries the stamp,
    `meta`, and `createdBy`, lifted from a `2xx` body behind a shape guard;
    `putMeta` returns an ack with no validator)
  - was-teaching-server: WAS-189, shipped in 0.42.0 (2026-10-04): `PUT /:id`
    answers `201` on create, a re-creation over a tombstone included, and `200`
    on update, `PUT /:id/meta` answers `200`, both with the server-managed
    members body (the WAS-172 stamp and the provenance) filled inside the write;
    a resurrection records fresh `createdBy` / `createdAt`; `StorageBackend`
    write return types widened, breaking for custom backends; ARCHITECTURE, the
    WAS-96 wire inventory, CHANGELOG breaking note
  - was-conformance-suite: shipped in 0.29.0 (2026-10-04): the strict-`204`
    sites accept `201` / `200` / `204` and check the server-managed body shape
    through one `assertResourceWriteResponse` helper; no ARCHITECTURE file,
    AGENTS carries no write-response prose
  - wallet-attached-storage-spec: WASS-55, filed 2026-10-05 (both operation
    bullets, the `201` / `200` statuses, the four examples, the Quickstart, the
    `createdBy` definition's resurrection exception, the privacy considerations,
    the Version History; blocked-by WASS-47)
  - unaffected: storage-core (`ResourceMetadata` is the stored record shape the
    spec defines, and the write response body already satisfies it structurally;
    the repo has no write-response type or prose)
  - unaffected: encrypted-collections-spec (parties walked 2026-10-05; the
    profile's only `204` write text is the chunk operations, which WAS-189 did
    not change, and it states nothing about Resource or `/meta` writes)
  - wallet-core: WC-278, filed 2026-10-05 (correct the stale write-ack passage
    in `docs/cross-replica-sync-compatibility.md` and ARCHITECTURE; decide
    whether the engine adopts the widened `WriteAck`; low priority)
  - freewallet: FW-656, filed 2026-10-05 (bump was-sync and the server to 0.42,
    re-verify the cross-replica conformance test against a body-answering
    server, rewrite the stale echo prose in the conflict-handler test,
    `browserStore.ts`, and ARCHITECTURE)
  - was-react: WR-59, filed 2026-10-05 (bump was-sync and was-client to
    `>=0.90.2`; no code reads the old ack members, ARCHITECTURE/AGENTS expected
    unchanged)
  - dcw: DCW-92, filed 2026-10-05 (not a was-sync consumer; the was-client floor
    bump to `>=0.90.2` and the fake ports moved to the current `WriteAck` shape,
    no `PushWriteAck` reader found; blocked-by DCW-89)
- acceptance:
  - [x] The write response body carries the record's full stamp (`updatedAt`,
        `updatedAtCounter`, `originId`; the nested `meta` on a `/meta` write)
        beside `createdBy` (decided 2026-10-03, the design doc's section 8
        option a), was-client's `WriteAck` carries the same members, and the ack
        write-back stamps them under WS-23's unit rule
  - [x] `PushWriteAck` keeps each port ack whole
        (`{ id, pushedUpdatedAt, content?, meta? }`), `pushRow` fills `content`
        from the content write or delete and `meta` from the `/meta` write, and
        `hasAck` counts a validator alone
  - [x] `createPushHandler` calls `onWriteAccepted` only for a row that returned
        no conflict entry, with the content-then-`/meta` `412` and `404` cases
        pinned
  - [x] `createAckWriteBack` stamps the content stamp and `createdBy` from the
        content ack and `meta` from the `/meta` ack alongside the validators in
        the same `incrementalPatch`, only when the same ack carries a validator,
        the content stamp only while the row's `updatedAt` equals
        `pushedUpdatedAt`, and skipping a member longer than the schema allows
  - [x] A forced-window integration case holds a content write's response until
        a nudged pull has returned the echo into the write-back window, asserts
        the row still lacks the server stamp before releasing it, and the row
        then ends with the server's `createdBy`, stamp, and `etag` (the design
        doc's section 7 note records why the window is forced at the write-back
        rather than the first write)
  - [x] The two integration cases that wait for `awaitInSync` before nudging a
        pull drop that wait
  - [x] The was-client devDependency and peer floor move to the release that
        widens `WriteAck` (done: 0.90.1); the server devDependency comes from
        the registry (done: was-teaching-server 0.42.0, published 2026-10-04)
  - [x] ARCHITECTURE.md invariants 2 and 18 and the Glossary `Ack` / `Echo`
        entries describe the ack as a source of the two members, with the three
        residuals named
  - [x] CHANGELOG.md entry
  - [x] `touches:` entries resolved (2026-10-05)

Context: After this replica pushes a row, the server's echo comes back down the
feed. RxDB drops a pulled state for a row whose local state differs from its
assumed primary, or that has no assumed primary yet, and the pull checkpoint
still moves past it. The item first placed that window at the ack write-back. It
starts earlier: a locally created row has no assumed primary from its insert
until RxDB writes the replication meta after the push handler returns, so an
echo pulled during the push's own HTTP round trip is dropped too, and nothing on
the ack path can cover that span. The row then keeps the client's `updatedAt`
and never learns its `createdBy`, however `isEqual` is written. The write
response carries only an `ETag` today, so the ack cannot supply those two
members either.

discovered-from: WS-6

The fix makes the echo unnecessary for this replica's own writes. The write
response carries the server-managed members (`201` on create, a re-creation over
a tombstone included, `200` on update, with `contentType`, `size`, `updatedAt`,
and on a `201` this write's `createdAt` and `createdBy`; signed off 2026-10-02,
the resurrection rule 2026-10-03), was-client's `WriteAck` carries `updatedAt`
and `createdBy`, and the existing ack write-back stamps them into the row with
the validators, only when the ack also carries a validator and the row still
holds the pushed `updatedAt`. The write-back is also skipped for a row that
returned a conflict entry, since it collides with RxDB's conflict fork write and
discards the resolver's decision today. A dropped echo then costs nothing. The
window itself stays, and stays load-bearing in three residual cases: a server
that still answers `204`, a hidden `ETag` (WS-21), and a swallowed write-back
failure. The first draft delivered the acked state through RxDB's conflict
array; the review pass found that RxDB writes no replication meta for such a row
when the local row changed during the push, so a delete during a create's push
would leave the server copy live, and the design returned to the write-back. The
design doc enumerates the sites and the interaction matrix.

WAS-96 (was-teaching-server's approved multi-primary design, 2026-10-02) changes
the ground under this item. Its stamp model removes `version` and `metaVersion`
from the wire and adds `updatedAtCounter` and `originId` beside `updatedAt`,
with a nested `meta` object for the `/meta` record (WS-23). The write response
body signed off here (`contentType`, `size`, `updatedAt`, `createdAt`,
`createdBy`) predates the stamp, so as written the ack would stamp an
`updatedAt` with no counter or origin id, and the row would not compare equal to
the feed echo once `statesEqual` compares stamp members. The acceptance boxes
that name the row's `version` and the write-back's revision rules describe
members WAS-96 removes. Decided 2026-10-03: the stamp members are folded into
this item's body shape, so the server changes its write response once, and WS-23
lands first against the `etag`-only ack. The body shape is a wire decision the
two designs share; WAS-96's wire inventory gains an entry for it.

Design note from the 2026-10-04 cleanup pass: `PushWriteAck` today merges the
two port acks into renamed members (`etag`, `metaEtag`), which loses which write
each value came from. Once the ack carries the stamp, a shape that keeps each
port ack whole (`{ id, content?: WriteAck, meta?: WriteAck }`) lets the
write-back patch the content ack onto the top-level triple and the `/meta` ack
onto `meta` as units, so the unit rule follows from the shape rather than from
per-member routing in `recordAck` and the write-back.

### WS-27: Rows from a re-created Collection's previous generation linger in the replica

- status: done
- done: 2026-10-05
- priority: low
- labels: pull, checkpoint, correctness, was-96
- acceptance:
  - [x] Either the pull handler, on a refused checkpoint, marks every row the
        restarted feed does not list as deleted once the restart has caught up,
        or the residual is documented in ARCHITECTURE.md with the conditions
        under which it occurs
  - [x] An integration case deletes and re-creates the Collection on the server,
        pulls, and asserts the chosen outcome for a row that existed only in the
        previous generation

Context: WAS-96 embeds the Collection's feed generation in the opaque
checkpoint, and a Collection tombstone followed by a re-create mints a new
generation. The server refuses the stale checkpoint with the `400` that 0.7.0
already turns into a restart from the beginning. The restarted feed lists only
the new life's writes, so a row that existed in the previous generation and was
never re-created stays in the replica with no tombstone to clear it, and may be
pushed back as a create. A re-created Collection is already a feed restart
today, so the gap is latent now and becomes reachable through the replicated
Collection tombstones WAS-96 adds (its WAS-174), where a tombstone applied from
a peer cascades on every replica.
