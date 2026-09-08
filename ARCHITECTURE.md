# Architecture

The current shape of this library, with the rationale inline: why each part is
shaped the way it is, stated where the shape is described. This file is kept
current in the same change set that alters the shape; it overwrites in place and
records no history. History lives elsewhere: CHANGELOG.md for what landed,
`decisions/` for durable decisions with their rejected alternatives and revisit
criteria, and the archived roadmap for the work items. Reference decision
records from here where the resulting shape is described, instead of re-arguing
them.

## Layer map

`@interop/was-sync` is the WAS replication driver for RxDB. The placement --
what lives here, and what stays in was-client, social-core, wallet-core, and
each consuming app -- is decision
[0001](decisions/0001-rxdb-replication-driver-package.md).

Three entries, and the split between them is part of the contract.

```
src/index.ts             The "." door: RxDB-free, in the module graph AND in
                         the emitted declarations
src/types.ts             The wire and replica shapes, the port interfaces, the
                         opaque-body equality, the optional-field copy, the LWW
                         stamp accessor
src/syncedDocSchema.ts   The one replica schema, returned as a structural type
src/conflictHandler.ts   The RxDB conflict-handler seam (injected decision) and
                         its last-write-wins default resolver
src/writerId.ts          The writer-id mint and clear, over an injected storage
                         port and a required key prefix
src/log.ts               The logging seam: the locally declared Logger port,
                         setLogger, and the console fallback

src/rxdb.ts              The "./rxdb" door: everything that needs the peer
src/changesQuery.ts      The pull handler and the wire-to-replica mapping
src/pushWrites.ts        The push handler: write routing, the benign-412 delete
                         retry, the conflict assembler, the write acks
src/wasReplication.ts    The replicateRxCollection wiring and the ack write-back
src/feedPrimaryPort.ts   The opt-in feed-backed conflict re-read (a server that
                         hides the ETag behind CORS)
src/controller.ts        The controller core: the serialized lifecycle, the
                         per-collection replications, status, auth escalation,
                         polling, reachability

src/testing.ts           The "./testing" door: the stub port, and the memory
                         schedule and online source
```

Dependency direction is strictly downward. The runtime dependencies are
`@interop/social-core` (the last-write-wins comparison), `json-canonicalize`
(the JCS body equality), and `uuidv7` (the writer-id mint).
`@interop/was-client` and `rxdb` are peers; `rxdb` is optional, since only
`./rxdb` needs it. Nothing here depends on `@interop/wallet-core`, which is what
keeps the conflict resolver an injected seam rather than a dependency.

## Invariants

The rules the code upholds that a reader cannot infer from any one call site,
numbered so items and reviews can cite them.

1. **Bodies are opaque.** `data` is the stored content body and `custom` the
   stored metadata body; both move verbatim. Encrypting and decrypting are
   read-time and write-time concerns above this layer, and the driver holds no
   key material. The one decision that cannot be body-opaque, settling a
   mutable-head conflict, is injected: `makeConflictHandler` takes a resolver,
   and the default resolver takes a `decrypt` closure rather than a cipher
   (`src/conflictHandler.ts`).
2. **The driver mints no ids.** Row ids are the caller's, content-addressed and
   identical on every replica; a resolved row keeps the `createdBy` the server
   recorded. Two replicas therefore converge on the same rows without
   coordinating.
3. **Every content push carries the row's `Key-Epoch` stamp.** The stamp rides
   `SyncedDoc.epoch` from the feed and back out through `putContent`; the header
   itself belongs to was-client's port, and the policy for refreshing a stale
   descriptor belongs to the consuming app.
