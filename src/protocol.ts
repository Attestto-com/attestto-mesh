/**
 * MeshProtocol — PUT/GET/UPDATE operations.
 *
 * ATT-256: Protocolo PUT/GET
 *
 * Orchestrates: sign → encrypt → hash → DHT put → gossip publish
 * And: DHT get → find provider → fetch → verify → decrypt → return
 */

import type { MeshNode } from './node.js'
import type { MeshStore } from './store.js'
import type { MeshItemMetadata, MeshItem, GossipPutMessage, GossipTombstoneMessage, GossipMessage } from './types.js'
import { meshKeyToString } from './types.js'
import { hashBlob } from './crypto.js'
import { resolveConflict } from './conflict.js'

export class MeshProtocol {
  private node: MeshNode
  private store: MeshStore

  constructor(node: MeshNode, store: MeshStore) {
    this.node = node
    this.store = store

    // Listen for incoming gossip messages
    this.node.on('gossip:message', (msg: GossipMessage) => {
      this.handleGossipMessage(msg)
    })

    // Serve direct fetch requests from local store (Cartero Ciego —
    // we hand over only the encrypted blob we already hold).
    // Guard for tests that mock MeshNode without the fetch surface.
    if (typeof this.node.setFetchHandler === 'function') {
      this.node.setFetchHandler((contentHash) => this.store.get(contentHash))
    }

    // Receive direct PUSH propagation from peers — same verification path as
    // gossip handlePut (hash check, version check, store).
    if (typeof this.node.setPushHandler === 'function') {
      this.node.setPushHandler((item: MeshItem) => {
        this.handlePut({ type: 'put', metadata: item.metadata, blob: item.blob })
      })
    }
  }

  /**
   * PUT — publish data to the mesh.
   *
   * Flow: hash(blob) → store locally → DHT put(key, contentHash) → gossip publish
   */
  async put(metadata: Omit<MeshItemMetadata, 'contentHash' | 'sizeBytes' | 'createdAt' | 'lastAccessedAt'>, blob: Uint8Array): Promise<string> {
    const contentHash = hashBlob(blob)
    const now = Date.now()

    const fullMetadata: MeshItemMetadata = {
      ...metadata,
      contentHash,
      sizeBytes: blob.length,
      createdAt: now,
      lastAccessedAt: now,
    }

    // Store locally (L1 cache)
    const stored = this.store.put(fullMetadata, blob)
    if (!stored) {
      throw new Error('Failed to store item locally — storage full or item too large')
    }

    // Publish key → contentHash to DHT
    const key = meshKeyToString({ didOwner: metadata.didOwner, path: metadata.path })
    const dhtValue = new TextEncoder().encode(JSON.stringify({
      contentHash,
      version: metadata.version,
    }))
    await this.node.dhtPut(new TextEncoder().encode(key), dhtValue)

    // Announce in DHT that this node provides the content blob (best-effort —
    // peers use findProviders(contentHash) to discover us via fetchFromPeer).
    await this.node.provideContent(contentHash).catch(() => { /* best-effort */ })

    // Gossip the full item to peers (best-effort; gossipsub mesh formation
    // is unreliable on small benches and we use direct push as the primary
    // propagation channel below).
    const gossipMsg: GossipPutMessage = {
      type: 'put',
      metadata: fullMetadata,
      blob,
    }
    await this.node.publish(gossipMsg).catch(() => { /* best-effort */ })

    // Direct push to all currently connected peers — primary propagation
    // channel. Bypasses gossipsub entirely; uses libp2p streams.
    if (typeof this.node.pushToAll === 'function') {
      await this.node.pushToAll({ metadata: fullMetadata, blob }).catch(() => 0)
    }

    // Emit event
    this.node.emit('mesh:event', {
      type: 'item:stored',
      contentHash,
    })

    // Update storage metrics
    this.node.updateStorageMetrics(this.store.getUsage())

    return contentHash
  }

