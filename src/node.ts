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
import { EventEmitter } from 'node:events'
import type {
  MeshNodeConfig,
  MeshNodeStatus,
  MeshEvent,
  NodeLevel,
  StorageMetrics,
  GossipMessage,
} from './types.js'
import { DEFAULT_CONFIG } from './types.js'

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

  constructor(config: Partial<MeshNodeConfig> & { dataDir: string }) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
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

    // Subscribe to mesh gossip topic
    const pubsub = this.getPubsub()
    if (pubsub) {
      pubsub.subscribe(this.topic)
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

    await this.node.start()
    this.startedAt = Date.now()
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
   * Put a value into the DHT.
   */
  async dhtPut(key: Uint8Array, value: Uint8Array): Promise<void> {
    const dht = this.getDHT()
    if (!dht) throw new Error('Node not started')
    await dht.put(key, value)
  }

  /**
   * Get a value from the DHT.
   */
  async dhtGet(key: Uint8Array): Promise<Uint8Array | null> {
    const dht = this.getDHT()
    if (!dht) throw new Error('Node not started')
    try {
      for await (const event of dht.get(key)) {
        if (event.name === 'VALUE' && event.value) {
          return event.value
        }
      }
    } catch {
      return null
    }
    return null
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