4. **The benign 412 delete retry.** A locally created row is pushed with the
   revision it was inserted with while the server assigns its own, so a delete
   conditional on a stale revision would be refused forever and leave the
   resource live. A refused delete re-reads the resource, and a body unchanged
   under a drifted revision is re-deleted against the fresh ETag; every other
   412 is a real conflict (`src/pushWrites.ts`). The push-ack write-back only
   makes the case rarer -- it is best-effort and swallows its own failure -- so
   the retry stays the authority for deletes. A delete with no assumed primary
   is skipped, not sent: the row was created and deleted locally before this
   replica ever pushed it, so the replica holds no server state for it, while
   another replica may hold a live resource under the same content-addressed id
   (invariant 2). HTTP has no precondition for "delete only what I created" (an
   `If-Match` needs a validator this replica never had, and a header-less
   `DELETE` would tombstone the other replica's copy), so `src/pushWrites.ts`
   issues no write and reports the row accepted with no ack, the create path's
   `If-None-Match: *` guard mirrored. RxDB then settles the local tombstone as
   the assumed primary. The replica keeps that tombstone until the resource next
   changes on the feed (RxDB defers a pulled state behind a pending local
   change, and the initial pull pages past the live copy while the delete is
   still pending); the first such change brings the live copy down, since
   nothing is pending against the row by then. The integration suite pins the
   skip, the intact copy, and that convergence. A delete's `404` (was-client's
   not-found signal, matched by name) is the already-gone outcome on either
   delete call, not an error: a conformant server answers `204` for an
   authorized delete of an absent resource, so the `404` is a masked
   authorization refusal that no retry can advance, and rethrowing it would pin
   the whole batch in RxDB's retry loop. Revoked access still surfaces on the
   next feed pull. A `/meta` write's `404` is likewise not an error on its own:
   a metadata-only edit against a resource another replica deleted is the same
   delete race, raised as the not-found signal on the default port and as the
   auth signal with `status: 404` on a `mapAuthErrors` port. One classifier in
   `src/pushWrites.ts` takes both shapes to the same corroborating feed re-read,
   and an absent or tombstoned primary resolves the row as a tombstone conflict
   entry for the conflict handler; a primary that is alive rethrows the original
   signal. A tombstone is absent for preconditions: a `412` whose re-read
   resolves `null` builds a tombstone conflict entry with `version: 0` and no
   `etag` (the plain port cannot tell a tombstone from a resource that never
   existed, and both take the same next write), and an assumed primary with
   `_deleted: true` routes a content write to `If-None-Match: *` and a delete to
   an unconditional `DELETE`, since `If-Match` against a tombstone is refused
   whatever validator it carries. That refusal is RFC 9110's rule, not a server
   quirk: a tombstone has no current representation (which is why `GET` answers
   `404`), and against no representation `If-None-Match: *` is true and
   `If-Match` with any tag is false. Honoring the tombstone's surviving ETag was
   considered and rejected on 2026-09-07: it would put WAS at odds with the HTTP
   semantics the spec borrows, for a gain confined to one race (a third replica
   re-creating and re-deleting in between), which the changes feed already
   surfaces as higher-version entries for the next pull to reconcile. The
   `/meta` half of a resurrection is a create-if-absent for the same reason: a
   tombstone entry carries no `custom` and no `metaVersion`, so the handler
   compares the local `custom` against nothing and sends `If-None-Match: *`, and
   against the teaching server, whose tombstone drops the metadata object and
   retires its validator, both halves land in one push cycle. A server that kept
   the metadata object through a tombstone would answer that create with a
   `412`, which costs one extra cycle (the re-read, a metadata conflict entry, a
   resolution) rather than failing the row. The integration suite pins both the
   one-cycle path and the refusal of a `/meta` `If-Match` carrying the
   pre-delete validator.
5. **Cross-package errors match by `err.name`, never `instanceof`.** Every error
   this driver classifies is was-client's, raised inside a seam the app injects,
   and that seam can resolve to a second copy of was-client. The predicates come
   from `@interop/was-client/sync` (was-client's
   `decisions/0001-cross-package-errors-match-by-name.md`); reading `err.status`
   after the name match is the intended shape. The controller's `isAuthError`
   walks RxDB's error graph because RxDB serializes a thrown handler error to
   plain JSON, so only the name survives.
6. **JCS-canonical body equality.** `bodiesEqual` compares canonicalized JSON
   rather than `JSON.stringify` output. It decides whether a write is issued at
   all and whether the delete retry fires, so a host that re-serializes a stored
   body with a different key order must not read as a change.