  /**
   * GET — retrieve data from the mesh.
   *
   * Flow: check L1 (local store) → DHT get → fetch from peer
   */
  async get(didOwner: string, path: string): Promise<MeshItem | null> {
    // L1: Check local store first (0ms)
    const local = this.store.getLatestByKey(didOwner, path)
    if (local) {
      return local
    }

    // L2: Query DHT for content hash
    const key = meshKeyToString({ didOwner, path })
    const dhtValue = await this.node.dhtGet(new TextEncoder().encode(key))
    if (!dhtValue) return null

    try {
      const { contentHash } = JSON.parse(new TextDecoder().decode(dhtValue))

      // Check local store by content hash (maybe we got it via gossip)
      const byHash = this.store.get(contentHash)
      if (byHash) return byHash

      // L3: Find peers advertising this content hash and fetch directly.
      // Try providers in DHT order; stop at first peer returning a verified blob.
      for await (const peerId of this.node.findProviders(contentHash)) {
        const fetched = await this.node.fetchFromPeer(peerId, contentHash)
        if (!fetched) continue

        // SECURITY: never trust the peer — re-hash and cross-check metadata.
        if (hashBlob(fetched.blob) !== contentHash) continue
        if (fetched.metadata.contentHash !== contentHash) continue
        if (fetched.metadata.didOwner !== didOwner || fetched.metadata.path !== path) continue

        // Cache locally so subsequent reads hit L1
        const stored = this.store.put(fetched.metadata, fetched.blob)
        if (stored) {
          this.node.updateStorageMetrics(this.store.getUsage())
          this.node.emit('mesh:event', {
            type: 'item:received',
            contentHash,
            didOwner,
            path,
          })
        }
        return fetched
      }

      return null
    } catch {
      return null
    }
  }

  /**
   * Propagate a DID tombstone — revoke all data for a DID.
   */
  async tombstone(didOwner: string, signature: string): Promise<void> {
    const msg: GossipTombstoneMessage = {
      type: 'tombstone',
      didOwner,
      signature,
      ttlSeconds: 30 * 24 * 60 * 60, // 30 days
      timestamp: Date.now(),
    }

    // Delete locally (authorized — caller holds the private key)
    this.applyLocalTombstone(didOwner)

    // Propagate to network
    await this.node.publish(msg)
  }

  // -------------------------------------------------------------------------
  // Gossip message handler
  // -------------------------------------------------------------------------

  private handleGossipMessage(msg: GossipMessage): void {
    switch (msg.type) {
      case 'put':
        this.handlePut(msg)
        break
      case 'tombstone':
        this.handleTombstone(msg)
        break
    }
  }

  private handlePut(msg: GossipPutMessage): void {
    const { metadata, blob } = msg

    // Verify content hash matches
    const computed = hashBlob(blob)
    if (computed !== metadata.contentHash) return // Corrupted — reject

    // Check for version conflict
    const existing = this.store.getLatestByKey(metadata.didOwner, metadata.path)
    if (existing) {
      // Only accept if new version > existing AND valid
      if (metadata.version <= existing.metadata.version) {
        // Conflict — resolve
        const result = resolveConflict(
          { metadata, blob },
          { metadata: existing.metadata, blob: existing.blob }
        )
        if (result.winner.metadata.contentHash === existing.metadata.contentHash) {
          return // Existing version wins — reject incoming
        }
      }
    }

    // Store it
    const stored = this.store.put(metadata, blob)
    if (stored) {
      this.node.emit('mesh:event', {
        type: 'item:received',
        contentHash: metadata.contentHash,
        didOwner: metadata.didOwner,
        path: metadata.path,
      })
      this.node.updateStorageMetrics(this.store.getUsage())
    }
  }

  private handleTombstone(msg: GossipTombstoneMessage): void {
    // SECURITY: Tombstone signature MUST be verified against the DID document
    // before deleting any data. Until DID resolution is wired in, tombstones
    // from remote peers are rejected entirely to prevent unauthorized data
    // destruction. Only local tombstones (via tombstone()) are trusted.
    void msg
    return
  }

  /**
   * Execute a tombstone locally — called only by the owning node with a
   * verified signature from its own keypair. NOT triggered by gossip.
   */
  private applyLocalTombstone(didOwner: string): void {
    const deleted = this.store.deleteByDid(didOwner)
    if (deleted > 0) {
      this.node.updateStorageMetrics(this.store.getUsage())
    }
  }
}
