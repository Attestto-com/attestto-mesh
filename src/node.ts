/**
 * MeshNode — libp2p node for the Attestto distributed mesh.
 *
 * ATT-254: Infraestructura libp2p en Electron Main Process
 *
 * Transporte: TCP + WebRTC
 * Cifrado: Noise
 * Muxer: Yamux
 * DHT: Kademlia
 * Pubsub: GossipSub
 */

import { createLibp2p, type Libp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { kadDHT } from '@libp2p/kad-dht'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { bootstrap } from '@libp2p/bootstrap'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2'
import type { PrivateKey } from '@libp2p/interface'
import { EventEmitter } from 'node:events'
import { CID } from 'multiformats/cid'
import * as Digest from 'multiformats/hashes/digest'
import * as raw from 'multiformats/codecs/raw'
import { concat as uint8Concat } from 'uint8arrays/concat'
import type {
  MeshNodeConfig,
  MeshNodeStatus,
  MeshEvent,
  NodeLevel,
  StorageMetrics,
  GossipMessage,
  MeshItem,
  MeshItemMetadata,
} from './types.js'
import { DEFAULT_CONFIG } from './types.js'

/** libp2p protocol id for direct blob fetch by content hash */
const FETCH_PROTOCOL = '/attestto/mesh/fetch/1.0.0'

/** SHA-256 multihash code */
const SHA256_CODE = 0x12

/** Max blob fetch payload (envelope) — guard against malicious peers */
const MAX_FETCH_BYTES = 64 * 1024

/**
 * Minimal libp2p stream surface — avoids importing the (unstable) interface
 * package while keeping dialProtocol/handle handlers strongly typed enough.
 */
interface LibStream {
  source: AsyncIterable<Uint8Array | { subarray: () => Uint8Array }>
  sink: (source: AsyncIterable<Uint8Array>) => Promise<void>
  close?: () => Promise<void>
}

/** Read all bytes from a libp2p stream up to maxBytes; returns null on overflow. */
async function readStreamCapped(stream: LibStream, maxBytes: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of stream.source) {
    const u8 = chunk instanceof Uint8Array ? chunk : chunk.subarray()
    total += u8.length
    if (total > maxBytes) return null
    chunks.push(u8)
  }
  return uint8Concat(chunks, total)
}

function gossipTopic(meshId: string): string {
  return `/attestto/mesh/${meshId}/1.0.0`
}

/** Per-peer rate limit: max messages per sliding window */
const RATE_LIMIT_MAX = 50
const RATE_LIMIT_WINDOW_MS = 1000

interface PeerRateState {
  count: number
  windowStart: number
}

export class MeshNode extends EventEmitter {
  private node: Libp2p | null = null
  private config: MeshNodeConfig
  private topic: string
  private startedAt: number = 0
  private _storageMetrics: StorageMetrics = {
    usedBytes: 0,
    limitBytes: 0,
    itemCount: 0,
    percentage: 0,
  }
  private peerRates = new Map<string, PeerRateState>()
  private fetchHandler: ((contentHash: string) => MeshItem | null) | null = null
  private privateKey: PrivateKey | undefined

  constructor(config: Partial<MeshNodeConfig> & { dataDir: string; privateKey?: PrivateKey }) {
    super()
    const { privateKey, ...rest } = config
    this.privateKey = privateKey
    this.config = { ...DEFAULT_CONFIG, ...rest }
    this.topic = gossipTopic(this.config.meshId)
  }

