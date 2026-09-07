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
    const schema = syncedDocSchema()
    expect(schema.version).toBe(0)
    expect(schema.primaryKey).toBe('id')
    expect(Object.keys(schema.properties).sort()).toEqual([
      'createdBy',
      'custom',
      'data',
      'epoch',
      'etag',
      'id',
      'metaEtag',
      'metaVersion',
      'updatedAt',
      'version'
    ])
    expect(schema.required).toEqual(['id', 'updatedAt', 'version'])
    expect(schema.indexes).toEqual(['updatedAt'])
  })

  it('returns a fresh object per call, so a caller cannot mutate the shape', () => {
    const first = syncedDocSchema()
    const second = syncedDocSchema()
    expect(first).not.toBe(second)
    expect(first).toEqual(second)
  })
})
