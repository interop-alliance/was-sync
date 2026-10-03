# WAS Sync Roadmap (open items)

nextAvailableId: 18

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

### WS-17: Echo pulled during the ack write-back window is dropped

- status: todo
- priority: medium
- labels: push, ack, pull, correctness, rxdb
- design: TBD
- design-approved:
- touches:
  - was-sync (ARCHITECTURE.md invariants 4 and 18)
  - was-client (only if the ack contract changes; likely unaffected)
- acceptance:
  - [ ] An integration test that nudges a pull during the push settle window (or
        otherwise forces the race) shows the echo's `createdBy` and server
        `updatedAt` landing in the local row
  - [ ] The integration cases that wait for `awaitInSync` before nudging a pull
        drop that wait
  - [ ] ARCHITECTURE.md invariants 4 and 18 describe the new ack path
  - [ ] `touches:` entries resolved

Context: After a push succeeds, the driver writes the server's new revision back
into the local row. RxDB sees that as an ordinary local edit until its next push
cycle has run. If the echo of the same write is pulled in that short gap, RxDB
sets it aside as behind a pending local edit, and the pull moves on without it.
The echo is never pulled again. The row then keeps the client's `updatedAt` and
never learns its server-assigned `createdBy`, even with the full-member
`isEqual` from WS-6. The gap is a few milliseconds, so a polling pull rarely
hits it. A pull nudged right after a push hits it readily.

discovered-from: WS-6

The ack write-back (`createAckWriteBack` in `src/wasReplication.ts`) is a plain
`incrementalPatch` on the local row. That write triggers a push cycle.
`pushWrites` finds the bodies unchanged and issues no write, and RxDB then
records the stamped row as the assumed primary. Until that cycle has run, the
row's local state differs from its assumed primary. RxDB's downstream treats
such a row as holding a local write not yet pushed (the "non-upstream-replicated
local write to the fork" branch in
`node_modules/rxdb/dist/esm/replication-protocol/downstream.js`, RxDB 17.5.0).
It returns without writing the pulled state, and the pull checkpoint still
advances past the entry.

The candidate approach is the one RxDB's replication docs describe for a server
that modifies a pushed document (recalled, not yet verified against the docs;
confirm before the design doc relies on it). The push handler returns a
server-modified document as a conflict entry. The conflict handler then writes
it to the local row atomically with the replication meta, in place of a
side-channel local write. That reshapes the ack path. `onWriteAccepted` and the
write-back would change, and invariant 4 describes the write-back as
best-effort, which would no longer hold. The resolver would also need a rule
that adopts a remote whose body equals the local one. Since this changes the
mechanism invariant 4 documents, the item is design-gated. The design doc is not
yet written.

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
