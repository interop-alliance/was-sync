import { describe, it, expect } from 'vitest'
import { Example } from '../../src/index.js'

describe('Example', () => {
  it('calls function', async () => {
    const ex = new Example()
    expect(ex.hello()).toBe('world')
  })
})
