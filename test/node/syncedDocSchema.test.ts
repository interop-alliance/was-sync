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
import { optionalBodyFields } from '../../src/types.js'

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
        updatedAtCounter: { type: 'integer', minimum: 0 },
        originId: { type: 'string', maxLength: 64 },
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
        createdBy: { type: 'string', maxLength: 256 },
        epoch: { type: 'string', maxLength: 256 },
        etag: { type: 'string', maxLength: 256 },
        metaEtag: { type: 'string', maxLength: 256 },
        data: { type: 'object', additionalProperties: true },
        custom: { type: 'object', additionalProperties: true }
      },
      required: ['id', 'updatedAt'],
      indexes: ['updatedAt']
    })
  })

  it('declares exactly the required pair plus every optional body field', () => {
    // The schema literal is kept by hand (RxDB hashes it), so this holds it in
    // step with the one key table the mappings and the equality run on.
    expect(Object.keys(syncedDocSchema().properties).sort()).toStrictEqual(
      ['id', 'updatedAt', ...optionalBodyFields].sort()
    )
  })

  it('drops the integer revision members for the server write stamp', () => {
    const schema = syncedDocSchema()
    expect('version' in schema.properties).toBe(false)
    expect('metaVersion' in schema.properties).toBe(false)
    expect(schema.required).toStrictEqual(['id', 'updatedAt'])
    expect(schema.version).toBe(0)
  })

  it('types both counters as non-negative integers', () => {
    const { properties } = syncedDocSchema()
    const meta = properties['meta']!['properties'] as Record<
      string,
      Record<string, unknown>
    >
    for (const counter of [
      properties['updatedAtCounter']!,
      meta['updatedAtCounter']!
    ]) {
      expect(counter).toStrictEqual({ type: 'integer', minimum: 0 })
    }
  })

  it('requires all four members of a present meta stamp', () => {
    const meta = syncedDocSchema().properties['meta']!
    expect(meta['type']).toBe('object')
    expect(meta['required']).toStrictEqual([
      'updatedAt',
      'updatedAtCounter',
      'originId',
      'generation'
    ])
    expect(Object.keys(meta['properties'] as object)).toStrictEqual(
      meta['required']
    )
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
    expect(second.required).toStrictEqual(['id', 'updatedAt'])
    expect(second.indexes).toStrictEqual(['updatedAt'])
  })
})
