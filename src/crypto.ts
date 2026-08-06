/**
 * Cryptographic utilities for the mesh.
 *
 * SHA-256 hashing and Ed25519 signature verification.
 */

import { createHash, createPublicKey, verify } from 'node:crypto'

/**
 * SHA-256 hash of a blob, returned as hex string.
 */
export function hashBlob(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Verify an Ed25519 signature against a raw 32-byte public key (synchronous).
 *
 * Inbound gossip handlers run on the message hot path and stay synchronous, so
 * verification must not require an await. The DID → public-key resolution is
 * done by the caller (see `verify.ts`); this only checks the signature bytes.
 */
export function verifySignatureSync(
  data: Uint8Array,
  signature: string,
  publicKey: Uint8Array
): boolean {
  try {
    const keyObject = createPublicKey({
      key: Buffer.concat([
        // Ed25519 SPKI DER prefix
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(publicKey),
      ]),
      format: 'der',
      type: 'spki',
    })
    return verify(null, data, keyObject, Buffer.from(signature, 'hex'))
  } catch {
    return false
  }
}

/**
 * Async wrapper around {@link verifySignatureSync}, retained for callers that
 * already await it.
 */
export async function verifySignature(
  data: Uint8Array,
  signature: string,
  publicKey: Uint8Array
): Promise<boolean> {
  return verifySignatureSync(data, signature, publicKey)
}

/**
 * Sign data with an Ed25519 private key.
 *
 * Used for testing and by the local node to sign its own data.
 */
export async function signData(
  data: Uint8Array,
  privateKey: Uint8Array
): Promise<string> {
  const { sign, createPrivateKey } = await import('node:crypto')
  // Build PKCS8 DER in a local buffer and zero it immediately after the
  // KeyObject is created — prevents the raw key material from sitting in
  // the heap for the lifetime of the process.
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    privateKey,
  ])
  let keyObject
  try {
    keyObject = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  } finally {
    der.fill(0)
  }
  const sig = sign(null, data, keyObject)
  return sig.toString('hex')
}
