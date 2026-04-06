/**
 * Conflict Resolution — version desempatador.
 *
 * ATT-257: Versionamiento y Resolucion de Conflictos
 *
 * Rules (in priority order):
 * 1. Version with more recent Solana anchor wins
 * 2. Without anchor: more recent signature timestamp wins
 * 3. Exact tie: higher content hash wins (deterministic)
 */

import type { ConflictCandidate } from './types.js'

export type ConflictReason = 'anchor' | 'timestamp' | 'hash'

export interface ConflictResult {
  winner: ConflictCandidate
  loser: ConflictCandidate
  reason: ConflictReason
}

/**
 * Resolve a conflict between two versions of the same key.
 *
 * Both candidates must have the same didOwner + path.
 */
export function resolveConflict(a: ConflictCandidate, b: ConflictCandidate): ConflictResult {
  // Rule 1: Solana anchor wins
  const aAnchor = a.metadata.solanaAnchor
  const bAnchor = b.metadata.solanaAnchor

  if (aAnchor && bAnchor) {
    // Both anchored — most recent slot wins
    if (aAnchor.slot !== bAnchor.slot) {
      return aAnchor.slot > bAnchor.slot
        ? { winner: a, loser: b, reason: 'anchor' }
        : { winner: b, loser: a, reason: 'anchor' }
    }
  } else if (aAnchor && !bAnchor) {
    return { winner: a, loser: b, reason: 'anchor' }
  } else if (!aAnchor && bAnchor) {
    return { winner: b, loser: a, reason: 'anchor' }
  }

  // Rule 2: Higher version number wins
  if (a.metadata.version !== b.metadata.version) {
    return a.metadata.version > b.metadata.version
      ? { winner: a, loser: b, reason: 'timestamp' }
      : { winner: b, loser: a, reason: 'timestamp' }
  }

  // Rule 3: Same version — more recent creation timestamp
  if (a.metadata.createdAt !== b.metadata.createdAt) {
    return a.metadata.createdAt > b.metadata.createdAt
      ? { winner: a, loser: b, reason: 'timestamp' }
      : { winner: b, loser: a, reason: 'timestamp' }
  }

  // Rule 4: Deterministic tiebreak — higher content hash
  return a.metadata.contentHash > b.metadata.contentHash
    ? { winner: a, loser: b, reason: 'hash' }
    : { winner: b, loser: a, reason: 'hash' }
}
