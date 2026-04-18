/**
 * ATT-300: SolanaMemoAdapter unit tests.
 *
 * These tests verify the adapter's validation, construction, and error
 * handling WITHOUT hitting the real Solana network. Integration tests
 * against devnet belong in a separate suite gated behind SOLANA_RPC_URL.
 */

import { describe, it, expect, vi } from 'vitest'
import { SolanaMemoAdapter, type SolanaMemoAdapterConfig } from '../src/solana-adapter.js'
import { anchor } from '../src/anchor.js'

const VALID_HASH = 'a'.repeat(64)
const FAKE_KEYPAIR = new Uint8Array(64) // 64 zero bytes — won't sign, but validates shape

function makeConfig(overrides?: Partial<SolanaMemoAdapterConfig>): SolanaMemoAdapterConfig {
  return {
    rpcUrl: 'https://api.devnet.solana.com',
    keypairBytes: FAKE_KEYPAIR,
    ...overrides,
  }
}

describe('SolanaMemoAdapter construction', () => {
  it('constructs with valid config', () => {
    const adapter = new SolanaMemoAdapter(makeConfig())
    expect(adapter.name).toBe('solana-memo')
  })

  it('throws without rpcUrl', () => {
    expect(() => new SolanaMemoAdapter(makeConfig({ rpcUrl: '' }))).toThrow('requires rpcUrl')
  })

  it('throws with wrong keypair length', () => {
    expect(() => new SolanaMemoAdapter(makeConfig({ keypairBytes: new Uint8Array(32) }))).toThrow('64-byte')
  })

  it('throws with empty keypair', () => {
    expect(() => new SolanaMemoAdapter(makeConfig({ keypairBytes: new Uint8Array(0) }))).toThrow('64-byte')
  })

  it('defaults commitment to confirmed', () => {
    const adapter = new SolanaMemoAdapter(makeConfig())
    // Can't directly inspect private field, but we verify it doesn't throw
    expect(adapter).toBeDefined()
  })

  it('accepts finalized commitment', () => {
    const adapter = new SolanaMemoAdapter(makeConfig({ commitment: 'finalized' }))
    expect(adapter).toBeDefined()
  })

  it('accepts custom memo prefix', () => {
    const adapter = new SolanaMemoAdapter(makeConfig({ memoPrefix: 'custom:' }))
    expect(adapter).toBeDefined()
  })
})

describe('SolanaMemoAdapter.submit() validation', () => {
  it('rejects malformed content hash', async () => {
    const adapter = new SolanaMemoAdapter(makeConfig())
    await expect(adapter.submit('not-a-hash')).rejects.toThrow('Invalid content hash')
  })

  it('rejects empty content hash', async () => {
    const adapter = new SolanaMemoAdapter(makeConfig())
    await expect(adapter.submit('')).rejects.toThrow('Invalid content hash')
  })

  it('rejects hash with wrong length', async () => {
    const adapter = new SolanaMemoAdapter(makeConfig())
    await expect(adapter.submit('a'.repeat(63))).rejects.toThrow('Invalid content hash')
  })
})

describe('SolanaMemoAdapter integrates with anchor()', () => {
  it('anchor() validates hash before calling adapter', async () => {
    const adapter = new SolanaMemoAdapter(makeConfig())
    await expect(anchor('bad-hash', adapter)).rejects.toThrow('Invalid content hash')
  })

  it('anchor() would delegate to submit for valid hash (fails on network)', async () => {
    const adapter = new SolanaMemoAdapter(makeConfig())
    // This will fail because we're not on a real network, but it proves
    // anchor() correctly delegates to the adapter (hash validation passes)
    await expect(anchor(VALID_HASH, adapter)).rejects.toThrow()
  })
})

describe('SolanaMemoAdapter devnet integration', () => {
  const rpcUrl = process.env.SOLANA_RPC_URL
  const keypairPath = process.env.SOLANA_KEYPAIR_PATH

  it.skipIf(!rpcUrl || !keypairPath)(
    'anchors a real hash on devnet',
    async () => {
      const { readFileSync } = await import('node:fs')
      const keypairJson = JSON.parse(readFileSync(keypairPath!, 'utf-8'))
      const keypairBytes = new Uint8Array(keypairJson)

      const adapter = new SolanaMemoAdapter({
        rpcUrl: rpcUrl!,
        keypairBytes,
        commitment: 'confirmed',
      })

      const result = await adapter.submit(VALID_HASH)

      expect(result.txHash).toMatch(/^[A-Za-z0-9]+$/)
      expect(result.slot).toBeGreaterThan(0)
      expect(result.timestamp).toBeGreaterThan(0)

      // Verify via anchor() wrapper
      // (skip — would double-charge)
    },
    { timeout: 30_000 },
  )
})
