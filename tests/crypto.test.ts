/**
 * Tests for crypto utilities
 */

import { describe, it, expect } from 'vitest'
import { hashBlob, signData, verifySignature } from '../src/crypto.js'
import { generateKeyPairSync } from 'node:crypto'

describe('hashBlob', () => {
  it('produces consistent SHA-256 hex', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5])
    const hash1 = hashBlob(data)
    const hash2 = hashBlob(data)
    expect(hash1).toBe(hash2)
    expect(hash1).toHaveLength(64) // 256 bits = 64 hex chars
  })

  it('different data produces different hashes', () => {
    const a = hashBlob(new Uint8Array([1]))
    const b = hashBlob(new Uint8Array([2]))
    expect(a).not.toBe(b)
  })

  it('empty data produces a valid hash', () => {
    const hash = hashBlob(new Uint8Array([]))
    expect(hash).toHaveLength(64)
    // Known SHA-256 of empty input
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

describe('signData / verifySignature', () => {
  it('signs and verifies with Ed25519', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pubKeyRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
    const privKeyRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)

    const data = new Uint8Array([10, 20, 30])
    const sig = await signData(data, privKeyRaw)
    expect(typeof sig).toBe('string')

    const valid = await verifySignature(data, sig, pubKeyRaw)
    expect(valid).toBe(true)
  })

  it('rejects tampered data', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pubKeyRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
    const privKeyRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)

    const data = new Uint8Array([10, 20, 30])
    const sig = await signData(data, privKeyRaw)

    const tampered = new Uint8Array([10, 20, 31])
    const valid = await verifySignature(tampered, sig, pubKeyRaw)
    expect(valid).toBe(false)
  })

  it('rejects wrong public key', async () => {
    const kp1 = generateKeyPairSync('ed25519')
    const kp2 = generateKeyPairSync('ed25519')
    const privKeyRaw = kp1.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)
    const wrongPubKey = kp2.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)

    const data = new Uint8Array([1, 2, 3])
    const sig = await signData(data, privKeyRaw)

    const valid = await verifySignature(data, sig, wrongPubKey)
    expect(valid).toBe(false)
  })
})
