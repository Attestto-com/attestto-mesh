/**
 * @attestto/mesh — Core Types
 *
 * Distributed application data mesh for sovereign identity state.
 * "Redis descentralizado" — not a file system.
 */

// ---------------------------------------------------------------------------
// Mesh Item — the fundamental unit stored in the mesh
// ---------------------------------------------------------------------------

export interface MeshItemMetadata {
  /** SHA-256 hash of the encrypted blob (content-addressed key) */
  contentHash: string

  /** DID of the data owner (e.g. did:sns:maria.sol) */
  didOwner: string

  /** Logical path within the owner's namespace (e.g. /credentials/cosevi-exam-2026) */
  path: string

  /** Monotonically increasing version number */
  version: number

  /** Time-to-live in seconds. 0 = permanent (requires Solana anchor) */
  ttlSeconds: number

  /** Unix timestamp (ms) when item was first stored locally */
  createdAt: number

  /** Unix timestamp (ms) of last local access (for LRU eviction) */
  lastAccessedAt: number

  /** Size of the encrypted blob in bytes */
  sizeBytes: number

  /** Ed25519 signature of the content by the DID owner */
  signature: string

  /** Solana anchor, if any */
  solanaAnchor: SolanaAnchor | null
}

export interface SolanaAnchor {
  /** Solana transaction hash */
  txHash: string
  /** Solana slot number */
  slot: number
  /** Unix timestamp (ms) of the anchor */
  timestamp: number
}

export interface MeshItem {
  metadata: MeshItemMetadata
  /** Encrypted blob — the node cannot read this (Cartero Ciego) */
  blob: Uint8Array
}

// ---------------------------------------------------------------------------
// Mesh Key — how items are addressed in the DHT
// ---------------------------------------------------------------------------

/** DHT key = did:sns:owner/path → contentHash */
export interface MeshKey {
  didOwner: string
  path: string
}

export function meshKeyToString(key: MeshKey): string {
  return `${key.didOwner}/${key.path}`
}

export function stringToMeshKey(str: string): MeshKey {
  const firstSlash = str.indexOf('/')
  if (firstSlash === -1) throw new Error(`Invalid mesh key: ${str}`)
  return {
    didOwner: str.slice(0, firstSlash),
    path: str.slice(firstSlash + 1),
  }
}

// ---------------------------------------------------------------------------
// Node Configuration
// ---------------------------------------------------------------------------

export interface MeshNodeConfig {
  /** Directory for mesh data (index.db + store/) */
  dataDir: string

  /** Maximum storage in bytes (default: 250 MB) */
  maxStorageBytes: number

  /** Bootstrap peer multiaddrs */
  bootstrapPeers: string[]

  /** TCP listen port (0 = random) */
  listenPort: number

  /**
   * TCP listen address.
   * Use '0.0.0.0' for anchor/relay nodes with a public IP.
   * Use '127.0.0.1' for desktop nodes that rely on circuit relay for NAT traversal
   * and should not be directly reachable from the LAN.
   */
  listenAddress: string

  /** GC interval in ms (default: 6 hours) */
  gcIntervalMs: number

  /** Minimum holders before LRU can evict (safety rail) */
  minHoldersForEviction: number

  /** Maximum item size in bytes (default: 10 KB) */
  maxItemSizeBytes: number

  /** Mesh ID — isolates meshes by country/network (default: 'attestto-cr') */
  meshId: string

  /** Enable relay server (for anchor/bootstrap nodes with public IPs) */
  enableRelayServer: boolean

  /** Enable relay client (for nodes behind NAT — connects via relay nodes) */
  enableRelayClient: boolean
}

/**
 * Public Attestto-operated mesh anchor nodes. Baked into DEFAULT_CONFIG so any
 * consumer of @attestto/mesh joins the public mesh out of the box. Override by
 * passing a custom `bootstrapPeers` to MeshNode (e.g. empty array for tests,
 * or a private list for isolated deployments).
 *
 * Each anchor runs `src/daemon.ts` with MESH_RELAY_SERVER=1 and persistent
 * peer keys on stable storage. Hostnames are owned by Attestto so the IP can
 * change without breaking deployed clients.
 */
export const PUBLIC_BOOTSTRAP_PEERS: readonly string[] = [
  // attestto-anchor-cr — Fly.io dfw (Dallas), via Cloudflare DNS-only CNAME.
  '/dns4/anchor.attestto.org/tcp/4001/p2p/12D3KooWCrRxaNTcvbK8HatLgyq3NsuqBRqY32PaUH9wgpHmLtCw',
]

export const DEFAULT_CONFIG: MeshNodeConfig = {
  dataDir: '',
  maxStorageBytes: 250 * 1024 * 1024, // 250 MB
  bootstrapPeers: [...PUBLIC_BOOTSTRAP_PEERS],
  listenPort: 0,
  // Defaults to loopback for safety — anchor nodes (daemon.ts) and the
  // desktop explicitly opt into 0.0.0.0. Tests assert this default.
  listenAddress: '127.0.0.1',
  gcIntervalMs: 6 * 60 * 60 * 1000, // 6 hours
  minHoldersForEviction: 6,
  maxItemSizeBytes: 10 * 1024, // 10 KB
  meshId: 'attestto-cr',
  enableRelayServer: false,
  enableRelayClient: true,
}

// ---------------------------------------------------------------------------
// Node Status
// ---------------------------------------------------------------------------

export type NodeLevel = 'anchor' | 'pro' | 'standard' | 'light'

export interface MeshNodeStatus {
  /** libp2p peer ID */
  peerId: string
  /** Number of connected peers */
  peerCount: number
  /** Whether DHT is ready */
  dhtReady: boolean
  /** Uptime in milliseconds */
  uptimeMs: number
  /** Storage usage */
  storage: StorageMetrics
  /** Node tier level */
  level: NodeLevel
}

export interface StorageMetrics {
  /** Bytes used */
  usedBytes: number
  /** Bytes limit */
  limitBytes: number
  /** Number of items stored */
  itemCount: number
  /** Usage percentage (0-100) */
  percentage: number
}

// ---------------------------------------------------------------------------
// Events emitted by the mesh node
// ---------------------------------------------------------------------------

export type MeshEvent =
  | { type: 'peer:connected'; peerId: string }
  | { type: 'peer:disconnected'; peerId: string }
  | { type: 'item:received'; contentHash: string; didOwner: string; path: string }
  | { type: 'item:stored'; contentHash: string }
  | { type: 'item:evicted'; contentHash: string; reason: 'ttl' | 'version' | 'lru' | 'tombstone' }
  | { type: 'storage:pressure'; percentage: number }
  | { type: 'gc:completed'; itemsPruned: number; bytesFreed: number }
  | { type: 'conflict:resolved'; key: string; winnerVersion: number; reason: 'anchor' | 'timestamp' | 'hash' }

// ---------------------------------------------------------------------------
// Gossip message types propagated via GossipSub
// ---------------------------------------------------------------------------

export type GossipMessage =
  | GossipPutMessage
  | GossipTombstoneMessage

export interface GossipPutMessage {
  type: 'put'
  metadata: MeshItemMetadata
  blob: Uint8Array
}

export interface GossipTombstoneMessage {
  type: 'tombstone'
  didOwner: string
  /** Signature proving the DID owner authorized revocation */
  signature: string
  /** Tombstone TTL — 30 days for full propagation */
  ttlSeconds: number
  timestamp: number
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

export interface ConflictCandidate {
  metadata: MeshItemMetadata
  blob: Uint8Array
}
