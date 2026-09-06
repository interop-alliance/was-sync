/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The single generic RxDB JSON schema reused across every synced collection.
 * One shape (`{ id, updatedAt, version, metaVersion?, createdBy?, epoch?,
 * data?, custom? }`) carries both a content revision and an
 * independently-versioned metadata sub-resource; `_deleted` is added by RxDB via
 * `deletedField`. `data` / `custom` are opaque bodies (plaintext JSON, or an EDV
 * envelope on an encrypted collection), so they are typed as free-form objects.
 * `createdBy` is the server-managed creator DID carried down from the `changes`
 * feed. `epoch` is the opaque key-epoch id the resource's envelope was encrypted
 * under (absent = pre-epoch, encrypted directly to the vault key), also carried
 * down the feed.
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
 * `updatedAt` is indexed because it is the change-feed sort field / checkpoint
 * component.
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
      version: { type: 'number' },
      metaVersion: { type: 'number' },
      // The server-managed creator DID (a `did:key`), absent when unrecorded.
      createdBy: { type: 'string', maxLength: 256 },
      // The opaque key-epoch id the envelope was encrypted under, absent when
      // pre-epoch (encrypted directly to the vault key). Not indexed.
      epoch: { type: 'string', maxLength: 256 },
      // Opaque stored bodies -- content and metadata envelopes -- moved verbatim.
      data: { type: 'object', additionalProperties: true },
      custom: { type: 'object', additionalProperties: true }
    },
    required: ['id', 'updatedAt', 'version'],
    indexes: ['updatedAt']
  }
}
