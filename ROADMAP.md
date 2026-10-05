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
