# WS-17: The ack carries the server state (design)

- item: WS-17
- status: reviewed
- approved:
- wire-level decisions contained: listed in section 5 (the write response status
  and body, and the fresh-provenance rule for a resurrection), signed off by the
  user on 2026-10-02; the body shape and the statuses were revised the same day
  after the review pass, and the resurrection rule was added 2026-10-03 after
  the completeness pass
- decision records extracted: none yet (candidates listed in section 6)

## 1. Problem and scope

After this replica pushes a row, the server's echo of that write comes back down
the `changes` feed. RxDB drops a pulled state for a row whose local state
differs from its assumed primary, or that has no assumed primary at all
(`node_modules/rxdb/dist/esm/replication-protocol/downstream.js:207-218`, RxDB
17.5.0), and the pull checkpoint still advances past it. The roadmap item placed
that window at the ack write-back. It is wider. A locally created row has no
assumed primary from its insert until the upstream writes the replication meta
after the push handler returns, and the write-back then re-opens it until the
cycle it triggers has run. An echo pulled anywhere in that span, the push's own
HTTP round trip included, is dropped and is not pulled again. The row then keeps
the client's `updatedAt` and never learns its `createdBy`, however `isEqual` is
written. The write response carries only an `ETag` header today (a `204` with no
body), so the ack cannot supply those two members either.

The fix makes the echo unnecessary for this replica's own writes. The write
response carries the server-managed members of the resource, was-client's
`WriteAck` carries `updatedAt` and `createdBy`, and the existing ack write-back
stamps them into the local row alongside the validators it already stamps. A
dropped echo then costs nothing: the row already holds everything the echo would
bring. The window itself is not closed; it stays harmless.

The first draft of this design delivered the acked state through RxDB's conflict
array instead. The review pass found that path unsound (section 6), and the
design returned to the write-back.

Out of scope: the `DELETE` response (unchanged, the driver pushes nothing
further for a tombstone); the `POST` create, chunk `PUT`, Collection `meta/log`
`PUT`, Space `PUT`, and Collection `PUT` responses (unchanged); the non-sync
`Resource.put` return value in was-client; wallet-core's engine adopting the new
ack members (a follow-up there); the last-write-wins rule, the conflict handler,
the feed-walk primary read, the key epoch stamp, and the `writerId` label, all
of which are unchanged. Four pre-existing gaps the review surfaced are filed as
their own items (WS-19, WS-20, WS-21, WS-22) rather than absorbed here. One
pre-existing defect on the ack path is fixed here, since the write-back is the
code under change: a row that earned an ack and a conflict entry in the same
push had its write-back collide with RxDB's conflict fork write (section 5).

## 2. Invariant inventory

Numbers are ARCHITECTURE.md's.

- 1, bodies are opaque. Upheld. The write-back stamps server-managed members and
  reads neither body.
- 2, the driver mints no ids; a resolved row keeps the `createdBy` the server
  recorded. Changed in how the row learns `createdBy`: from the ack on an
  accepted create as well as from the echo. The invariant text gains that
  sentence.
- 4, the benign 412 delete retry. Unchanged. The write-back stays best-effort
  and swallows its own failure, so the retry remains the authority for deletes.
  No text edit.
- 5, errors match by `err.name`. Upheld; no new error class or predicate.
- 6, JCS-canonical body equality. Upheld; not touched.
- 13, diagnostics ride the logging seam. Upheld; the write-back's `warn` on
  failure stays the one swallow point it names.
- 14, the root entry never reaches `rxdb`. Upheld; every change is under
  `./rxdb` or in the structurally typed `PushWriteAck`.
- 16, an integrity failure fails the cycle. Upheld; the conflict handler is not
  touched.
- 17, pushes declare the injected writer id or none. Upheld; the push itself is
  unchanged.
