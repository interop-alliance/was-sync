/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Shared types for the collection-agnostic WAS replication driver.
 *
 * The driver moves stored bodies between a local replica and a remote WAS
 * Collection through the {@link WasSyncPort} seam. Nothing here imports RxDB or
 * `@interop/was-client` at runtime: the wire model (`Json`, `SyncCheckpoint`,
 * the base primary state, the write acknowledgment) is was-client's, imported
 * as types only, so a body crosses the port boundary without a cast.
 *
 * The wire contract follows the WAS `changes` feed and its V2
 * encrypted-metadata profile: a synced document carries both a content record
 * (`data`, stamped `updatedAt` / `updatedAtCounter` / `originId`) and an
 * independently-stamped metadata sub-resource (`custom`, stamped by the nested
 * `meta` object). A metadata-only edit re-surfaces the resource with a new
 * `meta` stamp and unchanged content stamp and `data`. The sync layer moves
 * both bodies opaquely: `data` is the stored content body (plaintext JSON, or
 * the EDV envelope on an encrypted collection) and `custom` is the stored
 * metadata body (an opaque envelope on an encrypted collection); encrypt and
 * decrypt stay a read-time and write-time concern above this layer.
 *
 * The two small helpers that travel with these shapes live here as well: the
 * opaque-body equality every routing decision is made on, and the optional-field
 * copy every wire-to-local mapping runs.
 */
import { canonicalize as jcsCanonicalize } from 'json-canonicalize'
import type {
  Json,
  MasterState as ClientPrimaryState,
  ResourceMetaStamp,
  SyncCheckpoint as ClientSyncCheckpoint,
  WireDoc as ClientWireDoc,
  WriteAck as ClientWriteAck
} from '@interop/was-client/sync'

/**
 * A JSON value -- the opaque stored resource body the sync layer moves
 * verbatim. For a plaintext collection this is the user document; for an
 * encrypted one it is the EDV envelope. The driver never inspects or transforms
 * it. was-client owns the wire model, so the type is aliased rather than
 * re-declared.
 */
export type { Json }

/**
 * The `/meta` record's own write stamp with its generation,
 * `{ updatedAt, updatedAtCounter, originId, generation }`, nested on a wire
 * document, a primary state, and a stored row under `meta`. Present only once
 * metadata has been written for the resource, and then complete: the driver
 * stores and compares it whole and reads no member of it. was-client's type,
 * re-exported so a consumer names it from here.
 */
export type { ResourceMetaStamp }

/**
 * One document as the replication handlers see it: the stored shape plus RxDB's
 * deleted flag. Structurally identical to RxDB's own `WithDeleted<T>`, declared
 * here so the root entry's declarations carry no `rxdb` import (a consumer
 * running `skipLibCheck` with `rxdb` absent would otherwise get a silent error
 * type).
 */
export type WithDeleted<DocType> = DocType & { _deleted: boolean }

/**
 * The two fields the last-write-wins rule reads off a payload: the app-owned
 * ISO-8601 edit stamp and the writing client's id (the exact-instant
 * tiebreaker). Read off a doc with {@link lwwFields}; compared with
 * `remotePayloadWins` from `@interop/social-core`, which owns the rule.
 */
export interface LwwFields {
  updatedAt: string
  writerId: string
}

/**
 * Reads the LWW fields off a doc when it carries them. Storage payloads are
 * generic over `{ id: string }`, so docs without `updatedAt`/`writerId` are
 * legal; callers fall back to their own rule for those.
 *
 * @param doc {unknown}
 * @returns {LwwFields | null}
 */
export function lwwFields(doc: unknown): LwwFields | null {
  const { updatedAt, writerId } = doc as {
    updatedAt?: unknown
    writerId?: unknown
  }
  return typeof updatedAt === 'string' && typeof writerId === 'string'
    ? { updatedAt, writerId }
    : null
}

/**
 * The optional half of a synced document, shared verbatim by every shape it
 * travels in ({@link WireDoc} on the feed, {@link SyncedDoc} locally,
 * {@link PrimaryState} on the conflict re-read): the two server-minted members
 * of the content write stamp, the metadata stamp and body, the content body,
 * the content body's key-epoch id, the server-managed creator DID, and the
 * opaque `ETag` validators. Each is genuinely absent rather than `undefined`
 * when the server has nothing for it, so every mapping between the shapes
 * copies them conditionally -- see {@link copyOptionalBodyFields}.
 */
