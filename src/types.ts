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
 * encrypted-metadata profile: a synced document carries both a content revision
 * (`version` / `data`) and an independently-versioned metadata sub-resource
 * (`metaVersion` / `custom`). A metadata-only edit re-surfaces the resource with
 * a bumped `updatedAt` / `metaVersion` but unchanged `version` / `data`. The
 * sync layer moves both bodies opaquely: `data` is the stored content body
 * (plaintext JSON, or the EDV envelope on an encrypted collection) and `custom`
 * is the stored metadata body (an opaque envelope on an encrypted collection);
 * encrypt and decrypt stay a read-time and write-time concern above this layer.
 *
 * The two small helpers that travel with these shapes live here as well: the
 * opaque-body equality every routing decision is made on, and the optional-field
 * copy every wire-to-local mapping runs.
 */
import { canonicalize as jcsCanonicalize } from 'json-canonicalize'
import type {
  Json,
  MasterState as ClientPrimaryState,
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
 * {@link PrimaryState} on the conflict re-read): the independently-versioned
 * metadata revision and body, the content body, the content body's key-epoch
 * stamp, the server-managed creator DID, and the opaque `ETag` validators.
 * Each is genuinely absent rather than `undefined` when the server has nothing
 * for it, so every mapping between the shapes copies them conditionally -- see
 * {@link copyOptionalBodyFields}.
 */
export interface OptionalBodyFields {
  metaVersion?: number
  data?: Json
  custom?: Json
  epoch?: string
  /**
   * The server-managed creator DID, present once the server records one. It
   * rides the feed on a tombstone too, so it survives a delete.
   */
  createdBy?: string
  /**
   * The content `ETag`, quoted, exactly as the server emits it -- echo it back
   * verbatim as a later content write's `ifMatch`. It can no longer be
   * rebuilt from `version` alone, since the server's `ETag` also embeds a
   * per-record generation marker ahead of the version.
   */
  etag?: string
  /**
   * The `/meta` object's `ETag`, quoted, exactly as the server emits it --
   * echo it back verbatim as a later metadata write's `ifMatch`.
   */
  metaEtag?: string
}

/**
 * Structural equality over two opaque bodies, by JCS-canonicalized JSON string,
 * so a key-order-only difference between two structurally identical bodies is
 * not misread as a change. Decides whether the content or the metadata half
 * changed -- which endpoint(s) a push writes, whether the benign-412 delete
 * retry fires, and whether two states compare equal for conflict resolution.
 * Canonical rather than raw `JSON.stringify`, because a host that re-serializes
 * a stored body with a different key order would otherwise defeat the delete
 * retry (leaving a retracted resource live) and draw a spurious `PUT` on an
 * immutable content-addressed row.
 *
 * @param left {Json | undefined}
 * @param right {Json | undefined}
 * @returns {boolean}
 */
export function bodiesEqual(
  left: Json | undefined,
  right: Json | undefined
): boolean {
  return jcsCanonicalize(left ?? null) === jcsCanonicalize(right ?? null)
}

/**
 * Copies the {@link OptionalBodyFields} that are present on `source` onto
 * `target`, leaving an absent field absent (never writing an explicit
 * `undefined`, which would surface the key in a serialized body). The single
 * place every wire-to-local, feed-to-primary, and primary-to-conflict mapping
 * shares, so a new optional wire field is added once.
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
  if (source.data !== undefined) {
    target.data = source.data
  }
  if (source.metaVersion !== undefined) {
    target.metaVersion = source.metaVersion
  }
  if (source.custom !== undefined) {
    target.custom = source.custom
  }
  if (source.epoch !== undefined) {
    target.epoch = source.epoch
  }
  if (source.createdBy !== undefined) {
    target.createdBy = source.createdBy
  }
  if (source.etag !== undefined) {
    target.etag = source.etag
  }
  if (source.metaEtag !== undefined) {
    target.metaEtag = source.metaEtag
  }
}

/**
 * The keyset position in the change feed: the `{ id, updatedAt }` of the last
 * document a pull returned. Passed back verbatim to resume, and used as the
 * RxDB replication checkpoint. `id` is the total-order tiebreaker within a
 * single `updatedAt`. was-client's own checkpoint type, aliased here so the
 * driver and the port agree by construction.
 */
