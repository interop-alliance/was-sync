# 0002: The write stamp is stored as the wire shapes it

- Status: accepted
- Date: 2026-10-03
- Driving work: the adoption of the server's multi-primary write stamp in the
  replica schema and the push path, on the design approved 2026-10-03. The
  server replaced the per-record revision counter with a stamp minted at the
  writing origin, and the `/meta` record's own stamp travels as one nested
  object on every wire document.
- Affects: `@interop/was-sync` (the replica schema, `SyncedDoc`, the pull
  mapping, the feed primary read, the conflict entry, the default equality); the
  consumers that persist the replica schema (`@interop/was-react`, the
  Freewallet browser wallet).

## Context

The server stamps every versioned record with `updatedAt`, `updatedAtCounter`,
and `originId`, and stamps the `/meta` record separately, as a nested object
`meta: { updatedAt, updatedAtCounter, originId, generation }`. The server
settled the nested shape on the sidecar, the change document, the provenance
statement, and the served `/meta` object; `@interop/storage-core` declares it as
`ResourceMetaStamp`.

Three documents in this driver have to agree on one shape: the stored replica
row, the conflict entry the push handler assembles from a re-read primary, and
the echo pulled from the changes feed. The driver copies server-managed members
across every mapping through one helper and compares a stored row to a pulled
document in the default equality. The driver never reads `generation`.

RxDB stores the schema's shape as state: a changed property set changes the
schema hash and every existing replica is forgotten and re-pulled. The shape
chosen here is therefore the one every consumer's storage will hold.

## Decision

The replica row stores the stamp under the wire names and with the wire nesting.
`updatedAtCounter` and `originId` are top-level members beside `updatedAt`.
`meta` is a nested object carrying all four of the server's members,
`generation` included, and is either absent or complete. No member is renamed,
flattened, or stripped on the way in or out.

Consequently the stored row, the conflict entry, and the echo are byte-equal in
their stamp members; `copyOptionalBodyFields` carries the stamp as it carries
`etag`, with no per-member mapping; and `statesEqual` compares `meta`
canonically as one value.

## Rejected Alternatives

- Flatten `meta` into top-level `metaUpdatedAt`, `metaUpdatedAtCounter`,
  `metaOriginId`, `metaGeneration`. Every mapping would need a per-member
  translation in both directions, the echo would stop being byte-equal to the
  stored row, and the shape would diverge from the one the server settled on
  every other carrier of the stamp.
- Store `meta` without `generation`, since the driver never reads it. The stored
  `meta` would then differ from the wire `meta`, and a canonical comparison of
  the two, which is the reason to store the stamp, would always report a
  difference.
- Nest `metaEtag` inside `meta` as `meta.etag`. The write acknowledgement can
  carry the validator without the stamp (an `ETag`-only ack, and a server that
  hides `ETag` headers produces the reverse), so a validator inside `meta` would
  force a partial `meta` object, breaking the rule that `meta` is complete or
  absent. The validators are HTTP header values and stay flat beside each other.
- Group `createdBy`, `writerId`, and `originId` under a `provenance` object. The
  three are different kinds: a server-set creator, a client-declared attribution
  label, and the origin segment of the stamp's order key. Grouping the third
  with the first two splits the stamp triple and conflates the origin with
  attribution, which the Glossary keeps apart.

## Consequences

- The stamp arrives and leaves through the same helper as every other
  server-managed member; a member the server adds later is carried and compared
  without a driver change.
- The row holds `originId` and `generation`, which disclose nothing a local
  reader did not already have: both are segments of the `etag` and `metaEtag`
  the row already carries.
- A local edit moves `updatedAt` and leaves `updatedAtCounter` and `originId`
  where they were, so an edited row holds a triple no server minted until its
  echo arrives. The driver reads the two server-minted members nowhere; a
  consumer must not read the triple off a local row as an order key.
- Any change to the server's stamp shape is a schema change here, and so a
  forgotten replica in every consumer.

## Revisit Criteria

Reopen this decision when one or more of the following holds:

1. RxDB's schema handling, or an index a consumer needs, requires a `/meta`
   stamp member at the top level.
2. The server changes the shape of the stamp on the change document, in which
   case the stored shape follows it and this record is amended, not reversed.

If revisited, the stored shape stays identical to the wire shape; a driver-local
layout that differs from the wire is not an option.
