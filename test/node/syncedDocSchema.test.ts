/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The replica schema is stored state rather than a code detail: RxDB hashes it
 * and refuses to open an existing replica whose stored hash differs at the same
 * `version`. These cases pin the merged shape (the union of the two copies the
 * package was built from) and the version it ships at, so a change that would
 * strand every existing replica cannot land unnoticed.
 */
import { describe, expect, it } from 'vitest'
import { syncedDocSchema } from '../../src/syncedDocSchema.js'

describe('syncedDocSchema', () => {
  it('ships the merged shape at version 0', () => {
    // The full literal, not a key list: RxDB's schema hash covers every member,
    // so a changed type, maxLength, or additionalProperties strands a replica.
    expect(syncedDocSchema()).toStrictEqual({
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 256 },
        updatedAt: { type: 'string', maxLength: 64 },
        version: { type: 'number' },
        metaVersion: { type: 'number' },
        createdBy: { type: 'string', maxLength: 256 },
        epoch: { type: 'string', maxLength: 256 },
        etag: { type: 'string', maxLength: 256 },
        metaEtag: { type: 'string', maxLength: 256 },
        data: { type: 'object', additionalProperties: true },
        custom: { type: 'object', additionalProperties: true }
      },
      required: ['id', 'updatedAt', 'version'],
      indexes: ['updatedAt']
    })
  })

  it('returns a fresh object per call, so a caller cannot mutate the shape', () => {
    const first = syncedDocSchema()
    first.properties['id']!['maxLength'] = 1
    first.properties['extra'] = { type: 'string' }
    first.required.push('extra')
    first.indexes.push('extra')

    const second = syncedDocSchema()
    expect(second).not.toBe(first)
    expect(second.properties['id']).toStrictEqual({
      type: 'string',
      maxLength: 256
    })
    expect('extra' in second.properties).toBe(false)
    expect(second.required).toStrictEqual(['id', 'updatedAt', 'version'])
    expect(second.indexes).toStrictEqual(['updatedAt'])
  })
})