- 18, the default `isEqual` compares every member. Changed in its rationale, and
  its WS-17 paragraph is rewritten rather than deleted. The echo stops being the
  only way `createdBy` and the server's `updatedAt` reach the row. The window
  stays, and the paragraph says so: an echo pulled inside it is still dropped,
  and that is harmless whenever the ack carried the members. Three residuals
  keep the echo load-bearing: a server answering `204` with no body, a hidden
  `ETag` (the validators arrive only through the echo, WS-21, and the write-back
  then stamps nothing at all, so that deployment gets no new window from this
  design), and a write-back failure that was swallowed. The full-member
  comparison stays: after the write-back the echo differs from the row only in
  what the ack did not carry (a `metaVersion` / `metaEtag` the content write did
  not return, say), or in an `updatedAt` another writer moved on, and RxDB
  writes it only where `isEqual` says it differs.

Text sites that change, beyond the two invariants: the Glossary `Ack` entry (the
ack carries `updatedAt` and `createdBy` when the server answers with a body) and
`Echo` entry ("the only way" goes); `src/conflictHandler.ts:89-98`
(`statesEqual` JSDoc, the echo "differs only in what the server alone assigns");
`src/types.ts:247-251` (`SyncedDoc.createdBy`, "the push side never writes it");
`src/types.ts:306-314` (the `WriteAck` alias JSDoc, "the new revision number
plus the opaque `etag`"); `src/syncedDocSchema.ts:11-12` (`createdBy` "carried
down from the `changes` feed"); `src/wasReplication.ts` (the
`createAckWriteBack` JSDoc, "touches the revision/etag fields", and the comment
at `:84-85`); `src/pushWrites.ts:93-95` (the header's "never `data` /
`updatedAt`" no longer holds), `:139-146` (the `PushWriteAck` JSDoc, "absent
fields mean ... no `ETag`"), `:207-211` (the `pushRow` JSDoc, "`ack: null` when
no response carried a revision"), and `:481-484` (the `createPushHandler` JSDoc
gains the no-conflict-entry condition); the
`test/node/replication.integration.test.ts` comments at `:534-541`, `:963-969`,
`:1112-1127`, and `:1192-1194` that cite the WS-17 wait; `README.md:28-29` (the
write-back sentence gains the two members). Downstream, freewallet
`src/stores/contactsConflictHandler.ts:27-32` justifies its `deepEqual` by the
echo and is listed for a follow-up there. The CHANGELOG `0.8.0 - TBD` entry for
WS-7 stays accurate: the write-back it describes remains. Sites that describe
the write-back itself (`ARCHITECTURE.md:37-39`, `:207-210`, `src/rxdb.ts:6-7`,
`src/pushWrites.ts:85-92`) stay valid.

## 3. Consumer enumeration

Produced by a grep of `onWriteAccepted`, `PushWriteAck`, `createPushHandler`,
`createWasReplication`, `makeConflictHandler`, `makeLwwConflictHandler`,
`statesEqual`, `isEqual`, and `@interop/was-sync` across was-sync, was-react,
freewallet, dcw, and wallet-core (excluding `node_modules`), plus the export
lists of `src/index.ts` and `src/rxdb.ts`, a grep of `WriteAck` / `putMeta` /
`putContent` in wallet-core's and was-client's `src/`, and a walk of the WAS
spec's "Parties to this contract" table (wallet-attached-storage-spec
`AGENTS.md:101-115`) and the encrypted-collections spec's table.

In this package:

- `src/pushWrites.ts` -- `PushWriteAck` gains `updatedAt?` / `createdBy?` and
  `pushedUpdatedAt`; `pushRow` fills them from the port acks and the pushed row;
  `hasAck` is unchanged (the two members do not make an ack on their own);
  `createPushHandler` calls `onWriteAccepted` only for a row that returned no
  conflict entry.
- `src/wasReplication.ts` -- `createAckWriteBack` stamps the two members under
  the validator, still-pushed-state, and length conditions of section 5.
- `src/rxdb.ts` -- the `PushWriteAck` export is widened, not removed (additive).
- `test/node/pushWrites.test.ts` -- the fourteen `onWriteAccepted` cases keep
  their shape; new cases cover the two members.
- `test/node/replicationAck.test.ts` -- gains the two-member stamping.
- `test/node/replication.integration.test.ts` -- two cases drop their
  `awaitInSync` wait before nudging a pull; a forced-window case is added.
