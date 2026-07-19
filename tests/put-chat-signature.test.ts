/**
 * SOC-59 regression — inbound writes and chat messages must be signature-verified.
 *
 * The mesh is public: any peer can dial and publish. These tests guard the
 * property that a peer cannot write under a DID it does not control, cannot
 * overwrite a victim's version, and cannot forge/delete chat messages.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPairSync } from 'node:crypto'
import { MeshStore } from '../src/store.js'
import { ChatStore } from '../src/chat-store.js'
import { MeshProtocol } from '../src/protocol.js'
import type { MeshNode } from '../src/node.js'
import { hashBlob } from '../src/crypto.js'
import {
  resolveDidKey,
  didKeyFromEd25519,
  signPutMetadata,
  signChatMessage,
  signChatDelete,
} from '../src/verify.js'
import type {
  MeshItemMetadata,
  GossipPutMessage,
  GossipChatMessage,
  GossipChatDeleteMessage,
} from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Identity {
  did: string
  pub: Uint8Array
  priv: Uint8Array
}

function makeIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)
  return { did: didKeyFromEd25519(pub), pub, priv }
}

class FakeNode extends EventEmitter {
  dhtPut = vi.fn().mockResolvedValue(undefined)
  dhtGet = vi.fn().mockResolvedValue(null)
  publish = vi.fn().mockResolvedValue(undefined)
  updateStorageMetrics = vi.fn()
  peerId = 'fake-peer-id'
  isRunning = true
}

async function signedPut(
  id: Identity,
  overrides: Partial<MeshItemMetadata> = {},
  blob = new Uint8Array(40).fill(3)
): Promise<GossipPutMessage> {
  const base: MeshItemMetadata = {
    contentHash: hashBlob(blob),
    didOwner: id.did,
    path: 'credentials/test',
    version: 1,
    ttlSeconds: 0,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    sizeBytes: blob.length,
    signature: '',
    solanaAnchor: null,
    ...overrides,
  }
  base.signature = await signPutMetadata(base, id.priv)
  return { type: 'put', metadata: base, blob }
}

// ---------------------------------------------------------------------------
// did:key resolver
// ---------------------------------------------------------------------------

describe('resolveDidKey / didKeyFromEd25519', () => {
  it('round-trips a raw Ed25519 public key', () => {
    const id = makeIdentity()
    const resolved = resolveDidKey(id.did)
    expect(resolved).not.toBeNull()
    expect(Buffer.from(resolved!).equals(Buffer.from(id.pub))).toBe(true)
  })

  it('returns null for non-did:key methods', () => {
    expect(resolveDidKey('did:sns:maria.sol')).toBeNull()
  })

  it('returns null for a malformed did:key', () => {
    expect(resolveDidKey('did:key:zNOTvalidbase58!!')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PUT verification
// ---------------------------------------------------------------------------

describe('SOC-59: inbound PUT requires a valid owner signature', () => {
  let dataDir: string
  let store: MeshStore
  let fakeNode: FakeNode
  let owner: Identity

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mesh-putsig-'))
    store = new MeshStore(dataDir)
    fakeNode = new FakeNode()
    // Default resolver (did:key). No custom resolver injected.
    new MeshProtocol(fakeNode as unknown as MeshNode, store)
    owner = makeIdentity()
  })

  afterEach(() => {
    store.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('accepts a correctly signed put from the owning did:key', async () => {
    const put = await signedPut(owner)
    fakeNode.emit('gossip:message', put)
    expect(store.has(put.metadata.contentHash)).toBe(true)
  })

  it('rejects a put with a placeholder/absent signature', async () => {
    const put = await signedPut(owner)
    put.metadata.signature = 'placeholder'
    fakeNode.emit('gossip:message', put)
    expect(store.has(put.metadata.contentHash)).toBe(false)
  })

  it('rejects a put whose namespace is claimed but signed by a different key', async () => {
    // Attacker signs with their own key but sets didOwner to the victim's DID.
    const attacker = makeIdentity()
    const victim = makeIdentity()
    const put = await signedPut(attacker, { didOwner: victim.did })
    fakeNode.emit('gossip:message', put)
    expect(store.has(put.metadata.contentHash)).toBe(false)
  })

  it('rejects a did:sns put under the default resolver (fail-closed)', async () => {
    const put = await signedPut(owner, { didOwner: 'did:sns:maria.sol' })
    fakeNode.emit('gossip:message', put)
    expect(store.has(put.metadata.contentHash)).toBe(false)
  })

  it('a forged higher version cannot overwrite the owner\'s latest', async () => {
    // Owner legitimately publishes v1.
    const v1 = await signedPut(owner, { version: 1 }, new Uint8Array(40).fill(1))
    fakeNode.emit('gossip:message', v1)
    expect(store.getLatestByKey(owner.did, 'credentials/test')!.metadata.version).toBe(1)

    // Attacker sends v2 for the same key with an invalid signature.
    const attacker = makeIdentity()
    const forged = await signedPut(attacker, { didOwner: owner.did, version: 2 }, new Uint8Array(40).fill(2))
    forged.metadata.signature = 'attacker-sig'
    fakeNode.emit('gossip:message', forged)

    // v1 must survive; the forged v2 is not stored.
    const latest = store.getLatestByKey(owner.did, 'credentials/test')!
    expect(latest.metadata.version).toBe(1)
    expect(store.has(forged.metadata.contentHash)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// did:sns via injected resolver
// ---------------------------------------------------------------------------

describe('SOC-59: injected resolver enables non-did:key methods', () => {
  let dataDir: string
  let store: MeshStore
  let fakeNode: FakeNode

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mesh-snsres-'))
    store = new MeshStore(dataDir)
    fakeNode = new FakeNode()
  })

  afterEach(() => {
    store.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('accepts a did:sns put when a resolver maps the DID to the signing key', async () => {
    const id = makeIdentity()
    const resolver = (did: string) => (did === 'did:sns:maria.sol' ? id.pub : null)
    new MeshProtocol(fakeNode as unknown as MeshNode, store, undefined, { didResolver: resolver })

    const put = await signedPut(id, { didOwner: 'did:sns:maria.sol' })
    fakeNode.emit('gossip:message', put)
    expect(store.has(put.metadata.contentHash)).toBe(true)
  })

  it('rejects when the resolver returns the wrong key for the DID', async () => {
    const signer = makeIdentity()
    const wrong = makeIdentity()
    const resolver = (did: string) => (did === 'did:sns:maria.sol' ? wrong.pub : null)
    new MeshProtocol(fakeNode as unknown as MeshNode, store, undefined, { didResolver: resolver })

    const put = await signedPut(signer, { didOwner: 'did:sns:maria.sol' })
    fakeNode.emit('gossip:message', put)
    expect(store.has(put.metadata.contentHash)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Chat verification
// ---------------------------------------------------------------------------

describe('SOC-59: inbound chat requires a valid sender signature', () => {
  let dataDir: string
  let store: MeshStore
  let chatStore: ChatStore
  let fakeNode: FakeNode
  let sender: Identity

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mesh-chatsig-'))
    store = new MeshStore(dataDir)
    chatStore = new ChatStore(dataDir)
    fakeNode = new FakeNode()
    new MeshProtocol(fakeNode as unknown as MeshNode, store, chatStore)
    sender = makeIdentity()
  })

  afterEach(() => {
    store.close()
    chatStore.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  async function signedChat(id: Identity, overrides: Partial<GossipChatMessage> = {}): Promise<GossipChatMessage> {
    const msg: GossipChatMessage = {
      type: 'chat',
      id: `m-${Math.random().toString(36).slice(2)}`,
      channelId: 'channel-1',
      from: id.did,
      body: 'ciphertext',
      timestamp: new Date().toISOString(),
      sequence: 1,
      signature: '',
      ...overrides,
    }
    msg.signature = await signChatMessage(msg, id.priv)
    return msg
  }

  it('stores a correctly signed chat message', async () => {
    const msg = await signedChat(sender, { id: 'good-1' })
    fakeNode.emit('gossip:message', msg)
    expect(chatStore.getMessage('good-1')).not.toBeNull()
  })

  it('rejects a chat message with a forged sender (bad signature)', async () => {
    const attacker = makeIdentity()
    const victim = makeIdentity()
    // Attacker signs with their key but claims to be the victim.
    const msg = await signedChat(attacker, { id: 'forged-1', from: victim.did })
    fakeNode.emit('gossip:message', msg)
    expect(chatStore.getMessage('forged-1')).toBeNull()
  })

  it('a peer cannot delete a message it did not author', async () => {
    // Sender legitimately posts a message.
    const msg = await signedChat(sender, { id: 'victim-msg' })
    fakeNode.emit('gossip:message', msg)
    expect(chatStore.getMessage('victim-msg')).not.toBeNull()

    // Attacker forges a delete claiming to be the sender.
    const attacker = makeIdentity()
    const del: GossipChatDeleteMessage = {
      type: 'chat-delete',
      messageId: 'victim-msg',
      channelId: 'channel-1',
      from: sender.did,
      timestamp: new Date().toISOString(),
      signature: '',
    }
    del.signature = await signChatDelete(del, attacker.priv) // wrong key
    fakeNode.emit('gossip:message', del)

    // Still present — forged delete rejected.
    expect(chatStore.getMessages('channel-1').some((m) => m.id === 'victim-msg')).toBe(true)
  })

  it('accepts a delete signed by the actual author', async () => {
    const msg = await signedChat(sender, { id: 'mine-to-delete' })
    fakeNode.emit('gossip:message', msg)

    const del: GossipChatDeleteMessage = {
      type: 'chat-delete',
      messageId: 'mine-to-delete',
      channelId: 'channel-1',
      from: sender.did,
      timestamp: new Date().toISOString(),
      signature: '',
    }
    del.signature = await signChatDelete(del, sender.priv)
    fakeNode.emit('gossip:message', del)

    expect(chatStore.getMessages('channel-1').some((m) => m.id === 'mine-to-delete')).toBe(false)
  })
})
