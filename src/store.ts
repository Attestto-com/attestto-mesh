/**
 * MeshStore — Local storage layer for mesh data.
 *
 * ATT-255: Almacenamiento Local del Mesh (/mesh/ store)
 *
 * SQLite index (better-sqlite3) + flat .enc files for blobs.
 * Separated from the citizen's vault — this stores OTHER people's encrypted data.
 */

import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { MeshItemMetadata, StorageMetrics, SolanaAnchor } from './types.js'

interface ItemRow {
  content_hash: string
  did_owner: string
  path: string
  version: number
  ttl_seconds: number
  created_at: number
  last_accessed_at: number
  size_bytes: number
  signature: string
  solana_tx_hash: string | null
  solana_slot: number | null
  solana_timestamp: number | null
}

export class MeshStore {
  private db: Database.Database
  private storeDir: string
  private maxStorageBytes: number

  constructor(dataDir: string, maxStorageBytes: number = 250 * 1024 * 1024) {
    this.maxStorageBytes = maxStorageBytes

    // Ensure directories exist
    const meshDir = dataDir
    this.storeDir = join(meshDir, 'store')
    if (!existsSync(meshDir)) mkdirSync(meshDir, { recursive: true })
    if (!existsSync(this.storeDir)) mkdirSync(this.storeDir, { recursive: true })

    // Initialize SQLite
    const dbPath = join(meshDir, 'index.db')
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.initSchema()
  }

  // -------------------------------------------------------------------------
  // CRUD Operations
  // -------------------------------------------------------------------------

