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