export type SyncCheckpoint = ClientSyncCheckpoint

/**
 * One document as it travels on the `changes`-feed wire
 * (`POST /space/:s/:c/query`, profile `changes`). `id` is the WAS resourceId,
 * `version` is the content revision number and the user content body is
 * nested under `data`; `metaVersion` is the independent metadata revision and
 * the user-writable metadata body is under `custom`. A tombstone carries
 * `_deleted: true` with no `data`. `metaVersion` / `custom` are present only
 * once metadata has been written for the resource.
 *
 * `version` and `metaVersion` are for comparison/ordering only -- they are not
 * usable `ifMatch` values on their own, since the server's `ETag` is an opaque
 * string that embeds more than the revision number. `etag` and `metaEtag`
 * carry those opaque validators, quoted exactly as the server emits them, so a
 * puller can pass one back verbatim as a conditional write's `ifMatch` without
 * a separate {@link WasSyncPort.get}. `epoch` is the opaque key-epoch id the
 * content body was encrypted under, and `createdBy` the server-managed creator
 * DID, both moved verbatim. was-client's own feed document type, aliased here
 * so the driver and the port agree by construction.
 */
export type WireDoc = ClientWireDoc

/**
 * The local replica's document shape, shared across every synced collection.
 * The envelope fields are top-level (`id` primary key, `updatedAt` the
 * checkpoint sort field, `version` / `metaVersion` the server revisions); the
 * user bodies stay nested (`data` for content, `custom` for metadata) to avoid
 * field collisions. `_deleted` is managed by RxDB via `deletedField` and so is
 * not part of this "clean" shape (the handlers work with
 * {@link WithDeleted}`<SyncedDoc>`).
 */
export interface SyncedDoc {
  id: string
  updatedAt: string
  version: number
  metaVersion?: number
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
   * The server-managed creator DID, pulled off the feed. Read-only here: the
   * push side never writes it, and it rides the conflict entry so a resolved
   * row keeps the creator the server recorded.
   */
  createdBy?: string
  /**
   * The content `ETag`, quoted, exactly as the server last reported it (off
   * the feed, a re-read, or a write's own ack). Echoed back verbatim as the
   * next content write's `ifMatch` -- it is opaque and cannot be rebuilt from
   * `version`.
   */
  etag?: string
  /**
   * The `/meta` object's `ETag`, quoted, exactly as the server last reported
   * it. Echoed back verbatim as the next metadata write's `ifMatch`.
   */
  metaEtag?: string
}

/**
 * The current server-side state of a single resource, as read back for the 412
 * conflict path: was-client's own primary state (content `version` /
 * `updatedAt`, plus the optional `metaVersion` / `data` / `custom` /
 * `createdBy` / `epoch`) plus the OPTIONAL `deleted` flag that distinguishes a
 * tombstone from a live resource.
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
 * The acknowledgment a conditional write returns: the new revision number plus
 * the opaque `etag` validator it lives behind, exactly as the server sent it.
 * Pass `etag` back verbatim as a later write's `ifMatch` -- it can no longer be
 * synthesized from the revision number alone, since the server's `ETag` also
 * embeds a per-record generation marker ahead of it. `etag` is absent against a
 * backend that does not version resources; was-client's own ack type, aliased
 * here so the driver and the port agree by construction.
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
   * server, per the `key-epochs` feature). Returns the accepted write's
   * {@link WriteAck}.
   *
   * @param options {object}
   * @param options.id {string}
   * @param options.data {Json}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {boolean}
   * @param [options.epoch] {string}
   * @returns {Promise<WriteAck>}
   */
  putContent(options: {
    id: string
    data: Json
    ifMatch?: string
    ifNoneMatch?: boolean
    epoch?: string
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
   * was-client wedges the batch on it.
   *
   * @param options {object}
   * @param options.id {string}
   * @param [options.ifMatch] {string}
   * @returns {Promise<WriteAck | undefined>}
   */
  deleteContent(options: {
    id: string
    ifMatch?: string
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
   * treating it as a delete race.
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
