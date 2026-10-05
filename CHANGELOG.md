# @interop/was-sync Changelog

## 0.8.2 - TBD

### Changed

- A refused pull checkpoint now logs a `warn` before the feed restarts.
  ARCHITECTURE.md documents the restart's residual. A row from a re-created
  Collection's previous generation stays in the replica until it is forgotten,
  and returns to the server as a create only when edited (WS-27).
- Update the `@interop/was-client` devDependency to `^0.91.0`.

## 0.8.1 - 2026-10-04

### Fixed

- A row removed while its create push is in flight is no longer deleted with a
  header-less `DELETE`. The driver re-reads the primary and sends the delete
  with `If-Match` carrying the resource's validator. A re-read showing another
  writer's record or a changed body surfaces as a conflict. An absent or
  tombstoned re-read is read as already gone (WS-22).

### Changed

- The hidden-`ETag` echo-drop case is closed as a spec conformance matter. The
  WAS spec is to require `ETag` exposed cross-origin. The driver's hidden-`ETag`
  path stays as best-effort for non-conforming servers, and no validator members
  are added to the write body (WS-21).

## 0.8.0 - 2026-10-04

### Fixed

- The benign-412 delete retry no longer tombstones a resource another writer
  deleted and re-created under the same id. When the replica has a `writerId`
  and the re-read primary carries one, the retry fires only if they match; a
  revision under another writer's label surfaces as a conflict. With no label on
  either side the body-equality rule is unchanged. The feed-walking primary read
  now carries the feed's `writerId` into the primary state (WS-5).
- The default `isEqual` (`statesEqual`) compares every member of the synced
  document. It now also compares `id`, `updatedAt`, `createdBy`, `epoch`,
  `etag`, and `metaEtag`. The old comparison let RxDB skip the feed echo of a
  replica's own write. As a result, a row the replica created kept the client's
  `updatedAt` and never received the server-assigned `createdBy`. A consumer
  that overrode `isEqual` with a deep equality to get this behavior can drop the
  override (WS-6).
- An accepted write is acked on its `etag` / `metaEtag` alone, so the next
  conditional write echoes the validator. An accepted write whose `ETag` is
  hidden from a cross-origin caller carries neither and acks nothing (WS-7,
  WS-18).
- The ack write-back stamps the write's `updatedAt`, `updatedAtCounter`,
  `originId`, and `createdBy` from the content ack, and `meta` from the `/meta`
  ack, when the server answers the write with a body (was-teaching-server
  0.42.0, `@interop/was-client` 0.90.0). Each stamp is patched as a unit beside
  its validator, only while the row still holds the pushed state, and never from
  an ack with no validator. A row this replica created no longer depends on the
  feed echo for its `createdBy` and server stamp, so an echo RxDB drops behind
  the pending write-back costs nothing. A row that earned a content ack and then
  a `/meta` conflict in the same push is no longer written back; the write-back
  collided with RxDB's conflict fork write and discarded the resolver's decision
  (WS-17).
- **BREAKING**: `PushWriteAck` keeps each port ack whole,
  `{ id, pushedState, content?, meta? }`, in place of the merged
  `{ id, etag?, metaEtag? }`. The `@interop/was-client` peer floor rises to
  `0.90.2` (WS-17).
- The controller no longer reports `synced` on the replayed initial `active$`
  value. A collection stays at `idle` until its first cycle starts, so a session
  whose server is unreachable shows `idle` then `error`, not `synced` (WS-8).

### Changed

- **BREAKING**: `createWasReplication` no longer accepts `deletedField`. The
  push handler, the conflict entries, and the feed primary read all branch on
  `_deleted`, so under any other field a local delete was pushed as a content
  write of the tombstone's body. The replication always runs under RxDB's
  default `_deleted` (WS-19).