  /**
   * Store an encrypted blob with its metadata.
   * Returns true if stored, false if rejected (duplicate, over limit).
   */
  put(metadata: MeshItemMetadata, blob: Uint8Array): boolean {
    // Check size limit
    if (blob.length > 10 * 1024) {
      return false // Item too large (>10 KB)
    }

    // Check storage capacity
    const usage = this.getUsage()
    if (usage.usedBytes + blob.length > this.maxStorageBytes) {
      return false // Storage full
    }

    // Check if we already have this exact content
    if (this.has(metadata.contentHash)) {
      // Update last_accessed_at and return
      this.touchAccess(metadata.contentHash)
      return true
    }

    // Write blob to filesystem
    const blobPath = this.blobPath(metadata.contentHash)
    writeFileSync(blobPath, blob)

    // Insert into index
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO items (
        content_hash, did_owner, path, version, ttl_seconds,
        created_at, last_accessed_at, size_bytes, signature,
        solana_tx_hash, solana_slot, solana_timestamp
      ) VALUES (
        @content_hash, @did_owner, @path, @version, @ttl_seconds,
        @created_at, @last_accessed_at, @size_bytes, @signature,
        @solana_tx_hash, @solana_slot, @solana_timestamp
      )
    `)

    stmt.run({
      content_hash: metadata.contentHash,
      did_owner: metadata.didOwner,
      path: metadata.path,
      version: metadata.version,
      ttl_seconds: metadata.ttlSeconds,
      created_at: metadata.createdAt,
      last_accessed_at: metadata.lastAccessedAt,
      size_bytes: metadata.sizeBytes,
      signature: metadata.signature,
      solana_tx_hash: metadata.solanaAnchor?.txHash ?? null,
      solana_slot: metadata.solanaAnchor?.slot ?? null,
      solana_timestamp: metadata.solanaAnchor?.timestamp ?? null,
    })

    return true
  }

  /**
   * Retrieve an encrypted blob by content hash.
   */
  get(contentHash: string): { metadata: MeshItemMetadata; blob: Uint8Array } | null {
    const row = this.db.prepare('SELECT * FROM items WHERE content_hash = ?').get(contentHash) as ItemRow | undefined
    if (!row) return null

    const blobPath = this.blobPath(contentHash)
    if (!existsSync(blobPath)) {
      // Index/blob mismatch — clean up orphan row
      this.db.prepare('DELETE FROM items WHERE content_hash = ?').run(contentHash)
      return null
    }

    // Update last_accessed_at
    this.touchAccess(contentHash)

    const blob = readFileSync(blobPath)
    return {
      metadata: this.rowToMetadata(row),
      blob: new Uint8Array(blob),
    }
  }

  /**
   * Check if a content hash exists in the store.
   */
  has(contentHash: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM items WHERE content_hash = ?').get(contentHash)
    return row !== undefined
  }

  /**
   * Delete an item by content hash.
   */
  delete(contentHash: string): boolean {
    const blobPath = this.blobPath(contentHash)
    const result = this.db.prepare('DELETE FROM items WHERE content_hash = ?').run(contentHash)

    if (existsSync(blobPath)) {
      unlinkSync(blobPath)
    }

    return result.changes > 0
  }

  /**
   * List items matching optional filters.
   */
  list(filter?: {
    didOwner?: string
    path?: string
    expiredOnly?: boolean
    maxVersion?: number
    limit?: number
    orderByAccess?: 'asc' | 'desc'
  }): MeshItemMetadata[] {
    const conditions: string[] = []
    const params: Record<string, unknown> = {}

    if (filter?.didOwner) {
      conditions.push('did_owner = @did_owner')
      params.did_owner = filter.didOwner
    }
    if (filter?.path) {
      conditions.push('path = @path')
      params.path = filter.path
    }
    if (filter?.expiredOnly) {
      conditions.push('ttl_seconds > 0 AND (created_at + ttl_seconds * 1000) < @now')
      params.now = Date.now()
    }
    if (filter?.maxVersion !== undefined) {
      conditions.push('version <= @max_version')
      params.max_version = filter.maxVersion
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const order = filter?.orderByAccess ? `ORDER BY last_accessed_at ${filter.orderByAccess.toUpperCase()}` : ''
    const limit = filter?.limit ? `LIMIT ${filter.limit}` : ''

    const sql = `SELECT * FROM items ${where} ${order} ${limit}`
    const rows = this.db.prepare(sql).all(params) as ItemRow[]
    return rows.map((row) => this.rowToMetadata(row))
  }

  /**
   * Get the latest version of an item by DID owner + path.
   */
  getLatestByKey(didOwner: string, path: string): { metadata: MeshItemMetadata; blob: Uint8Array } | null {
    const row = this.db.prepare(
      'SELECT * FROM items WHERE did_owner = ? AND path = ? ORDER BY version DESC LIMIT 1'
    ).get(didOwner, path) as ItemRow | undefined

    if (!row) return null
    return this.get(row.content_hash)
  }

  /**
   * Get all versions of an item by DID owner + path.
   */
  getVersions(didOwner: string, path: string): MeshItemMetadata[] {
    const rows = this.db.prepare(
      'SELECT * FROM items WHERE did_owner = ? AND path = ? ORDER BY version DESC'
    ).all(didOwner, path) as ItemRow[]
    return rows.map((row) => this.rowToMetadata(row))
  }

  /**
   * Delete all items belonging to a DID (tombstone propagation).
   */
  deleteByDid(didOwner: string): number {
    const items = this.db.prepare('SELECT content_hash FROM items WHERE did_owner = ?').all(didOwner) as Array<{ content_hash: string }>

    for (const item of items) {
      const blobPath = this.blobPath(item.content_hash)
      if (existsSync(blobPath)) unlinkSync(blobPath)
    }

    const result = this.db.prepare('DELETE FROM items WHERE did_owner = ?').run(didOwner)
    return result.changes
  }

  // -------------------------------------------------------------------------
  // Storage Metrics
  // -------------------------------------------------------------------------

  /**
   * Get current storage usage metrics.
   */
  getUsage(): StorageMetrics {
    const row = this.db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as total FROM items').get() as { count: number; total: number }
    return {
      usedBytes: row.total,
      limitBytes: this.maxStorageBytes,
      itemCount: row.count,
      percentage: this.maxStorageBytes > 0 ? Math.round((row.total / this.maxStorageBytes) * 100) : 0,
    }
  }

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------

  close(): void {
    this.db.close()
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        content_hash TEXT PRIMARY KEY,
        did_owner TEXT NOT NULL,
        path TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        ttl_seconds INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        signature TEXT NOT NULL,
        solana_tx_hash TEXT,
        solana_slot INTEGER,
        solana_timestamp INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_items_did_owner ON items(did_owner);
      CREATE INDEX IF NOT EXISTS idx_items_did_path ON items(did_owner, path);
      CREATE INDEX IF NOT EXISTS idx_items_ttl ON items(ttl_seconds, created_at);
      CREATE INDEX IF NOT EXISTS idx_items_lru ON items(last_accessed_at);
      CREATE INDEX IF NOT EXISTS idx_items_version ON items(did_owner, path, version);
    `)
  }

  private blobPath(contentHash: string): string {
    return join(this.storeDir, `${contentHash}.enc`)
  }

  private touchAccess(contentHash: string): void {
    this.db.prepare('UPDATE items SET last_accessed_at = ? WHERE content_hash = ?').run(Date.now(), contentHash)
  }

  private rowToMetadata(row: ItemRow): MeshItemMetadata {
    let solanaAnchor: SolanaAnchor | null = null
    if (row.solana_tx_hash && row.solana_slot !== null && row.solana_timestamp !== null) {
      solanaAnchor = {
        txHash: row.solana_tx_hash,
        slot: row.solana_slot,
        timestamp: row.solana_timestamp,
      }
    }

    return {
      contentHash: row.content_hash,
      didOwner: row.did_owner,
      path: row.path,
      version: row.version,
      ttlSeconds: row.ttl_seconds,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
      sizeBytes: row.size_bytes,
      signature: row.signature,
      solanaAnchor,
    }
  }
}