7. **The replica schema is stored state.** RxDB hashes the declared schema and
   refuses to open a replica whose stored hash differs at the same `version`.
   The schema ships at `version: 0` with no migration strategy, so a replica
   created under a different shape is forgotten and re-pulled rather than
   migrated. Changing the shape is a breaking change for every existing replica
   and says so in the CHANGELOG.
8. **The writer id is never an identity.** Unkeyed, clearable, unrecoverable,
   derived from no secret. The key prefix is required (the package mints no
   default key two apps could collide on) and the storage is an injected port. A
   storage that cannot answer mints a fresh id per call and remembers nothing: a
   module-level fallback would stamp one label into two accounts' histories in
   the same tab.
9. **`stop()` is terminal, and every transition is serialized.** The controller
   core runs start and stop on one FIFO queue, so an overlapping pair cannot
   interleave and leave a dangling replication, and a `start()` queued behind a
   `stop()` is refused rather than run against a database the caller is closing.
   A session that replicates again constructs a fresh controller. What `stop()`
   guarantees is bounded by RxDB's `cancel()`, which awaits the start and
   checkpoint queues rather than an in-flight round trip.
10. **A failed bring-up unwinds without latching.** It cancels every replication
    it registered, flags every collection `error`, and rethrows, so the caller's
    bootstrap can surface the failure and the instance stays re-startable.
    Registration happens before subscription, since the replication auto-starts
    and a throw in between would leave one `stop()` could not reach.
11. **A capability-less collection is skipped, not replicated.** In a port whose
    other entries carry a delegated capability, an entry with none is flagged
    `error` and skipped: replicating it would draw a fail-closed 403 that reads
    as a session-wide access failure. A port where no entry carries one invokes
    the client's own root capability throughout.
12. **The core reaches for no platform globals.** The timer and the reachability
    signal are injected ports, so the core runs where there is no DOM and a test
    drives both. An `isOnline` that cannot answer must return `true`, or a
    platform with no reachability signal would never poll. `pollMs` is required
    for the same reason a default would be wrong: two consumers poll at
    different rates.
13. **Diagnostics ride the package's own logging seam.** All diagnostics leave
    through `src/log.ts`: a locally declared `Logger` port and `setLogger`. An
    app wires a logger once at bootstrap, under one namespace for the whole
    package (`setLogger(createLogger('sync'))`), the same library-port
    convention used across the ecosystem (decision 0004 in the logging package's
    own repo). The port is declared locally rather than imported, so the
    published declarations name no `@interop/logger` specifier.
    `@interop/logger` is a type-only devDependency: an eslint rule blocks a
    value import in `src/`, and `test/packaging/` greps `dist/` for the
    specifier. A test pins the local `Logger` type to the package's own. The
    undecryptable-side warnings and a resolver that throws are the two signals
    that must reach the app's logger; RxDB treats a failed resolution as fatal.
    The driver's swallow points reach it too now: the best-effort ack write-back
    logs its failure at `warn`, and the benign-412 delete re-issue and a
    conflict entry handed back to RxDB each log at `debug`. The old per-call
    port could not reach those points.
14. **The root entry never reaches `rxdb`.** Neither at runtime nor in its
    emitted declarations. A missing package is a resolution failure rather than
    something a bundler drops, and every consumer compiles with `skipLibCheck`,
    so a surviving `import type` would degrade to a silent error type. The
    schema and the conflict handler therefore declare structural types of their
    own. `test/packaging/` walks the built graph and asserts it.
15. **`./testing` is test-only, and holds no fake server.** The stub port
    refuses every call and the memory ports never fire on their own, so a
    production import would leave a replica that never syncs. The eslint config
    keeps `src/` off it, and each consumer keeps the same restriction on its own
    production globs. The integration suite runs against a live in-process
    `was-teaching-server` through the real was-client port rather than a fake: a
    fake is a second implementation of the WAS contract, and the one this
    package started with hid bugs by synthesizing a 412 for a header-less
    DELETE, never assigning `createdBy`, and raising error shapes the default
    port does not.

## Ownership heuristics

