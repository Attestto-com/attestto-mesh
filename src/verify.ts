/**
 * Authenticity verification for inbound mesh messages.
 *
 * SEC (SOC-59): the mesh is public — any peer can dial and publish. Content
 * hashing proves a blob is intact, not that the writer controls the DID it
 * claims to write under. Every inbound PUT and chat message must therefore be
 * verified against an Ed25519 signature by the owning DID before it is stored
 * or propagated. This module defines the canonical bytes that get signed, the
 * DID → public-key resolver interface, and the verify/sign helpers.
 */

import { base58btc } from 'multiformats/bases/base58'
import { verifySignatureSync, signData } from './crypto.js'
import type {
  MeshItemMetadata,
  GossipChatMessage,
  GossipChatAckMessage,
  GossipChatDeleteMessage,
} from './types.js'

/**
 * Resolves a DID to its raw 32-byte Ed25519 public key, or `null` if the DID
 * cannot be resolved (unknown method, malformed, or not yet cached).
 *
 * Resolution on the gossip hot path is synchronous by design: methods that need
 * network I/O (e.g. `did:sns` over Solana Name Service) must be resolved ahead
 * of time and served from a cache. When a resolver returns `null`, the message
 * is rejected (fail-closed) — the same posture the tombstone handler already
 * takes. The default resolver ({@link resolveDidKey}) handles `did:key`, whose
 * key is embedded in the identifier and needs no network access.
 */
export type DidResolver = (did: string) => Uint8Array | null

// multicodec prefix for an Ed25519 public key: varint(0xed) = [0xed, 0x01]
const ED25519_MULTICODEC = Uint8Array.of(0xed, 0x01)

/**
 * Resolve a `did:key` Ed25519 identifier to its raw 32-byte public key.
 * Returns `null` for any other DID method or a malformed identifier.
 *
 * Format: `did:key:z<base58btc(0xed01 || pubkey)>`.
 */
export function resolveDidKey(did: string): Uint8Array | null {
  const PREFIX = 'did:key:'
  if (!did.startsWith(PREFIX)) return null
  const mb = did.slice(PREFIX.length)
  // base58btc multibase identifiers begin with 'z'.
  if (!mb.startsWith('z')) return null
  try {
    const bytes = base58btc.decode(mb)
    if (
      bytes.length !== ED25519_MULTICODEC.length + 32 ||
      bytes[0] !== ED25519_MULTICODEC[0] ||
      bytes[1] !== ED25519_MULTICODEC[1]
    ) {
      return null
    }
    return bytes.slice(ED25519_MULTICODEC.length)
  } catch {
    return null
  }
}

/**
 * Build a `did:key` identifier from a raw 32-byte Ed25519 public key.
 * Inverse of {@link resolveDidKey}; useful for local identities and tests.
 */
export function didKeyFromEd25519(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('Ed25519 public key must be 32 bytes')
  const prefixed = new Uint8Array(ED25519_MULTICODEC.length + 32)
  prefixed.set(ED25519_MULTICODEC, 0)
  prefixed.set(publicKey, ED25519_MULTICODEC.length)
  return `did:key:${base58btc.encode(prefixed)}`
}

// ---------------------------------------------------------------------------
// Canonical serialization — the exact bytes that get signed and verified.
// A version tag guards against cross-type/replay reuse of a signature and lets
// the format evolve. Fields are newline-joined in a fixed order.
// ---------------------------------------------------------------------------

const enc = new TextEncoder()

/** Binds the blob (via contentHash), the namespace (didOwner/path), and order (version). */
export function canonicalPutBytes(m: Pick<MeshItemMetadata, 'contentHash' | 'didOwner' | 'path' | 'version'>): Uint8Array {
  return enc.encode(`mesh-put:v1\n${m.contentHash}\n${m.didOwner}\n${m.path}\n${m.version}`)
}

export function canonicalChatBytes(m: Pick<GossipChatMessage, 'id' | 'channelId' | 'from' | 'body' | 'timestamp' | 'sequence'>): Uint8Array {
  return enc.encode(`mesh-chat:v1\n${m.id}\n${m.channelId}\n${m.from}\n${m.body}\n${m.timestamp}\n${m.sequence}`)
}

export function canonicalChatAckBytes(m: Pick<GossipChatAckMessage, 'messageId' | 'channelId' | 'from' | 'timestamp'>): Uint8Array {
  return enc.encode(`mesh-chat-ack:v1\n${m.messageId}\n${m.channelId}\n${m.from}\n${m.timestamp}`)
}

export function canonicalChatDeleteBytes(m: Pick<GossipChatDeleteMessage, 'messageId' | 'channelId' | 'from' | 'timestamp'>): Uint8Array {
  return enc.encode(`mesh-chat-delete:v1\n${m.messageId}\n${m.channelId}\n${m.from}\n${m.timestamp}`)
}

// ---------------------------------------------------------------------------
// Verification — resolve the claimed DID's key, then check the signature.
// Any failure (unresolvable DID, bad signature, thrown error) → false.
// ---------------------------------------------------------------------------

function verify(did: string, canonical: Uint8Array, signature: string, resolver: DidResolver): boolean {
  if (!signature) return false
  const key = resolver(did)
  if (!key) return false
  return verifySignatureSync(canonical, signature, key)
}

export function verifyPutSignature(metadata: MeshItemMetadata, resolver: DidResolver): boolean {
  return verify(metadata.didOwner, canonicalPutBytes(metadata), metadata.signature, resolver)
}

export function verifyChatSignature(msg: GossipChatMessage, resolver: DidResolver): boolean {
  return verify(msg.from, canonicalChatBytes(msg), msg.signature, resolver)
}

export function verifyChatAckSignature(msg: GossipChatAckMessage, resolver: DidResolver): boolean {
  return verify(msg.from, canonicalChatAckBytes(msg), msg.signature, resolver)
}

export function verifyChatDeleteSignature(msg: GossipChatDeleteMessage, resolver: DidResolver): boolean {
  return verify(msg.from, canonicalChatDeleteBytes(msg), msg.signature, resolver)
}

// ---------------------------------------------------------------------------
// Signing — produce the signature a publisher attaches. The DID owner's private
// key lives in the calling application (wallet/CORTEX), not in the mesh node, so
// these are exported for those publishers and for tests. Off the hot path, so
// async is fine.
// ---------------------------------------------------------------------------

export async function signPutMetadata(
  metadata: Pick<MeshItemMetadata, 'contentHash' | 'didOwner' | 'path' | 'version'>,
  privateKey: Uint8Array
): Promise<string> {
  return signData(canonicalPutBytes(metadata), privateKey)
}

export async function signChatMessage(
  msg: Pick<GossipChatMessage, 'id' | 'channelId' | 'from' | 'body' | 'timestamp' | 'sequence'>,
  privateKey: Uint8Array
): Promise<string> {
  return signData(canonicalChatBytes(msg), privateKey)
}

export async function signChatAck(
  msg: Pick<GossipChatAckMessage, 'messageId' | 'channelId' | 'from' | 'timestamp'>,
  privateKey: Uint8Array
): Promise<string> {
  return signData(canonicalChatAckBytes(msg), privateKey)
}

export async function signChatDelete(
  msg: Pick<GossipChatDeleteMessage, 'messageId' | 'channelId' | 'from' | 'timestamp'>,
  privateKey: Uint8Array
): Promise<string> {
  return signData(canonicalChatDeleteBytes(msg), privateKey)
}
