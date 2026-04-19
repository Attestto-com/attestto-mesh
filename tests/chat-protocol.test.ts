/**
 * Chat protocol handler tests — verifies gossip message handling
 * for chat messages, acknowledgments, and deletions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MeshStore } from '../src/store.js'
import { ChatStore } from '../src/chat-store.js'
import { MeshProtocol } from '../src/protocol.js'
import type { MeshNode } from '../src/node.js'
import type { GossipChatMessage, GossipChatAckMessage, GossipChatDeleteMessage } from '../src/types.js'

class FakeNode extends EventEmitter {
  dhtPut = vi.fn().mockResolvedValue(undefined)
  dhtGet = vi.fn().mockResolvedValue(null)
  publish = vi.fn().mockResolvedValue(undefined)
  updateStorageMetrics = vi.fn()
  pushToAll = vi.fn().mockResolvedValue(0)
  provideContent = vi.fn().mockResolvedValue(undefined)
  peerId = 'fake-peer-id'
  isRunning = true
}

function makeChat(overrides: Partial<GossipChatMessage> = {}): GossipChatMessage {
  return {
    type: 'chat',
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    channelId: 'channel-1',
    from: 'did:sns:alice.attestto.sol',
    body: 'encrypted-body',
    timestamp: new Date().toISOString(),
    sequence: 1,
    signature: 'sig-placeholder',
    ...overrides,
  }
}

describe('Chat Protocol Handlers', () => {
  let dataDir: string
  let store: MeshStore
  let chatStore: ChatStore
  let fakeNode: FakeNode
  let protocol: MeshProtocol

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'chat-proto-'))
    store = new MeshStore(dataDir)
    chatStore = new ChatStore(dataDir)
    fakeNode = new FakeNode()
    protocol = new MeshProtocol(fakeNode as unknown as MeshNode, store, chatStore)
  })

  afterEach(() => {
    store.close()
    chatStore.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  describe('publishChat', () => {
    it('stores message locally and publishes to gossip', async () => {
      const msg = makeChat()
      await protocol.publishChat(msg)

      // Stored in chat store
      const stored = chatStore.getMessage(msg.id)
      expect(stored).not.toBeNull()
      expect(stored!.body).toBe('encrypted-body')

      // Published to gossip
      expect(fakeNode.publish).toHaveBeenCalledWith(msg)
    })

    it('emits chat:received event', async () => {
      const events: unknown[] = []
      fakeNode.on('mesh:event', (e: unknown) => events.push(e))

      const msg = makeChat()
      await protocol.publishChat(msg)

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        type: 'chat:received',
        channelId: 'channel-1',
        messageId: msg.id,
      })
    })
  })

  describe('handleChat (via gossip)', () => {
    it('stores incoming chat messages from gossip', () => {
      const msg = makeChat({ id: 'gossip-msg-1' })
      fakeNode.emit('gossip:message', msg)

      const stored = chatStore.getMessage('gossip-msg-1')
      expect(stored).not.toBeNull()
    })

    it('deduplicates messages', () => {
      const msg = makeChat({ id: 'dup-msg' })
      fakeNode.emit('gossip:message', msg)
      fakeNode.emit('gossip:message', msg)

      expect(chatStore.getMessageCount('channel-1')).toBe(1)
    })

    it('emits event only for new messages', () => {
      const events: unknown[] = []
      fakeNode.on('mesh:event', (e: unknown) => events.push(e))

      const msg = makeChat({ id: 'event-msg' })
      fakeNode.emit('gossip:message', msg)
      fakeNode.emit('gossip:message', msg) // duplicate

      const chatEvents = (events as Array<{ type: string }>).filter((e) => e.type === 'chat:received')
      expect(chatEvents).toHaveLength(1)
    })
  })

  describe('publishChatAck', () => {
    it('acknowledges a message and publishes', async () => {
      const msg = makeChat({ id: 'ack-target' })
      chatStore.putMessage(msg)

      const ack: GossipChatAckMessage = {
        type: 'chat-ack',
        messageId: 'ack-target',
        channelId: 'channel-1',
        from: 'did:sns:bob.attestto.sol',
        timestamp: new Date().toISOString(),
        signature: 'sig',
      }

      await protocol.publishChatAck(ack)

      expect(chatStore.isAcknowledged('ack-target')).toBe(true)
      expect(fakeNode.publish).toHaveBeenCalledWith(ack)
    })

    it('emits chat:ack event', async () => {
      const events: unknown[] = []
      fakeNode.on('mesh:event', (e: unknown) => events.push(e))

      const msg = makeChat({ id: 'ack-event' })
      chatStore.putMessage(msg)

      await protocol.publishChatAck({
        type: 'chat-ack',
        messageId: 'ack-event',
        channelId: 'channel-1',
        from: 'did:sns:bob.attestto.sol',
        timestamp: new Date().toISOString(),
        signature: 'sig',
      })

      const ackEvents = (events as Array<{ type: string }>).filter((e) => e.type === 'chat:ack')
      expect(ackEvents).toHaveLength(1)
    })
  })

  describe('handleChatAck (via gossip)', () => {
    it('acknowledges message when ack arrives via gossip', () => {
      const msg = makeChat({ id: 'gossip-ack' })
      chatStore.putMessage(msg)

      fakeNode.emit('gossip:message', {
        type: 'chat-ack',
        messageId: 'gossip-ack',
        channelId: 'channel-1',
        from: 'did:sns:bob.attestto.sol',
        timestamp: new Date().toISOString(),
        signature: 'sig',
      })

      expect(chatStore.isAcknowledged('gossip-ack')).toBe(true)
    })
  })

  describe('publishChatDelete', () => {
    it('deletes a message within the window', async () => {
      const msg = makeChat({ id: 'del-msg' })
      chatStore.putMessage(msg)

      const del: GossipChatDeleteMessage = {
        type: 'chat-delete',
        messageId: 'del-msg',
        channelId: 'channel-1',
        from: msg.from,
        timestamp: new Date().toISOString(),
        signature: 'sig',
      }

      const result = await protocol.publishChatDelete(del)
      expect(result).toBe(true)
      expect(fakeNode.publish).toHaveBeenCalledWith(del)
    })

    it('rejects deletion after acknowledgment', async () => {
      const msg = makeChat({ id: 'acked-msg' })
      chatStore.putMessage(msg)
      chatStore.acknowledge('acked-msg', 'did:sns:bob.attestto.sol', new Date().toISOString())

      const result = await protocol.publishChatDelete({
        type: 'chat-delete',
        messageId: 'acked-msg',
        channelId: 'channel-1',
        from: msg.from,
        timestamp: new Date().toISOString(),
        signature: 'sig',
      })

      expect(result).toBe(false)
      expect(fakeNode.publish).not.toHaveBeenCalled()
    })

    it('rejects deletion by non-author', async () => {
      const msg = makeChat({ id: 'not-mine' })
      chatStore.putMessage(msg)

      const result = await protocol.publishChatDelete({
        type: 'chat-delete',
        messageId: 'not-mine',
        channelId: 'channel-1',
        from: 'did:sns:attacker.sol',
        timestamp: new Date().toISOString(),
        signature: 'sig',
      })

      expect(result).toBe(false)
    })
  })

  describe('handleChatDelete (via gossip)', () => {
    it('deletes message when delete arrives via gossip', () => {
      const msg = makeChat({ id: 'gossip-del' })
      chatStore.putMessage(msg)

      fakeNode.emit('gossip:message', {
        type: 'chat-delete',
        messageId: 'gossip-del',
        channelId: 'channel-1',
        from: msg.from,
        timestamp: new Date().toISOString(),
        signature: 'sig',
      })

      // Message is soft-deleted — won't appear in getMessages
      expect(chatStore.getMessages('channel-1')).toHaveLength(0)
    })
  })

  describe('getChatMessages', () => {
    it('returns messages for a channel', async () => {
      chatStore.putMessage(makeChat({ id: 'a', sequence: 1 }))
      chatStore.putMessage(makeChat({ id: 'b', sequence: 2 }))

      const msgs = protocol.getChatMessages('channel-1')
      expect(msgs).toHaveLength(2)
      expect(msgs[0].sequence).toBe(1)
      expect(msgs[1].sequence).toBe(2)
    })

    it('returns empty for unknown channel', () => {
      expect(protocol.getChatMessages('nope')).toHaveLength(0)
    })
  })

  describe('protocol without chat store', () => {
    it('silently ignores chat messages when no chat store', () => {
      const noChatProtocol = new MeshProtocol(fakeNode as unknown as MeshNode, store)

      // Should not throw
      fakeNode.emit('gossip:message', makeChat())
      expect(noChatProtocol.getChatMessages('channel-1')).toHaveLength(0)
    })
  })
})
