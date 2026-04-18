/**
 * @attestto/mesh
 *
 * Distributed application data mesh over libp2p.
 * Encrypted P2P storage for sovereign identity state.
 *
 * @license Apache-2.0
 */

// Types
export type {
  MeshItemMetadata,
  SolanaAnchor,
  MeshItem,
  MeshKey,
  MeshNodeConfig,
  MeshNodeStatus,
  StorageMetrics,
  NodeLevel,
  MeshEvent,
  GossipMessage,
  GossipPutMessage,
  GossipTombstoneMessage,
  GossipChatMessage,
  GossipChatAckMessage,
  GossipChatDeleteMessage,
  ChatAttachment,
  ChatVaultReference,
  ChatStructuredCard,
  ChatEvent,
  ConflictCandidate,
} from './types.js'

export { meshKeyToString, stringToMeshKey, DEFAULT_CONFIG, PUBLIC_BOOTSTRAP_PEERS } from './types.js'

// Core modules
export { MeshNode } from './node.js'
export { MeshStore } from './store.js'
export { MeshProtocol } from './protocol.js'
export { resolveConflict } from './conflict.js'
export { MeshGC } from './gc.js'
export { anchor, anchorToSolana, MockAnchorAdapter } from './anchor.js'
export type { AnchorAdapter } from './anchor.js'
export { SolanaMemoAdapter } from './solana-adapter.js'
export type { SolanaMemoAdapterConfig } from './solana-adapter.js'
export { hashBlob, verifySignature } from './crypto.js'
export { ChatStore } from './chat-store.js'
