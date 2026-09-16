# WAS Sync Roadmap (open items)

nextAvailableId: 16

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

### WS-14: Conflict handler's decrypt closure needs the row id and an integrity bucket

- status: in-progress
- priority: high
- labels: conflict-handler, encryption, correctness
- touches:
  - freewallet: wallet-core WC-236. Not the closure the original list expected
    -- `contactsConflictHandler.ts` wires the generic `makeConflictHandler` and
    hands the whole `DocCipher` to wallet-core's `resolveContactHeadConflict`,
    so it owns no decrypt closure. It is still affected: that resolver takes
    bodies and no ids, so widening it to address each side by row id means the
    caller passes `realMasterState.id` / `newDocumentState.id`, which it already
    has in scope. Tracked as the freewallet entry on WC-236
  - wallet-core: WC-236 (added on audit, absent from the original list).
    `src/sync/contactsConflict.ts:80` calls `cipher.decrypt({ envelope: data })`
    with no `id`, so it stops typechecking under the new `DocCipher` and skips
    the binding check; and `contactHeadPayloadOf` (`:78-83`) catches every
    decrypt failure into `undefined`, which would swallow an `IntegrityError` as
    "no payload here"
  - was-react: WR-50. `src/storage/localStore.ts:307-310` passes
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
  - [x] `touches:` entries resolved: wallet-core WC-236 (which carries
        freewallet's caller change as its own `touches:` entry) and was-react
        WR-50, both filed 2026-09-16. wallet-core was absent from the original
        list and freewallet is affected only through it
  - [ ] Depends on `@interop/was-client` 0.66.0 being published and the
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

### WS-15: Push retries a permanent `NotSupportedError` forever

- status: todo
- priority: medium
- labels: push, errors, was-client-port, conditional-writes
- touches:
  - was-client (0.66.0, not yet published -- the sync port's `putContent`,
    `deleteContent`, and `putMeta` now throw `NotSupportedError` before any
    request when they carry `ifMatch` / `ifNoneMatch` and the collection's
    backend does not advertise `conditional-writes`)
- acceptance:
  - [ ] `src/pushWrites.ts` classifies `NotSupportedError` (by `name`) as
        permanent rather than letting it fall into the retry-with-backoff bucket
  - [ ] `src/controller.ts` stops the collection's replication on it and reports
        the collection as `error` with the refusal as the cause
  - [ ] A test with a port that throws `NotSupportedError` on a guarded push
        shows no retry

Context: `pushWrites.ts` (around line 361) lets every non-conflict error
propagate so RxDB retries the batch with backoff, and `controller.ts` only
special-cases `WasSyncAuthError`. The new refusal is permanent: a backend that
does not advertise `conditional-writes` will not start enforcing preconditions
on a retry. Against the reference server every server-managed backend advertises
the token, so only a client-registered external backend reaches this today.
Decide whether a dedicated predicate on was-client's `./sync` subpath is wanted,
or a local name check is enough.

discovered-from: was-client WCL-50.
