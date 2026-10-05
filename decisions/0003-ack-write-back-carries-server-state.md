# 0003: The ack write-back carries the server state

- Status: accepted
- Date: 2026-10-04
- Driving work: closing the window in which RxDB drops the feed echo of this
  replica's own write, so a created row never learned its `createdBy` or the
  server's write stamp.
- Affects: was-sync (`src/pushWrites.ts`, `src/wasReplication.ts`); was-client
  (`WriteAck` in `./sync`); was-teaching-server (the Resource write response
  body)

## Context

After a push, the server's echo of the write comes back down the `changes`
feed. RxDB drops a pulled state for a row whose local state differs from its
assumed primary, or that has no assumed primary yet, and the pull checkpoint
still moves past it. A locally created row is in that state from its insert
until RxDB writes the replication meta after the push handler returns, and
again from the ack write-back until the push cycle it triggers has run. An
echo pulled in that span is never pulled again. The write response used to
carry an `ETag` alone, so nothing on the ack path could supply what the echo
carried.

## Decision

The write response body carries the server-managed members of the record as
the write left them, was-client's `WriteAck` carries the write stamp, the
nested `meta` stamp on a `/meta` write, and `createdBy` on a create, and the
driver's existing ack write-back patches them into the local row beside the
validators. The content ack supplies the top-level stamp as a unit, the
`/meta` ack supplies `meta` as a unit, the two are not mixed, and no member is
patched without a validator in the same ack. The stamp is patched only while
the row still holds the pushed `updatedAt`. A row that returned a conflict
entry gets no write-back. The echo then costs nothing when dropped. The window
itself stays, and stays load-bearing for a server answering `204`, a hidden
`ETag`, and a swallowed write-back failure.

## Rejected Alternatives

- Delivering the acked state through RxDB's conflict array. RxDB writes no
  replication meta for a conflict row whose local state changed during the
  push, so a delete during a create's push would leave the server copy live,
  and one resolver throw in a batch discards every sibling's acked state.
  Do not reopen unless RxDB records the pushed state for conflict rows
  independently of the fork write.
- A re-read after the write (`GET /:id/meta` or a feed walk per accepted
  write). A round trip per push, and a concurrent writer's state could be
  taken as this write's. Do not reopen unless the spec adds a write-scoped
  read.
- Headers on a `204`. `Last-Modified` is second-precision and would never
  match the feed's stamp, and a creator header is a new wire name that needs
  cross-origin exposure.
- A pull-side hold-back for ids whose push is in flight. Couples the two
  handlers and still leaves a residual between the write-back and its cycle.

## Consequences

- A replica's own writes no longer depend on the echo for `createdBy` or the
  server stamp. Tests that waited for pushes to settle before nudging a pull
  can drop the wait.
- The write-back patch is larger than a validator-only patch, and it still
  triggers one push cycle that finds nothing to write.
- A server that answers `204` keeps today's behavior and today's window.
- The write response body is a wire contract shared with the server and the
  spec; a change to its shape has to be made in both.

## Revisit Criteria

Reopen this decision when one or more of the following holds:

1. RxDB stops dropping a pulled state behind a pending local write, or
   re-pulls what it dropped.
2. The spec adds a write-scoped read or puts the validators in the body, so
   the hidden-`ETag` residual can close on the same path.
