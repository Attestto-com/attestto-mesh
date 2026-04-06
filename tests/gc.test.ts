/**
 * ATT-299: GC holder-count safety rail tests.
 *
 * Validates that the LRU phase queries the DHT for real provider counts
 * and refuses to evict when fewer than minHolders peers hold the blob.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MeshStore } from '../src/store.js'
import { MeshGC } from '../src/gc.js'
import { MeshNode } from '../src/node.js'
import { hashBlob } from '../src/crypto.js'
import type { MeshItemMetadata } from '../src/types.js'

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'mesh-gc-test-'))
}

function makeMetadata(idx: number): { meta: MeshItemMetadata; blob: Uint8Array } {
  // Each blob unique (idx in first byte) so contentHash differs.
  // Stay under the 10 KB hard cap enforced by MeshStore.
  const blob = new Uint8Array(9 * 1024).fill(idx)
  return {
    meta: {
      contentHash: hashBlob(blob),
      didOwner: `did:sns:user${idx}.sol`,
      path: `data/${idx}`,
      version: 1,
      ttlSeconds: 0,
      createdAt: Date.now() - idx * 1000,
      lastAccessedAt: Date.now() - idx * 1000,
      sizeBytes: blob.length,
      signature: 'placeholder',
      solanaAnchor: null,
    },
    blob,
  }
}

class FakeNodeWithProviders extends EventEmitter {
  peerId = 'self-peer'
  isRunning = true
  updateStorageMetrics = vi.fn()
  // Configurable provider list per content hash
  providers = new Map<string, string[]>()
  findProvidersCalls = 0

  async *findProviders(contentHash: string): AsyncGenerator<string> {
    this.findProvidersCalls++
    const peers = this.providers.get(contentHash) ?? []
    for (const p of peers) yield p
  }
}

describe('ATT-299: MeshGC.estimateHolders — DHT-backed safety rail', () => {
  let dataDir: string
  let store: MeshStore
  let fakeNode: FakeNodeWithProviders
  let gc: MeshGC

  beforeEach(() => {
    dataDir = makeTmpDir()
    // Tiny storage limit so a few items push past 90 % and trigger LRU
    store = new MeshStore(dataDir, 47 * 1024) // 47 KB cap → 5×9 KB ≈ 98 %
    fakeNode = new FakeNodeWithProviders()
    gc = new MeshGC(store, fakeNode as unknown as MeshNode, 6)
  })

  afterEach(() => {
    store.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('refuses to evict when fewer than minHolders peers hold the blob', async () => {
    // Fill store to >90% — 6 items × 20 KB = 120 KB > 100 KB
    for (let i = 0; i < 5; i++) {
      const { meta, blob } = makeMetadata(i)
      store.put(meta, blob)
      // Only 2 remote holders — below minHolders=6
      fakeNode.providers.set(meta.contentHash, ['peer1', 'peer2'])
    }

    const usageBefore = store.getUsage()
    expect(usageBefore.percentage).toBeGreaterThanOrEqual(90)

    const result = await gc.run()

    expect(result.lruPruned).toBe(0)
    expect(fakeNode.findProvidersCalls).toBeGreaterThan(0)
    // Data still intact
    expect(store.getUsage().itemCount).toBe(5)
  })

  it('evicts when enough remote peers hold the blob', async () => {
    for (let i = 0; i < 5; i++) {
      const { meta, blob } = makeMetadata(i)
      store.put(meta, blob)
      // 10 remote holders — well above minHolders=6
      const peers = Array.from({ length: 10 }, (_, j) => `peer${j}`)
      fakeNode.providers.set(meta.contentHash, peers)
    }

    expect(store.getUsage().percentage).toBeGreaterThanOrEqual(90)

    const result = await gc.run()

    expect(result.lruPruned).toBeGreaterThan(0)
    expect(store.getUsage().percentage).toBeLessThanOrEqual(90)
  })

  it('does not double-count duplicate provider peer ids', async () => {
    const { meta, blob } = makeMetadata(0)
    // Force LRU phase by filling beyond cap
    store.put(meta, blob)
    for (let i = 1; i < 6; i++) {
      const m = makeMetadata(i)
      store.put(m.meta, m.blob)
      fakeNode.providers.set(m.meta.contentHash, ['p1', 'p1', 'p1', 'p1', 'p1', 'p1', 'p1'])
    }
    // 7 entries, all same peer id — should count as 1 distinct, +1 self = 2 < 6
    fakeNode.providers.set(meta.contentHash, ['p1', 'p1', 'p1', 'p1', 'p1', 'p1', 'p1'])

    const result = await gc.run()
    expect(result.lruPruned).toBe(0)
  })

  it('excludes self from the holder count', async () => {
    for (let i = 0; i < 5; i++) {
      const { meta, blob } = makeMetadata(i)
      store.put(meta, blob)
      // 5 remote peers + self in the list = should still count as 5 remote (below 6)
      fakeNode.providers.set(meta.contentHash, ['peer1', 'peer2', 'peer3', 'peer4', 'peer5', 'self-peer'])
    }

    const result = await gc.run()
    // 5 remote + 1 self = 6 holders. minHolders=6 means we need STRICTLY MORE than 6.
    // Safety rail uses `holderCount <= minHolders` so 6 is still protected.
    expect(result.lruPruned).toBe(0)
  })
})
