/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The single generic RxDB JSON schema reused across every synced collection.
 * One shape (`{ id, updatedAt, updatedAtCounter?, originId?, meta?, createdBy?,
 * epoch?, etag?, metaEtag?, data?, custom? }`) carries both a content record
 * and an independently-stamped metadata sub-resource; `_deleted` is added by
 * RxDB via `deletedField`. `updatedAt`, `updatedAtCounter`, and `originId` are
 * the content record's write stamp as the server minted it; `updatedAt` alone
 * is required, since a fresh local row needs a wall-clock value for the index
 * before the server has stamped it, and the server's value replaces it from
 * the write ack or the echo. `meta` is the `/meta` record's own stamp with its generation, stored
 * nested as the wire shapes it (decision 0002), absent until metadata has been
 * written and complete once present. `data` / `custom` are opaque bodies
 * (plaintext JSON, or an EDV envelope on an encrypted collection), so they are
 * typed as free-form objects. `createdBy` is the server-managed creator DID,
 * adopted from the create's ack or carried down from the `changes` feed. `epoch` is the opaque key-epoch id the
 * resource's envelope was encrypted under (absent = pre-epoch, encrypted
 * directly to the vault key), also carried down the feed. `etag` / `metaEtag`
 * are the opaque `ETag` validators the server last reported for the content and
 * `/meta` sub-resources -- echoed back verbatim as a later conditional write's
 * `ifMatch`.
 *
 * The schema is documentation unless a consumer registers a validator: this
 * package registers none, its tests run on bare memory storage, and the bounds
 * below (`maxLength`, `minimum`) describe the server's mint rather than being
 * enforced here. A server that minted a longer `originId` or `generation`
 * would need a matching schema edit that no test here catches.
 *
 * The return type is declared structurally rather than as RxDB's
 * `RxJsonSchema<SyncedDoc>`, so this module (and the root entry that exports it)
 * carries no `rxdb` import in its emitted declarations. The object is what
 * `addCollections` takes.
 */

/**
 * The synced-doc schema as RxDB reads it: a JSON-schema object plus RxDB's
 * `version`, `primaryKey`, and `indexes` members. Structural, so the root entry
 * stays free of `rxdb`.
 */
export interface SyncedDocSchema {
  version: number
  primaryKey: string
  type: 'object'
  properties: Record<string, Record<string, unknown>>
  required: string[]
  indexes: string[]
}

/**
 * Returns the synced-doc schema. `id` is the primary key (the WAS resourceId);
 * the `updatedAt` index is part of the stored schema (below) and so stays
 * although the driver no longer sorts or resumes by it.
 *
 * The shape is stored state rather than a code detail: RxDB hashes it and
 * refuses to open an existing replica whose stored hash differs at the same
 * `version`. It ships at `version: 0` with no migration strategy, so a replica
 * created under a different shape is forgotten and re-pulled at the next login
 * rather than migrated.
 *
 * @returns {SyncedDocSchema}
 */
export function syncedDocSchema(): SyncedDocSchema {
  return {
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: {
      id: { type: 'string', maxLength: 256 },
      updatedAt: { type: 'string', maxLength: 64 },
      // The server-minted rest of the content write stamp: a safe non-negative
      // integer counter and the origin id (`[A-Za-z0-9_-]{1,64}` on the
      // server). Absent until the server has stamped the row.
      updatedAtCounter: { type: 'integer', minimum: 0 },
      originId: { type: 'string', maxLength: 64 },
      // The `/meta` record's own stamp and generation, nested as on the wire.
      // All four members are required: `meta` is absent or complete.
      meta: {
        type: 'object',
        properties: {
          updatedAt: { type: 'string', maxLength: 64 },
          updatedAtCounter: { type: 'integer', minimum: 0 },
          originId: { type: 'string', maxLength: 64 },
          generation: { type: 'string', maxLength: 64 }
        },
        required: ['updatedAt', 'updatedAtCounter', 'originId', 'generation']
      },
      // The server-managed creator DID (a `did:key`), absent when unrecorded.
      createdBy: { type: 'string', maxLength: 256 },
      // The opaque key-epoch id the envelope was encrypted under, absent when
      // pre-epoch (encrypted directly to the vault key). Not indexed.
      epoch: { type: 'string', maxLength: 256 },
      // The opaque `ETag` validators the server last reported for the content
      // and `/meta` sub-resources, echoed back verbatim as a later conditional
      // write's `ifMatch`. Not indexed.
      etag: { type: 'string', maxLength: 256 },
      metaEtag: { type: 'string', maxLength: 256 },
      // Opaque stored bodies -- content and metadata envelopes -- moved verbatim.
      data: { type: 'object', additionalProperties: true },
      custom: { type: 'object', additionalProperties: true }
    },
    required: ['id', 'updatedAt'],
    indexes: ['updatedAt']
  }
}
