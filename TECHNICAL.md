**[English](./TECHNICAL.md)** | [Espanol](./docs/translations/TECHNICAL.es.md)

---

# Technical Reference

> This document is for developers, protocol engineers, and security auditors. For an executive overview, see the [README](./README.md).

---

## Architecture

### Network Layer (libp2p)

The mesh runs on [libp2p](https://libp2p.io/), the modular networking stack used by IPFS, Filecoin, and Ethereum's consensus layer.

| Component | Implementation | Purpose |
|:----------|:---------------|:--------|
| Transport | TCP (primary), WebRTC (planned) | Peer connections |
| Encryption | Noise Protocol | All connections encrypted at transport level |
| Multiplexing | Yamux | Multiple streams over a single connection |
| Peer Discovery | Kademlia DHT + Bootstrap | Find peers by proximity (XOR distance) |
| Data Propagation | GossipSub | Epidemic broadcast of new items to subscribed peers |
| Identity | Ed25519 PeerId | Each node has a unique cryptographic identity |

**Gossip Topic:** `/attestto/mesh/1.0.0`

All mesh items are propagated via GossipSub on a single topic. Nodes validate incoming items before storing (hash verification, signature check, version comparison).

### Storage Layer (SQLite + Flat Files)

Each node maintains a local store separated from the user's private vault:

```
{dataDir}/
├── index.db           ← SQLite (WAL mode) — metadata index
└── store/
    ├── {hash}.enc     ← Encrypted blob files
    └── ...
```

**SQLite Schema:**

```sql
CREATE TABLE items (
  content_hash      TEXT PRIMARY KEY,    -- SHA-256 of encrypted blob
  did_owner         TEXT NOT NULL,       -- DID of data owner
  path              TEXT NOT NULL,       -- Logical path (e.g. credentials/exam)
  version           INTEGER NOT NULL,    -- Monotonically increasing
  ttl_seconds       INTEGER NOT NULL,    -- 0 = permanent
  created_at        INTEGER NOT NULL,    -- Unix ms
  last_accessed_at  INTEGER NOT NULL,    -- Unix ms (for LRU)
  size_bytes        INTEGER NOT NULL,    -- Blob size
  signature         TEXT NOT NULL,       -- Ed25519 signature by DID owner
  solana_tx_hash    TEXT,                -- Solana anchor (nullable)
  solana_slot       INTEGER,
  solana_timestamp  INTEGER
);
```

**Indexes:** `did_owner`, `(did_owner, path)`, `(ttl_seconds, created_at)`, `last_accessed_at`, `(did_owner, path, version)`

### Protocol Layer

#### PUT Flow

```
1. Caller provides: blob + metadata (didOwner, path, version, signature)
2. contentHash = SHA-256(blob)
3. Store locally (L1 cache)
4. DHT.put(key, contentHash) — register in distributed hash table
5. GossipSub.publish(metadata + blob) — propagate to peers
```

#### GET Flow

```
1. Check L1 (local store) — 0ms if cached
2. Query DHT for contentHash by key — <100ms
3. Fetch blob from providing peer — network dependent
4. Verify: SHA-256(blob) === contentHash
5. Verify: Ed25519 signature matches DID owner's public key
6. Store locally for future L1 hits
```

#### Version Acceptance Rule

A new version is accepted only if:
- `newVersion > currentVersion` (monotonically increasing)
- Signature is valid for the claimed DID owner
- Content hash matches the blob

### Conflict Resolution

When two peers disagree about the canonical version, conflicts are resolved deterministically:

```
Priority 1: Solana anchor — version with more recent slot wins
Priority 2: Version number — higher version wins
Priority 3: Creation timestamp — more recent wins
Priority 4: Content hash — lexicographically higher wins (deterministic tiebreak)
```

An anchored version always beats an unanchored one. This incentivizes anchoring critical state changes.

### Garbage Collection

Three-phase GC runs every 6 hours (configurable):

**Phase 1 — TTL Expiry:**
Items with `ttl_seconds > 0` where `created_at + ttl_seconds * 1000 < now` are deleted.

**Phase 2 — Version Pruning:**
For each `(didOwner, path)` with more than 2 versions, only the latest (canonical) and second-latest (rollback) are kept. All older versions are deleted.

**Phase 3 — LRU Eviction (pressure-triggered):**
Activates only when storage usage exceeds 90%. Evicts least-recently-accessed items until usage drops below 80%.

**Safety Rail:** Items are never evicted if fewer than 6 peers hold a copy (queried via DHT `findProviders`). This prevents data loss for under-replicated items.

---

## API Reference

### MeshNode

```typescript
import { MeshNode } from '@attestto/mesh'

const node = new MeshNode({
  dataDir: '/path/to/mesh',         // Required
  bootstrapPeers: [multiaddr, ...], // Bootstrap peer addresses
  listenPort: 4001,                 // TCP port (0 = random)
  maxStorageBytes: 250 * 1024 * 1024, // 250 MB default
  gcIntervalMs: 6 * 60 * 60 * 1000,  // 6 hours default
  minHoldersForEviction: 6,         // Safety rail
  maxItemSizeBytes: 10 * 1024,      // 10 KB max per item
})

await node.start()           // Start libp2p node
await node.stop()            // Graceful shutdown
node.getStatus()             // { peerId, peerCount, dhtReady, uptimeMs, storage, level }
node.getMultiaddrs()         // Listening addresses
node.isRunning               // boolean
node.peerId                  // string

// Events (via EventEmitter)
node.on('mesh:event', (event: MeshEvent) => { ... })
node.on('gossip:message', (msg: GossipMessage) => { ... })
```

### MeshStore

```typescript
import { MeshStore } from '@attestto/mesh'

const store = new MeshStore(dataDir, maxStorageBytes?)

store.put(metadata, blob)                    // → boolean
store.get(contentHash)                       // → { metadata, blob } | null
store.has(contentHash)                       // → boolean
store.delete(contentHash)                    // → boolean
store.list({ didOwner?, path?, expiredOnly?, maxVersion?, limit?, orderByAccess? })
store.getLatestByKey(didOwner, path)          // → { metadata, blob } | null
store.getVersions(didOwner, path)             // → MeshItemMetadata[]
store.deleteByDid(didOwner)                   // → number (items deleted)
store.getUsage()                              // → StorageMetrics
store.close()                                 // Close SQLite connection
```

### MeshProtocol

```typescript
import { MeshProtocol } from '@attestto/mesh'

const protocol = new MeshProtocol(node, store)

await protocol.put(metadata, blob)           // → contentHash (string)
await protocol.get(didOwner, path)           // → MeshItem | null
await protocol.tombstone(didOwner, signature) // Revoke all data for a DID
```

### MeshGC

```typescript
import { MeshGC } from '@attestto/mesh'

const gc = new MeshGC(store, node, minHolders?)

gc.start(intervalMs)    // Start scheduled GC
gc.stop()               // Stop scheduler
await gc.run()           // Manual GC cycle → GCResult
```

### Conflict Resolution

```typescript
import { resolveConflict } from '@attestto/mesh'

const result = resolveConflict(candidateA, candidateB)
// → { winner, loser, reason: 'anchor' | 'timestamp' | 'hash' }
```

### Crypto Utilities

```typescript
import { hashBlob, verifySignature, signData } from '@attestto/mesh'

hashBlob(data: Uint8Array)                          // → hex string (SHA-256)
await verifySignature(data, signature, publicKey)   // → boolean
await signData(data, privateKey)                    // → hex signature
```

---

## Types

All types are exported from `@attestto/mesh`:

```typescript
// Core data
MeshItem, MeshItemMetadata, MeshKey, SolanaAnchor

// Configuration
MeshNodeConfig, DEFAULT_CONFIG

// Status
MeshNodeStatus, StorageMetrics, NodeLevel

// Events
MeshEvent  // Union: peer:connected, peer:disconnected, item:received,
           //        item:stored, item:evicted, storage:pressure,
           //        gc:completed, conflict:resolved

// Gossip
GossipMessage, GossipPutMessage, GossipTombstoneMessage

// Conflict
ConflictCandidate
```

---

## Security Model

### Blind Courier Principle

Nodes store encrypted blobs addressed by content hash. A node:
- **Cannot** read the data it stores (encrypted by the owner's key)
- **Cannot** determine who the data belongs to (DID owner field is the public identifier, not PII)
- **Can** verify that a blob matches its claimed hash (integrity check)
- **Can** verify that a signature was produced by the claimed DID (authenticity check)

### Threat Mitigations

| Threat | Mitigation |
|:-------|:-----------|
| Sybil attack (fake nodes) | Each node must present a DID linked to a verified national identity |
| Data tampering | Content-addressed storage — SHA-256 hash must match blob |
| Replay attacks | Monotonically increasing version numbers; new version must be signed |
| Unauthorized writes | Ed25519 signature required from the DID owner |
| Storage exhaustion | 10 KB max per item, 250 MB per node, LRU eviction with safety rails |
| Network partition | Local mesh continues operating; Solana anchor resolves conflicts on rejoin |

### What This Library Does NOT Do

- Key management (use a vault like SQLCipher)
- DID resolution (will integrate with `did:sns` resolver)
- Encryption of blobs (caller must encrypt before `put()`)
- Authentication of peers (planned via DID-based peer auth)

---

## Building and Testing

```bash
# Install
pnpm install

# Type check (strict mode)
pnpm type-check

# Run all tests
pnpm test

# Build (dual ESM + CJS)
pnpm build

# Watch mode
pnpm dev           # tsup --watch
pnpm test:watch    # vitest
```

### Test Coverage

| Suite | Tests | What it covers |
|:------|------:|:---------------|
| `store.test.ts` | 18 | CRUD, size limits, versioning, tombstone deletion, metrics, Solana anchor |
| `conflict.test.ts` | 6 | Anchor priority, version ordering, timestamp, deterministic tiebreak, symmetry |
| `crypto.test.ts` | 6 | SHA-256 consistency, Ed25519 sign/verify, tamper detection, wrong-key rejection |

---

## Contributing

This is Public Digital Infrastructure. Contributions are welcome.

1. Fork the repo
2. Create a feature branch
3. Write tests for new functionality
4. Ensure `pnpm test` and `pnpm type-check` pass
5. Open a pull request

See the [Apache 2.0 License](./LICENSE) for terms.
