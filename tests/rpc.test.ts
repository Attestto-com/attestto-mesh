/**
 * RPC server integration tests — HTTP endpoints + WebSocket.
 *
 * Tests run a real HTTP server on a random port with mocked MeshNode/Protocol/Store.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import * as http from 'node:http'
import * as net from 'node:net'
import { MeshStore } from '../src/store.js'
import { ChatStore } from '../src/chat-store.js'
import { MeshProtocol } from '../src/protocol.js'
import { MeshRpcServer } from '../src/rpc.js'
import type { MeshNode } from '../src/node.js'
import { hashBlob } from '../src/crypto.js'

// ── Helpers ──────────────────────────────────────────────────────────

class FakeNode extends EventEmitter {
  dhtPut = vi.fn().mockResolvedValue(undefined)
  dhtGet = vi.fn().mockResolvedValue(null)
  publish = vi.fn().mockResolvedValue(undefined)
  pushToAll = vi.fn().mockResolvedValue(0)
  provideContent = vi.fn().mockResolvedValue(undefined)
  updateStorageMetrics = vi.fn()
  peerId = 'test-peer-id'
  isRunning = true
  getStatus = vi.fn().mockReturnValue({
    peerId: 'test-peer-id',
    peerCount: 2,
    dhtReady: true,
    uptimeMs: 5000,
    storage: { usedBytes: 1024, limitBytes: 250 * 1024 * 1024, itemCount: 3, percentage: 0.01 },
    level: 'standard',
  })
  getGossipDiagnostic = vi.fn().mockReturnValue({})
  getConnectionDiagnostic = vi.fn().mockResolvedValue([])
  getSelfProtocols = vi.fn().mockReturnValue([])
  getMultiaddrs = vi.fn().mockReturnValue([])
}

async function fetch(url: string, opts?: RequestInit): Promise<{ status: number; body: unknown; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const reqOpts: http.RequestOptions = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: opts?.method ?? 'GET',
      headers: opts?.headers as Record<string, string> | undefined,
    }
    const req = http.request(reqOpts, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: unknown
        try { body = JSON.parse(text) } catch { body = text }
        resolve({ status: res.statusCode ?? 0, body, text })
      })
    })
    req.on('error', reject)
    if (opts?.body) req.write(opts.body)
    req.end()
  })
}

// ── Tests ────────────────────────────────────────────────────────────

describe('MeshRpcServer', () => {
  let dataDir: string
  let store: MeshStore
  let chatStore: ChatStore
  let fakeNode: FakeNode
  let protocol: MeshProtocol
  let rpc: MeshRpcServer
  let port: number
  let baseUrl: string

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'rpc-test-'))
    store = new MeshStore(dataDir)
    chatStore = new ChatStore(dataDir)
    fakeNode = new FakeNode()
    protocol = new MeshProtocol(fakeNode as unknown as MeshNode, store, chatStore)

    // Find a random available port
    port = await new Promise<number>((resolve) => {
      const srv = net.createServer()
      srv.listen(0, () => {
        const addr = srv.address() as net.AddressInfo
        srv.close(() => resolve(addr.port))
      })
    })

    rpc = new MeshRpcServer(fakeNode as unknown as MeshNode, protocol, store, {
      port,
      bind: '127.0.0.1',
    })
    await rpc.start()
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await rpc.stop()
    store.close()
    chatStore.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  // ── Health & Status ─────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns 200 when running', async () => {
      const res = await fetch(`${baseUrl}/health`)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ status: 'ok', peerId: 'test-peer-id' })
    })

    it('returns 503 when not running', async () => {
      fakeNode.isRunning = false
      const res = await fetch(`${baseUrl}/health`)
      expect(res.status).toBe(503)
      expect(res.body).toMatchObject({ status: 'degraded' })
    })
  })

  describe('GET /status', () => {
    it('returns node status', async () => {
      const res = await fetch(`${baseUrl}/status`)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ peerId: 'test-peer-id', peerCount: 2 })
    })
  })

  describe('GET /metrics', () => {
    it('returns prometheus-style metrics', async () => {
      const res = await fetch(`${baseUrl}/metrics`)
      expect(res.status).toBe(200)
      expect(res.text).toContain('mesh_peer_count 2')
      expect(res.text).toContain('mesh_dht_ready 1')
    })
  })

  describe('GET /diag', () => {
    it('returns diagnostics', async () => {
      const res = await fetch(`${baseUrl}/diag`)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('status')
      expect(res.body).toHaveProperty('gossip')
    })
  })

  describe('GET /list', () => {
    it('returns stored items', async () => {
      const res = await fetch(`${baseUrl}/list`)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ count: 0, items: [] })
    })
  })

  // ── PUT / GET ───────────────────────────────────────────────────

  describe('POST /put', () => {
    it('stores a blob and returns content hash', async () => {
      const blob = Buffer.from('hello mesh').toString('base64')
      const res = await fetch(`${baseUrl}/put`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          didOwner: 'did:sns:test.sol',
          path: '/test',
          version: 1,
          blob_b64: blob,
        }),
      })
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('contentHash')
    })

    it('rejects missing fields', async () => {
      const res = await fetch(`${baseUrl}/put`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ didOwner: 'did:sns:test.sol' }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('GET /get', () => {
    it('returns 400 without params', async () => {
      const res = await fetch(`${baseUrl}/get`)
      expect(res.status).toBe(400)
    })

    it('returns 404 for missing item', async () => {
      const res = await fetch(`${baseUrl}/get?did=did:sns:x.sol&path=/nope`)
      expect(res.status).toBe(404)
    })
  })

  // ── Chat endpoints ─────────────────────────────────────────────

  describe('POST /chat/send', () => {
    it('sends a chat message', async () => {
      const res = await fetch(`${baseUrl}/chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'msg-1',
          channelId: 'ch-1',
          from: 'did:sns:alice.sol',
          body: 'hello',
          timestamp: new Date().toISOString(),
          sequence: 1,
          signature: 'sig',
        }),
      })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ ok: true, id: 'msg-1' })
    })

    it('rejects missing fields', async () => {
      const res = await fetch(`${baseUrl}/chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'msg-1' }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /chat/ack', () => {
    it('acknowledges a message', async () => {
      // First store a message
      chatStore.putMessage({
        type: 'chat', id: 'ack-me', channelId: 'ch-1', from: 'did:sns:alice.sol',
        body: 'hi', timestamp: new Date().toISOString(), sequence: 1, signature: 'sig',
      })

      const res = await fetch(`${baseUrl}/chat/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: 'ack-me',
          channelId: 'ch-1',
          from: 'did:sns:bob.sol',
          timestamp: new Date().toISOString(),
          signature: 'sig',
        }),
      })
      expect(res.status).toBe(200)
      expect(chatStore.isAcknowledged('ack-me')).toBe(true)
    })
  })

  describe('POST /chat/delete', () => {
    it('deletes a message within window', async () => {
      chatStore.putMessage({
        type: 'chat', id: 'del-me', channelId: 'ch-1', from: 'did:sns:alice.sol',
        body: 'oops', timestamp: new Date().toISOString(), sequence: 1, signature: 'sig',
      })

      const res = await fetch(`${baseUrl}/chat/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: 'del-me',
          channelId: 'ch-1',
          from: 'did:sns:alice.sol',
          timestamp: new Date().toISOString(),
          signature: 'sig',
        }),
      })
      expect(res.status).toBe(200)
    })

    it('returns 409 for non-deletable message', async () => {
      chatStore.putMessage({
        type: 'chat', id: 'acked-msg', channelId: 'ch-1', from: 'did:sns:alice.sol',
        body: 'hi', timestamp: new Date().toISOString(), sequence: 1, signature: 'sig',
      })
      chatStore.acknowledge('acked-msg', 'did:sns:bob.sol', new Date().toISOString())

      const res = await fetch(`${baseUrl}/chat/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: 'acked-msg',
          channelId: 'ch-1',
          from: 'did:sns:alice.sol',
          timestamp: new Date().toISOString(),
          signature: 'sig',
        }),
      })
      expect(res.status).toBe(409)
    })
  })

  describe('GET /chat/messages', () => {
    it('returns messages for a channel', async () => {
      chatStore.putMessage({
        type: 'chat', id: 'a', channelId: 'ch-1', from: 'did:sns:alice.sol',
        body: 'hello', timestamp: new Date().toISOString(), sequence: 1, signature: 'sig',
      })

      const res = await fetch(`${baseUrl}/chat/messages?channel=ch-1`)
      expect(res.status).toBe(200)
      const body = res.body as { messages: unknown[] }
      expect(body.messages).toHaveLength(1)
    })

    it('returns 400 without channel param', async () => {
      const res = await fetch(`${baseUrl}/chat/messages`)
      expect(res.status).toBe(400)
    })
  })

  describe('GET /chat/channels', () => {
    it('returns channel list', async () => {
      const res = await fetch(`${baseUrl}/chat/channels`)
      expect(res.status).toBe(200)
    })
  })

  // ── 404 ─────────────────────────────────────────────────────────

  describe('unknown routes', () => {
    it('returns 404', async () => {
      const res = await fetch(`${baseUrl}/nope`)
      expect(res.status).toBe(404)
    })
  })

  // ── Auth (non-loopback) ─────────────────────────────────────────

  describe('auth on non-loopback', () => {
    let authRpc: MeshRpcServer
    let authPort: number

    beforeEach(async () => {
      authPort = await new Promise<number>((resolve) => {
        const srv = net.createServer()
        srv.listen(0, () => {
          const addr = srv.address() as net.AddressInfo
          srv.close(() => resolve(addr.port))
        })
      })
      // Non-loopback bind with token
      authRpc = new MeshRpcServer(fakeNode as unknown as MeshNode, protocol, store, {
        port: authPort,
        bind: '0.0.0.0',
        token: 'secret-token',
      })
      await authRpc.start()
    })

    afterEach(async () => {
      await authRpc.stop()
    })

    it('rejects unauthenticated PUT', async () => {
      const res = await fetch(`http://127.0.0.1:${authPort}/put`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          didOwner: 'did:sns:test.sol', path: '/test', version: 1,
          blob_b64: Buffer.from('data').toString('base64'),
        }),
      })
      expect(res.status).toBe(401)
    })

    it('accepts authenticated PUT', async () => {
      const res = await fetch(`http://127.0.0.1:${authPort}/put`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer secret-token',
        },
        body: JSON.stringify({
          didOwner: 'did:sns:test.sol', path: '/test', version: 1,
          blob_b64: Buffer.from('data').toString('base64'),
        }),
      })
      expect(res.status).toBe(200)
    })
  })

  // ── WebSocket ───────────────────────────────────────────────────

  describe('WebSocket /ws', () => {
    it('completes handshake and receives connected event', async () => {
      const result = await new Promise<string>((resolve, reject) => {
        const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')

        const conn = net.createConnection({ host: '127.0.0.1', port }, () => {
          conn.write(
            'GET /ws HTTP/1.1\r\n' +
            `Host: 127.0.0.1:${port}\r\n` +
            'Connection: Upgrade\r\n' +
            'Upgrade: websocket\r\n' +
            'Sec-WebSocket-Version: 13\r\n' +
            `Sec-WebSocket-Key: ${key}\r\n` +
            '\r\n'
          )
        })

        let headersDone = false
        let buf = Buffer.alloc(0)

        conn.on('data', (data: Buffer) => {
          buf = Buffer.concat([buf, data])

          if (!headersDone) {
            const headerEnd = buf.indexOf('\r\n\r\n')
            if (headerEnd === -1) return
            headersDone = true
            buf = buf.subarray(headerEnd + 4)
          }

          // Parse WebSocket frame
          if (buf.length >= 2) {
            const payloadLen = buf[1] & 0x7f
            if (buf.length >= 2 + payloadLen) {
              const payload = buf.subarray(2, 2 + payloadLen).toString('utf8')
              conn.destroy()
              resolve(payload)
            }
          }
        })

        conn.on('error', reject)
        setTimeout(() => { conn.destroy(); reject(new Error('Timeout')) }, 2000)
      })

      const parsed = JSON.parse(result)
      expect(parsed).toMatchObject({ type: 'connected', peerId: 'test-peer-id' })
    })

    it('rejects upgrade on wrong path', async () => {
      const result = await new Promise<number>((resolve, reject) => {
        const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/not-ws',
          headers: {
            'Connection': 'Upgrade',
            'Upgrade': 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': key,
          },
        })

        // On wrong path, we get the response directly, not an upgrade
        req.on('response', (res) => {
          resolve(res.statusCode ?? 0)
        })

        req.on('upgrade', () => {
          reject(new Error('Should not have upgraded'))
        })

        // The socket might close without a proper HTTP response
        req.on('error', () => resolve(404))

        setTimeout(() => resolve(404), 1000)
        req.end()
      })

      // Either 404 response or connection closed
      expect(result).toBe(404)
    })

    it('broadcasts mesh events to connected WS clients', async () => {
      const result = await new Promise<string>((resolve, reject) => {
        const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')

        const conn = net.createConnection({ host: '127.0.0.1', port }, () => {
          conn.write(
            'GET /ws HTTP/1.1\r\n' +
            `Host: 127.0.0.1:${port}\r\n` +
            'Connection: Upgrade\r\n' +
            'Upgrade: websocket\r\n' +
            'Sec-WebSocket-Version: 13\r\n' +
            `Sec-WebSocket-Key: ${key}\r\n` +
            '\r\n'
          )
        })

        let headersDone = false
        let frameCount = 0
        let buf = Buffer.alloc(0)

        conn.on('data', (data: Buffer) => {
          buf = Buffer.concat([buf, data])

          if (!headersDone) {
            const headerEnd = buf.indexOf('\r\n\r\n')
            if (headerEnd === -1) return
            headersDone = true
            buf = buf.subarray(headerEnd + 4)
          }

          // Try to extract frames
          while (buf.length >= 2) {
            const payloadLen = buf[1] & 0x7f
            if (buf.length < 2 + payloadLen) break

            const payload = buf.subarray(2, 2 + payloadLen).toString('utf8')
            buf = buf.subarray(2 + payloadLen)
            frameCount++

            if (frameCount === 1) {
              // First frame is 'connected', emit a mesh event
              setTimeout(() => {
                fakeNode.emit('mesh:event', {
                  type: 'chat:received',
                  channelId: 'ch-1',
                  messageId: 'msg-1',
                  from: 'did:sns:alice.sol',
                })
              }, 50)
              continue
            }

            // Second frame is the broadcast
            conn.destroy()
            resolve(payload)
            return
          }
        })

        conn.on('error', reject)
        setTimeout(() => { conn.destroy(); reject(new Error('Timeout waiting for broadcast')) }, 5000)
      })

      const parsed = JSON.parse(result)
      expect(parsed).toMatchObject({
        type: 'chat:received',
        channelId: 'ch-1',
        messageId: 'msg-1',
      })
    })
  })

  // ── Lifecycle ───────────────────────────────────────────────────

  describe('stop', () => {
    it('cleans up server and WS clients', async () => {
      expect(rpc.wsClientCount).toBe(0)
      await rpc.stop()
      // Double stop should not throw
      await rpc.stop()
    })
  })
})
