# @interop/was-sync Changelog

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