- `package.json` -- the was-client devDependency moves to the widening release
  and the peer floor rises to it; the was-teaching-server devDependency returns
  to a registry version (it is `link:../was-teaching-server` today).

Downstream of this package:

- was-react `test/node/conditionalWrites.test.ts:195` -- calls
  `createPushHandler` with a callback and reads `acks[0]`; the callback stays
  and the array's meaning does not change. Affected when it adopts the release:
  the raised peer floor forces a was-client bump (it pins was-client `^0.74.0`
  and was-sync `^0.5.1`).
- freewallet `src/stores/contactsConflictHandler.ts:55`, was-react
  `src/storage/localStore.ts:50` -- inject a resolver; unaffected, the conflict
  handler is not touched.
- freewallet `tests/conformance/crossReplica.test.ts:235-245` -- runs
  `createWasReplication` with `live: false` against the in-process server;
  re-verify once the server answers with a body (the ack now stamps two more
  members before the one-shot run ends).
- dcw `test-node/contactsSync*.test.ts` -- fake ports returning
  `{ version, etag }`; the new members are optional, so the fakes compile.
  Affected when it adopts the release: the peer floor forces a was-client bump
  (it pins `^0.80.0`).
- wallet-core `src/sync/push.ts:82-93, 154-163` -- records `ack.version` and
  `ack.etag`; unchanged, may adopt the new members later (follow-up there).
  `docs/cross-replica-sync-compatibility.md:97-106` describes this driver's ack
  path and is stale today; follow-up there.

Parties to the wire change:

- was-client `src/sync/types.ts:112` (`WriteAck`),
  `src/sync/port.ts:377, 471-474` (`writeAck`, `putMeta`), its ARCHITECTURE.md
  ack paragraph (~635-645). Its non-sync `upsertResource`
  (`src/internal/write.ts:331`), `writeMeta` (`src/internal/meta.ts:170-177`),
  `Collection.add`'s PUT branch, and `WasTransport#put` read only the `ETag` and
  tolerate a body; unaffected.
- was-teaching-server `src/requests/ResourceRequest.ts:173, 569` (both `PUT`
  replies); `src/types.ts:864-905, 967-998` (`StorageBackend.writeResource` /
  `writeResourceMetadata` return types); `src/backends/filesystem.ts` and
  `src/backends/postgres.ts` (both implementations); the tombstone provenance
  sites `postgres.ts:2086-2094` and `filesystem.ts:4813`, which keep the prior
  `createdBy` / `createdAt` across a tombstone today and under the resurrection
  rule record this write's instead; its ARCHITECTURE.md backend-contract text
  (~488). `StorageBackend` is a public port (`src/index.ts:6`), so the widening
  is breaking for custom backends and touches WAS-3 (the Google Drive backend)
  and WAS-18 (publishing the port). The did:webvh `did.jsonl` write shares the
  Resource `PUT` handler (`ResourceRequest.ts:108-121`) and follows it.
- wallet-attached-storage-spec `spec.md` -- the Resource `PUT` bullet (~3237)
  and its three examples (~3261, ~3278, ~3301); the `/meta` `PUT` bullet (~3643)
  and example (~3664); the Quickstart (~274, ~286); the `createdBy` definition
  (~3409, "recorded on the first write and preserved unchanged by later writes"
  gains the resurrection exception); the privacy considerations; the Version
  History.
- was-conformance-suite -- six strict-`204` assertions on these two operations:
  `src/suites/resource-api.ts:282, 348`,
  `src/suites/conditional-requests-api.ts:293, 321`,
  `src/suites/encryption-descriptor-api.ts:397, 456`.
  `src/suites/governed-log-api.ts:786` is a Collection `/meta` `PUT` and stays.
  The server's CI gates on the published suite
  (`.github/workflows/ci.yml:46-105`), so the suite ships first.
- storage-core `src/was.ts:648-652` -- the `ResourceMetadata` JSDoc says the
  object is addressable at `/meta`; the write response body is a subset of its
  server-managed members, so the JSDoc gains a sentence or the entry is recorded
  `unaffected`.
