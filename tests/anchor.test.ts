/**
 * ATT-300: AnchorAdapter contract tests.
 *
 * Validates the adapter pattern, hash validation, malformed-adapter
 * defense, and the production guard on MockAnchorAdapter.
 */

import { describe, it, expect } from 'vitest'
import { anchor, MockAnchorAdapter, type AnchorAdapter } from '../src/anchor.js'
import type { SolanaAnchor } from '../src/types.js'

const VALID_HASH = 'a'.repeat(64)

describe('ATT-300: anchor() with AnchorAdapter', () => {
  it('delegates to the adapter and returns its anchor', async () => {
    const fake: SolanaAnchor = { txHash: 'sig_xyz', slot: 12345, timestamp: 1700000000000 }
    const adapter: AnchorAdapter = {
      name: 'fake',
      submit: async () => fake,
    }
    const result = await anchor(VALID_HASH, adapter)
    expect(result).toEqual(fake)
  })

  it('rejects malformed content hash before calling the adapter', async () => {
    let called = false
    const adapter: AnchorAdapter = {
      name: 'spy',
      submit: async () => {
        called = true
        return { txHash: 'x', slot: 0, timestamp: 0 }
      },
    }
    await expect(anchor('not-a-hash', adapter)).rejects.toThrow('Invalid content hash')
    expect(called).toBe(false)
  })

  it('rejects malformed adapter return values', async () => {
    const broken: AnchorAdapter = {
      name: 'broken',
      submit: async () => ({ txHash: 'x' } as unknown as SolanaAnchor),
    }
    await expect(anchor(VALID_HASH, broken)).rejects.toThrow('malformed anchor')
  })

  it('propagates adapter failures (no fallback to mock)', async () => {
    const failing: AnchorAdapter = {
      name: 'failing',
      submit: async () => { throw new Error('rpc down') },
    }
    await expect(anchor(VALID_HASH, failing)).rejects.toThrow('rpc down')
  })
})

describe('ATT-300: MockAnchorAdapter', () => {
  it('produces a deterministic-shaped mock anchor in development', async () => {
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      const result = await new MockAnchorAdapter().submit(VALID_HASH)
      expect(result.txHash).toMatch(/^mock_/)
      expect(typeof result.slot).toBe('number')
      expect(typeof result.timestamp).toBe('number')
    } finally {
      process.env.NODE_ENV = original
    }
  })

  it('refuses to run in production', async () => {
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      await expect(new MockAnchorAdapter().submit(VALID_HASH)).rejects.toThrow('cannot run in production')
    } finally {
      process.env.NODE_ENV = original
    }
  })

  it('rejects malformed content hash', async () => {
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      await expect(new MockAnchorAdapter().submit('xyz')).rejects.toThrow('Invalid content hash')
    } finally {
      process.env.NODE_ENV = original
    }
  })
})
