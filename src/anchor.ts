/**
 * Solana Anchor — timestamp and proof-of-existence anchoring.
 *
 * ATT-257 Task 4.3: Anclaje Solana
 *
 * Creates a Solana memo transaction with the content hash.
 * Not every mutation is anchored — only critical changes or periodic checkpoints.
 */

import type { SolanaAnchor } from './types.js'

/**
 * Anchor a content hash to Solana via memo transaction.
 *
 * This is a stub that returns the anchor structure.
 * In production, this will use @solana/web3.js to send a memo tx.
 *
 * @param contentHash - SHA-256 hash to anchor
 * @param _options - Future: wallet, connection, etc.
 * @returns SolanaAnchor with txHash, slot, and timestamp
 */
export async function anchorToSolana(
  contentHash: string,
  _options?: {
    rpcUrl?: string
    commitment?: string
  }
): Promise<SolanaAnchor> {
  // TODO: Implement actual Solana memo transaction
  //
  // Production flow:
  // 1. Create memo instruction with contentHash as data
  // 2. Sign with node's keypair (or multisig via Squads)
  // 3. Send transaction
  // 4. Confirm and extract slot + timestamp
  //
  // Cost: ~$0.00025 per anchor

  // Guard: mock anchor must never run in production — fake tx hashes would
  // be stored as real proofs and silently break all verification.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'anchorToSolana is not implemented. Cannot anchor in production until ' +
      'the real Solana memo transaction is wired in.'
    )
  }

  // Development/testing only
  return {
    txHash: `mock_${contentHash.slice(0, 16)}_${Date.now()}`,
    slot: Math.floor(Date.now() / 400),
    timestamp: Date.now(),
  }
}
