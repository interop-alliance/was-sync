# WS-23: Adopt the WAS-96 stamp data model (design)

- item: WS-23
- status: approved
- approved: 2026-10-03
- wire-level decisions contained: listed in section 5 (the replica schema's
  stored shape and `required` list, the nested `meta` member, the absent-stamp
  rule that replaces the `0` sentinel, the `/meta` routing key, the stamp
  comparison, the no-guard rule); all seven signed off by the user on
  2026-10-03, each taking the recommendation as stated
- decision records extracted: decisions/0002 (the nested `meta` object is stored
  as the wire shapes it, not flattened)
- review pass: 2026-10-03, six charters (consumer completeness, matrix attack,
  adversary walk, invariant audit, torn state, contract blast radius); findings
  folded in below, open points in section 8
- approval walkthrough: 2026-10-03, each of the seven decisions and the four
  open points re-read one at a time with the user; decisions confirmed as
  stated, open points 1 to 3 resolved (section 8), open point 4 left as the
  consumers' follow-up

## 1. Problem and scope

The server's approved multi-primary design (was-teaching-server
`designs/WAS-96-multi-primary-spaces.md`, approved 2026-10-02) replaces the
per-record revision counter with a write stamp minted at the writing origin.
Every versioned record carries `updatedAt`, `updatedAtCounter`, and `originId`.
The `/meta` record's stamp and generation travel as one nested object,
`meta: { updatedAt, updatedAtCounter, originId, generation }`. The validator
becomes `"<generation>.<ms>.<counter>.<originId>"`. `version` and `metaVersion`
leave every wire object, so no revision number can be read out of a validator.
`etag` and `metaEtag` stay.

This driver stores `version` as a required schema member and `metaVersion` as an
optional one, and reads them in six places: the push handler's `/meta` routing
and `hasAck`, the conflict and tombstone entries, the feed primary read,
`statesEqual`, the pull mapping, and the ack write-back's revision rules. The
`0` sentinel ("no known revision") and the WS-7 skip-zero rule describe a
revision that no longer exists. This design replaces the revision members with
the stamp members everywhere the driver stores, maps, compares, or logs them,
and replaces the `0` sentinel with absence.

Out of scope, each its own item: the `kind` filter and the `deleted` rename at
the pull boundary (WS-24, which this item is blocked by); `writerId` on the
`/meta` write (WS-25); the reasoning for keeping the payload order in the
default resolver (WS-26); the ack carrying server-managed members (WS-17,
section 8). The resolver's six rules are unchanged. The `writerId` label, the
key epoch id, the checkpoint wrapping, the controller, and the writer-id mint
are unchanged. The server, storage-core, and was-client make their own changes
under their own items; this doc states what the driver needs from them.

Where the shared packages stand (checked 2026-10-03):

- storage-core 0.28.0 is released. It declares `WriteStamp` (`updatedAt`,
  `updatedAtCounter`, `originId`) and `ResourceMetaStamp` (`WriteStamp` plus
  `generation`, `src/was.ts:60`), and its `ChangeDocument` carries
  `updatedAtCounter` and `originId` as required members and `meta` as an
  optional one, with `version` / `metaVersion` removed.
- was-client 0.87.0 is released (2026-10-03). `parseEtag` is removed. `WireDoc`
  follows the new `ChangeDocument`. `MasterState` carries optional
  `updatedAtCounter`, `originId`, and `meta?: ResourceMetaStamp`
  (`src/sync/types.ts:94-99`). `WriteAck` is `{ etag?: string }` alone (`:112`),
  and its JSDoc says a caller that needs the write's stamp reads it from the
  feed or from `get`. `ResourceMetaStamp` is not re-exported from `./sync` yet.
- was-teaching-server is 0.39.0 with a `0.40.0 - TBD` entry that adds the
  per-store origin id only. WAS-172 (the stamp) and WAS-182 (the widened feed)
  are both `todo`. The integration suite runs against the live server from the
  registry, so this item cannot go green before that release.
- The WAS spec has no stamp text yet and still documents `version` /
  `metaVersion` and the `(updatedAt, writerId)` tie-break.

WS-17 changes the ack after this item lands (decided 2026-10-03): the write
response body carries the record's full stamp (`updatedAt`, `updatedAtCounter`,
`originId`, and the nested `meta` on a `/meta` write) beside `createdBy`,
was-client's `WriteAck` grows to carry those members, and the write-back stamps
them under the unit rule in section 5. This item is implemented first, against
the `etag`-only ack, with the echo as the stamp's source for accepted writes;
WS-17 then closes the gap. WAS-96's wire inventory has no entry for a write
response body, so it needs an amendment when WS-17 is approved.

So the driver's compile-time dependency is in place and the runtime dependency
is not. The driver's own `package.json` moves with it: the was-client
devDependency moves to `^0.87.1` (on 0.x a caret pins the minor), the peer range
moves from `>=0.85.0 <1.0.0` to a floor at 0.87.1, and the `was-teaching-server`
devDependency from `link:` to the registry release that ships WAS-172 and
WAS-182. The CHANGELOG entry names the was-client floor.

## 2. Invariant inventory

Numbers are ARCHITECTURE.md's.

- 1, bodies are opaque. Upheld. No stamp member is read out of a body.
- 2, the driver mints no ids; a resolved row keeps the server's `createdBy`.
  Upheld, with one qualification the text gains: the driver mints no
  `updatedAtCounter` or `originId` either, and the only stamp member a local row
  carries before the server has seen it is the app's own `updatedAt`. The two
  server-minted members reach a row only from the feed or a re-read primary (and
  from an ack, if a later was-client ack carries them).
- 4, the benign 412 delete retry. Changed in wording only; the mechanism
  (condition on `etag`, compare bodies, match `writerId`) reads no revision.
  Every passage that does is rewritten: "the revision it was inserted with" and
  "a body unchanged under a drifted revision" (lines 86-90), the tombstone
  conflict entry's "`version: 0`" (124-125), "higher-version entries for the
  next pull to reconcile" (136-137), and the resurrection paragraph's "carries
  no `custom` and no `metaVersion`" (138-147), which becomes "no `custom`, no
  `meta`, and no `metaEtag`" and gains the explicit tombstone guard on the
  `/meta` routing (section 5).
- 5, errors match by `err.name`. Upheld. No new error class or predicate.
- 6, JCS-canonical body equality. Upheld. The `/meta` routing still decides
  whether to write on `bodiesEqual` over `custom`, and `meta` is compared
  canonically through the same helper (section 5).
