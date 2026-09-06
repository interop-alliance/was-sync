/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the logging seam (`src/log.ts`): the type-only
 * assignability check against `@interop/logger`'s own `Logger` type, the
 * unwired console fallback, and the wired path through `setLogger`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureLogger } from '@interop/logger'
import type { Logger as PortLogger } from '@interop/logger'
import { log, setLogger } from '../../src/log.js'
import type { Logger } from '../../src/log.js'

// The compile-time half of the "library port" contract (decision 0004 in
// the @interop/logger repo): the locally declared `Logger` in src/log.ts and
// the package's own `Logger` type must stay mutually assignable, even though
// src/log.ts itself takes no reference to the package. A drift in either
// shape fails `tsc`, not this assertion at runtime.
function assertMutuallyAssignable(): void {
  const asPortLogger: PortLogger = log
  const asLocalLogger: Logger = asPortLogger
  void asLocalLogger
}
assertMutuallyAssignable()

describe('the console fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs through the prefixed console when no logger is installed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    log.warn('x', { a: 1 })

    expect(warn).toHaveBeenCalledWith('[was-sync]', 'x', { a: 1 })
  })

  it('passes no trailing argument when called with no data', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})

    log.debug('x')

    expect(debug).toHaveBeenCalledWith('[was-sync]', 'x')
  })
})

describe('setLogger', () => {
  afterEach(() => {
    // vitest isolates modules per FILE, not per test: an injected logger
    // left standing here would leak into every other test in this file.
    setLogger({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    })
  })

  it('routes calls to the installed logger and reports structured events', () => {
    const capture = captureLogger('sync')
    const previous = setLogger(capture.logger)

    const err = new Error('boom')
    log.error('msg', { err, id: 'r1' })

    expect(capture.events).toHaveLength(1)
    const event = capture.events[0]!
    expect(event.ns).toBe('sync')
    expect(event.level).toBe('error')
    expect(event.msg).toBe('msg')
    expect(event.err).toBe(err)
    expect(event.data).toEqual({ id: 'r1' })

    const restored = setLogger(previous)
    expect(restored).toBe(capture.logger)
  })
})