- encrypted-collections-spec -- its parties table is walked because the suite's
  `vault` cases are among the six sites; no profile text changes.
- app-connect-spec -- no expectations about the Resource `PUT` response;
  unaffected.

## 4. Interaction matrix

Columns: the ack carries `updatedAt` / `createdBy` and the write-back stamps
them (A), the write response status and body (B).

| Flow                                                          | A                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | B                                                                                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Create push, body server                                      | Changed: the row gains `version`, `etag`, `updatedAt`, `createdBy` in one `incrementalPatch`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `201` with `contentType`, `size`, `updatedAt`, `createdAt`, `createdBy`                                                                    |
| Create over a tombstone (resurrection), body server           | Changed: as a create; the row gains this write's `createdBy`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `201`; the server records fresh provenance, so `createdAt` / `createdBy` are this write's                                                  |
| Update push, body server                                      | Changed: `version`, `etag`, `updatedAt` stamped; `createdBy` absent from the ack, the row keeps its own                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `200` with `contentType`, `size`, `updatedAt`                                                                                              |
| Meta-only push, body server                                   | Changed: `metaVersion`, `metaEtag`, `updatedAt` stamped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `200` with `contentType`, `size`, `updatedAt`                                                                                              |
| Create with `custom` (content write then `/meta` write)       | Changed: `updatedAt` from the `/meta` ack, the later stamp, which is what the feed shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Two responses; the second's `updatedAt` wins                                                                                               |
| Delete push                                                   | Fine: no ack members to stamp, the write-back skips tombstones as today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `204`, unchanged                                                                                                                           |
| Server answers `204` with no body (old server)                | Fine: the ack carries validators only; `createdBy` / `updatedAt` arrive through the echo with today's window                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Conformant                                                                                                                                 |
| Hidden `ETag` (cross-origin, header not exposed), body server | Fine: the ack carries no validator, so the write-back stamps nothing and runs no patch, exactly as today; no new write-back window opens, and the echo stays the only source of the validators and the two members (a dropped echo is WS-21, unchanged by this design)                                                                                                                                                                                                                                                                                                  | The body is readable without header exposure, but is not lifted into the row without a validator                                           |
| `/meta` ack with a body but no `ETag`                         | Changed in was-client only: `putMeta` returns the ack (today it returns `undefined` and discards the body); `hasAck` does not count the two members on their own, so the driver stamps nothing                                                                                                                                                                                                                                                                                                                                                                          | --                                                                                                                                         |
| Content accepted, then `/meta` `412`                          | Changed: the content ack is preserved beside the conflict entry as today (`src/pushWrites.ts:276-288`), but `onWriteAccepted` is no longer called for the row. The conflict entry carries the fresh validators and RxDB records it as the assumed primary, so `pushRow` conditions the next write on it. Today the write-back bumps the fork `_rev` and RxDB's conflict fork write `409`s against the pre-push `previous` (`upstream.js:222, 337-340, 358`), so no meta is written (`:372-378`, `:292` having skipped the row) and the resolver's decision is discarded | --                                                                                                                                         |
| Content accepted, then `/meta` `404` (tombstone race)         | Changed: as the row above. Today the discarded decision lets the next cycle re-create over the tombstone with `If-None-Match: *` and a delete-wins resolver is bypassed; with the fix the resolver's choice lands                                                                                                                                                                                                                                                                                                                                                       | --                                                                                                                                         |
| Concurrent local edit during the push                         | Changed: the upstream writes the pushed-state meta as today (`upstream.js:309`); `incrementalPatch` applies on the latest row, so the edit keeps its content and gains the validators; `updatedAt` / `createdBy` are stamped only while the row's `updatedAt` still equals the pushed one (`pushedUpdatedAt`), so the earlier write's server stamp cannot move a newer edit's stamp backwards (freewallet sorts by it, `browserStore.ts:586`; was-react stamps edits at `localStore.ts:773`)                                                                            | --                                                                                                                                         |
| Concurrent local delete during the push                       | Fine for this item: the pushed-state meta is written as today; the write-back finds a tombstone and skips; the delete goes out as today, which is a header-less `DELETE` on a create (pre-existing, WS-22)                                                                                                                                                                                                                                                                                                                                                              | --                                                                                                                                         |
| Server member longer than the schema allows                   | Fine: the write-back skips it at `debug` (`updatedAt` 64, `createdBy` 256, `src/syncedDocSchema.ts:59,63`), so the single patch cannot throw on it and lose the validators                                                                                                                                                                                                                                                                                                                                                                                              | --                                                                                                                                         |
| Write-back failure (storage error, row gone)                  | Fine: logged at `warn`, swallowed, the echo stays the source, as today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | --                                                                                                                                         |
| Echo pulled during the push HTTP                              | Fine: dropped by RxDB (`downstream.js:207`), harmless when the ack carried the members                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | --                                                                                                                                         |
| Echo pulled between the write-back and its push cycle         | Fine: dropped, harmless for the same reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | --                                                                                                                                         |
| Echo pulled after the write-back cycle                        | Fine: `isEqual` true and nothing is written; an echo that differs for any reason (a member the acks did not carry, a stamp another writer moved on) is written harmlessly                                                                                                                                                                                                                                                                                                                                                                                               | --                                                                                                                                         |
| Foreign state pulled in the window                            | Fine for this item: dropped as today, and another writer's `/meta` edit landing between our content `PUT` and the write-back stays unseen until the row next changes (pre-existing, WS-20)                                                                                                                                                                                                                                                                                                                                                                              | --                                                                                                                                         |
| Batch rejected after some rows were accepted                  | Fine: RxDB re-sends the batch; the accepted rows `412`, re-read, and resolve as today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | --                                                                                                                                         |
| Crash between the server commit and the write-back            | Fine: as today; the next push `412`s, re-reads, and the echo is still ahead of the stored pull checkpoint                                                                                                                                                                                                                                                                                                                                                                                                                                                               | --                                                                                                                                         |
| Server lies in the body                                       | Fine: the same trust the feed echo already gets for the same members; was-client lifts only an object body with a string `contentType` and a number `size`, and only string members, so a malformed body stamps nothing                                                                                                                                                                                                                                                                                                                                                 | The spec says a `2xx` body on these operations is only this object                                                                         |
| Server echoes the stored representation on `200`              | Fine: the defense is the spec rule that a `2xx` body on these operations is only this object; the shape guard (`contentType` string, `size` number) is a sanity check that catches the common echo, not a proof                                                                                                                                                                                                                                                                                                                                                         | Out of contract for a conformant server                                                                                                    |
| `PUT`-only capability holder                                  | --                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Learns nothing it did not cause: on an update the body has no provenance; on a create, a resurrection included, `createdBy` is its own DID |
| `/meta`-only capability holder                                | --                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Learns the content's `contentType` and `size`; written into the privacy considerations                                                     |
| Injected resolver (freewallet contacts), injected `isEqual`   | Fine: not touched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | --                                                                                                                                         |
| Feed-walk primary read (`withFeedPrimaryRead`)                | Fine: unchanged; `feedPrimaryPort.ts:137-141` passes writes through, so the widened ack passes through too                                                                                                                                                                                                                                                                                                                                                                                                                                                              | --                                                                                                                                         |
| wallet-core engine against a body server                      | Fine: records `version` / `etag` only, as today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Tolerates the body                                                                                                                         |
| Conformance suite against a body server                       | --                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Refused until the six sites accept `201` / `200` / `204`; the suite ships first                                                            |

