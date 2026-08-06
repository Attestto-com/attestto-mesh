/**
 * ChatStore — SQLite storage for chat messages.
 *
 * Separate from MeshStore (which stores encrypted blobs for others).
 * ChatStore indexes messages by channelId + sequence for efficient retrieval.
 * Messages are stored as-is (already E2E encrypted by the sender).
 */

import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { GossipChatMessage } from './types.js'

interface ChatMessageRow {
  id: string
  channel_id: string
  from_did: string
  body: string
  timestamp: string
  sequence: number
  reply_to: string | null
  attachment: string | null
  signature: string
  ack_by: string | null
  ack_at: string | null
  deleted: number
}

export class ChatStore {
  private db: Database.Database

  constructor(dataDir: string) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
    const dbPath = join(dataDir, 'chat.db')
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.initSchema()
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        from_did TEXT NOT NULL,
        body TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        reply_to TEXT,
        attachment TEXT,
        signature TEXT NOT NULL,
        ack_by TEXT,
        ack_at TEXT,
        deleted INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_chat_channel_seq ON chat_messages(channel_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_chat_channel_ts ON chat_messages(channel_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_chat_from ON chat_messages(from_did);
    `)
  }

  /**
   * Store a chat message. Returns true if stored (new), false if duplicate.
   */
  putMessage(msg: GossipChatMessage): boolean {
    const existing = this.db.prepare('SELECT id FROM chat_messages WHERE id = ?').get(msg.id)
    if (existing) return false

    this.db.prepare(`
      INSERT INTO chat_messages (id, channel_id, from_did, body, timestamp, sequence, reply_to, attachment, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msg.id,
      msg.channelId,
      msg.from,
      msg.body,
      msg.timestamp,
      msg.sequence,
      msg.replyTo ?? null,
      msg.attachment ? JSON.stringify(msg.attachment) : null,
      msg.signature
    )
    return true
  }

  /**
   * Get messages for a channel, ordered by sequence.
   */
  getMessages(channelId: string, limit = 100, afterSequence = 0): GossipChatMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM chat_messages
      WHERE channel_id = ? AND sequence > ? AND deleted = 0
      ORDER BY sequence ASC
      LIMIT ?
    `).all(channelId, afterSequence, limit) as ChatMessageRow[]

    return rows.map((row) => this.rowToMessage(row))
  }

  /**
   * Get a single message by ID.
   */
  getMessage(messageId: string): GossipChatMessage | null {
    const row = this.db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(messageId) as ChatMessageRow | undefined
    return row ? this.rowToMessage(row) : null
  }

  /**
   * Mark a message as acknowledged.
   */
  acknowledge(messageId: string, ackerDid: string, ackTimestamp: string): boolean {
    const result = this.db.prepare(`
      UPDATE chat_messages SET ack_by = ?, ack_at = ? WHERE id = ? AND ack_by IS NULL
    `).run(ackerDid, ackTimestamp, messageId)
    return result.changes > 0
  }

  /**
   * Check if a message has been acknowledged.
   */
  isAcknowledged(messageId: string): boolean {
    const row = this.db.prepare('SELECT ack_by FROM chat_messages WHERE id = ?').get(messageId) as { ack_by: string | null } | undefined
    return row?.ack_by != null
  }

  /**
   * Soft-delete a message (only if within deletion window and not acknowledged).
   * Returns true if deleted, false if not eligible.
   */
  deleteMessage(messageId: string, authorDid: string, deletionWindowMs = 60_000): boolean {
    const row = this.db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(messageId) as ChatMessageRow | undefined
    if (!row) return false

    // Only the author can delete
    if (row.from_did !== authorDid) return false

    // Cannot delete if acknowledged
    if (row.ack_by) return false

    // Cannot delete if outside window
    const messageTime = new Date(row.timestamp).getTime()
    if (Date.now() - messageTime > deletionWindowMs) return false

    this.db.prepare('UPDATE chat_messages SET deleted = 1 WHERE id = ?').run(messageId)
    return true
  }

  /**
   * Get the latest sequence number for a sender in a channel.
   */
  getLatestSequence(channelId: string, fromDid: string): number {
    const row = this.db.prepare(`
      SELECT MAX(sequence) as max_seq FROM chat_messages WHERE channel_id = ? AND from_did = ?
    `).get(channelId, fromDid) as { max_seq: number | null } | undefined
    return row?.max_seq ?? 0
  }

  /**
   * Get all channel IDs that have messages.
   */
  getChannels(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT channel_id FROM chat_messages ORDER BY channel_id').all() as { channel_id: string }[]
    return rows.map((r) => r.channel_id)
  }

  /**
   * Get message count for a channel.
   */
  getMessageCount(channelId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM chat_messages WHERE channel_id = ? AND deleted = 0').get(channelId) as { cnt: number }
    return row.cnt
  }

  close(): void {
    this.db.close()
  }

  private rowToMessage(row: ChatMessageRow): GossipChatMessage {
    const msg: GossipChatMessage = {
      type: 'chat',
      id: row.id,
      channelId: row.channel_id,
      from: row.from_did,
      body: row.body,
      timestamp: row.timestamp,
      sequence: row.sequence,
      signature: row.signature,
    }
    if (row.reply_to) msg.replyTo = row.reply_to
    if (row.attachment) msg.attachment = JSON.parse(row.attachment)
    return msg
  }
}