export interface OptionalBodyFields {
  /**
   * The counter and origin halves of the content record's write stamp, minted
   * by the server beside `updatedAt`. Absent on a row the server has not
   * stamped yet (a fresh local row, the tombstone conflict entry). Copied as a
   * pair from a feed document or a re-read primary and never minted here.
   */
  updatedAtCounter?: number
  originId?: string
  /**
   * The `/meta` record's own stamp, present once metadata has been written.
   */
  meta?: ResourceMetaStamp
  data?: Json
  custom?: Json
  /**
   * The opaque key-epoch id `data` was encrypted under, when known (stamped by
   * the encrypting cipher on a local write, or pulled off the feed). Sent as
   * the `Key-Epoch` header on the content push so the server's stamp stays in
   * step with the envelope.
   */
  epoch?: string
  /**
   * The server-managed creator DID, present once the server records one. It
   * rides the feed on a tombstone too, so it survives a delete. Read-only
   * here: the push side sends nothing for it, the ack write-back adopts the
   * one the create's ack carried, and it rides the conflict entry so a
   * resolved row keeps the creator the server recorded.
   */
  createdBy?: string
  /**
   * The content `ETag`, quoted, exactly as the server last reported it (off
   * the feed, a re-read, or a write's own ack) -- echo it back verbatim as a
   * later content write's `ifMatch`. Opaque: no revision number is read out
   * of it.
   */
  etag?: string
  /**
   * The `/meta` object's `ETag`, quoted, exactly as the server last reported
   * it -- echo it back verbatim as a later metadata write's `ifMatch`.
   */
  metaEtag?: string
}

/**
 * The {@link OptionalBodyFields} members by name, the one list the optional
 * half is copied and compared from. A member added to the interface is added
 * here too (the `satisfies` check holds the two in step), and every mapping and
 * the default equality pick it up without a change of their own.
 */
export const optionalBodyFields = [
  'updatedAtCounter',
  'originId',
  'meta',
  'data',
  'custom',
  'epoch',
  'createdBy',
  'etag',
  'metaEtag'
] as const satisfies readonly (keyof OptionalBodyFields)[]

/**
 * The members of {@link optionalBodyFields} that are JSON objects compared
 * canonically ({@link bodiesEqual}) rather than strictly: the two opaque bodies
 * and the `/meta` stamp.
 */
export const opaqueBodyFields: ReadonlySet<keyof OptionalBodyFields> = new Set([
  'meta',
  'data',
  'custom'
])

/**
 * Structural equality over two JSON values (the opaque bodies, and the `/meta`
 * stamp), by JCS-canonicalized JSON string, so a key-order-only difference
 * between two structurally identical values is not misread as a change.
 * Decides whether the content or the metadata half changed -- which endpoint(s)
 * a push writes, whether the benign-412 delete retry fires, and whether two
 * states compare equal for conflict resolution. Canonical rather than raw
 * `JSON.stringify`, because a host that re-serializes a stored body with a
 * different key order would otherwise defeat the delete retry (leaving a
 * retracted resource live) and draw a spurious `PUT` on an immutable
 * content-addressed row. The same reference, or two absent values, compare
 * equal without serializing.
 *
 * @param left {unknown}   a JSON value, or `undefined` for an absent one
 * @param right {unknown}
 * @returns {boolean}
 */
export function bodiesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true
  }
  return jcsCanonicalize(left ?? null) === jcsCanonicalize(right ?? null)
}

/**
 * Copies the {@link OptionalBodyFields} that are present on `source` onto
 * `target`, leaving an absent field absent (never writing an explicit
 * `undefined`, which would surface the key in a serialized body). The single
 * place every wire-to-local, feed-to-primary, and primary-to-conflict mapping
 * shares, driven by {@link optionalBodyFields} so a new optional wire field is
 * declared once.
 *
 * @param options {object}
 * @param options.source {OptionalBodyFields}
 * @param options.target {OptionalBodyFields}   mutated in place
 * @returns {void}
 */
