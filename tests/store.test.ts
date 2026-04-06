/**
 * Tests for MeshStore — ATT-255
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MeshStore } from '../src/store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { MeshItemMetadata } from '../src/types.js'

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'mesh-test-'))
}

function makeMetadata(overrides: Partial<MeshItemMetadata> = {}): MeshItemMetadata {
  return {
    contentHash: 'abc123def456',
    didOwner: 'did:sns:maria.sol',
    path: 'credentials/cosevi-exam-2026',
    version: 1,
    ttlSeconds: 0,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    sizeBytes: 100,
    signature: 'sig_hex_placeholder',
    solanaAnchor: null,
    ...overrides,
  }
}

function makeBlob(size: number = 100): Uint8Array {
  return new Uint8Array(size).fill(42)
}

describe('MeshStore', () => {
  let dataDir: string
  let store: MeshStore

  beforeEach(() => {
    dataDir = makeTmpDir()
    store = new MeshStore(dataDir)
  })

  afterEach(() => {
    store.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  describe('put / get', () => {
    it('stores and retrieves an item', () => {
      const metadata = makeMetadata()
      const blob = makeBlob()
      expect(store.put(metadata, blob)).toBe(true)

      const result = store.get('abc123def456')
      expect(result).not.toBeNull()
      expect(result!.metadata.contentHash).toBe('abc123def456')
      expect(result!.metadata.didOwner).toBe('did:sns:maria.sol')
      expect(result!.blob).toEqual(blob)
    })

    it('rejects items larger than 10 KB', () => {
      const metadata = makeMetadata()
      const bigBlob = makeBlob(11 * 1024) // 11 KB
      expect(store.put(metadata, bigBlob)).toBe(false)
    })

    it('rejects when storage is full', () => {
      const tinyStore = new MeshStore(dataDir, 200) // 200 bytes max
      const metadata = makeMetadata({ sizeBytes: 150 })
      expect(tinyStore.put(metadata, makeBlob(150))).toBe(true)

      const metadata2 = makeMetadata({ contentHash: 'second_item', sizeBytes: 100 })
      expect(tinyStore.put(metadata2, makeBlob(100))).toBe(false)
      tinyStore.close()
    })

    it('returns null for non-existent hash', () => {
      expect(store.get('nonexistent')).toBeNull()
    })
  })

  describe('has', () => {
    it('returns true for stored items', () => {
      store.put(makeMetadata(), makeBlob())
      expect(store.has('abc123def456')).toBe(true)
    })

    it('returns false for missing items', () => {
      expect(store.has('nonexistent')).toBe(false)
    })
  })

  describe('delete', () => {
    it('removes an item', () => {
      store.put(makeMetadata(), makeBlob())
      expect(store.delete('abc123def456')).toBe(true)
      expect(store.has('abc123def456')).toBe(false)
    })

    it('returns false for non-existent item', () => {
      expect(store.delete('nonexistent')).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // List / Queries
  // -----------------------------------------------------------------------

  describe('list', () => {
    it('lists all items', () => {
      store.put(makeMetadata({ contentHash: 'a1' }), makeBlob())
      store.put(makeMetadata({ contentHash: 'b2', didOwner: 'did:sns:juan.sol' }), makeBlob())
      expect(store.list()).toHaveLength(2)
    })

    it('filters by DID owner', () => {
      store.put(makeMetadata({ contentHash: 'a1' }), makeBlob())
      store.put(makeMetadata({ contentHash: 'b2', didOwner: 'did:sns:juan.sol' }), makeBlob())
      const list = store.list({ didOwner: 'did:sns:maria.sol' })
      expect(list).toHaveLength(1)
      expect(list[0].contentHash).toBe('a1')
    })

    it('filters expired items', () => {
      const now = Date.now()
      store.put(makeMetadata({ contentHash: 'expired', ttlSeconds: 1, createdAt: now - 5000 }), makeBlob())
      store.put(makeMetadata({ contentHash: 'fresh', ttlSeconds: 3600, createdAt: now }), makeBlob())
      store.put(makeMetadata({ contentHash: 'permanent', ttlSeconds: 0 }), makeBlob())

      const expired = store.list({ expiredOnly: true })
      expect(expired).toHaveLength(1)
      expect(expired[0].contentHash).toBe('expired')
    })
  })

  // -----------------------------------------------------------------------
  // Versioning
  // -----------------------------------------------------------------------

  describe('versioning', () => {
    it('getLatestByKey returns highest version', () => {
      store.put(makeMetadata({ contentHash: 'v1', version: 1 }), makeBlob())
      store.put(makeMetadata({ contentHash: 'v2', version: 2 }), makeBlob())
      store.put(makeMetadata({ contentHash: 'v3', version: 3 }), makeBlob())

      const latest = store.getLatestByKey('did:sns:maria.sol', 'credentials/cosevi-exam-2026')
      expect(latest).not.toBeNull()
      expect(latest!.metadata.version).toBe(3)
    })

    it('getVersions returns all versions ordered DESC', () => {
      store.put(makeMetadata({ contentHash: 'v1', version: 1 }), makeBlob())
      store.put(makeMetadata({ contentHash: 'v2', version: 2 }), makeBlob())

      const versions = store.getVersions('did:sns:maria.sol', 'credentials/cosevi-exam-2026')
      expect(versions).toHaveLength(2)
      expect(versions[0].version).toBe(2)
      expect(versions[1].version).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // Tombstone (DID deletion)
  // -----------------------------------------------------------------------

  describe('deleteByDid', () => {
    it('removes all items for a DID', () => {
      store.put(makeMetadata({ contentHash: 'a1', path: 'cred/1' }), makeBlob())
      store.put(makeMetadata({ contentHash: 'a2', path: 'cred/2' }), makeBlob())
      store.put(makeMetadata({ contentHash: 'b1', didOwner: 'did:sns:other.sol' }), makeBlob())

      const deleted = store.deleteByDid('did:sns:maria.sol')
      expect(deleted).toBe(2)
      expect(store.list()).toHaveLength(1)
      expect(store.list()[0].didOwner).toBe('did:sns:other.sol')
    })
  })

  // -----------------------------------------------------------------------
  // Storage Metrics
  // -----------------------------------------------------------------------

  describe('getUsage', () => {
    it('returns zero for empty store', () => {
      const usage = store.getUsage()
      expect(usage.usedBytes).toBe(0)
      expect(usage.itemCount).toBe(0)
      expect(usage.percentage).toBe(0)
    })

    it('tracks used bytes and item count', () => {
      store.put(makeMetadata({ sizeBytes: 500 }), makeBlob(500))
      const usage = store.getUsage()
      expect(usage.usedBytes).toBe(500)
      expect(usage.itemCount).toBe(1)
      expect(usage.percentage).toBe(0) // 500 / 250MB ≈ 0%
    })
  })

  // -----------------------------------------------------------------------
  // Solana Anchor metadata
  // -----------------------------------------------------------------------

  describe('solana anchor', () => {
    it('stores and retrieves anchor metadata', () => {
      const metadata = makeMetadata({
        solanaAnchor: {
          txHash: 'abc123',
          slot: 12345,
          timestamp: Date.now(),
        },
      })
      store.put(metadata, makeBlob())

      const result = store.get(metadata.contentHash)
      expect(result!.metadata.solanaAnchor).not.toBeNull()
      expect(result!.metadata.solanaAnchor!.txHash).toBe('abc123')
      expect(result!.metadata.solanaAnchor!.slot).toBe(12345)
    })

    it('handles null anchor', () => {
      store.put(makeMetadata(), makeBlob())
      const result = store.get('abc123def456')
      expect(result!.metadata.solanaAnchor).toBeNull()
    })
  })
})