- **BREAKING**: the replica schema and `SyncedDoc` carry the server's write
  stamp in place of the integer revisions. `version` and `metaVersion` are gone.
  `updatedAtCounter`, `originId`, and the nested `meta` (`updatedAt`,
  `updatedAtCounter`, `originId`, `generation`) are added, all optional, and
  `required` is `['id', 'updatedAt']`. The schema version stays at `0`, so RxDB
  refuses to open an existing replica with the new shape. The consumer must
  forget every existing replica (remove the collection) and re-pull it. The
  consumer must forget the collection's replication meta
  (`rx-replication-meta-*`) with it or change its `replicationIdentifier`, or a
  retained checkpoint resumes past every row and the new replica comes up empty.
  Local writes not yet pushed at the update are lost.
  - `PushWriteAck` is `{ id, etag?, metaEtag? }`.
  - `statesEqual` compares `updatedAtCounter` and `originId` strictly and `meta`
    canonically, in place of the revisions.
  - The tombstone conflict entry carries only `id`, `updatedAt`, and
    `_deleted: true`.
  - The `/meta` write is an update when the assumed primary is not a tombstone
    and carries `meta` or `metaEtag`. A tombstone sends `If-None-Match: *`.
  - Requires `@interop/was-client` >= 0.89.1, the new peer range. The
    `ResourceMetaStamp` type is was-client's own, re-exported from the root
    entry. The integration suite runs against was-teaching-server 0.41.1
    (WS-23).
- The push handler no longer sends a `writerId` member on a `/meta` write. The
  label is a member of the content record alone, and the `Writer-Id` header
  still goes on content writes and deletes. The public `writerId` option is
  unchanged. `WasSyncPort.putMeta` lost its `writerId` option, which matters
  only to a consumer that implements the port (WS-25).
- Docs: ARCHITECTURE.md records that was-client's sync port (0.89.0) filters the
  widened `changes` feed. It hands on JSON Resources and their tombstones only,
  with `deleted` renamed `_deleted`, so the pull handler and the feed primary
  read filter nothing themselves. Consuming was-client 0.89.0 meets WS-24's pull
  boundary filter.
- Tests: the integration suite boots through `was-teaching-server/testing`
  (`startTestServer`, `openTempBackend`), against the server's 0.41.1 release.
- Tests: an audit of the suites for tautological and inert tests. The `hasAck()`
  memo bypass, the feed walk's page-to-page checkpoint forwarding, teardown
  awaiting `cancel()`, registration before subscription, and the controller's
  sync-port wiring (`feedPrimaryRead`, `capability`, `mapAuthErrors`) now have
  tests that fail when the behavior breaks. The packaging and browser smoke
  tests make `rxdb` unresolvable before loading the root entry, so their "no
  rxdb" claim is checked rather than named. Duplicate cases were collapsed;
  `toEqual` on absent-member claims became `toStrictEqual` or `in` checks.
- `./testing`: `memorySchedule()` gains `intervalsMs()` and
  `memoryOnlineSource()` gains `subscribers()`, so a test can pin the poll
  interval and the online-source unsubscribe.
- The Playwright smoke server runs on its own port (5791, strict), so a stray
  dev server on 5173 is no longer picked up.

## 0.7.0 - 2026-10-01

### Changed

- **BREAKING**: `SyncCheckpoint` follows was-client's opaque string checkpoint,
  replacing the `{ id, updatedAt }` object. The RxDB checkpoint record is the
  new `ReplicationCheckpoint`, `{ checkpoint: SyncCheckpoint }`: RxDB stacks
  checkpoints with `Object.assign`, which would scatter a bare string, so the
  pull handler wraps the string for RxDB and unwraps it for the port. A replica
  persisted with the retired object record reads as no checkpoint and pulls from
  the beginning. `createWasReplication` returns
  `RxReplicationState<SyncedDoc, ReplicationCheckpoint>`. Requires
  `@interop/was-client` 0.85.0 or later.
- The pull handler restarts the feed from the beginning when the port raises its
  refused-checkpoint signal (`isSyncCheckpointError`), as for a checkpoint
  issued by another server. Every other pull failure is rethrown. The refused
  checkpoint is remembered for the life of the handler, so an empty restarted
  feed (which RxDB does not persist a checkpoint for) costs the 400 round trip
  once rather than once per poll.

## 0.6.0 - 2026-09-28

### Added

- WAS writer attribution on push. `createWasReplication` and
  `createSyncController` take an optional app-minted `writerId`. When set, every
  content write and delete sends it as the `Writer-Id` header and every metadata
  write as the body's `writerId` member. When absent, no label is sent, which
  clears any stored one. The pull side does not read it, and the feed's
  `writerId` is not stored in the local row.
- `WasSyncPort.putContent` / `deleteContent` / `putMeta` take an optional
  `writerId`, matching was-client's port.

### Changed

- BREAKING: `createPushHandler` takes one options object,
  `{ port, onWriteAccepted?, writerId? }`, in place of positional arguments.
- The `@interop/was-client` peer range is now `>=0.79.0`, the first release
  whose sync port sends `writerId`.

## 0.5.1 - 2026-09-25

