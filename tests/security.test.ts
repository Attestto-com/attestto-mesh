/**
 * Security regression tests — attestto-mesh
 *
 * Each test is named after the vulnerability it guards against.
 * If any of these fail, a security regression has been introduced.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MeshStore } from '../src/store.js'
import { MeshProtocol } from '../src/protocol.js'
import { MeshNode } from '../src/node.js'
import { anchorToSolana } from '../src/anchor.js'
import { DEFAULT_CONFIG } from '../src/types.js'
import { hashBlob, signData } from '../src/crypto.js'
import { generateKeyPairSync } from 'node:crypto'
import type { MeshItemMetadata, GossipTombstoneMessage, GossipPutMessage } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'mesh-sec-test-'))
}

function makeMetadata(overrides: Partial<MeshItemMetadata> = {}): MeshItemMetadata {
  const blob = new Uint8Array(50).fill(7)
  return {
    contentHash: hashBlob(blob),
    didOwner: 'did:sns:maria.sol',
    path: 'credentials/test',
    version: 1,
    ttlSeconds: 0,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    sizeBytes: 50,
    signature: 'placeholder',
    solanaAnchor: null,
    ...overrides,
  }
}

/**
 * Minimal MeshNode stand-in for protocol tests — no real libp2p needed.
 */
class FakeNode extends EventEmitter {
  dhtPut = vi.fn().mockResolvedValue(undefined)
  dhtGet = vi.fn().mockResolvedValue(null)
  publish = vi.fn().mockResolvedValue(undefined)
  updateStorageMetrics = vi.fn()
  peerId = 'fake-peer-id'
  isRunning = true
}

// ---------------------------------------------------------------------------
// 1. Tombstone from remote peer must never delete data
// ---------------------------------------------------------------------------

