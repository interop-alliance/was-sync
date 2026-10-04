# WAS Sync Roadmap (open items)

nextAvailableId: 29

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

### WS-23: Adopt the WAS-96 stamp data model in the replica schema and the push path

- status: todo
- priority: high
- labels: schema, push, pull, conflict, breaking, was-96
- blocked-by: WS-24
- design: designs/WS-23-stamp-data-model.md
- design-approved: 2026-10-03
- touches:
  - was-sync (ARCHITECTURE.md invariants 4, 7, 18, Glossary `Ack`, README,
    CHANGELOG breaking note)
  - was-client (the sync port's `WireDoc`, `MasterState`, and `WriteAck` drop
    `version` / `metaVersion` for the stamp members; `parseEtag` is retired or
    reads the new layout; ARCHITECTURE/AGENTS)
  - was-teaching-server: WAS-189 (the write response body as a WAS-96 wire
    item), WAS-190 (a `/meta`-only write leaves the content stamp unchanged),
    filed 2026-10-03; the model ships under WAS-172 and the widened feed under
    WAS-182, and the integration suite here follows the registry release
  - storage-core (`WriteStamp`, `ResourceMetaStamp`, the reshaped
    `ChangeDocument`; shipped in 0.28.0, 2026-10-03)
  - was-conformance-suite (a "Parties to this contract" row; its feed cases
    assert `metaVersion` and fail against a WAS-172 server; ships before the
    server)
  - wallet-attached-storage-spec (the `changes` profile and tie-break text still
    describe `version` / `metaVersion`; the stamp text is WAS-96's spec work)
  - wallet-core (the `ack.version` sites stop compiling against was-client
    0.87.0, and the `replica.version > 0` / `=== 0` reads in `src/sync/push.ts`
    and `src/sync/remint.ts` become a silent never-acked state; the engine needs
    a durable acked flag of its own; ARCHITECTURE/AGENTS)
  - freewallet, was-react (each persists the replica schema and inserts rows
    with `version: 0`; a reshaped schema forgets every existing replica, which
    must take the replication meta with it; ARCHITECTURE/AGENTS)
  - dcw (not a was-sync consumer; drives wallet-core's engine over its own
    SQLite `version` / `metaVersion` columns and fake ports returning
    `{ version, etag }`)
- acceptance:
  - [ ] `SyncedDoc` and the replica schema carry `updatedAtCounter`, `originId`,
        and the nested `meta` stamp in place of `version` / `metaVersion`, with
        the schema's `required` list and `maxLength`s settled in the design
  - [ ] No site in `src/` reads or writes `version` / `metaVersion`: the push
        handler's routing and `hasAck`, the conflict and tombstone entries, the
        feed primary read, `statesEqual`, and the ack write-back, whose
        revision-`0` skip is removed with the member
  - [ ] The conflict entries carry the same stamp members the feed document
        carries. The ack write-back stamps them once WS-17 puts the stamp in the
        write response (decided 2026-10-03); this item lands against
        was-client's `etag`-only ack with the echo as the stamp's source for
        accepted writes
  - [ ] The default resolver's rules are unchanged and a test pins that rule 1
        and rule 2 compare bodies, not stamps
  - [ ] The integration suite runs against the server release that ships the
        stamp model, from the registry
  - [ ] ARCHITECTURE.md invariant 7's breaking-change note is applied: the
        CHANGELOG entry says every existing replica is forgotten and re-pulled
  - [ ] CHANGELOG.md entry
  - [ ] `touches:` entries resolved

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

### WS-24: Map the widened `changes` feed at the pull boundary

- status: todo
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
  - [ ] The pull handler and the feed primary read skip every change document
        whose `kind` is not `resource`, and a `kind` they do not know. The pull
        handler keeps following the server checkpoint until the page it hands
        RxDB holds at least one resource document or the feed ends: RxDB drops
        an empty page before persisting its checkpoint, so a page filtered to
        zero would be re-fetched on every poll (found in the WS-23 review)
  - [ ] A unit case drives the pull handler with an all-filtered page followed
        by a resource page and asserts the resource page's checkpoint is the one
        returned
  - [x] A `kind: resource` entry whose `contentType` is not JSON (no inline
        `data`) takes a documented outcome: skipped, or stored as a bodiless row
  - [ ] The feed's `deleted` member reaches RxDB as `_deleted`, on the pulled
        row and on the primary state the push path re-reads
  - [ ] Unit cases drive the pull handler and the feed primary read with
        `collection-metadata`, `policy`, `log`, an unknown kind, and a binary
        resource
  - [ ] CHANGELOG.md entry
  - [ ] `touches:` entries resolved

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
still reads `version` and does not compile against was-client 0.87.0 or later.
The unit cases for the skipped kinds live in was-client's sync port tests; here
an integration case against a server release that ships the widened feed would
pin the boundary end to end.

### WS-25: Stop sending `writerId` on the `/meta` write

- status: todo
- priority: medium
- labels: push, writer-id, was-96
- blocked-by: WS-23
- touches:
  - was-sync (ARCHITECTURE.md invariant 17, Glossary `Writer id`, README)
  - was-client (`putMeta` drops its `writerId` option; ARCHITECTURE/AGENTS)
  - wallet-core (the engine's `/meta` write)
- acceptance:
  - [ ] The push handler sends no `writerId` member on a `/meta` write, and
        keeps the `Writer-Id` header on content writes, deletes, and the
        benign-412 re-issue
  - [ ] The unit cases that assert the body member are inverted
  - [ ] ARCHITECTURE.md invariant 17 and the Glossary describe the label as a
        content-record member only
  - [ ] CHANGELOG.md entry
  - [ ] `touches:` entries resolved

Context: WAS-96's open point 2 moves `writerId` to the content record alone. A
`/meta` write no longer touches it, and the spec's declare-or-clear rule for
Update Resource Metadata is withdrawn. Invariant 17 and the 0.6.0 CHANGELOG
entry say every metadata write declares the label in its body. Once the server
ignores the member, sending it is harmless but misleading, and once the port
drops the option it no longer compiles. The benign-412 delete retry reads the
label off the re-read primary's content record, which WAS-96 keeps, so WS-5's
rule is unaffected.

### WS-26: Record why the default resolver keeps the payload-stamp order under WAS-96

- status: todo
- priority: low
- labels: conflict, docs, was-96
- blocked-by: WS-23
- acceptance:
  - [ ] ARCHITECTURE.md's "Ownership heuristics" entry for the last-write-wins
        comparison and invariant 1 state that the resolver compares the
        payload's `(updatedAt, writerId)` because its local side never holds a
        server stamp, which is the case the spec's revised tie-break keeps
  - [ ] The entry names the condition under which that stops holding (a resolver
        that sees two stamped sides, for instance a future `keep-conflicts`
        sibling comparison) so the next reader can tell whether to reopen it

Context: WAS-96 invariant 12 rewrites the spec's client-side tie-break: stamped
records order by `(ms, counter, originId)`, and `(updatedAt, writerId)` is kept
for an unstamped local edit against a stamped remote. The default resolver's
rules 1 and 2 compare bodies, not revisions, so they survive the model, and its
LWW comparison reads the payload's `updatedAt` and `writerId` out of the
decrypted body (`lwwFieldsOf`), which is the unstamped-local case. Nothing
changes in code, but the spec sentence the comparison rests on is being
rewritten, so the reasoning needs to be on record here rather than inferred from
`@interop/social-core`.

### WS-27: Rows from a re-created Collection's previous generation linger in the replica

- status: todo
- priority: low
- labels: pull, checkpoint, correctness, was-96
- acceptance:
  - [ ] Either the pull handler, on a refused checkpoint, marks every row the
        restarted feed does not list as deleted once the restart has caught up,
        or the residual is documented in ARCHITECTURE.md with the conditions
        under which it occurs
  - [ ] An integration case deletes and re-creates the Collection on the server,
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

### WS-28: State what the driver assumes when a consumer fails over to another replica

- status: todo
- priority: low
- labels: docs, controller, was-96
- blocked-by: WS-23
- acceptance:
  - [ ] ARCHITECTURE.md records that a controller is bound to one port and one
        server, that a consumer fails over by constructing a fresh controller
        against the other replica, and that the refused checkpoint then re-pulls
        the Collection from the beginning
  - [ ] It records that a Resource's stamp and `ETag` are identical on every
        replica under WAS-96, so the validators the replica holds condition
        correctly on the other server, and that a lagging replica answers a
        `412` whose re-read primary is older than the assumed one, which the
        default resolver's rule 2 adopts as remote
  - [ ] Whether the resolver should prefer the assumed primary over an older
        re-read primary is decided or filed as its own item

Context: WAS-96 settles that a client replicates against one server at a time
(its alternative 7) and that every capability is host-bound (its section 5.12),
so a wallet reaches a second replica with a new port and a new grant. The
driver's controller already takes one port and the 0.7.0 checkpoint restart
covers the re-pull. What is not written down is what the local rows mean on the
other server. Under the stamp model Resources are byte-identical across
replicas, `ETag` included, so the `If-Match` a row carries from server A holds
on server B. The one hazard is a replica behind its source: a write against it
draws a `412` whose re-read primary predates the assumed one, and rule 2 of the
default resolver would then adopt the older `custom`. That is a consumer
sequencing concern more than a driver defect, but the driver's assumption should
be stated.

### WS-17: Echo pulled during the ack write-back window is dropped

- status: todo
- priority: medium
- labels: push, ack, pull, correctness, rxdb
- design: designs/WS-17-ack-carries-server-state.md
- design-approved:
- touches:
  - was-sync (ARCHITECTURE.md invariants 2 and 18, Glossary `Ack` / `Echo`,
    README)
  - was-client (`WriteAck` gains `updatedAt` / `createdBy`; `writeAck` and
    `putMeta` lift them from a `2xx` body behind a shape guard; `putMeta`
    returns an ack with no validator; ARCHITECTURE/AGENTS)
  - was-teaching-server (`PUT /:id` answers `201` on create, a re-creation over
    a tombstone included, and `200` on update, `PUT /:id/meta` answers `200`,
    both with the server-managed-members body filled inside the write; a
    resurrection records fresh `createdBy` / `createdAt`; `StorageBackend` write
    return types widen, breaking for custom backends, WAS-3 and WAS-18 affected;
    ARCHITECTURE/AGENTS, CHANGELOG breaking note)
  - was-teaching-server: WAS-189, filed 2026-10-03 (the write response body
    carries the WAS-172 stamp members and the provenance, one body shape settled
    once; it also carries this item's statuses and resurrection rule)
  - was-conformance-suite (six strict-`204` sites accept `201` / `200` / `204`
    and check the body shape; ships before the server; ARCHITECTURE/AGENTS)
  - wallet-attached-storage-spec (both operation bullets, the four examples, the
    Quickstart, the `createdBy` definition's resurrection exception, the privacy
    considerations, the Version History; AGENTS)
  - storage-core (`ResourceMetadata` JSDoc notes the write response subset, or
    `unaffected`; ARCHITECTURE/AGENTS)
  - encrypted-collections-spec (parties walked; its `vault` suite cases are
    among the six sites; no profile text change; AGENTS)
  - wallet-core (optional: the engine adopts the new ack members;
    `docs/cross-replica-sync-compatibility.md:97-106` is stale;
    ARCHITECTURE/AGENTS)
  - freewallet (`tests/conformance/crossReplica.test.ts` re-verified against a
    body-answering server; `src/stores/contactsConflictHandler.ts:27-32`
    justifies `deepEqual` by the echo; ARCHITECTURE/AGENTS)
  - was-react (affected when it adopts the release: the raised peer floor forces
    a was-client bump; the callback and the push handler's return keep their
    meaning; ARCHITECTURE/AGENTS)
  - dcw (affected when it adopts the release: the peer floor forces a was-client
    bump; its fake ports return `{ version, etag }` and the new members are
    optional)
- acceptance:
  - [ ] The write response body carries the record's full stamp (`updatedAt`,
        `updatedAtCounter`, `originId`; the nested `meta` on a `/meta` write)
        beside `createdBy` (decided 2026-10-03, the design doc's section 8
        option a), was-client's `WriteAck` carries the same members, and the ack
        write-back stamps them under WS-23's unit rule
  - [ ] `PushWriteAck` carries `updatedAt` / `createdBy` / `pushedUpdatedAt`,
        `pushRow` fills them from the port acks and the pushed row (the last
        `updatedAt` wins), and `hasAck` does not count the two members on their
        own
  - [ ] `createPushHandler` calls `onWriteAccepted` only for a row that returned
        no conflict entry, with the content-then-`/meta` `412` and `404` cases
        pinned
  - [ ] `createAckWriteBack` stamps `updatedAt` and `createdBy` alongside the
        validators in the same `incrementalPatch`, only when the ack carries a
        validator, only while the row's `updatedAt` equals `pushedUpdatedAt`,
        and skipping a member longer than the schema allows
  - [ ] A forced-window integration case holds the content write's response
        until a nudged pull has returned the echo, asserts the row still lacks
        `createdBy` before releasing it, and the row then ends with the server's
        `createdBy`, `updatedAt`, `version`, and `etag`
  - [ ] The two integration cases that wait for `awaitInSync` before nudging a
        pull drop that wait
  - [ ] The was-client devDependency and peer floor move to the release that
        widens `WriteAck`; the server devDependency comes from the registry
  - [ ] ARCHITECTURE.md invariants 2 and 18 and the Glossary `Ack` / `Echo`
        entries describe the ack as a source of the two members, with the three
        residuals named
  - [ ] CHANGELOG.md entry
  - [ ] `touches:` entries resolved

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

### WS-19: `pushRow` never sees `_deleted` under a non-default `deletedField`

- status: todo
- priority: medium
- labels: push, correctness, rxdb
- acceptance:
  - [ ] The push handler reads the deleted flag under the `deletedField` the
        replication was configured with, or `createWasReplication` rejects a
        non-default `deletedField`
  - [ ] A unit case drives the handler with a non-default field and asserts the
        delete branch fires

Context: `createWasReplication` accepts a `deletedField` option and hands it to
RxDB. RxDB's replication plugin swaps `_deleted` for that field on every row
before the push handler sees it (`swapDefaultDeletedTodeletedField`), but
`pushRow` branches on `newDocumentState._deleted`. With any field other than the
default the delete branch never fires and a local delete is pushed as a content
write of the tombstone's body. Nothing exercises the option today, so the gap is
latent.

discovered-from: WS-17

### WS-20: A foreign state pulled during this replica's own push window is dropped

- status: todo
- priority: low
- labels: pull, push, correctness, rxdb
- acceptance:
  - [ ] Either the driver re-pulls a foreign state dropped inside the window, or
        the residual is documented in ARCHITECTURE.md invariant 18 with the
        conditions under which it occurs
  - [ ] An integration case lands another writer's `/meta` edit between this
        replica's content write and its write-back cycle and asserts the chosen
        outcome

Context: RxDB drops a pulled state for a row whose local state differs from its
assumed primary and moves the checkpoint past it. WS-17 makes that harmless for
this replica's own echo, since the ack now carries what the echo would bring. It
does nothing for another writer's change to the same row inside the window.
`/meta` is versioned on its own, so another writer can commit a metadata edit
right after this replica's content write without a `412` on either side. The
feed entry carries both, is pulled inside the window, and is dropped; this
replica's `custom` stays stale until the row next changes. Candidates: a
pull-side hold-back that trims the batch before an in-flight id so the entry is
re-pulled, or a cheaper rule that re-pulls only when the dropped entry's
validators differ from the ack's.

discovered-from: WS-17

Unchanged by WAS-96: its open point 2 keeps two stamp sets per Resource, so
`/meta` stays independently versioned and the race above stays reachable. The
"validators differ" rule would compare the nested `meta` stamp under WS-23.

### WS-21: A dropped echo on a hidden-`ETag` deployment leaves the next `PUT` unconditional

- status: todo
- priority: medium
- labels: push, ack, conditional-writes, correctness
- touches:
  - wallet-attached-storage-spec (validator members in the write response body,
    if that is the fix; a wire decision)
  - was-client (`WriteAck` reads them)
  - was-teaching-server, was-conformance-suite
- acceptance:
  - [ ] A row created against a server whose `ETag` header is not exposed
        cross-origin ends with the server's validator even when its echo was
        dropped inside the window
  - [ ] The next content edit of that row sends an `If-Match`

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

### WS-22: A local delete during a create's push goes out as a header-less `DELETE`

- status: todo
- priority: medium
- labels: push, delete, correctness
- acceptance:
  - [ ] A row inserted and removed while its create `PUT` is in flight is
        deleted on the server with an `If-Match` carrying the create's
        validator, or the delete is deferred until the row holds one
  - [ ] An integration case pins the race against the live server and asserts
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
