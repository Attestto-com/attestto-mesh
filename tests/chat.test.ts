import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ChatStore } from '../src/chat-store.js'
import type { GossipChatMessage } from '../src/types.js'

function makeMessage(overrides: Partial<GossipChatMessage> = {}): GossipChatMessage {
  return {
    type: 'chat',
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    channelId: 'channel-1',
    from: 'did:sns:alice.attestto.sol',
    body: 'encrypted-body-base64',
    timestamp: new Date().toISOString(),
    sequence: 1,
    signature: 'sig-placeholder',
    ...overrides,
  }
}

describe('ChatStore', () => {
  let store: ChatStore
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'chat-test-'))
    store = new ChatStore(dataDir)
  })

  afterEach(() => {
    store.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  describe('putMessage', () => {
    it('stores a new message and returns true', () => {
      const msg = makeMessage()
      expect(store.putMessage(msg)).toBe(true)
    })

    it('returns false for duplicate message', () => {
      const msg = makeMessage()
      store.putMessage(msg)
      expect(store.putMessage(msg)).toBe(false)
    })

    it('stores messages with attachments', () => {
      const msg = makeMessage({
        attachment: {
          type: 'vault-reference',
          credentialId: 'cred-123',
          credentialType: 'ProfessionalLicense',
          credentialHash: 'sha256-abc',
          summary: 'Notary License — expires 2027-03',
        },
      })
      store.putMessage(msg)
      const retrieved = store.getMessage(msg.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.attachment).toEqual(msg.attachment)
    })
  })

  describe('getMessages', () => {
    it('returns messages ordered by sequence', () => {
      store.putMessage(makeMessage({ id: 'a', sequence: 3 }))
      store.putMessage(makeMessage({ id: 'b', sequence: 1 }))
      store.putMessage(makeMessage({ id: 'c', sequence: 2 }))

      const msgs = store.getMessages('channel-1')
      expect(msgs.map((m) => m.sequence)).toEqual([1, 2, 3])
    })

    it('respects afterSequence parameter', () => {
      store.putMessage(makeMessage({ id: 'a', sequence: 1 }))
      store.putMessage(makeMessage({ id: 'b', sequence: 2 }))
      store.putMessage(makeMessage({ id: 'c', sequence: 3 }))

      const msgs = store.getMessages('channel-1', 100, 1)
      expect(msgs.map((m) => m.sequence)).toEqual([2, 3])
    })

    it('respects limit parameter', () => {
      for (let i = 1; i <= 10; i++) {
        store.putMessage(makeMessage({ id: `msg-${i}`, sequence: i }))
      }

      const msgs = store.getMessages('channel-1', 3)
      expect(msgs).toHaveLength(3)
    })

    it('filters by channelId', () => {
      store.putMessage(makeMessage({ id: 'a', channelId: 'channel-1', sequence: 1 }))
      store.putMessage(makeMessage({ id: 'b', channelId: 'channel-2', sequence: 1 }))

      const msgs = store.getMessages('channel-1')
      expect(msgs).toHaveLength(1)
      expect(msgs[0].channelId).toBe('channel-1')
    })

    it('excludes deleted messages', () => {
      const msg = makeMessage({ id: 'del-me', sequence: 1 })
      store.putMessage(msg)
      store.deleteMessage('del-me', msg.from)

      const msgs = store.getMessages('channel-1')
      expect(msgs).toHaveLength(0)
    })
  })

  describe('getMessage', () => {
    it('returns null for nonexistent message', () => {
      expect(store.getMessage('nope')).toBeNull()
    })

    it('returns the stored message', () => {
      const msg = makeMessage({ replyTo: 'prev-msg' })
      store.putMessage(msg)
      const retrieved = store.getMessage(msg.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.id).toBe(msg.id)
      expect(retrieved!.replyTo).toBe('prev-msg')
    })
  })

  describe('acknowledge', () => {
    it('marks a message as acknowledged', () => {
      const msg = makeMessage()
      store.putMessage(msg)
      const acked = store.acknowledge(msg.id, 'did:sns:bob.attestto.sol', new Date().toISOString())
      expect(acked).toBe(true)
      expect(store.isAcknowledged(msg.id)).toBe(true)
    })

    it('cannot double-acknowledge', () => {
      const msg = makeMessage()
      store.putMessage(msg)
      store.acknowledge(msg.id, 'did:sns:bob.attestto.sol', new Date().toISOString())
      const again = store.acknowledge(msg.id, 'did:sns:charlie.attestto.sol', new Date().toISOString())
      expect(again).toBe(false)
    })

    it('returns false for nonexistent message', () => {
      expect(store.acknowledge('nope', 'did:x', new Date().toISOString())).toBe(false)
    })
  })

  describe('deleteMessage', () => {
    it('deletes within the window before acknowledgment', () => {
      const msg = makeMessage()
      store.putMessage(msg)
      expect(store.deleteMessage(msg.id, msg.from)).toBe(true)
    })

    it('prevents deletion after acknowledgment', () => {
      const msg = makeMessage()
      store.putMessage(msg)
      store.acknowledge(msg.id, 'did:sns:bob.attestto.sol', new Date().toISOString())
      expect(store.deleteMessage(msg.id, msg.from)).toBe(false)
    })

    it('prevents deletion by non-author', () => {
      const msg = makeMessage()
      store.putMessage(msg)
      expect(store.deleteMessage(msg.id, 'did:sns:attacker.sol')).toBe(false)
    })

    it('prevents deletion after window expires', () => {
      const msg = makeMessage({
        timestamp: new Date(Date.now() - 120_000).toISOString(), // 2 minutes ago
      })
      store.putMessage(msg)
      expect(store.deleteMessage(msg.id, msg.from)).toBe(false)
    })
  })

  describe('getLatestSequence', () => {
    it('returns 0 for empty channel', () => {
      expect(store.getLatestSequence('ch-x', 'did:x')).toBe(0)
    })

    it('returns the highest sequence', () => {
      store.putMessage(makeMessage({ id: 'a', sequence: 5 }))
      store.putMessage(makeMessage({ id: 'b', sequence: 3 }))
      store.putMessage(makeMessage({ id: 'c', sequence: 10 }))
      expect(store.getLatestSequence('channel-1', 'did:sns:alice.attestto.sol')).toBe(10)
    })
  })

  describe('getChannels', () => {
    it('returns distinct channel IDs', () => {
      store.putMessage(makeMessage({ id: 'a', channelId: 'ch-1', sequence: 1 }))
      store.putMessage(makeMessage({ id: 'b', channelId: 'ch-2', sequence: 1 }))
      store.putMessage(makeMessage({ id: 'c', channelId: 'ch-1', sequence: 2 }))
      expect(store.getChannels()).toEqual(['ch-1', 'ch-2'])
    })
  })

  describe('getMessageCount', () => {
    it('counts non-deleted messages', () => {
      store.putMessage(makeMessage({ id: 'a', sequence: 1 }))
      store.putMessage(makeMessage({ id: 'b', sequence: 2 }))
      const msg3 = makeMessage({ id: 'c', sequence: 3 })
      store.putMessage(msg3)
      store.deleteMessage('c', msg3.from)
      expect(store.getMessageCount('channel-1')).toBe(2)
    })
  })
})