  /**
   * Start the libp2p node and join the mesh.
   */
  async start(): Promise<void> {
    if (this.node) return

    const services: Record<string, unknown> = {
      identify: identify(),
      ping: ping(),
      dht: kadDHT({
        clientMode: false,
      }),
      pubsub: gossipsub({
        emitSelf: false,
        allowPublishToZeroTopicPeers: true,
        // floodPublish: send to ALL peers known to support the protocol, not
        // just the topic-mesh subset. Critical for tiny benches (< D=6 peers)
        // where mesh formation is unreliable. Slight overhead at scale, but
        // we never have huge fanout in our model anyway.
        floodPublish: true,
        // Allow the mesh to form with just 1 peer. Defaults are D=6/Dlo=4/Dhi=12
        // which strand small networks.
        D: 4,
        Dlo: 1,
        Dhi: 8,
      }),
    }

    // Relay server — for anchor nodes with public IPs that help NAT peers connect
    if (this.config.enableRelayServer) {
      services.relay = circuitRelayServer()
    }

    const peerDiscovery: Array<unknown> = []
    if (this.config.bootstrapPeers.length > 0) {
      peerDiscovery.push(
        bootstrap({ list: this.config.bootstrapPeers })
      )
    }

    // Transports: TCP always, relay client for NAT traversal
    const transports: Array<unknown> = [tcp()]
    if (this.config.enableRelayClient) {
      transports.push(circuitRelayTransport())
    }

    this.node = await createLibp2p({
      ...(this.privateKey ? { privateKey: this.privateKey } : {}),
      addresses: {
        listen: [`/ip4/${this.config.listenAddress}/tcp/${this.config.listenPort}`],
      },
      transports: transports as never[],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: peerDiscovery as never[],
      services: services as never,
    })

    // Wire up peer events
    this.node.addEventListener('peer:connect', (evt) => {
      const peerId = evt.detail.toString()
      this.emitMeshEvent({ type: 'peer:connected', peerId })
    })

    this.node.addEventListener('peer:disconnect', (evt) => {
      const peerId = evt.detail.toString()
      this.peerRates.delete(peerId)
      this.emitMeshEvent({ type: 'peer:disconnected', peerId })
    })

    // Wire up gossipsub message listener (subscribe is deferred until AFTER
    // node.start() — subscribing on a not-yet-started node leaves the
    // subscription in a pre-start state that never propagates to peers).
    const pubsub = this.getPubsub()
    if (pubsub) {
      pubsub.addEventListener('message', (evt: unknown) => {
        const e = evt as { detail: { topic: string; data: Uint8Array; from?: { toString(): string } } }
        if (e.detail.topic !== this.topic) return

        // Rate limit per sender peer
        const senderId = e.detail.from?.toString() ?? 'unknown'
        if (!this.checkRateLimit(senderId)) return

        // Reject oversized raw payloads before attempting to decode
        if (e.detail.data.length > 12 * 1024) return

        try {
          const msg = this.decodeGossipMessage(e.detail.data)
          this.emit('gossip:message', msg)
        } catch {
          // Malformed message — ignore
        }
      })
    }

    // Register direct blob fetch protocol — peers ask us for a contentHash,
    // we serve from local store (only items we already hold).
    await (this.node as unknown as {
      handle: (
        protocol: string,
        handler: (info: { stream: LibStream }) => void | Promise<void>
      ) => Promise<void>
    }).handle(FETCH_PROTOCOL, ({ stream }) => {
      void this.serveFetchStream(stream)
    })

    await this.node.start()
    this.startedAt = Date.now()

    // Subscribe AFTER start so the subscription announcement actually fires
    // to (current and future) connected peers via gossipsub.
    const pubsubStarted = this.getPubsub()
    if (pubsubStarted) {
      pubsubStarted.subscribe(this.topic)
    }
  }

  /**
   * Register a handler that resolves a contentHash to a local MeshItem.
   * Called by MeshProtocol so the node can serve fetch requests from peers.
   */
  setFetchHandler(fn: (contentHash: string) => MeshItem | null): void {
    this.fetchHandler = fn
  }