export function copyOptionalBodyFields({
  source,
  target
}: {
  source: OptionalBodyFields
  target: OptionalBodyFields
}): void {
  // Indexed through a loose view: one member at a time the key types line up,
  // but TypeScript cannot see that across a union of keys.
  const sink = target as Record<string, unknown>
  for (const key of optionalBodyFields) {
    if (source[key] !== undefined) {
      sink[key] = source[key]
    }
  }
}

/**
 * The resume position in the change feed: the opaque checkpoint string of the
 * last document a pull returned, scoped to the server and collection that
 * issued it. Passed back verbatim to resume, compared by equality only, and
 * used as the RxDB replication checkpoint. was-client's own checkpoint type,
 * aliased here so the driver and the port agree by construction.
 */
export type SyncCheckpoint = ClientSyncCheckpoint

/**
 * The checkpoint record the pull handler hands RxDB and RxDB persists in the
 * replication meta: the opaque {@link SyncCheckpoint} under a `checkpoint`
 * member. RxDB stacks checkpoints with `Object.assign`, which would scatter a
 * bare string into index-keyed characters, so the string travels wrapped and
 * the pull handler unwraps it on the way back.
 */
export interface ReplicationCheckpoint {
  checkpoint: SyncCheckpoint
}

/**
 * One document as it travels on the `changes`-feed wire
 * (`POST /space/:s/:c/query`, profile `changes`). `id` is the WAS resourceId;
 * `updatedAt`, `updatedAtCounter`, and `originId` are the content record's
 * write stamp and the user content body is nested under `data`; the nested
 * `meta` object is the `/meta` record's own stamp and the user-writable
 * metadata body is under `custom`. A tombstone carries `_deleted: true` with no
 * `data`. `meta` / `custom` are present only once metadata has been written for
 * the resource.
 *
 * The stamps are for comparison only -- they are not usable `ifMatch` values.
 * `etag` and `metaEtag` carry the opaque validators, quoted exactly as the
 * server emits them, so a puller can pass one back verbatim as a conditional
 * write's `ifMatch` without a separate {@link WasSyncPort.get}. `epoch` is the
 * opaque key-epoch id the content body was encrypted under, and `createdBy` the
 * server-managed creator DID, both moved verbatim. `writerId` is the
 * writer-attribution label the write was declared under, when one was; the
 * pull mapping does not carry it into the local row. was-client's own feed
 * document type, aliased here so the driver and the port agree by construction.
 */
export type WireDoc = ClientWireDoc

/**
 * The local replica's document shape, shared across every synced collection.
 * The envelope fields are top-level (`id` primary key, `updatedAt` the
 * wall-clock change stamp, `updatedAtCounter` / `originId` the server-minted
 * rest of the content write stamp, `meta` the `/meta` record's stamp); the user
 * bodies stay nested (`data` for content, `custom` for metadata) to avoid field
 * collisions. `_deleted` is managed by RxDB via `deletedField` and so is not
 * part of this "clean" shape (the handlers work with
 * {@link WithDeleted}`<SyncedDoc>`).
 *
 * The stamp on a local row is the last server state the row learned, not a
 * description of the local edit. An app edit moves `updatedAt` and leaves
 * `updatedAtCounter` and `originId` where they were, so an edited row holds a
 * triple no server minted until its echo arrives. The driver reads the two
 * server-minted members nowhere; a consumer must not read the triple off a
 * local row as an order key.
 *
 * The optional half is {@link OptionalBodyFields}, the same members the wire
 * document and the primary state carry.
 */
export interface SyncedDoc extends OptionalBodyFields {
  id: string
  updatedAt: string
}

/**
 * The current server-side state of a single resource, as read back for the 412
 * conflict path: was-client's own primary state (the content `updatedAt`, plus
 * the optional `updatedAtCounter` / `originId` / `meta` / `data` / `custom` /
 * `createdBy` / `epoch` and the validators) plus the OPTIONAL `deleted` flag
 * that distinguishes a tombstone from a live resource.
 *
 * The flag is optional because the two `get` implementations report an absent
 * resource differently. A feed-backed read ({@link withFeedPrimaryRead})
 * resolves a tombstone as a document and sets the flag; a was-client `get`
 * resolves `null` for both a tombstone and an absence and sets nothing. A
 * reader treats an absent flag as `false` and a `null` read as the tombstone.
 */