### Changed

- Update to latest di core 8.8.0.

## 0.5.0 - 2026-09-17

### Removed

- BREAKING: the permanent-refusal give-up path, in full. `isPermanentRefusal`
  (exported from `./rxdb`) is gone, and the push handler no longer classifies or
  logs was-client's `NotSupportedError` apart from any other rethrow.
  Conditional writes are a baseline WAS server requirement as of the spec's
  WASS-40, and was-client 0.67.0 removed the backend-feature gate that raised
  the refusal, so no write the sync port sends can be refused for want of the
  feature. An app matching the signal to report a dead collection should drop
  the branch; nothing else replaces it, because nothing raises it.

### Changed

- The controller no longer stops a single collection on a replication error. An
  error reports `error` on that collection's status and is left to RxDB's
  backoff, which is what every remaining replication failure warrants.

## 0.4.0 - 2026-09-16

### Changed

- The push handler treats was-client's `NotSupportedError` as permanent rather
  than transient. The sync port raises it before a guarded write is sent when
  the collection's backend advertises no `conditional-writes`, and a retry
  cannot change that, so the refusal is logged at `error` and rethrown unchanged
  instead of being left to look like a network failure.
- The controller stops a collection whose replication reports that refusal:
  `isPermanentRefusal` (new, exported from `./rxdb`) finds it under RxDB's error
  wrapping, and the collection's subscriptions, replication, and registry entry
  are released, leaving its status at `error`. Sibling collections keep
  replicating and the controller stays startable. Without this RxDB re-sent the
  refused batch forever, starving every row behind it.
- Raise the `@interop/was-client` peer range to `>=0.67.0 <1.0.0`, for the
  `isNotSupportedError` predicate on its `./sync` subpath.

## 0.3.0 - 2026-09-16

### Changed

- BREAKING: the conflict resolver's `decrypt` closure is now was-client's
  `DocCipher.decrypt`, exported as the `ConflictDecrypt` type:
  `({ id, envelope, context? }) => Promise<Json | Blob>`, where it used to be
  `(envelope) => Promise<Json>`. `lwwResolver` and `makeLwwConflictHandler` take
  the new shape. Each side is decrypted under the row's own `SyncedDoc.id`, so
  the cipher's check that an envelope was written for the resource it is read
  under is no longer skipped.
- BREAKING: an `IntegrityError` from the closure propagates out of the resolver
  and fails the replication cycle instead of being scored `undecryptable`. A
  body written for another resource is not an absent key, and the undecryptable
  rules would otherwise adopt or re-assert it with only a `warn`.
  `UnknownEpochError` and `KeyUnwrapError` are unaffected.
- A closure that resolves a `Blob` is scored `undecryptable` rather than absent,
  so the write is not silently lost. It does not arise through was-client's own
  ciphers: the resolver supplies no codec context, which a chunked envelope
  needs to resolve one.
- Raise the `@interop/was-client` peer range to `>=0.66.0 <1.0.0`. A build
  calling `decrypt(envelope)` next to was-client 0.66.0 passes no id, which
  skips the binding check and makes the plaintext cipher throw on every read.
- Update the `was-teaching-server` devDependency to `^0.35.1`. was-client 0.62.0
  made service discovery mandatory, and the integration suite's pinned server
  predates WAS v0.5.

## 0.2.9 - 2026-09-11

### Changed

- Widen the `@interop/was-client` peer range to `>=0.59.1 <1.0.0`, so a
  was-client minor release no longer needs a was-sync republish. The lower bound
  moves when the driver starts using a newer was-client API.

## 0.2.8 - 2026-09-10

### Changed

- Update to latest ed25519 key dep.

## 0.2.7 - 2026-09-10

### Changed

- Update to latest was-client dev dep.

## 0.2.6 - 2026-09-10

### Changed

- Update to latest was-client dev dep.

## 0.2.5 - 2026-09-08

### Fixed

- Fix pnpm workspace, bump latest was-teaching-server devDep.

## 0.2.4 - 2026-09-08

### Changed

- The undecryptable-side conflict warnings carry a `reason` (`unknown-epoch`,
  `key-unwrap`, or `other`), classified through `@interop/was-client/sync`'s
  `isUnknownEpochError` and `isKeyUnwrapError`, so a spent or unwired descriptor
  refresh is told apart from a key this reader was never given.
- Documented where the unknown-epoch refresh rule sits relative to the driver:
  it runs inside the injected `decrypt` closure, which on an encrypted
  collection should be `@interop/was-client/edv`'s
  `createRefreshingEdvDocCipher`. The driver holds no cipher and runs no refresh
  of its own.