## 5. Design

Driver (`src/pushWrites.ts`, `src/wasReplication.ts`). `PushWriteAck` gains
`updatedAt?: string`, `createdBy?: string`, and `pushedUpdatedAt: string` (the
pushed row's own `updatedAt`; an internal driver type, not wire). `pushRow`
fills the first two from the port acks: `createdBy` from any ack that carried
one, `updatedAt` from the last ack that carried one (the metadata write runs
after the content write, and the feed shows the later stamp). `hasAck` is
unchanged: the two members do not make an ack on their own, so a `/meta` ack
carrying a body but no validator stamps nothing. `createPushHandler` calls
`onWriteAccepted` only for a row whose result carries no conflict entry. A row
that earned both (content accepted, then a `/meta` `412` or `404`) is left to
RxDB's conflict path: the conflict entry already carries the fresh validators
and RxDB records it as the assumed primary, so the next write conditions on it.
Today the write-back on such a row bumps the fork `_rev`, RxDB's conflict fork
write `409`s against the pre-push `previous` and is ignored, and the resolver's
decision is discarded with no meta written; that is the one pre-existing defect
fixed here.

`createAckWriteBack` keeps its shape and its revision rules (an absent or `0`
revision stamps no `version`, a validator is always stamped). It stamps
`updatedAt` and `createdBy` in the same single `incrementalPatch` as the
validators, under three conditions: the same ack carries a validator (`etag` or
`metaEtag`), so a hidden-`ETag` deployment, where the echo must land anyway,
gets no new write-back window; the row's `updatedAt` still equals
`pushedUpdatedAt`, so a local edit made during the push is not stamped backwards
(validators are stamped regardless, as today); and the member is no longer than
the schema allows (`updatedAt` 64, `createdBy` 256), a longer one being skipped
at `debug` so the patch cannot throw and lose the validators. A member equal to
the row's is not patched. `onWriteAccepted` stays. No conflict-handler change,
no API removal. The acked state never carries an explicit `undefined` member;
absent stays absent.

was-client (`src/sync/types.ts`, `src/sync/port.ts`). `WriteAck` gains
`updatedAt?: string` and `createdBy?: string`. `writeAck` and `putMeta` lift
them from `response.data` on any `2xx` only when the body is an object whose
`contentType` is a string and `size` is a number (the shape guard that tells the
Metadata body from an echoed representation), and only members that are strings.
`putMeta` returns the ack whenever it has any member; today it returns
`undefined` without an `ETag` and discards the body. was-client's ARCHITECTURE
ack paragraph and the `WriteAck` JSDoc describe the two members and the guard.

Wire-level decisions (signed off 2026-10-02; the body shape and statuses revised
the same day after review):

- A successful `PUT /:id` answers `201 Created` when it created the Resource, a
  re-creation over a tombstone included, and `200 OK` when it updated a live
  one. A successful `PUT /:id/meta` answers `200 OK`; it never creates (a
  `/meta` write to an absent Resource is a `404`). Both carry the `ETag` header
  as today and `Content-Type: application/json`.
- A Resource re-created over a tombstone gets fresh provenance (signed off
  2026-10-03): the server records this write's invoker as `createdBy` and this
  write's time as `createdAt`. The tombstone's provenance is not preserved. The
  spec's "recorded on the first write and preserved unchanged by later writes"
  (~3409) gains that exception, and both server backends change (today
  `postgres.ts:2086-2094` and `filesystem.ts:4813` keep the prior values).
- The body holds server-managed members only: `contentType`, `size`, and
  `updatedAt` always; `createdAt` and `createdBy` only when this write recorded
  them, which is every `201`. No `custom`, `epoch`, or `writerId`. The member
  names and types are the Resource Metadata object's.
- A `2xx` body on these two operations is only this object, so a client can
  trust one it receives; that rule, not the client's shape guard, is the defense
  against a server echoing the stored representation. A server SHOULD answer
  with the body and MAY answer `204` with no body; a client treats a missing
  body as an ack carrying only the validator.
- The server fills the body from the row as this write left it, read inside the
  write's own lock or transaction (Postgres `RETURNING`, a filesystem stat under
  the lock), not from a re-read after the fact. A concurrent writer's state must
  not be reported as this write's; the postgres `created_by` race
  (`postgres.ts:2105-2112`) is the case the rule exists for.
