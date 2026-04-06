/**
 * Tests for conflict resolution — ATT-257
 */

import { describe, it, expect } from 'vitest'
import { resolveConflict } from '../src/conflict.js'
import type { ConflictCandidate, MeshItemMetadata } from '../src/types.js'

function makeCandidate(overrides: Partial<MeshItemMetadata> = {}): ConflictCandidate {
  return {
    metadata: {
      contentHash: 'default_hash',
      didOwner: 'did:sns:maria.sol',
      path: 'credentials/exam',
      version: 1,
      ttlSeconds: 0,
      createdAt: 1000,
      lastAccessedAt: 1000,
      sizeBytes: 100,
      signature: 'sig',
      solanaAnchor: null,
      ...overrides,
    },
    blob: new Uint8Array([1, 2, 3]),
  }
}

describe('resolveConflict', () => {
  it('anchored version beats non-anchored', () => {
    const anchored = makeCandidate({
      contentHash: 'anchored',
      version: 1,
      solanaAnchor: { txHash: 'tx1', slot: 100, timestamp: 1000 },
    })
    const unanchored = makeCandidate({
      contentHash: 'unanchored',
      version: 2,
    })

    const result = resolveConflict(anchored, unanchored)
    expect(result.winner.metadata.contentHash).toBe('anchored')
    expect(result.reason).toBe('anchor')
  })

  it('more recent Solana slot wins between two anchored', () => {
    const older = makeCandidate({
      contentHash: 'older',
      solanaAnchor: { txHash: 'tx1', slot: 100, timestamp: 1000 },
    })
    const newer = makeCandidate({
      contentHash: 'newer',
      solanaAnchor: { txHash: 'tx2', slot: 200, timestamp: 2000 },
    })

    const result = resolveConflict(older, newer)
    expect(result.winner.metadata.contentHash).toBe('newer')
    expect(result.reason).toBe('anchor')
  })

  it('higher version wins when no anchors', () => {
    const v1 = makeCandidate({ contentHash: 'v1', version: 1 })
    const v3 = makeCandidate({ contentHash: 'v3', version: 3 })

    const result = resolveConflict(v1, v3)
    expect(result.winner.metadata.contentHash).toBe('v3')
    expect(result.reason).toBe('timestamp')
  })

  it('more recent timestamp wins when same version', () => {
    const early = makeCandidate({ contentHash: 'early', version: 2, createdAt: 1000 })
    const late = makeCandidate({ contentHash: 'late', version: 2, createdAt: 2000 })

    const result = resolveConflict(early, late)
    expect(result.winner.metadata.contentHash).toBe('late')
    expect(result.reason).toBe('timestamp')
  })

  it('deterministic tiebreak: higher hash wins', () => {
    const a = makeCandidate({ contentHash: 'aaa', version: 1, createdAt: 1000 })
    const z = makeCandidate({ contentHash: 'zzz', version: 1, createdAt: 1000 })

    const result = resolveConflict(a, z)
    expect(result.winner.metadata.contentHash).toBe('zzz')
    expect(result.reason).toBe('hash')
  })

  it('is symmetric — same result regardless of argument order', () => {
    const a = makeCandidate({ contentHash: 'aaa', version: 1, createdAt: 1000 })
    const z = makeCandidate({ contentHash: 'zzz', version: 1, createdAt: 1000 })

    const result1 = resolveConflict(a, z)
    const result2 = resolveConflict(z, a)
    expect(result1.winner.metadata.contentHash).toBe(result2.winner.metadata.contentHash)
  })
})