- **A WAS request, an error class, or a wire name** belongs to
  `@interop/was-client` (`./sync` for the port, the vocabulary, and the four
  `err.name` predicates). This package speaks no WAS HTTP itself.
- **The last-write-wins comparison** belongs to `@interop/social-core`
  (`remotePayloadWins`). This package reads the stamp off a payload
  (`lwwFields`) and applies whichever comparator it is handed.
- **A conflict policy for a particular collection** belongs to the consuming
  app, as the injected resolver. A wallet delegates to its own contacts
  comparator; an app framework compares decrypted stamps through the default.
- **Key material, ciphers, key epochs, and descriptor-refresh policy** belong to
  `@interop/was-client/edv` and to each consuming app.
- **The session gates** (guest, no remote configured, no local replica) belong
  to each app's binding, ahead of the controller core.
- **The status store, the i18n, and the platform wiring** belong to each app.
  The core reports status through a callback and takes the timer and
  reachability as ports.
- **The change engine a replica-less wallet drives** belongs to
  `@interop/wallet-core/sync`. It and this driver are siblings sharing the wire
  types rather than one algorithm: the engine drives its own store and applies a
  page transactionally, while RxDB drives this driver's handlers and owns the
  transaction.

## Parties to the specs

The WAS spec's "Parties to this contract" table names `@interop/was-client` as
the speaker of the `changes` profile, and this package takes no row of its own:
every request it makes goes through was-client's sync port, so by the table's
admission rule ("speaks the WAS HTTP contract directly") it is a downstream
consumer like the wallets. The walk recorded at the extraction: was-client
unchanged and still the one named speaker; storage-core, was-teaching-server,
and was-conformance-suite unaffected (no wire byte changes); everything
downstream gains this package as one more consumer through was-client, with no
row text change; and in the encrypted-collections spec the `@interop/was-react`
row is confirmed rather than rewritten, since the document cipher stays there
and this package holds none. The package's node and its `rxdb` edge belong to
the byoe-ecosystem layer map instead.

## Glossary

- **Driver** -- this package: the RxDB-side implementation of WAS replication.
  Contrast the **engine** (`@interop/wallet-core/sync`), the replica-less
  implementation a mobile wallet drives. Avoid: adapter, sync layer.
- **Port** -- an injected seam the driver depends on rather than implements: the
  `WasSyncPort` (WAS access), the storage port (the writer-id mint), and the
  schedule and online source (the controller). Avoid: provider, service.
- **Logging seam** -- `src/log.ts`: the locally declared `Logger` port and
  `setLogger`; the one place the package's diagnostics leave through. Avoid: log
  port, SyncLogPort, logger option.
- **Primary state** -- the server's current state of one resource, as re-read
  for the 412 conflict path (`PrimaryState`, `withFeedPrimaryRead`). RxDB's own
  field names on a push row (`assumedMasterState`, `realMasterState`) are RxDB's
  API and stay as they are. Avoid: master state, remote state.
- **Wire doc** -- one document as it travels on the `changes` feed (`WireDoc`).
  Contrast the **synced doc** (`SyncedDoc`), the same document as the local
  replica stores it. Avoid: change document, row payload.
- **Conflict entry** -- the primary state the push handler returns for a row the
  server refused, which is what RxDB's push contract asks for. Avoid: conflict
  result, rejection.
- **Ack** -- the server revision and opaque `ETag` an accepted write earned
  (`PushWriteAck`), written back into the local row so the next conditional
  write's `If-Match` echoes what the server holds. Avoid: receipt, confirmation.
- **Writer id** -- an unkeyed, clearable attribution label saying which writing
  agent produced a revision; it attributes history and breaks last-write-wins
  ties. Avoid: device id, replica id, client id (a client id is keyed and
  custodied; this is neither).
- **Key epoch** -- the opaque id of the key a stored envelope was encrypted
  under, carried verbatim on `SyncedDoc.epoch` and stamped on the content push.
  The driver never interprets it. Avoid: key version, epoch key.

## Current State labels

Everything above is current. One item is Desired Direction rather than current:
the `react-native` export condition is carried on all three subpaths, but no
React Native consumer exists and RxDB's own React Native story is not exercised
here.