  /**
   * Announce to the DHT that this node provides the given content hash.
   * Best-effort — silently ignores failures (no peers, DHT not ready, etc.).
   */
  async provideContent(contentHash: string): Promise<void> {
    const dht = this.getDHT() as unknown as {
      provide?: (cid: CID) => AsyncIterable<unknown>
    } | null
    if (!dht || typeof dht.provide !== 'function') return
    const TIMEOUT_MS = 3000
    try {
      const cid = this.contentHashToCid(contentHash)
      const drain = (async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _evt of dht.provide!(cid)) { /* drain */ }
      })()
      await Promise.race([
        drain,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('provide timeout')), TIMEOUT_MS)
        ),
      ])
    } catch {
      // best-effort
    }
  }

  /**
   * Find peers in the DHT that advertise the given content hash.
   * Yields opaque peer-id objects suitable for fetchFromPeer().
   */
  async *findProviders(contentHash: string): AsyncGenerator<unknown> {
    const dht = this.getDHT() as unknown as {
      findProviders?: (cid: CID) => AsyncIterable<{
        name: string
        providers?: Array<{ id: unknown }>
      }>
    } | null
    if (!dht || typeof dht.findProviders !== 'function') return
    let cid: CID
    try {
      cid = this.contentHashToCid(contentHash)
    } catch {
      return
    }
    try {
      for await (const event of dht.findProviders(cid)) {
        if (event.name === 'PROVIDER' && Array.isArray(event.providers)) {
          for (const p of event.providers) {
            if (p && p.id) yield p.id
          }
        }
      }
    } catch {
      // empty
    }
  }

  /**
   * Open a direct stream to a provider peer and request the blob for
   * a given content hash. Returns null on any error or empty response.
   * Caller MUST verify the returned hash matches before trusting the data.
   */
  async fetchFromPeer(peerId: unknown, contentHash: string): Promise<MeshItem | null> {
    if (!this.node) return null
    try {
      const stream = await (this.node as unknown as {
        dialProtocol: (peer: unknown, protocols: string | string[]) => Promise<LibStream>
      }).dialProtocol(peerId, FETCH_PROTOCOL)

      const req = new TextEncoder().encode(contentHash)
      await stream.sink((async function* () { yield req })())

      const data = await readStreamCapped(stream, MAX_FETCH_BYTES)
      await stream.close?.()?.catch(() => undefined)
      if (!data || data.length === 0) return null
      return this.decodeMeshItem(data)
    } catch {
      return null
    }
  }

  /**
   * Internal: handle an inbound fetch stream — read contentHash, look it up
   * in the local store via fetchHandler, write the encoded MeshItem (or
   * empty on miss) and close.
   */
  private async serveFetchStream(stream: LibStream): Promise<void> {
    try {
      const reqBytes = await readStreamCapped(stream, 256)
      const contentHash = new TextDecoder().decode(reqBytes).trim()
      // SHA-256 hex is exactly 64 chars — reject anything else
      if (!/^[0-9a-f]{64}$/i.test(contentHash)) {
        await stream.sink((async function* () { yield new Uint8Array(0) })())
        return
      }
      const item = this.fetchHandler ? this.fetchHandler(contentHash) : null
      const payload = item ? this.encodeMeshItem(item) : new Uint8Array(0)
      await stream.sink((async function* () { yield payload })())
    } catch {
      // ignore
    } finally {
      await stream.close?.()?.catch(() => undefined)
    }
  }

  private contentHashToCid(contentHash: string): CID {
    const bytes = new Uint8Array(contentHash.length / 2)
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(contentHash.slice(i * 2, i * 2 + 2), 16)
    }
    const mh = Digest.create(SHA256_CODE, bytes)
    return CID.create(1, raw.code, mh)
  }

  private encodeMeshItem(item: MeshItem): Uint8Array {
    const json = JSON.stringify(item, (_k, v) => {
      if (v instanceof Uint8Array) return { __uint8array: true, data: Array.from(v) }
      return v
    })
    return new TextEncoder().encode(json)
  }

  private decodeMeshItem(data: Uint8Array): MeshItem | null {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(data), (_k, v) => {
        if (v && typeof v === 'object' && (v as { __uint8array?: boolean }).__uint8array) {
          return new Uint8Array((v as { data: number[] }).data)
        }
        return v
      }) as { metadata: MeshItemMetadata; blob: Uint8Array }
      if (!parsed || !parsed.metadata || !(parsed.blob instanceof Uint8Array)) return null
      return parsed
    } catch {
      return null
    }
  }

  /**
   * Stop the node gracefully.
   */
  async stop(): Promise<void> {
    if (!this.node) return
    const pubsub = this.getPubsub()
    if (pubsub) {
      pubsub.unsubscribe(this.topic)
    }
    await this.node.stop()
    this.node = null
    this.startedAt = 0
  }

  /**
   * Publish a gossip message to all mesh peers.
   */
  async publish(message: GossipMessage): Promise<void> {
    const pubsub = this.getPubsub()
    if (!pubsub) throw new Error('Node not started')
    const data = this.encodeGossipMessage(message)
    await pubsub.publish(this.topic, data)
  }

  /**
   * Put a value into the DHT — best-effort with a timeout.
   *
   * On a small mesh (< K=20 peers), Kademlia's put waits for replication to
   * K closest peers and effectively never completes. We don't want PUT to
   * block on that: gossip carries the full message to currently-connected
   * peers, and the DHT entry is only needed for peers that join LATER and
   * have to look up the (didOwner, path) → contentHash mapping. Treat the
   * DHT write as opportunistic — log timeouts and move on.
   */
  async dhtPut(key: Uint8Array, value: Uint8Array): Promise<void> {
    const dht = this.getDHT()
    if (!dht) throw new Error('Node not started')
    const TIMEOUT_MS = 3000
    try {
      await Promise.race([
        dht.put(key, value),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('dhtPut timeout')), TIMEOUT_MS)
        ),
      ])
    } catch {
      // best-effort — gossip is the primary delivery channel
    }
  }

  /**
   * Get a value from the DHT.
   */
  async dhtGet(key: Uint8Array): Promise<Uint8Array | null> {
    const dht = this.getDHT()
    if (!dht) throw new Error('Node not started')
    const TIMEOUT_MS = 3000
    try {
      const find = (async (): Promise<Uint8Array | null> => {
        for await (const event of dht.get(key)) {
          if (event.name === 'VALUE' && event.value) return event.value
        }
        return null
      })()
      return await Promise.race([
        find,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
      ])
    } catch {
      return null
    }
  }

  /**
   * Get the current node status.
   */
  getStatus(): MeshNodeStatus {
    if (!this.node) {
      return {
        peerId: '',
        peerCount: 0,
        dhtReady: false,
        uptimeMs: 0,
        storage: this._storageMetrics,
        level: 'light',
      }
    }

    const peers = this.node.getPeers()
    return {
      peerId: this.node.peerId.toString(),
      peerCount: peers.length,
      dhtReady: peers.length > 0,
      uptimeMs: Date.now() - this.startedAt,
      storage: this._storageMetrics,
      level: this.calculateLevel(peers.length),
    }
  }

  /**
   * Update storage metrics (called by MeshStore).
   */
  updateStorageMetrics(metrics: StorageMetrics): void {
    this._storageMetrics = metrics
    if (metrics.percentage > 90) {
      this.emitMeshEvent({ type: 'storage:pressure', percentage: metrics.percentage })
    }
  }

  /**
   * Get the libp2p peer ID.
   */
  get peerId(): string {
    return this.node?.peerId.toString() ?? ''
  }

  /**
   * Check if node is running.
   */
  get isRunning(): boolean {
    return this.node !== null
  }

  /**
   * Diagnostic — returns gossipsub mesh state for the current topic.
   * Used by RPC /diag to debug message propagation issues on small benches.
   */
  /** Diagnostic — list protocols THIS node advertises via identify. */
  getSelfProtocols(): string[] {
    if (!this.node) return []
    try {
      const protos = (this.node as unknown as { getProtocols: () => string[] }).getProtocols()
      return protos
    } catch {
      return []
    }
  }

  /** Diagnostic — list libp2p connections + protocols negotiated per peer. */
  async getConnectionDiagnostic(): Promise<Array<{
    peerId: string
    activeStreams: string[]
    streamCount: number
    remoteProtocols: string[]
  }>> {
    if (!this.node) return []
    const node = this.node as unknown as {
      getConnections: () => Array<{
        remotePeer: { toString: () => string }
        streams: Array<{ protocol?: string }>
      }>
      peerStore: {
        get: (peerId: unknown) => Promise<{ protocols?: string[] } | undefined>
      }
    }
    const connections = node.getConnections()
    const out: Array<{
      peerId: string
      activeStreams: string[]
      streamCount: number
      remoteProtocols: string[]
    }> = []
    for (const c of connections) {
      let remoteProtocols: string[] = []
      try {
        const peer = await node.peerStore.get(c.remotePeer as unknown as object)
        remoteProtocols = peer?.protocols ?? []
      } catch {
        remoteProtocols = []
      }
      out.push({
        peerId: c.remotePeer.toString(),
        activeStreams: c.streams.map((s) => s.protocol ?? '?'),
        streamCount: c.streams.length,
        remoteProtocols,
      })
    }
    return out
  }

  getGossipDiagnostic(): {
    topic: string
    selfTopics: string[]
    subscribers: string[]
    meshPeers: string[]
    allPubsubPeers: string[]
  } {
    const pubsub = this.getPubsub() as unknown as {
      getTopics?: () => string[]
      getSubscribers?: (topic: string) => Array<{ toString: () => string }>
      getMeshPeers?: (topic: string) => string[]
      getPeers?: () => Array<{ toString: () => string }>
    } | null
    if (!pubsub) return { topic: this.topic, selfTopics: [], subscribers: [], meshPeers: [], allPubsubPeers: [] }
    const selfTopics = typeof pubsub.getTopics === 'function' ? pubsub.getTopics() : []
    const subscribers = typeof pubsub.getSubscribers === 'function'
      ? pubsub.getSubscribers(this.topic).map((p) => p.toString())
      : []
    const meshPeers = typeof pubsub.getMeshPeers === 'function'
      ? pubsub.getMeshPeers(this.topic).map((p) => p.toString())
      : []
    const allPubsubPeers = typeof pubsub.getPeers === 'function'
      ? pubsub.getPeers().map((p) => p.toString())
      : []
    return { topic: this.topic, selfTopics, subscribers, meshPeers, allPubsubPeers }
  }

  /**
   * Get multiaddrs this node is listening on.
   */
  getMultiaddrs(): string[] {
    if (!this.node) return []
    return this.node.getMultiaddrs().map((ma) => ma.toString())
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getPubsub(): {
    subscribe: (topic: string) => void
    unsubscribe: (topic: string) => void
    publish: (topic: string, data: Uint8Array) => Promise<void>
    addEventListener: (event: string, handler: (evt: unknown) => void) => void
  } | null {
    if (!this.node) return null
    const services = (this.node as unknown as { services: Record<string, unknown> }).services
    return services?.pubsub as never ?? null
  }

  private getDHT(): {
    put: (key: Uint8Array, value: Uint8Array) => Promise<void>
    get: (key: Uint8Array) => AsyncIterable<{ name: string; value?: Uint8Array }>
  } | null {
    if (!this.node) return null
    const services = (this.node as unknown as { services: Record<string, unknown> }).services
    return services?.dht as never ?? null
  }

  private calculateLevel(peerCount: number): NodeLevel {
    if (peerCount >= 20) return 'anchor'
    if (peerCount >= 10) return 'pro'
    if (peerCount >= 3) return 'standard'
    return 'light'
  }

  private emitMeshEvent(event: MeshEvent): void {
    this.emit('mesh:event', event)
  }

  private checkRateLimit(peerId: string): boolean {
    const now = Date.now()
    const state = this.peerRates.get(peerId)
    if (!state || now - state.windowStart > RATE_LIMIT_WINDOW_MS) {
      this.peerRates.set(peerId, { count: 1, windowStart: now })
      return true
    }
    if (state.count >= RATE_LIMIT_MAX) return false
    state.count++
    return true
  }

  private encodeGossipMessage(msg: GossipMessage): Uint8Array {
    const json = JSON.stringify(msg, (_key, value) => {
      if (value instanceof Uint8Array) {
        return { __uint8array: true, data: Array.from(value) }
      }
      return value
    })
    return new TextEncoder().encode(json)
  }

  private decodeGossipMessage(data: Uint8Array): GossipMessage {
    const json = new TextDecoder().decode(data)
    return JSON.parse(json, (_key, value) => {
      if (value && typeof value === 'object' && value.__uint8array) {
        return new Uint8Array(value.data)
      }
      return value
    }) as GossipMessage
  }
}
