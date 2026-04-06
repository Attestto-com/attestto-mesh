/**
 * MeshGC — Garbage Collection.
 *
 * ATT-258: Garbage Collection
 *
 * Three-layer GC:
 * 1. TTL expired → delete
 * 2. Old versions (keep canonical + 1 rollback) → delete
 * 3. LRU under pressure, with 6-holder safety rail
 */

import type { MeshStore } from './store.js'
import type { MeshNode } from './node.js'
import type { MeshItemMetadata } from './types.js'

export interface GCResult {
  ttlPruned: number
  versionsPruned: number
  lruPruned: number
  totalPruned: number
  bytesFreed: number
}

export class MeshGC {
  private store: MeshStore
  private node: MeshNode
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private minHolders: number

  constructor(store: MeshStore, node: MeshNode, minHolders: number = 6) {
    this.store = store
    this.node = node
    this.minHolders = minHolders
  }

  /**
   * Start the GC scheduler.
   */
  start(intervalMs: number): void {
    if (this.intervalHandle) return
    this.intervalHandle = setInterval(() => {
      this.run().catch(() => {})
    }, intervalMs)
  }

  /**
   * Stop the GC scheduler.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
  }

  /**
   * Run a full GC cycle.
   */
  async run(): Promise<GCResult> {
    const usageBefore = this.store.getUsage()
    let lruPruned = 0

    // Phase 1: TTL expired
    const ttlPruned = this.pruneTTL()

    // Phase 2: Old versions (keep canonical + 1 rollback)
    const versionsPruned = this.pruneOldVersions()

    // Phase 3: LRU eviction under storage pressure
    const usageAfterPhase2 = this.store.getUsage()
    if (usageAfterPhase2.percentage > 90) {
      lruPruned = await this.pruneLRU()
    }

    const usageAfter = this.store.getUsage()
    const totalPruned = ttlPruned + versionsPruned + lruPruned
    const bytesFreed = usageBefore.usedBytes - usageAfter.usedBytes

    if (totalPruned > 0) {
      this.node.emit('mesh:event', {
        type: 'gc:completed',
        itemsPruned: totalPruned,
        bytesFreed,
      })
      this.node.updateStorageMetrics(usageAfter)
    }

    return { ttlPruned, versionsPruned, lruPruned, totalPruned, bytesFreed }
  }

  // -------------------------------------------------------------------------
  // Phase 1: TTL
  // -------------------------------------------------------------------------

  private pruneTTL(): number {
    const expired = this.store.list({ expiredOnly: true })
    for (const item of expired) {
      this.store.delete(item.contentHash)
    }
    return expired.length
  }

  // -------------------------------------------------------------------------
  // Phase 2: Old versions (canonical + 1 rollback only)
  // -------------------------------------------------------------------------

  private pruneOldVersions(): number {
    let pruned = 0

    // Get all unique DID+path combinations that have >2 versions
    const allItems = this.store.list()
    const keyMap = new Map<string, MeshItemMetadata[]>()

    for (const item of allItems) {
      const key = `${item.didOwner}::${item.path}`
      const existing = keyMap.get(key) ?? []
      existing.push(item)
      keyMap.set(key, existing)
    }

    for (const [, versions] of keyMap) {
      if (versions.length <= 2) continue

      // Sort by version DESC — keep top 2
      versions.sort((a, b) => b.version - a.version)
      const toDelete = versions.slice(2)

      for (const item of toDelete) {
        this.store.delete(item.contentHash)
        pruned++
      }
    }

    return pruned
  }

  // -------------------------------------------------------------------------
  // Phase 3: LRU eviction with safety rail
  // -------------------------------------------------------------------------

  private async pruneLRU(): Promise<number> {
    let pruned = 0
    const target = 80 // Evict until usage < 80%

    while (true) {
      const usage = this.store.getUsage()
      if (usage.percentage <= target) break

      // Get least recently accessed items
      const candidates = this.store.list({
        orderByAccess: 'asc',
        limit: 10,
      })

      if (candidates.length === 0) break

      let evictedAny = false
      for (const candidate of candidates) {
        // Safety rail: never evict if holders < minHolders
        // TODO: In production, query DHT for holderCount
        // For now, always allow eviction (demo/dev mode)
        const holderCount = await this.estimateHolders(candidate.contentHash)
        if (holderCount <= this.minHolders) {
          // DO NOT evict — emit pressure alert
          this.node.emit('mesh:event', {
            type: 'storage:pressure',
            percentage: usage.percentage,
          })
          continue
        }

        this.store.delete(candidate.contentHash)
        this.node.emit('mesh:event', {
          type: 'item:evicted',
          contentHash: candidate.contentHash,
          reason: 'lru',
        })
        pruned++
        evictedAny = true
      }

      if (!evictedAny) break // All candidates are protected
    }

    return pruned
  }

  /**
   * Estimate how many peers hold a given content hash.
   *
   * TODO: Query DHT findProviders in production.
   * For dev/demo, returns a high number to allow eviction.
   */
  private async estimateHolders(_contentHash: string): Promise<number> {
    // In production: query DHT findProviders
    // For now: return safe-to-evict value for development
    return 100
  }
}