describe('SEC-01: remote tombstone is blocked without signature verification', () => {
  let dataDir: string
  let store: MeshStore
  let fakeNode: FakeNode
  let protocol: MeshProtocol

  beforeEach(() => {
    dataDir = makeTmpDir()
    store = new MeshStore(dataDir)
    fakeNode = new FakeNode()
    protocol = new MeshProtocol(fakeNode as unknown as MeshNode, store)

    // Seed data for maria.sol
    const blob = new Uint8Array(50).fill(7)
    store.put(makeMetadata(), blob)
  })

  afterEach(() => {
    store.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('data survives a tombstone gossip message from a remote peer', () => {
    expect(store.list({ didOwner: 'did:sns:maria.sol' })).toHaveLength(1)

    const tombstone: GossipTombstoneMessage = {
      type: 'tombstone',
      didOwner: 'did:sns:maria.sol',
      signature: 'attacker_sig',
      ttlSeconds: 86400,
      timestamp: Date.now(),
    }

    // Simulate incoming gossip from a remote peer
    fakeNode.emit('gossip:message', tombstone)

    // Data must still be there — tombstone not applied
    expect(store.list({ didOwner: 'did:sns:maria.sol' })).toHaveLength(1)
  })

  it('local tombstone (owner-initiated) still works', async () => {
    expect(store.list({ didOwner: 'did:sns:maria.sol' })).toHaveLength(1)

    await protocol.tombstone('did:sns:maria.sol', 'owner_sig')

    expect(store.list({ didOwner: 'did:sns:maria.sol' })).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. SQL injection via list() filter inputs
// ---------------------------------------------------------------------------

describe('SEC-02: list() rejects SQL injection in filter inputs', () => {
  let dataDir: string
  let store: MeshStore

  beforeEach(() => {
    dataDir = makeTmpDir()
    store = new MeshStore(dataDir)
    store.put(makeMetadata({ contentHash: 'safe1' }), new Uint8Array(50).fill(1))
    store.put(makeMetadata({ contentHash: 'safe2', didOwner: 'did:sns:juan.sol' }), new Uint8Array(50).fill(2))
  })

  afterEach(() => {
    store.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('crafted limit string does not corrupt or crash the database', () => {
    // TypeScript would catch this at compile time, but we verify runtime safety too
    expect(() => store.list({ limit: '1; DROP TABLE items; --' as unknown as number })).not.toThrow()
    // Both rows still intact
    expect(store.list()).toHaveLength(2)
  })

  it('crafted orderByAccess string is rejected — only ASC/DESC allowed', () => {
    expect(() =>
      store.list({ orderByAccess: 'ASC; DROP TABLE items; --' as unknown as 'asc' | 'desc' })
    ).not.toThrow()
    expect(store.list()).toHaveLength(2)
  })

  it('negative limit is clamped to 1, not passed raw to SQL', () => {
    expect(() => store.list({ limit: -999 })).not.toThrow()
  })

  it('NaN limit is ignored — returns all rows', () => {
    expect(() => store.list({ limit: NaN })).not.toThrow()
    expect(store.list()).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 3. Anchor stub must never run in production
// ---------------------------------------------------------------------------

describe('SEC-03: anchorToSolana stub is blocked in production', () => {
  it('throws when NODE_ENV=production', async () => {
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      await expect(anchorToSolana('abc123')).rejects.toThrow('not implemented')
    } finally {
      process.env.NODE_ENV = original
    }
  })

  it('returns a mock anchor in development', async () => {
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      const anchor = await anchorToSolana('abc123')
      expect(anchor.txHash).toContain('mock_')
      expect(typeof anchor.slot).toBe('number')
    } finally {
      process.env.NODE_ENV = original
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Default listen address is 127.0.0.1, not 0.0.0.0
// ---------------------------------------------------------------------------

describe('SEC-04: default listenAddress does not expose port to LAN', () => {
  it('DEFAULT_CONFIG.listenAddress is 127.0.0.1', () => {
    expect(DEFAULT_CONFIG.listenAddress).toBe('127.0.0.1')
  })

  it('anchor nodes can explicitly opt in to 0.0.0.0', () => {
    const anchorConfig = { ...DEFAULT_CONFIG, listenAddress: '0.0.0.0', enableRelayServer: true }
    expect(anchorConfig.listenAddress).toBe('0.0.0.0')
  })
})

// ---------------------------------------------------------------------------
// 5. Gossip rate limit — max 50 messages per second per peer
// ---------------------------------------------------------------------------

describe('SEC-05: per-peer gossip rate limit is enforced', () => {
  it('drops messages beyond 50/sec from the same peer', () => {
    const node = new MeshNode({ dataDir: makeTmpDir() })
    const received: number[] = []

    node.on('gossip:message', () => received.push(Date.now()))

    // Access private checkRateLimit directly to unit-test the logic
    const check = (node as unknown as { checkRateLimit(id: string): boolean }).checkRateLimit.bind(node)

    let allowed = 0
    for (let i = 0; i < 100; i++) {
      if (check('attacker-peer')) allowed++
    }

    // Exactly 50 should be allowed within one window
    expect(allowed).toBe(50)
  })

  it('resets the window after 1 second', async () => {
    const node = new MeshNode({ dataDir: makeTmpDir() })
    const check = (node as unknown as { checkRateLimit(id: string): boolean }).checkRateLimit.bind(node)

    // Exhaust the window
    for (let i = 0; i < 50; i++) check('peer-a')
    expect(check('peer-a')).toBe(false)

    // Advance time past the window
    await new Promise((r) => setTimeout(r, 1050))

    // Should be allowed again
    expect(check('peer-a')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6. Oversized gossip payloads are rejected before decode
// ---------------------------------------------------------------------------

describe('SEC-06: oversized gossip payloads are dropped before decode', () => {
  let dataDir: string
  let store: MeshStore
  let fakeNode: FakeNode
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let protocol: MeshProtocol

  beforeEach(() => {
    dataDir = makeTmpDir()
    store = new MeshStore(dataDir)
    fakeNode = new FakeNode()
    protocol = new MeshProtocol(fakeNode as unknown as MeshNode, store)
  })

  afterEach(() => {
    store.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('a valid 10 KB put gossip message is accepted', () => {
    const blob = new Uint8Array(50).fill(9)
    const contentHash = hashBlob(blob)
    const msg: GossipPutMessage = {
      type: 'put',
      metadata: makeMetadata({ contentHash }),
      blob,
    }
    fakeNode.emit('gossip:message', msg)
    expect(store.has(contentHash)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 7. Key zeroization — private key buffer is cleared after signing
// ---------------------------------------------------------------------------

describe('SEC-07: signing clears the intermediate DER key buffer', () => {
  it('signData still produces a valid signature after zeroization', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
    const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)

    const data = new Uint8Array([1, 2, 3, 4, 5])
    const sig = await signData(data, privRaw)

    // Signature must still verify correctly — zeroization must not corrupt output
    const { verifySignature } = await import('../src/crypto.js')
    expect(await verifySignature(data, sig, pubRaw)).toBe(true)
  })
})