- Privacy: a writer learns nothing it did not cause, a resurrection included,
  since the only provenance a body ever carries is the invoker's own. A
  `/meta`-only writer learns the content's `contentType` and `size`, which the
  privacy considerations state.
- Unchanged: `DELETE` (`204`), `POST` create (`201` with its own body), chunk
  `PUT` (`204`), Collection `meta/log` `PUT` (`204`), Space and Collection
  `PUT`s. The did:webvh `did.jsonl` write shares the Resource `PUT` handler and
  follows it.
- Spec sites: the two operation bullets, the four examples, the Quickstart, the
  privacy considerations, and the Version History. Allowing a non-`204` answer
  is an incompatible change under the spec's Protocol Evolution text
  (`spec.md:1262-1275`), so it needs an entry there; where it goes is open
  (section 8).

was-teaching-server. Both `PUT` handlers answer with the status and body.
`StorageBackend.writeResource` and `writeResourceMetadata` return the members
the body needs alongside the validator, read inside the write. The widening is
breaking for custom backends (`StorageBackend` is exported from
`src/index.ts:6`): a CHANGELOG breaking note, and the WAS-3 and WAS-18 items are
affected. CORS needs no change: a body needs no header exposure.

was-conformance-suite. A hard predecessor, since the server's CI runs the
published suite. The six strict-`204` sites accept `201`, `200`, or `204`, and
check the body shape when a `2xx` carries one.