## 0.2.3 - 2026-09-08

### Changed

- The controller assigns `@interop/was-client`'s sync port directly, and
  `WireDoc` is aliased from the client like the other wire types. The `unknown`
  cast and the runtime `putMeta` probe are gone, since `@interop/was-client`
  0.54.0 types the port as what it implements, so a divergence in any port
  member is now a compile error at the seam rather than an `error$` event inside
  a push or pull cycle (WS-10).

### Fixed

- A delete with no assumed primary (a row created and deleted locally before the
  replica's first push) is skipped instead of sent as a header-less `DELETE`.
  Ids are content-addressed, so that unconditional delete tombstoned another
  replica's live copy of the same id. The row is reported accepted with no ack;
  the live copy stays on the server and comes down on its next feed change
  (WS-3).
- The `/meta` write's delete-race recovery now fires on the default port. A
  metadata-only edit against a resource another replica deleted used to reject
  the batch there (the recovery matched only the `mapAuthErrors` port's masked
  `404`), so RxDB retried the same write forever. One classifier now takes the
  default port's not-found signal and the auth port's `status: 404` to the same
  corroborating feed re-read, and the row resolves as a tombstone conflict
  entry. Needs `@interop/was-client` 0.54.0, whose default-port `putMeta` raises
  the not-found signal (WS-4).

## 0.2.2 - 2026-09-08

### Changed

- Update to latest was-client.

## 0.2.1 - 2026-09-07

### Fixed

- Fix the was-client dependency from link to npm.

### Tests

- The live-server integration suite now covers resurrecting a row that carries
  `custom`: the content create and the `/meta` create-if-absent land in one push
  cycle with a single conflict resolution, and a `/meta` `If-Match` carrying the
  pre-delete metadata `ETag` is refused with 412 after the re-create.

## 0.2.0 - 2026-09-07

### Changed

- **Breaking:** `putContent` / `deleteContent` / `putMeta` on the sync port now
  resolve a `WriteAck` (`{ version, etag? }`) instead of a bare revision number,
  matching was-client's opaque `ETag` contract. `MasterState` / `WireDoc` /
  `SyncedDoc` gain `etag` / `metaEtag`, and a conditional write's `ifMatch` is
  now the validator echoed back verbatim -- it can no longer be rebuilt from a
  version number. The replica schema's shape changed to carry the new fields, so
  an existing replica is forgotten and re-pulled at the next login (schema
  `version` stays `0`).

### Fixed

- Resurrecting a resource another replica deleted converges in one cycle on the
  plain was-client port (WS-2). A `412` whose re-read resolves `null` now builds
  a tombstone conflict entry with `version: 0` and no `etag` instead of a
  version copied from local state, and an assumed primary that is a tombstone
  routes the next content write to `If-None-Match: *` (the one precondition a
  server accepts against a tombstone) and a delete to an unconditional `DELETE`.
  Before the opaque-ETag change the re-push sent `If-Match` with the fabricated
  version and looped hot; after it, an unconditional `PUT` that could overwrite
  a concurrent re-create.

## 0.1.2 - 2026-09-07

### Added

- The driver's swallow points now log: the ack write-back failure at `warn`, and
  the benign-412 delete re-issue and the conflict hand-back at `debug`.

### Changed

- **Breaking:** `FakeWasServer` is removed from `@interop/was-sync/testing`. The
  integration suite now runs against a live in-process `was-teaching-server`
  through the real `createWasSyncPort` from `@interop/was-client`, so the
  server's conditional-write, tombstone, and `changes`-feed behavior is
  exercised rather than modeled (WS-11). The stub port and the memory schedule
  and online source remain on the subpath.
- **Breaking:** `SyncLogPort` and the per-call `log` options on
  `createSyncController`, `makeConflictHandler`, `lwwResolver`, and
  `makeLwwConflictHandler` are removed. The package adopts the ecosystem logging
  library port instead: `setLogger` and the `Logger` type on the root entry. An
  app wires one logger once at bootstrap, e.g.
  `setLogger(createLogger('sync'))`; the console fallback (prefixed
  `[was-sync]`) applies otherwise (WS-12).

### Fixed

- A delete's `404` no longer wedges the push batch on the default was-client
  port. The push handler reads the not-found signal from `deleteContent` (by
  `err.name`) as the already-gone outcome, matching what a `mapAuthErrors: true`
  port already resolves itself, so the batch completes and its other rows land
  (WS-1). A spec-conformant server answers `204` for an authorized delete of an
  absent resource; the `404` on that path is a masked authorization refusal,
  which still surfaces on the next feed pull.
- The packaging suite (formerly `test:dist`) is now `test:packaging` and lives
  in `test/packaging/`. The old `test/dist/` directory matched the unanchored
  `dist` line in `.gitignore`, so the suite was never committed and CI failed
  with "No test files found". The ignore entry is now anchored to `/dist`.

## 0.1.1 - 2026-09-05

### Added

- Initial release. The WAS replication driver for RxDB, merged from the two
  copies that had drifted apart in `@interop/was-react` (`src/sync/`) and in the
  Freewallet browser wallet (`src/lib/sync/`). Neither consumer may depend on
  the other, so a shared package is the one home the driver can have. The
  placement, its rejected alternatives, and its revisit criteria are recorded in
  `decisions/0001-rxdb-replication-driver-package.md`.
- Three entries. `@interop/was-sync` carries the wire and replica types, the
  synced-document schema, the conflict-handler seam with its last-write-wins
  default, and the writer-id mint; it is free of `rxdb` in its module graph and
  in its emitted declarations, so an app that never builds a replica resolves it
  with `rxdb` absent. `@interop/was-sync/rxdb` carries the pull and push
  handlers, the `replicateRxCollection` wiring, the feed-backed conflict
  re-read, and the controller core. `@interop/was-sync/testing` carries the
  fixtures. `@interop/was-client` and `rxdb` are peer dependencies; `rxdb` is
  marked optional.
- The pull side: the `changes`-feed handler and the wire-to-replica mapping,
  with the empty-page rule keyed on a nullish response checkpoint so the feed
  never restarts from its origin.
- The push side: content-then-metadata write routing (a metadata clear writes
  the cleared state rather than being skipped), the 412 conflict assembler, the
  benign-412 delete retry that keeps a stale revision from leaving a deleted
  resource live on the server, the per-batch primary-read memo, the `/meta` 404
  corroboration, and the acked-revision write-back.
- The conflict-handler seam. `makeConflictHandler` takes the decision as an
  injected resolver receiving the whole RxDB conflict input, so a wallet can
  delegate to its own comparator while an app framework uses the packaged
  `lwwResolver` (which scores an undecryptable side apart from an absent one).
  `makeLwwConflictHandler` is the two together.
- The controller core: one serialized FIFO lifecycle over a session's
  collections, a terminal `stop()`, a failed bring-up that unwinds and rethrows
  without latching, the skip-and-flag for a collection no delegated capability
  covers, the auth escalation over RxDB's wrapped error graph, the remote-change
  subscription off the collection stream, and injected timer and reachability
  ports.
- The writer-id mint, over a required key prefix and an injected storage port. A
  storage that cannot answer mints a fresh id per call and remembers nothing.
- An injected `{ warn, error }` log port on the controller core, the
  conflict-handler factory, and the last-write-wins resolver, defaulting to a
  no-op, so diagnostics ride each consumer's own logging seam. The factory logs
  one thing of its own: a resolver that throws, which RxDB treats as a fatal
  replication error, is reported with the row it happened on before it
  propagates. The port's metadata argument is `Record<string, unknown>`, which a
  namespaced logger satisfies directly.

### Changed

- The behavior set is the union of the two source copies, with each side's
  deltas ported into the merge base before the move: the benign-412 delete
  retry, JCS-canonical body equality, the server-managed `createdBy` carried
  across live documents and tombstones, and `err.name` classification in place
  of `instanceof` (`@interop/was-client`'s
  `decisions/0001-cross-package-errors-match-by-name.md`).
- The synced-document schema is the union of the two copies (`createdBy`, the
  `required` list, and the `updatedAt` index), shipped at `version: 0` with no
  migration strategy. RxDB refuses to open a replica whose stored schema hash
  differs at the same version, so every remembered browser in both consuming
  apps needs one forget-and-log-in-again after the upgrade. Transient sessions
  are unaffected.
- The server-side state a 412 re-read resolves is named "primary" throughout
  (`PrimaryState`, `PrimaryReadCache`, `withFeedPrimaryRead`,
  `feedPrimaryPort.ts`), renamed from the merge base's "master". RxDB's own
  field names on a push row (`assumedMasterState`, `realMasterState`) are RxDB's
  API and are unchanged.
