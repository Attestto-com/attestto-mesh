/**
 * Solana Anchor — timestamp and proof-of-existence anchoring.
 *
 * ATT-300: Adapter-based anchoring. The mesh package stays network-agnostic;
 * callers inject a concrete AnchorAdapter (e.g. a Solana memo adapter wired
 * with @solana/web3.js in the desktop/CORTEX layer).
 *
 * Why an adapter, not a hard Solana dependency?
 *  - Mesh is open-source infrastructure: it must not pull a 1.5 MB chain SDK.
 *  - Different deployments may anchor on different chains or none at all.
 *  - Tests stay deterministic with MockAnchorAdapter (no network).
 */

import type { SolanaAnchor } from './types.js'

const SHA256_HEX = /^[0-9a-f]{64}$/i

/**
 * AnchorAdapter — pluggable anchoring backend.
 *
 * Implementations MUST:
 *  - Submit `contentHash` to a verifiable, timestamped substrate (chain memo,
 *    notary log, etc.) such that the returned `txHash`/`slot`/`timestamp`
 *    can be independently re-verified later.
 *  - Reject malformed hashes (non-hex, wrong length).
 *  - Surface failures by throwing — never return a fake anchor on error.
 */
export interface AnchorAdapter {
  /** Human-readable backend name, e.g. 'solana-memo', 'mock'. */
  readonly name: string
  /** Submit and return the resulting anchor. */
  submit(contentHash: string): Promise<SolanaAnchor>
}

/**
 * MockAnchorAdapter — deterministic, network-free anchor for tests/dev.
 *
 * SECURITY: refuses to run when NODE_ENV=production. The mock produces
 * fake transaction hashes that would silently corrupt verification if
 * stored as real proofs.
 */
export class MockAnchorAdapter implements AnchorAdapter {
  readonly name = 'mock'

  async submit(contentHash: string): Promise<SolanaAnchor> {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'MockAnchorAdapter cannot run in production — wire a real AnchorAdapter ' +
        '(e.g. SolanaMemoAdapter) before deploying.'
      )
    }
    if (!SHA256_HEX.test(contentHash)) {
      throw new Error(`Invalid content hash: expected 64-char SHA-256 hex, got "${contentHash}"`)
    }
    const now = Date.now()
    return {
      txHash: `mock_${contentHash.slice(0, 16)}_${now}`,
      slot: Math.floor(now / 400),
      timestamp: now,
    }
  }
}

/**
 * Anchor a content hash via the supplied adapter.
 *
 * The mesh package never instantiates a network client — callers wire the
 * concrete adapter at the boundary (desktop main process, CLI, server).
 *
 * @throws if the hash is malformed or the adapter rejects.
 */
export async function anchor(contentHash: string, adapter: AnchorAdapter): Promise<SolanaAnchor> {
  if (!SHA256_HEX.test(contentHash)) {
    throw new Error(`Invalid content hash: expected 64-char SHA-256 hex, got "${contentHash}"`)
  }
  const result = await adapter.submit(contentHash)
  // Defensive: validate adapter return shape — a buggy adapter must not
  // be able to write garbage anchors into the mesh.
  if (!result || typeof result.txHash !== 'string' || typeof result.slot !== 'number' || typeof result.timestamp !== 'number') {
    throw new Error(`AnchorAdapter "${adapter.name}" returned malformed anchor`)
  }
  return result
}

/**
 * Back-compat wrapper — uses MockAnchorAdapter under the hood.
 *
 * @deprecated Use `anchor(contentHash, adapter)` with an explicit adapter.
 */
export async function anchorToSolana(
  contentHash: string,
  _options?: { rpcUrl?: string; commitment?: string }
): Promise<SolanaAnchor> {
  return anchor(contentHash, new MockAnchorAdapter())
}