export interface PrimaryState extends ClientPrimaryState {
  deleted?: boolean
}

/**
 * The short-lived primary-read memo the rows of ONE push batch share. A
 * resolving `get` implementation may answer from `byId` and MUST record every
 * primary state it resolved on the way there; a feed-walking implementation
 * pages past all of them anyway, so a batch of k conflicts costs one walk
 * instead of k.
 *
 * `inFlight` is what makes that hold under concurrency: the batch's rows push in
 * parallel, so without it every row would start its own walk before the first
 * one finished and the memo would never be read. A `get` that must walk
 * publishes its walk here; a `get` that finds a walk already running awaits it
 * and re-checks `byId` first. It settles (never rejects) so one row's failed
 * read is not another row's, and is `null` whenever no walk is running.
 *
 * The whole object is created per batch invocation and dropped with it: a memo
 * held across batches would go stale.
 */
export interface PrimaryReadCache {
  byId: Map<string, PrimaryState | null>
  inFlight: Promise<void> | null
}

/**
 * The acknowledgment a conditional write returns: the opaque `etag` validator
 * the accepted write earned, exactly as the server sent it (pass it back
 * verbatim as a later write's `ifMatch`), and, from a server that answers the
 * write with a body, the write's stamp (`updatedAt`, `updatedAtCounter`,
 * `originId`, copied whole or not at all), the `/meta` record's stamp under
 * `meta` on a metadata write, and `createdBy` on a create. It carries no
 * revision number. `etag` is absent where the header did not reach the client;
 * was-client's own ack type, aliased here so the driver and the port agree by
 * construction.
 */
export type WriteAck = ClientWriteAck

/**
 * The write/query half of the injected WAS-access seam. was-client's
 * `createWasSyncPort` implements it; this package depends only on the
 * interface. Every method moves the stored body verbatim -- no codec, no key
 * handling -- so the same port works for plaintext and encrypted collections
 * alike.
 *
 * `putContent` / `deleteContent` / `putMeta` MUST throw the port's conflict
 * signal (was-client's `WasSyncConflictError`, matched by
 * `isSyncConflictError`) when the server rejects a conditional write with
 * `412 precondition-failed`, and let every other error propagate so RxDB's
 * retry and backoff handles it.
 *
 * The 412 conflict re-read (`get`) is deliberately NOT part of this base: a
 * deployment whose server hides the ETag behind CORS wraps a base port with
 * {@link withFeedPrimaryRead}, which supplies a `get` resolved from the
 * changes-feed body and so produces a full {@link WasSyncPort}.
 */
export interface WasSyncBasePort {
  /**
   * Pulls one page of the `changes` feed. Omit `checkpoint` for the first page.
   * Returns the page's `documents` and its resume `checkpoint`, or
   * `checkpoint: null` for an empty (no-change) page.
   *
   * @param options {object}
   * @param [options.checkpoint] {SyncCheckpoint}   resume position
   * @param options.limit {number}                  requested batch size
   * @returns {Promise<{ documents: WireDoc[], checkpoint: SyncCheckpoint | null }>}
   */
  query(options: { checkpoint?: SyncCheckpoint; limit: number }): Promise<{
    documents: WireDoc[]
    checkpoint: SyncCheckpoint | null
  }>

  /**
   * Conditionally writes the content body verbatim (`PUT /:id`). Pass
   * `ifNoneMatch: true` for a create-if-absent, or `ifMatch` (the opaque `ETag`
   * from a prior read/write, echoed back verbatim) for an update-if-unchanged.
   * `epoch` is the opaque key-epoch id the body was encrypted under, sent as
   * the `Key-Epoch` header (an absent epoch clears any prior stamp on the
   * server, per the `key-epochs` feature). `writerId` is the writing agent's
   * attribution label, sent as the `Writer-Id` header; an absent `writerId`
   * clears any stored label (the spec's declare-or-clear rule). Returns the
   * accepted write's {@link WriteAck}.
   *
   * @param options {object}
   * @param options.id {string}
   * @param options.data {Json}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {boolean}
   * @param [options.epoch] {string}
   * @param [options.writerId] {string}
   * @returns {Promise<WriteAck>}
   */
  putContent(options: {
    id: string
    data: Json
    ifMatch?: string
    ifNoneMatch?: boolean
    epoch?: string
    writerId?: string
  }): Promise<WriteAck>

