/**
 * Cryptographic utilities for the mesh.
 *
 * SHA-256 hashing and Ed25519 signature verification.
 */

import { createHash } from 'node:crypto'

/**
 * SHA-256 hash of a blob, returned as hex string.
 */
export function hashBlob(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Verify an Ed25519 signature.
 *
 * Note: In production, this would use the DID document's verification method
 * to resolve the public key. For now, accepts the public key directly.
 */
export async function verifySignature(
  data: Uint8Array,
  signature: string,
  publicKey: Uint8Array
): Promise<boolean> {
  try {
    const { verify } = await import('node:crypto')
    const keyObject = await import('node:crypto').then((c) =>
      c.createPublicKey({
        key: Buffer.concat([
          // Ed25519 DER prefix
          Buffer.from('302a300506032b6570032100', 'hex'),
          publicKey,
        ]),
        format: 'der',
        type: 'spki',
      })
    )
    return verify(null, data, keyObject, Buffer.from(signature, 'hex'))
  } catch {
    return false
  }
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
  const keyObject = createPrivateKey({
    key: Buffer.concat([
      // Ed25519 PKCS8 prefix
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      privateKey,
    ]),
    format: 'der',
    type: 'pkcs8',
  })
  const sig = sign(null, data, keyObject)
  return sig.toString('hex')
}
