/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the two helpers that travel with the synced-document shapes:
 * the last-write-wins stamp accessor, and the JCS-canonical body equality every
 * push routing decision is made on. The comparison rule itself is
 * `remotePayloadWins`, owned and tested by `@interop/social-core`.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  bodiesEqual,
  copyOptionalBodyFields,
  lwwFields
} from '../../src/types.js'
import type { OptionalBodyFields } from '../../src/types.js'

describe('lwwFields', () => {
  it('reads the stamp off a payload carrying both fields', () => {
    expect(
      lwwFields({
        id: 'a',
        updatedAt: '2026-01-01T00:00:00.000Z',
        writerId: 'w1'
      })
    ).toEqual({ updatedAt: '2026-01-01T00:00:00.000Z', writerId: 'w1' })
  })

  it('answers null for a payload missing either field', () => {
    expect(lwwFields({ id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' })).toBe(
      null
    )
    expect(lwwFields({ id: 'a', writerId: 'w1' })).toBe(null)
    expect(lwwFields({ id: 'a' })).toBe(null)
  })

  it('answers null when either field is not a string', () => {
    expect(lwwFields({ updatedAt: 7, writerId: 'w1' })).toBe(null)
    expect(
      lwwFields({ updatedAt: '2026-01-01T00:00:00.000Z', writerId: 7 })
    ).toBe(null)
  })
})

describe('bodiesEqual', () => {
  it('treats two bodies differing only in key order as equal', () => {
    expect(
      bodiesEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })
    ).toBe(true)
  })

  it('separates bodies whose values differ', () => {
    expect(bodiesEqual({ a: 1 }, { a: 2 })).toBe(false)
  })

  it('treats an absent body and an explicit null as the same', () => {
    expect(bodiesEqual(undefined, null)).toBe(true)
  })

  it('keeps array order significant', () => {
    expect(bodiesEqual([1, 2], [2, 1])).toBe(false)
  })
})

describe('copyOptionalBodyFields', () => {
  it('carries every present optional field, including createdBy', () => {
    const target: OptionalBodyFields = {}
    copyOptionalBodyFields({
      source: {
        data: { a: 1 },
        custom: { b: 2 },
        metaVersion: 3,
        epoch: 'epoch-1',
        createdBy: 'did:key:z6MkCreator'
      },
      target
    })
    expect(target).toEqual({
      data: { a: 1 },
      custom: { b: 2 },
      metaVersion: 3,
      epoch: 'epoch-1',
      createdBy: 'did:key:z6MkCreator'
    })
  })

  it('leaves an absent field absent rather than writing undefined', () => {
    const target: OptionalBodyFields = {}
    copyOptionalBodyFields({ source: { data: { a: 1 } }, target })
    expect('createdBy' in target).toBe(false)
    expect('epoch' in target).toBe(false)
  })
})