  /**
   * Conditionally deletes a resource (writes a tombstone; `DELETE /:id`). Pass
   * `ifMatch` (the opaque `ETag` from a prior read/write, echoed back verbatim)
   * to delete only if unchanged. Returns the tombstone's new {@link WriteAck}
   * when the server supplies one (the reference server does not). A
   * spec-conformant server answers `204` for an authorized delete of an absent
   * resource. A `404` may either resolve `undefined` or reject with the
   * not-found signal (`err.name === 'WasSyncNotFoundError'`); the push handler
   * reads both as the already-gone outcome, so neither port configuration of
   * was-client wedges the batch on it. `writerId` declares the deleting
   * agent's attribution label as the `Writer-Id` header, recorded on the
   * tombstone; an absent one clears it.
   *
   * @param options {object}
   * @param options.id {string}
   * @param [options.ifMatch] {string}
   * @param [options.writerId] {string}
   * @returns {Promise<WriteAck | undefined>}
   */
  deleteContent(options: {
    id: string
    ifMatch?: string
    writerId?: string
  }): Promise<WriteAck | undefined>

  /**
   * Conditionally writes the metadata body verbatim (`PUT /:id/meta`, body
   * `{ custom }`). An ABSENT `custom` writes the CLEARED state (a body with no
   * `custom` member -- the server's metadata replace clears every property the
   * body omits), so removing a resource's metadata replicates rather than being
   * skipped. Pass `ifNoneMatch: true` when the resource has no metadata yet, or
   * `ifMatch` (the opaque `/meta` `ETag` from a prior read/write, echoed back
   * verbatim) for an update-if-unchanged. The resource must already exist (the
   * server does not create a resource from a `/meta` write). Returns the new
   * metadata {@link WriteAck}, or `undefined` when the server does not supply
   * one. A `404` (the resource was deleted by another replica) rejects with
   * the not-found signal (`err.name === 'WasSyncNotFoundError'`) on the default
   * port, or the auth signal carrying `status: 404` on a `mapAuthErrors` port;
   * the push handler corroborates either against the changes feed before
   * treating it as a delete race. No writer-attribution label is sent: the
   * label is a member of the content record alone, and a metadata write
   * leaves it unchanged.
   *
   * @param options {object}
   * @param options.id {string}
   * @param [options.custom] {Json}   absent = write the cleared state
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {boolean}
   * @returns {Promise<WriteAck | undefined>}
   */
  putMeta(options: {
    id: string
    custom?: Json
    ifMatch?: string
    ifNoneMatch?: boolean
  }): Promise<WriteAck | undefined>
}

/**
 * The full sync port the driver consumes: a {@link WasSyncBasePort}'s
 * write/query methods plus the `get` the 412 conflict assembler uses. The push
 * handler and `createWasReplication` require this full port; was-client's
 * `createWasSyncPort` returns one, and a base port gains `get` through
 * {@link withFeedPrimaryRead}.
 */
export interface WasSyncPort extends WasSyncBasePort {
  /**
   * Re-reads a single resource's current primary state (content + metadata) for
   * the 412 conflict assembler. Returns `null` when the resource is genuinely
   * absent (a delete/delete race); throws a retryable error when the state
   * cannot be resolved (a feed re-read that exhausts its scan budget), so the
   * replication cycle retries rather than fabricating a false tombstone.
   *
   * `cache` is an OPTIONAL {@link PrimaryReadCache}, shared by the rows of one
   * push batch (see its own docs for the contract). A hit is no staler than a
   * read issued at the same moment, since the memo lives only for that batch. An
   * implementation that ignores it is fully conformant, and a caller that omits
   * it gets an uncached read.
   *
   * @param options {object}
   * @param options.id {string}
   * @param [options.cache] {PrimaryReadCache}
   * @returns {Promise<PrimaryState | null>}
   */
  get(options: {
    id: string
    cache?: PrimaryReadCache
  }): Promise<PrimaryState | null>
}