Release order: suite, server, was-client, was-sync. was-sync bumps the
was-client devDependency and raises its peer floor to the widening release, and
its server devDependency returns to a registry version.

## 6. Alternatives rejected

- Delivering the acked state through RxDB's conflict array (the first draft).
  RxDB excludes conflict rows from the pushed-state meta write
  (`upstream.js:292`) and writes their meta only after a fork write whose
  `previous` is the pre-push state (`:338`); a `409` on that write is ignored
  (`:358`) and the meta is written only for the rows that succeeded
  (`:372-378`). A local edit or delete during the push therefore leaves the row
  with no record of the push at all. A delete after a create then takes the
  no-assumed-primary skip and the server copy stays live; a delete after an
  update `412`s and the resolver adopts the live remote. One resolver throw in a
  batch discards every sibling's acked state. The `isResolvedConflict` mark
  survives later meta writes and makes every pull of that row wait on the
  upstream. Do-not-reopen. Revisit if RxDB records the pushed state for conflict
  rows independently of the fork write and clears the mark.
- Pull-side hold-back: the pull handler trims its batch before an entry for an
  id whose push is in flight. Couples the two handlers through shared state,
  leaves a residual between the write-back and its cycle, and stalls every later
  entry in the batch. Kept as a candidate for WS-20 only.
- Headers on a `204` (`Last-Modified` plus a new creator header).
  `Last-Modified` is second-precision, so the row's `updatedAt` would not match
  the feed's ISO string and every echo would differ; a creator header is a new
  wire name; both need exposing to cross-origin callers.
- Validator members (`etag`, `metaEtag`) in the body. Would close the hidden
  `ETag` residual, but adds validator members to a shape the spec says exposes
  versions only through the `ETag` header. Left for WS-21.
- Re-read after the write (`GET /:id/meta` or a feed walk per accepted write). A
  round trip per push, and a concurrent writer's state could be taken as this
  write's ack, which was-client's `writeAck` comment already rules out.
  Do-not-reopen. Revisit if the spec ever adds a write-scoped read.
- Documentation only. Leaves rows this replica created without `createdBy` until
  they next change on the feed.
- The full Resource Metadata object as the body (the first sign-off). A
  `PUT`-only capability holder cannot `GET /:id/meta` but would read the prior
  `custom`, the creator's DID, and the key epoch from the reply. Replaced by the
  server-managed-members body.
- Answering with the body only when the caller is also authorized to read
  `/meta`. Puts an authorization check on the write path, and leaves write-only
  callers with the echo-only window.
- `200` on create and update alike (the first sign-off). RFC 9110 has a `PUT`
  that creates answer `201`, and the server already does so for Space and
  Collection `PUT`s.