- 7, the replica schema is stored state. Changed, and the invariant is what
  makes the change breaking. The property set, the `required` list, and the hash
  all move; the schema stays at RxDB `version: 0` with no migration, so every
  existing replica is forgotten and re-pulled. The text gains two sentences the
  review found missing: the forget must take the collection's replication meta
  with it (or change the `replicationIdentifier`), because a retained checkpoint
  would resume the re-pull past every row and bring the new replica up empty;
  and local writes not yet pushed when the app updates are lost with the old
  replica, since it can no longer be opened to drain them. The CHANGELOG entry
  says both.
- 13, diagnostics ride the logging seam. Upheld. The `debug` entries that carry
  `assumedVersion` / `version` carry `assumedEtag` / `etag` instead, and the two
  message texts that say "revision" ("drifted revision", `pushWrites.ts:353`;
  "acked revision", `wasReplication.ts:86`) say "validator".
- 14, the root entry never reaches `rxdb`. Upheld. The nested `meta` property
  fits the structural `SyncedDocSchema` (`properties` is
  `Record<string, Record<string, unknown>>`), and `ResourceMetaStamp` is a type
  import from was-client.
- 16, a decrypt failure is a missing key or a fatal one. Upheld. The resolver is
  not touched.
- 17, pushes declare the injected writer id, or none. Upheld here; WS-25 narrows
  it later. The delete retry reads `writerId` off the re-read primary's content
  record. WAS-96 keeps `writerId` as a content-record member served verbatim on
  the change document (its decision 12 and wire item 13, and storage-core
  0.28.0's `ChangeDocument` JSDoc); whether a tombstone document keeps it is
  confirmed in section 8.
- 18, the default `isEqual` compares every member. Changed in its member list
  and its rationale. `version` and `metaVersion` leave; `updatedAtCounter`,
  `originId`, and `meta` join. The rationale paragraph (261-273) is rewritten
  for an etag-only ack: the write-back stamps `etag` / `metaEtag`, so the echo
  differs in everything the server alone assigns, which is now `createdBy`, the
  server's `updatedAt`, `updatedAtCounter`, `originId`, and `meta`, and the echo
  is written. The sentence about an ack whose revision is `0` is deleted. If
  WS-17 later puts the stamp in the ack, the residual set shrinks and the
  paragraph is amended then. The paragraph also gains the local-edit note from
  section 5: an edited row's `updatedAtCounter` and `originId` describe the last
  server state the row learned, not the edit.

Glossary entries (ARCHITECTURE.md) the design edits, each named here because
section 5 refers back:

- `Ack`: loses the `version` / `metaVersion` sentences, the `0` paragraph, the
  "since was-client 0.86.0" sentence, and "four members"; becomes "the opaque
  `ETag` validators an accepted write earned, written back so the next
  conditional write echoes them".
- `Echo`: "the ack carries only revisions and ETags" becomes "the ack carries
  only validators", and the list of what the echo alone brings gains the stamp
  members.
- `Conflict entry`: notes the tombstone variant carries the local `updatedAt`
  and no other stamp member.
- `Wire doc` and `Primary state`: member lists updated.
- `Writer id`: gains "distinct from `originId`, which names the store that
  minted a stamp and is not an attribution label".
- New `Write stamp`: the `(updatedAt, updatedAtCounter, originId)` triple the
  server mints on every versioned record (storage-core's `WriteStamp`), with the
  `/meta` record's own stamp and generation nested under `meta`
  (`ResourceMetaStamp`). The driver stores and compares it and mints none of it.
  Avoid: revision, version, HLC stamp. Not the payload's `(updatedAt, writerId)`
  pair that `lwwFields` reads out of a decrypted body, and not the key epoch id.

The word "stamp" is already used in three other senses in ARCHITECTURE.md and
the code: the `Key-Epoch` "stamp" (invariant 3, Glossary `Key epoch`), the LWW
"stamp accessor" / "reads the stamp off a payload" (Layer map, Ownership
heuristics), and the verb "stamps a `version`". The design renames the first to
"the `Key-Epoch` header" / "the epoch id", the second to "the payload's LWW
fields", and keeps the verb only for the write-back. WS-26's title ("the
payload-stamp order") is renamed in the same change set.

## 3. Consumer enumeration

Produced by
`grep -n 'version\|metaVersion\|revision' src/*.ts test/**/*.ts README.md ARCHITECTURE.md CHANGELOG.md designs/*.md decisions/*.md`
in was-sync, the same grep over was-react `src/`, freewallet `src/`, dcw `app/`,
wallet-core `src/sync/`, was-client `src/sync/`, was-conformance-suite `src/`,
and the WAS spec, plus the roadmap item's `touches:` list. Re-run and extended
by the review pass on 2026-10-03.

Driver, `src/` (code):

- `src/syncedDocSchema.ts:59-77` -- the `version` and `metaVersion` properties,
  `required: ['id', 'updatedAt', 'version']`. Reshaped (section 5).
- `src/types.ts:88-116` `OptionalBodyFields.metaVersion`; `:230-266`
  `SyncedDoc.version` / `metaVersion`; `:159-163` `copyOptionalBodyFields`
  copies `metaVersion`. Reshaped.
- `src/changesQuery.ts:41-50` `wireDocToRxDoc` maps `version`. Reshaped; shares
  its lines with WS-24.
- `src/feedPrimaryPort.ts:48-56` `toPrimaryState` maps `version`. Reshaped.
- `src/pushWrites.ts:148-153` `PushWriteAck.version` / `metaVersion`; `:175-200`
  `primaryOrTombstone` writes `version: 0` and `primary.version ?? 0`;
  `:241-243` `assumedVersion` / `assumedMetaVersion`; `:256-260` `hasAck`;
  `:271-274` the memo bypass that reads `hasAck`; `:291-299` and `:353-357` log
  fields; `:376`, `:401`, `:437` copy `ack.version`; `:427-429` the `/meta`
  routing on `assumedMetaVersion`. Reshaped.
- `src/wasReplication.ts:33-35` `isRevision`; `:65-76` the write-back's revision
  rules, `doc.get('version')` / `doc.get('metaVersion')`. Reshaped; `isRevision`
  is deleted.
- `src/conflictHandler.ts:110-122` `statesEqual`. Reshaped. The resolver
  (`:337-420`) is unchanged, and its correctness now rests on the stated
  assumption that rules 1 and 2 compare bodies and no stamp (section 7 pins it).
  Rule 1 is renamed from "version-only conflict" to "validator-only conflict" in
  the JSDoc (`:288`, `:341`).
- `src/testing.ts`, `src/index.ts`, `src/rxdb.ts`, `src/controller.ts`,
  `src/log.ts` -- no revision member. Unaffected.

Driver, `src/` (JSDoc and comments that describe revisions, all rewritten):
`pushWrites.ts` 10-11, 40-70, 86-93, 141-160, 192-195, 208-211, 255, 265-268,
278, 304, 321-322, 481-483; `wasReplication.ts` 26-47, 63; `changesQuery.ts` 7,
26, 36; `syncedDocSchema.ts` 6-17; `feedPrimaryPort.ts` 11-20 (its whole
rationale is "a raw `GET` would report `version: 0`", which becomes "a raw `GET`
carries no stamp members and no `writerId`"); `types.ts` 14-17, 106-107,
204-227, 257, 269-270, 307-312; `conflictHandler.ts` 93-96, 129, 289.

Driver, docs: ARCHITECTURE.md per section 2; README.md:28-29 ("drifted
revision", "acked revision" become "drifted validator", "acked validator");
CHANGELOG.md's unreleased `0.8.0 - TBD` entry, whose WS-7 bullet ("no longer
stamps a `version` or `metaVersion` of `0`") and WS-18 bullet ("reports
`version: 0` in the conflict entry") describe members this same release removes,
so both are rewritten under the breaking entry rather than left beside it;
`designs/WS-17-ack-carries-server-state.md` sections 4, 5, and 7 describe the
revision rules and are superseded by this doc where they conflict (a note is
added at its head); `decisions/0001` uses "stamp" and "`version: 0`" in
non-revision senses only and needs no change.

Driver, tests: `test/node/pushWrites.test.ts` (155 occurrences),
`conflictHandler.test.ts` (50), `replication.integration.test.ts` (24),
`changesQuery.test.ts` (19), `feedPrimaryPort.test.ts` (17),
`syncedDocSchema.test.ts` (6), `replicationAck.test.ts` (5),
`replicationCheckpoint.test.ts` (1), `types.test.ts` (`metaVersion: 3` at
`:74,83`, missed by the lowercase grep), and `test/browser/wasSync.spec.ts`
(`:27-30` fixtures carry `version`, `:56` asserts `winner.version === 2`, which
would read `undefined` and fail). `test/packaging/rxdbFreeRoot.test.ts:103`
reads the RxDB schema `version` and is unaffected.

Shared packages:

- was-client: already reshaped in the released 0.87.0 (section 1). The driver
  needs one more thing from it: a re-export of `ResourceMetaStamp` and
  `WriteStamp` from `./sync`, so the driver aliases the type rather than
  declaring one; that is the 0.87.1 patch release (section 8).
- storage-core: shipped in 0.28.0; `unaffected` beyond that release.
- was-teaching-server: ships the model under WAS-172 and the feed under WAS-182.
  Its ROADMAP WAS-172 `touches:` already names "was-sync: the apply comparison".
- was-conformance-suite: a "Parties to this contract" row the item's `touches:`
  omitted. `src/suites/encryption-descriptor-api.ts:497` asserts
  `typeof doc.metaVersion === 'number'` on a feed document and
  `collection-api.ts:751-753` asserts `metaVersion === undefined`; both fail
  against a WAS-172 server. The suite ships before the server, so the follow-up
  is filed there.
- wallet-attached-storage-spec: `spec.md` documents `version` / `metaVersion` at
  900, 932, 2223, 4967, 4999, 5041-5043, 5062 and the `(updatedAt, writerId)`
  tie-break at 3526-3530 and 5028-5031. The stamp text is WAS-96's spec work,
  not this item's; the entry is annotated with that item once filed.
- wallet-core: `src/sync/types.ts:76` (`SyncedResourceReplica.version`), `:110`
  (`ResolveConflict` local `version`), `:160` and `:174` (`markPushed` /
  `markDeletedPushed` take `version`); `src/sync/push.ts:73`, `:92`
  (`version: ack.version`), `:104`, `:161`, `:199`; `push.ts:85`, `:207` and
  `remint.ts:131-132` read `replica.version` as the "ever acked" signal. The
  compile breaks are the `ack.version` sites against was-client 0.87.0. The
  semantic break is worse and silent: `replica.version` is wallet-core's own
  column, so the reads keep compiling while nothing sets it, every update then
  goes out as `If-None-Match: *` and `412`s, and the remint re-mints every acked
  replica. The engine needs a durable acked flag of its own. `etag` presence is
  not that flag: a hidden-`ETag` deployment acks with no `etag`.
  `src/sync/index.ts:35` and `docs/architecture/sync-engine.md:114` mention
  `metaVersion`. The follow-up is wallet-core's.
- freewallet and was-react: each persists the replica schema
  (`src/stores/browserStore.ts`, `src/storage/localStore.ts`), so each forgets
  every existing replica on adoption and must forget the replication meta with
  it. Each also inserts rows with `version: 0` directly:
  `freewallet/src/stores/browserStore.ts:459` (and the `0`-placeholder prose at
  `:431`, `:6`), `freewallet/src/stores/connectionsStore.ts:222`,
  `was-react/src/storage/localStore.ts:720` (and `:8`). Those fail to compile
  against the new `SyncedDoc` and, where a validator wraps the storage, fail at
  runtime on `additionalProperties`. Comments and tests:
  `freewallet/src/stores/contactsConflictHandler.ts:28` (mis-describes
  `statesEqual`; its `deepEqual` `isEqual` at `:56` already compares every
  member and needs no code change), its test fixtures (`:31-39`, `:155-156`,
  `:182`), `browserStore.test.ts:290`, `:1375`, `wasRemoteStore.ts:376`,
  `:1462`; `was-react/test/node/schemaHash.test.ts:41-47` (a frozen copy of the
  pre-reshape schema, fails at adoption), `src/storage/syncController.ts:159`,
  `src/storage/wasRemoteStore.ts:95`, `:423`, and was-react's ARCHITECTURE.md.
  was-react is on was-sync `^0.5.1` and was-client `^0.74.0`, so it catches up
  two minors before taking this release.
- dcw: not a was-sync consumer (no `rxdb` or `@interop/was-sync` dependency). It
  drives wallet-core's engine over SQLite with its own
  `version INTEGER NOT NULL DEFAULT 0` / `metaVersion INTEGER` columns
  (`app/model/schema.ts:126-127`, `syncedDoc.ts`, `syncStore.ts`) and fake ports
  returning `{ version, etag }`, on was-client `^0.80.0`. Its work is a column
  change behind wallet-core's `SyncStore` seam, not a forgotten replica. The
  item's `touches:` wording is corrected.

## 4. Interaction matrix

Rows are the driver's flows. Columns are the states this design introduces: a
stamped feed and primary read; a local row with no server stamp (fresh, or the
tombstone entry); a local row that was stamped and then edited; and the ack as
was-client 0.87.0 defines it (`etag` only). A fifth column, an ack that also
carries the stamp, exists only if WS-17 adopts it (section 8) and is marked "if
WS-17".

| Flow                                                      | Stamped feed / primary                                                                                                                                                                                                                                                                                                                                                                       | Local row, no server stamp                                                                                                                                                            | Stamped row, edited locally                                                                                                                                | `etag`-only ack (was-client 0.87.0)                                                                                                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consumer inserts a fresh row                              | --                                                                                                                                                                                                                                                                                                                                                                                           | Changed in the consumer: the insert carries `id`, `updatedAt`, bodies, and no `version: 0`; the three insert sites in section 3 are rewritten                                         | --                                                                                                                                                         | --                                                                                                                                                                                                    |
| Create push (no assumed primary)                          | --                                                                                                                                                                                                                                                                                                                                                                                           | Fine: `isCreate` keys on the assumed primary being absent or a tombstone (`upstream.js:215-245` sets it `undefined` until a push, pull, or resolution recorded one), not on `version` | --                                                                                                                                                         | Fine: `etag` written back, stamp absent until the echo                                                                                                                                                |
| Update push                                               | Fine: `ifMatch` is the assumed `etag` today                                                                                                                                                                                                                                                                                                                                                  | --                                                                                                                                                                                    | Fine: the edit's `updatedAt` moves, the stale counter and origin ride along unread; `ifMatch` is still the `etag`                                          | Fine: `etag` written back                                                                                                                                                                             |
| Meta-only push, assumed primary has `meta` and `metaEtag` | Fine: `If-Match: <metaEtag>`                                                                                                                                                                                                                                                                                                                                                                 | --                                                                                                                                                                                    | Fine                                                                                                                                                       | Fine: `metaEtag` written back                                                                                                                                                                         |
| Meta-only push, assumed primary has `metaEtag`, no `meta` | --                                                                                                                                                                                                                                                                                                                                                                                           | --                                                                                                                                                                                    | --                                                                                                                                                         | Changed, and the review's key finding: this is the normal state after this replica's own `/meta` write and before its echo. Routing keys on `meta` or `metaEtag`, so it sends `If-Match`, as today    |
| Meta-only push, assumed primary has `meta`, no `metaEtag` | Fine: unconditional `PUT`, the hidden-`ETag` case, as `metaVersion` present with `metaEtag` absent does today                                                                                                                                                                                                                                                                                | --                                                                                                                                                                                    | --                                                                                                                                                         | --                                                                                                                                                                                                    |
| Meta-only push, assumed primary has neither               | Fine: `If-None-Match: *`                                                                                                                                                                                                                                                                                                                                                                     | Fine: a row whose `/meta` was never written                                                                                                                                           | --                                                                                                                                                         | Changed on a hidden-`ETag` deployment only: after its own first `/meta` write the row has neither, so the next edit `412`s once and the conflict entry brings `meta` down; same as 0.86.0 today       |
| Meta-only push, assumed primary is a tombstone            | Changed: an explicit tombstone guard sends `If-None-Match: *` whatever `meta` / `metaEtag` the tombstone carries (section 8 confirms whether a WAS-182 tombstone carries `meta` at all)                                                                                                                                                                                                      | Fine: the driver's own tombstone entry carries neither                                                                                                                                | --                                                                                                                                                         | --                                                                                                                                                                                                    |
| Meta-only push and the top-level `updatedAt`              | Open (section 8): under WAS-96 the content record's `updatedAt` is the content stamp, so a `/meta`-only write may leave it unchanged, and the echo would then carry the pre-edit `updatedAt`                                                                                                                                                                                                 | --                                                                                                                                                                                    | Changed if confirmed: the app's bumped `updatedAt` is replaced by the older content `updatedAt` on the echo, and a consumer sorting by it reorders the row | --                                                                                                                                                                                                    |
| Delete push                                               | Fine: conditions on `etag`; the tombstone's absent-representation rule is unchanged                                                                                                                                                                                                                                                                                                          | Fine: the no-assumed-primary skip is unchanged                                                                                                                                        | Fine                                                                                                                                                       | Fine: nothing written back for a tombstone                                                                                                                                                            |
| Benign-412 delete retry                                   | Fine: body equality plus `writerId`, re-issued against the re-read `etag`; the log entry names `etag`s                                                                                                                                                                                                                                                                                       | --                                                                                                                                                                                    | --                                                                                                                                                         | --                                                                                                                                                                                                    |
| Content `412`, live primary                               | Changed: the conflict entry carries the primary's stamp members and `meta` verbatim, no `version`                                                                                                                                                                                                                                                                                            | --                                                                                                                                                                                    | --                                                                                                                                                         | --                                                                                                                                                                                                    |
| Content `412`, re-read resolves `null`                    | --                                                                                                                                                                                                                                                                                                                                                                                           | Changed: the tombstone entry is `{ id, updatedAt: <local>, _deleted: true }`, no other stamp member, no `etag`; the next write goes `If-None-Match: *` as today                       | --                                                                                                                                                         | --                                                                                                                                                                                                    |
| `/meta` `412` or `404` after an accepted content write    | Changed: the conflict entry carries the fresh primary (stamp, `meta`, validators) and is the sole carrier RxDB records as the assumed primary                                                                                                                                                                                                                                                | --                                                                                                                                                                                    | --                                                                                                                                                         | Unchanged by this item: the earned `etag` is still returned in the ack and written back as today; WS-17 stops that write-back for conflict rows (its one pre-existing-defect fix), and WS-23 does not |
| Re-read after an accepted write in the same batch         | Changed: the memo bypass is keyed on a "wrote this batch" flag instead of `hasAck`, so a hidden-`ETag` content write (no validator, so `hasAck` false) still re-reads fresh                                                                                                                                                                                                                  | --                                                                                                                                                                                    | --                                                                                                                                                         | --                                                                                                                                                                                                    |
| Pull of a foreign change                                  | Changed: `wireDocToRxDoc` maps the stamp members and `meta`; `kind` and `deleted` are WS-24's                                                                                                                                                                                                                                                                                                | --                                                                                                                                                                                    | Fine: RxDB defers the pulled state behind a pending local change as today                                                                                  | --                                                                                                                                                                                                    |
| Pull of this replica's echo                               | Changed: `statesEqual` compares the stamp members, so the echo differs from the acked row in `updatedAtCounter`, `originId`, `meta`, server `updatedAt`, `createdBy`, and is written                                                                                                                                                                                                         | --                                                                                                                                                                                    | Fine: the echo of the edit brings a fresh triple, replacing the hybrid                                                                                     | Fine: the echo is the only source of the stamp, as it is of `createdBy` today                                                                                                                         |
| Echo pulled inside the write-back window                  | Unchanged: dropped, as WS-17 describes; the row keeps its validators and no stamp until the next feed change, where today it keeps a stale `version`                                                                                                                                                                                                                                         | --                                                                                                                                                                                    | Changed: a hybrid triple persists until the next feed change                                                                                               | Changed: the residual the window costs now includes the stamp members                                                                                                                                 |
| Feed primary read (`withFeedPrimaryRead`)                 | Changed: `toPrimaryState` maps the stamp and `meta`; the memo and the walk are unchanged                                                                                                                                                                                                                                                                                                     | --                                                                                                                                                                                    | --                                                                                                                                                         | --                                                                                                                                                                                                    |
| Ack write-back                                            | --                                                                                                                                                                                                                                                                                                                                                                                           | --                                                                                                                                                                                    | Fine: validators patch on the latest row as today                                                                                                          | Changed: `isRevision` and the `0` skip go; `etag` / `metaEtag` are the only members patched                                                                                                           |
| Resolver rule 1 (validator-only conflict)                 | Fine: compares `_deleted`, `data`, `custom`; a `412` whose primary differs only in stamp members or `meta` resolves `local` as today                                                                                                                                                                                                                                                         | Fine                                                                                                                                                                                  | Fine: `local` returns the hybrid row, which the echo then replaces                                                                                         | --                                                                                                                                                                                                    |
| Resolver rule 2 (metadata conflict)                       | Fine: compares bodies                                                                                                                                                                                                                                                                                                                                                                        | Fine                                                                                                                                                                                  | Fine                                                                                                                                                       | --                                                                                                                                                                                                    |
| Resolver rules 3 to 6                                     | Fine: read the payload's `updatedAt` / `writerId` out of the decrypted body, not the write stamp; WS-26 records why                                                                                                                                                                                                                                                                          | Fine                                                                                                                                                                                  | Fine                                                                                                                                                       | --                                                                                                                                                                                                    |
| Injected resolver (freewallet's contacts comparator)      | Fine: receives the same three states with stamp members in place of revisions; `contactsConflictHandler.ts` reads no `version`, only its tests do                                                                                                                                                                                                                                            | --                                                                                                                                                                                    | Changed in obligation: a resolver that read the triple as an order key would read a hybrid; none does today                                                | --                                                                                                                                                                                                    |
| Injected `isEqual` (freewallet's `deepEqual`)             | Fine: already compares every member                                                                                                                                                                                                                                                                                                                                                          | --                                                                                                                                                                                    | --                                                                                                                                                         | --                                                                                                                                                                                                    |
| Malformed stamp from the server                           | Changed in what is stored: no validator runs in this package or its consumers, so an oversize `originId`, a non-integer counter, or a `meta` with a missing or extra member is stored verbatim and compared strictly, the same trust `etag` and `createdBy` get today; a consumer that adds a validator wrapper wedges the pull on such a document, as it would on an over-long `etag` today | --                                                                                                                                                                                    | --                                                                                                                                                         | --                                                                                                                                                                                                    |
| Checkpoint stacking                                       | Fine: the opaque string is untouched by WAS-96 (its decision 3)                                                                                                                                                                                                                                                                                                                              | --                                                                                                                                                                                    | --                                                                                                                                                         | --                                                                                                                                                                                                    |
| Controller lifecycle                                      | Fine: no revision read                                                                                                                                                                                                                                                                                                                                                                       | --                                                                                                                                                                                    | --                                                                                                                                                         | --                                                                                                                                                                                                    |
| Existing replica on a consumer device                     | Refused by RxDB at `addCollections` (schema hash mismatch at `version: 0`); the consumer forgets the collection and its `rx-replication-meta-*` instance and re-pulls; unpushed local writes are lost (invariant 7)                                                                                                                                                                          | --                                                                                                                                                                                    | --                                                                                                                                                         | --                                                                                                                                                                                                    |
| WS-21 (hidden `ETag`, unconditional next `PUT`)           | Unchanged: the row has no `etag` and no stamp, which changes nothing about the next write                                                                                                                                                                                                                                                                                                    | --                                                                                                                                                                                    | --                                                                                                                                                         | --                                                                                                                                                                                                    |
| WS-22 (local delete during a create's push)               | Unchanged: the header-less `DELETE` question is about `etag`                                                                                                                                                                                                                                                                                                                                 | --                                                                                                                                                                                    | --                                                                                                                                                         | --                                                                                                                                                                                                    |
| WS-25 (`writerId` on `/meta`)                             | Fine: the `/meta` write's attribution spread is untouched here                                                                                                                                                                                                                                                                                                                               | --                                                                                                                                                                                    | --                                                                                                                                                         | --                                                                                                                                                                                                    |
| wallet-core engine on the same server                     | Changed in wallet-core (section 3): compile breaks at the `ack.version` sites, and a silent never-acked state at the `replica.version` reads; the two drivers still converge on the same server state                                                                                                                                                                                        | --                                                                                                                                                                                    | --                                                                                                                                                         | --                                                                                                                                                                                                    |
| Conformance suite against a WAS-172 server                | Refused until its `metaVersion` assertions are rewritten (section 3); the suite ships first                                                                                                                                                                                                                                                                                                  | --                                                                                                                                                                                    | --                                                                                                                                                         | --                                                                                                                                                                                                    |

## 5. Design

Types (`src/types.ts`). `SyncedDoc` drops `version` and `metaVersion` and gains
`updatedAtCounter?: number`, `originId?: string`, and
`meta?: ResourceMetaStamp`, the type storage-core declares and was-client
re-exports from `./sync` (asked for as an in-house change; no local
declaration). `OptionalBodyFields` drops `metaVersion` and gains the same three,
so `copyOptionalBodyFields` carries them across every mapping as it carries
`etag` today, `meta` by reference. `updatedAt` stays a required top-level
member: a fresh local row needs a wall-clock value for the index, and the
server's `updatedAt` replaces it on the echo. `PrimaryState` keeps extending
was-client's `MasterState`, where the three members are optional; on `WireDoc`
the two top-level members are required (every feed document is stamped), and
`meta` is optional.

The stamp on a local row is the last server state the row learned, not a
description of the local edit. An app edit moves `updatedAt` and leaves
`updatedAtCounter` and `originId` where they were, so an edited row holds a
triple no server minted until its echo arrives. The driver reads the two members
nowhere (routing keys on `etag` and the assumed primary; the resolver reads
bodies and the payload), so the hybrid is harmless to it, and the Glossary says
so. A consumer must not read the triple off a local row as an order key.

Schema (`src/syncedDocSchema.ts`). `version` and `metaVersion` are deleted.
`updatedAtCounter: { type: 'integer', minimum: 0 }` and
`originId: { type: 'string', maxLength: 64 }` are added at the top level. `meta`
is added as a nested object with `updatedAt` (string, 64), `updatedAtCounter`
(integer, minimum 0), `originId` (string, 64), and `generation` (string, 64),
all four `required`. `required` at the top becomes `['id', 'updatedAt']`. The
`updatedAt` index stays. The RxDB schema `version` stays `0`. The module header
says plainly that the schema is documentation unless a consumer registers a
validator: this package registers none, its tests run on bare memory storage,
and neither freewallet nor was-react registers one.

Untrusted stamp. The driver stores what the server sends, with no boundary guard
on length, type, or `meta` completeness, the same trust `etag`, `createdBy`, and
`epoch` get today. A guard was considered (section 6). A consumer that wraps its
storage in a validator takes on the consequence that a malformed server document
wedges the pull, as an over-long `etag` would today; the README note on
validators says so.

Pull mapping (`src/changesQuery.ts`) and feed primary read
(`src/feedPrimaryPort.ts`). `wireDocToRxDoc` and `toPrimaryState` stop mapping
`version`; the stamp members and `meta` arrive through `copyOptionalBodyFields`.
`toPrimaryState` keeps carrying `writerId` explicitly. The `kind` filter and the
`deleted` rename land in the same two functions under WS-24, which ships first.
One constraint on that filter is recorded here because WS-23 inherits the
functions: RxDB drops a page whose `documents` array is empty before it persists
the checkpoint (`downstream.js:114`), and stops early on an under-full page
(`:125`), so a pull handler that filters a page down to zero resource documents
and returns the server's next checkpoint would re-fetch the same page on every
poll and never get past a burst of non-resource writes. The handler has to keep
following the server checkpoint internally until it holds at least one resource
document or the feed ends. WS-24's acceptance box is amended to say so.

Push handler (`src/pushWrites.ts`). `PushWriteAck` drops `version` and
`metaVersion` and is `{ id, etag?, metaEtag? }`. `hasAck` becomes
`etag !== undefined || metaEtag !== undefined`, the rule the Glossary's Ack
entry already states for an opaque validator. The memo bypass in `readPrimary`
stops reading `hasAck`: a local `wroteThisBatch` flag is set after each accepted
content write, `/meta` write, or delete, and the bypass keys on it, so a
hidden-`ETag` write (accepted, no validator) still gets a fresh re-read on a
later `412` in the same row. `primaryOrTombstone` builds the tombstone entry as
`{ id, updatedAt: fallbackUpdatedAt, _deleted: true }` and the live entry as
`{ id, updatedAt: primary.updatedAt, _deleted: primary.deleted ?? false }` plus
the optional members. The `/meta` create-or-update choice becomes: a tombstone
assumed primary sends `If-None-Match: *` (the new explicit guard); otherwise an
assumed primary with `meta` or `metaEtag` is an update, sent with
`If-Match: <metaEtag>` when `metaEtag` is present and unconditionally when it is
not (the hidden-`ETag` case); otherwise a create with `If-None-Match: *`. The
`metaEtag` half of the key is what keeps the post-ack, pre-echo state (a `204`
ack brings `metaEtag` and no `meta`) on the `If-Match` path it takes today. The
three `ack.version = ...` lines go. The two `debug` entries carry `assumedEtag`
and `etag`.

Ack write-back (`src/wasReplication.ts`). `isRevision` and its two branches are
deleted. `etag` and `metaEtag` are patched as today, and nothing else: with
was-client 0.87.0's ack the stamp reaches the row from the echo or a conflict
entry only. WS-17 (decided 2026-10-03, its option a) puts the full stamp in the
write response body, and was-client's ack grows to carry it, so once WS-17 lands
the write-back stamps it too. The rule is fixed here so the two designs agree:
the content ack alone supplies the top-level triple, patched as a unit or not at
all; the `/meta` ack alone supplies `meta`, patched whole or not at all; the two
are not mixed, and no member is patched without a validator in the same ack.

Default equality (`src/conflictHandler.ts`). `statesEqual` compares
`updatedAtCounter` and `originId` strictly in place of `version` and
`metaVersion`, and compares `meta` with `bodiesEqual` (canonical JSON), so a
member the server adds later still registers as a difference and two
member-equal objects compare equal. The header comment is rewritten for the
etag-only ack (section 2, invariant 18).

Docs. ARCHITECTURE.md per section 2. README: the two "revision" phrases and a
validator note. CHANGELOG: one breaking entry in the open `0.8.0 - TBD` version,
absorbing the WS-7 and WS-18 bullets, saying every existing replica is forgotten
and re-pulled together with its replication meta, that unpushed local writes at
the moment of the update are lost, naming the member changes, and naming the
was-client floor. `designs/WS-17-ack-carries-server-state.md` gets a head note
pointing here for the revision rules it describes.

Stored-shape and wire-adjacent decisions (each signed off individually by the
user on 2026-10-03, taking the recommendation as stated; doc approval is
separate):

1. The replica schema stores the stamp under the wire names `updatedAtCounter`,
   `originId`, and `meta`, with `meta` nested and carrying all four of WAS-96's
   members including `generation`. Recommended: verbatim, so the conflict entry,
   the echo, and the stored row are byte-equal and `copyOptionalBodyFields`
   needs no per-member mapping. Storing `originId` and `generation` discloses
   nothing new to a local reader: both are segments of the `etag` and `metaEtag`
   the row already holds.
2. `required: ['id', 'updatedAt']`; `updatedAtCounter`, `originId`, and `meta`
   optional, with absence meaning "no server stamp known" where `0` meant "no
   known revision". Recommended as stated.
3. Counters are `type: 'integer', minimum: 0`, matching the server's shape-check
   (safe non-negative integers). `maxLength`s: `originId` 64 (the server's
   charset is `[A-Za-z0-9_-]{1,64}`), `meta.updatedAt` 64, `meta.generation` 64
   (the server mints eight random bytes base58-encoded, about eleven characters,
   `src/lib/etag.ts` `newGeneration`; 64 matches `originId` and leaves a wide
   margin). The existing `etag` / `metaEtag` `maxLength` 256 holds the
   four-segment validator: eleven of generation, 13 digits of `ms`, 16 of
   counter, 64 of origin, three dots, two quotes is 109 at worst (section 8).
   The bounds describe the server and are not enforced here; a longer server
   mint would need a matching schema edit that no test catches.
4. The `/meta` create-or-update choice keys on the assumed primary not being a
   tombstone and carrying `meta` or `metaEtag`. Recommended over `meta` alone
   (misroutes the post-ack, pre-echo state as a create) and over `metaEtag`
   alone (misroutes the hidden-`ETag` state).
5. The tombstone conflict entry carries no stamp member other than the local
   `updatedAt`. Recommended; the entry describes a state the driver could not
   read.
6. `meta` is compared canonically (`bodiesEqual`), not member-wise. Recommended;
   see the design paragraph.
7. No boundary guard on the stamp. Recommended; see "Untrusted stamp".

## 6. Alternatives rejected

- Flatten `meta` into `metaUpdatedAt` / `metaUpdatedAtCounter` / `metaOriginId`
  / `metaGeneration` top-level members. Rejected: every mapping would need a
  per-member translation in both directions, the echo would no longer be
  byte-equal to the stored row, and WAS-96 settled the nested shape on the
  change document, the sidecar, and the served `/meta` object. Recorded as
  do-not-reopen in decisions/0002; revisit if RxDB's schema handling or an index
  need forces a flat member.
- Store `meta` stripped of `generation`. Rejected: the driver never reads
  `generation`, but stripping it makes the stored `meta` differ from the wire
  `meta`, and a canonical comparison in `statesEqual` is the point of storing
  the stamp.
- Keep `version` as a locally derived counter. Rejected: no site in the driver
  needs an integer revision once `etag` carries the validator, and a derived
  counter is a second notion of order beside the stamp.
- Bump the RxDB schema `version` to `1` with a migration strategy. Rejected:
  invariant 7 states the no-migration posture, the stored stamp members cannot
  be derived from a revision, and the consumers re-pull on a schema change
  already. Not do-not-reopen; a consumer with a replica too large to re-pull
  could revisit.
- Change the default resolver to order by `(ms, counter, originId)`. Rejected
  here and recorded under WS-26: the local side of a conflict never holds a
  server stamp for its own edit, so the only comparable pair is the payload's
  `(updatedAt, writerId)`, which is the case the spec's revised tie-break keeps.
- Drop the `updatedAt` index while the schema is being reshaped anyway.
  Rejected: freewallet sorts by it (`browserStore.ts:586`), and an index change
  is a consumer decision outside WAS-96's scope.
- Make `updatedAtCounter` required with a `0` sentinel on fresh rows. Rejected:
  it reintroduces the sentinel this item removes, and a counter of `0` is a
  valid stamp under an HLC (the first write in a millisecond).
- Validate the stamp at the pull boundary (drop a malformed triple or `meta`,
  skip over-long members as WS-17's write-back does). Rejected for this item:
  the driver trusts the server for `etag`, `createdBy`, and `epoch` verbatim
  today, a guard that drops a member silently would leave a row that never
  compares equal to its echo, and a guard that refuses the document would wedge
  the pull as a validator does. Revisit if a consumer registers a validator
  wrapper and meets a malformed document in practice.
- Key the `/meta` routing on `meta` alone or `metaEtag` alone. Rejected for the
  two misroutes decision 4 names.
- Clear `updatedAtCounter` / `originId` when the app edits a row, so no hybrid
  triple exists. Rejected: the driver has no hook on an app edit (RxDB writes go
  straight to the collection), and the hybrid is unread by the driver. Recorded
  instead as the Glossary rule that a local row's triple is advisory.

## 7. Test plan

- `test/node/syncedDocSchema.test.ts`: no `version` or `metaVersion` property;
  `required` is `['id', 'updatedAt']`; `meta` is an object with the four
  required members and the stated types and `maxLength`s; counters are `integer`
  with `minimum: 0`; the RxDB schema `version` is `0`.
- `test/node/types.test.ts`: `copyOptionalBodyFields` carries
  `updatedAtCounter: 0`, `originId`, and `meta` across, and omits each when
  absent (the `metaVersion: 3` cases are rewritten).
- `test/node/changesQuery.test.ts` and `test/node/feedPrimaryPort.test.ts`: a
  stamped wire document maps `updatedAtCounter` (including `0`), `originId`, and
  `meta` verbatim; a document without `meta` maps no `meta`; no `version` on the
  result; `toPrimaryState` still carries `writerId`.
- `test/node/pushWrites.test.ts`: `hasAck` reports an ack on `etag` or
  `metaEtag` alone and none otherwise; the tombstone conflict entry carries only
  `id`, `updatedAt`, `_deleted`; the live conflict entry carries the primary's
  stamp and `meta`; the `/meta` routing across the five assumed states (neither,
  `metaEtag` only, `meta` only, both, tombstone with both) sends
  `If-None-Match: *`, `If-Match`, unconditional, `If-Match`, `If-None-Match: *`;
  a hidden-`ETag` content write followed by a `/meta` `412` re-reads fresh (memo
  bypassed) although `hasAck` is false; the delete retry still fires on equal
  bodies and matching `writerId`; the `debug` entries carry `etag`s.
- `test/node/replicationAck.test.ts`: the write-back patches `etag` and
  `metaEtag` through a real RxDB collection and nothing else; an ack with no
  validator patches nothing; the revision-`0` cases are deleted with the member.
- `test/node/conflictHandler.test.ts`: `statesEqual` differs on each of
  `updatedAtCounter`, `originId`, and each `meta` member, is equal for two rows
  whose `meta` objects are distinct but member-equal, differs on a `meta`
  carrying an extra member, and treats `updatedAtCounter: 0` as present; rule 1
  resolves `local` for a real primary that differs from the assumed one only in
  stamp members or `meta` (the acceptance box's "rule 1 and rule 2 compare
  bodies, not stamps"); rule 2 resolves `remote` on a `custom` change whatever
  the stamps say; a `local` win returns the edited row with its stale triple.
- `test/node/replication.integration.test.ts`: against the registry server
  release that ships WAS-172 and WAS-182, a created row ends with the server's
  `updatedAtCounter` and `originId` after the echo, and no `meta` until a
  `/meta` write; a `/meta` write lands the nested `meta`; a `custom` edit made
  after the `/meta` ack and before the echo is pushed with `If-Match` and no
  `412`; a validator-only `412` (another replica re-writes an equal body)
  resolves `local` and re-pushes against the fresh `etag`; a resurrection over a
  feed tombstone sends the `/meta` half as `If-None-Match: *`; the `/meta`-only
  write's effect on the top-level `updatedAt` is asserted whichever way section
  8 settles it; the existing conflict, tombstone, and benign-412 cases stay
  green with their `version` assertions rewritten. The suite also uses `version`
  as a synchronization barrier, and each barrier is rewritten by purpose, not
  mechanically: the "write-back landed" wait (`:341`) keys on `etag` presence,
  since the ack is etag-only; the "echo landed" waits (`:548`, `:639`) key on
  `updatedAtCounter` and `originId` being defined and equal to the primary's,
  since the echo is the stamp's only source; the recreate-over-tombstone
  discriminators (`:941-956`) compare `etag`s or the counter-and-origin pair,
  since no integer orders them. The "validators carry no revision" case
  (`:964-990`), whose wrapper strips `version` / `metaVersion` off the primary,
  would pass vacuously and is reframed to strip `updatedAtCounter`, `originId`,
  and `meta` (the hidden-stamp primary).
- `test/browser/wasSync.spec.ts`: fixtures drop `version`; the winner
  discriminator becomes the payload's `updatedAt` (or `etag`), so the smoke
  still proves the resolver ran.
- `test/packaging/`: stays green; no root-graph change beyond a type import.

## 8. Open questions

Resolved on 2026-10-03, after the review pass:

- WS-17 and the ack's shape: option (a). The write response body carries the
  full stamp, was-client's `WriteAck` grows again, and this item's third
  acceptance box is deferred to WS-17 rather than reworded. Recorded in WS-17's
  roadmap item and its design doc section 8.
- A `/meta`-only write and the top-level `updatedAt`: the stamp model's answer
  is taken. The top-level `updatedAt` is the content record's stamp and a
  metadata write leaves it unchanged, or the content validator would move on a
  write that touched no content. WAS-96's decided open point 2 (two stamp sets,
  the content record's `updatedAt` top-level) implies this but does not state
  it, so WAS-96 needs the sentence added. Consumers that sort rows by the
  top-level `updatedAt` (freewallet, `browserStore.ts:586`) sort by the
  payload's own `updatedAt` instead; a follow-up is filed from the `touches:`
  entry.
- A tombstone carries no `meta`: WAS-96 invariant 3 says the `/meta` object is
  its own record, dropped by a soft delete, and a replicated tombstone drops it
  too. The routing guard stays as belt and braces. A tombstone keeps `writerId`
  as the deleting request's label (storage-core 0.28.0's `ChangeDocument`
  JSDoc), so invariant 17's "upheld" holds.

Resolved on 2026-10-03, in the approval walkthrough:

- `meta` is present on a feed document only once metadata has been written.
  Confirmed in the contract the server implements against: storage-core 0.28.0's
  `ChangeDocument` documents `meta` as present "once metadata has been written"
  and `metaEtag` as "absent until metadata has been written", and WAS-96
  invariant 3 makes the `/meta` object a record of its own, created by the first
  metadata write. The `If-None-Match: *` create path rests on it. Verified at
  integration against the WAS-182 release: the test plan's "a `/meta` write
  lands the nested `meta`" case gains its negative, a freshly created row that,
  after its echo, carries `updatedAtCounter` and `originId` and no `meta`. No
  driver-side defense (an empty `meta` read as absent); that would be the
  boundary guard decision 7 rejects and would mask a server contract violation.
- `meta.generation` length. The server mints eight random bytes base58-encoded,
  about eleven characters (`src/lib/etag.ts` `newGeneration`), and WAS-96 keeps
  the mint under WAS-172. The four-segment validator is at worst 109 characters
  (11 generation, 13 `ms`, 16 counter, 64 origin, five of punctuation), so
  `etag` / `metaEtag` stay at `maxLength` 256. `meta.generation` is tightened
  from 256 to 64, matching `originId` (decision 3 amended). The bound rests on
  the server keeping the eight-byte mint and no validator runs to catch a
  change, which the schema's module header says.
- The was-client re-export. Still missing in 0.87.0: the `./sync` type export
  list (`src/sync/index.ts:97-107`) carries `MasterState` and `WriteAck` but
  neither stamp type, although `MasterState.meta` already references
  `ResourceMetaStamp`. Both `ResourceMetaStamp` and `WriteStamp` are re-exported
  in a was-client patch release (0.87.1), the second so the write-back's unit
  rule and WS-17's grown ack can name the top-level triple without a further
  release. The driver's was-client floor is 0.87.1, and the release is the first
  implementation step rather than a design question. Not
  `NonNullable<MasterState['meta']>`: it names the type by where it appears, and
  breaks when `MasterState` reshapes.

Still open, as a consumer follow-up and not blocking this doc:

- How freewallet and was-react forget a replica together with its
  `rx-replication-meta-*` instance. Neither consumer touches
  `replicationIdentifier` or `removeCollectionStorages` today. Two mechanisms:
  remove both storages explicitly, or change the `replicationIdentifier`, for
  which the controller already exposes a per-collection hook
  (`src/controller.ts:201`), orphaning the old meta instance. Owner: each
  consumer's follow-up; this doc states the requirement only. A driver-side
  default that folds a schema generation into the identifier was considered and
  set aside: it changes an identifier every consumer's storage holds and is its
  own roadmap item with its own short design, not a rider on this one.
