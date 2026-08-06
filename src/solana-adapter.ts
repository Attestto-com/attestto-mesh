/**
 * SolanaMemoAdapter — real on-chain anchoring via Solana Memo program.
 *
 * ATT-300: Submits a SHA-256 content hash as a Memo instruction on Solana,
 * returning the confirmed tx signature, slot, and block timestamp.
 *
 * Requires @solana/web3.js as a peer dependency (not bundled with mesh).
 * The caller provides a funded Keypair and an RPC endpoint.
 */

import type { AnchorAdapter } from './anchor.js'
import type { SolanaAnchor } from './types.js'

const SHA256_HEX = /^[0-9a-f]{64}$/i

export interface SolanaMemoAdapterConfig {
  /** Solana JSON-RPC endpoint (e.g. https://api.devnet.solana.com) */
  rpcUrl: string
  /** Ed25519 keypair bytes (64 bytes: 32 secret + 32 public) */
  keypairBytes: Uint8Array
  /** Commitment level (default: 'confirmed') */
  commitment?: 'confirmed' | 'finalized'
  /** Memo prefix to distinguish attestto anchors (default: 'attestto:anchor:') */
  memoPrefix?: string
}

/**
 * SolanaMemoAdapter — submits content hashes to Solana via the Memo program.
 *
 * The Memo program (MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr) stores
 * arbitrary UTF-8 data in the transaction log. This is the cheapest way to
 * anchor a hash on Solana (~5000 lamports per tx, ~$0.001 at current prices).
 */
export class SolanaMemoAdapter implements AnchorAdapter {
  readonly name = 'solana-memo'

  private readonly rpcUrl: string
  private readonly keypairBytes: Uint8Array
  private readonly commitment: 'confirmed' | 'finalized'
  private readonly memoPrefix: string

  constructor(config: SolanaMemoAdapterConfig) {
    if (!config.rpcUrl) throw new Error('SolanaMemoAdapter requires rpcUrl')
    if (!config.keypairBytes || config.keypairBytes.length !== 64) {
      throw new Error('SolanaMemoAdapter requires 64-byte keypairBytes (32 secret + 32 public)')
    }
    this.rpcUrl = config.rpcUrl
    this.keypairBytes = config.keypairBytes
    this.commitment = config.commitment ?? 'confirmed'
    this.memoPrefix = config.memoPrefix ?? 'attestto:anchor:'
  }

  async submit(contentHash: string): Promise<SolanaAnchor> {
    if (!SHA256_HEX.test(contentHash)) {
      throw new Error(`Invalid content hash: expected 64-char SHA-256 hex, got "${contentHash}"`)
    }

    // Dynamic import — @solana/web3.js is a peer dependency, not bundled
    const {
      Connection,
      Keypair,
      Transaction,
      TransactionInstruction,
      PublicKey,
      sendAndConfirmTransaction,
    } = await import('@solana/web3.js')

    const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

    const connection = new Connection(this.rpcUrl, this.commitment)
    const keypair = Keypair.fromSecretKey(this.keypairBytes)

    const memoData = `${this.memoPrefix}${contentHash}`

    const instruction = new TransactionInstruction({
      keys: [{ pubkey: keypair.publicKey, isSigner: true, isWritable: false }],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memoData, 'utf-8'),
    })

    const tx = new Transaction().add(instruction)

    const signature = await sendAndConfirmTransaction(connection, tx, [keypair], {
      commitment: this.commitment,
    })

    // Fetch the confirmed transaction to get slot and block time
    const confirmed = await connection.getTransaction(signature, {
      commitment: this.commitment,
      maxSupportedTransactionVersion: 0,
    })

    if (!confirmed) {
      throw new Error(`Transaction ${signature} confirmed but not found on fetch`)
    }

    const timestamp = confirmed.blockTime
      ? confirmed.blockTime * 1000 // Convert seconds → milliseconds
      : Date.now()

    return {
      txHash: signature,
      slot: confirmed.slot,
      timestamp,
    }
  }
}