- Preserving a tombstone's provenance through a resurrection (today's server
  behavior). A body carrying the preserved `createdBy` would hand a `PUT`-only
  resurrector the original creator's DID, and omitting it would leave the row to
  learn `createdBy` from the echo again. Fresh provenance on a resurrection
  keeps the body rule uniform (every `201` carries this write's provenance) and
  the privacy claim true.

## 7. Test plan

- `test/node/pushWrites.test.ts`: `pushRow` reports `updatedAt`, `createdBy`,
  and `pushedUpdatedAt` (the last `updatedAt` wins across a content write and a
  `/meta` write); a `/meta` ack carrying the two members and no validator is not
  an ack on its own; `onWriteAccepted` is not called for a row that returned a
  conflict entry (content accepted, then `/meta` `412`; content accepted, then
  `/meta` `404` tombstone); the existing `onWriteAccepted` cases stay as they
  are.
- `test/node/replicationAck.test.ts`: the write-back stamps the two members
  through a real RxDB collection; an ack with revision `0` and a validator still
  stamps them and leaves `version` alone; an ack with no validator stamps
  nothing (the hidden-`ETag` case); a row whose `updatedAt` moved on since the
  push keeps its newer stamp and still gains the validators; an over-long member
  is skipped and the validators still land.
- `test/node/replication.integration.test.ts`: the two cases that wait for
  `awaitInSync` before nudging a pull drop the wait (the wait before the delete
  at `:1121-1127` stays, it waits for the validator). A forced-window case wraps
  the real port's `putContent` so that, after the server has committed, the
  response is held until a nudged `reSync()` pull has completed. `awaitInSync`
  cannot be used while the response is held (the upstream never goes idle), so
  the case gates on the downstream having processed the batch, and before it
  releases the response it asserts that the pull handler returned the echo and
  that the row still lacks `createdBy`. That proves the drop happened, so the
  case cannot pass on unfixed code. It then releases the response and asserts
  the row's `createdBy`, `updatedAt`, `version`, and `etag` equal the server's.
  A second case runs the create-with-`custom` tombstone race (another replica
  deletes between the content write and the `/meta` write) and asserts the
  resolver's choice lands. The suite runs against a teaching server that answers
  with the body, so the devDependency moves to that release.
- `test/packaging/`: stays green (no root-graph change).
- was-client: body parse on `201` and `200`; `204` fallback; an echoed
  representation carrying its own `updatedAt` is not lifted; a non-string member
  is not lifted; a `/meta` body without an `ETag` returns an ack.
- was-teaching-server: `201` on create and `200` on update; `201` on a
  re-creation over a tombstone with this write's `createdBy` / `createdAt`, and
  the feed and `GET /:id/meta` then report the same fresh provenance; the body
  members; `createdAt` / `createdBy` absent on an update; `/meta` `PUT` on an
  absent Resource stays `404`; the values come from the write under its lock (a
  concurrent-writer case on postgres).
- was-conformance-suite: the six sites accept `201` / `200` / `204` and check
  the body shape on a `2xx` with a body.

## 8. Open questions

- Where the spec records the change: a new Version History entry, or a bullet in
  the open v0.5 "Breaking changes so far" list. Owner: the user, at the spec
  edit.
- The body shape against WAS-96 (was-teaching-server
  `designs/WAS-96-multi-primary-spaces.md`, approved 2026-10-02, after this
  doc's review). WAS-96 removes `version` and `metaVersion` from every wire
  object and stamps each record with `updatedAt`, `updatedAtCounter`, and
  `originId`, the `/meta` record's stamp nested under `meta`. The body decided
  in section 5 carries `updatedAt` alone, so under that model the ack would
  stamp a partial stamp, and the row would not compare equal to the feed echo
  once `statesEqual` (WS-23) compares all three members. Section 5's
  `createAckWriteBack` revision rules (`version` absent or `0` stamps nothing)
  and the forced-window test's `version` assertion describe members WAS-96
  removes. Candidates: (a) the body carries the record's full stamp, the
  `updatedAtCounter` and `originId` beside `updatedAt`, and on a `/meta` write
  the nested `meta` object, so the server changes its write response once and
  the ack is byte-equal to the echo's stamp (recommended); (b) land this doc as
  decided and reshape the body under WS-23. The name set is WAS-96's, so (a)
  adds no new wire names, but it changes what the two operation bullets list.
  Owner: the user, before implementation; the roadmap item carries an acceptance
  box for it.
