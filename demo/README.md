**[English](./README.md)** | [Espanol](./README.es.md)

---

# Proof of Logic Demo

Validates all mesh primitives end-to-end in under 30 seconds.

## What It Proves

| Demo | What happens | Why it matters |
|:-----|:-------------|:---------------|
| **1. Publish + Sync** | Node A publishes a verifiable credential, Node B receives it via gossip | Data replicates across peers without a central server |
| **2. Conflict Resolution** | Both nodes publish different versions simultaneously, Solana anchor wins | Deterministic arbitration — no coordinator, no consensus protocol |
| **3. Version Pruning** | 20 versions published, GC reduces to 2 (canonical + rollback) | Storage stays bounded — the mesh cleans itself |
| **4. TTL + Tombstone** | Ephemeral message auto-expires; DID revocation propagates to all peers | Data has a lifecycle — nothing persists forever unless anchored |
| **5. Storage Metrics** | Both nodes report peer count, item count, bytes used, node level | Observability built in — every node knows its own health |

## How to Run

### Quick demo — one command, 15 seconds

```bash
pnpm demo
```

Both nodes run in a single process. No network configuration. Watch them discover each other, sync, conflict-resolve, and clean up in real time.

### Two machines on the same network

```bash
# Machine A
pnpm demo:alpha

# Machine B (use the multiaddr printed by Machine A)
pnpm demo:beta --peer /ip4/192.168.1.X/tcp/4001/p2p/12D3Koo...
```

Proves the protocol works between independent machines over real TCP, not just in-process.

### Docker — no local dependencies

```bash
# Build and run (no Node.js required)
docker build -t attestto-mesh .. && docker run attestto-mesh

# Two containers
docker compose -f ../docker-compose.yml up
```

For reviewers and auditors who want to verify without installing anything.

## Expected Output

```
Attestto Mesh — Proof of Logic
Mode: Local (both nodes in one process)

Alpha  Started — PeerId: ...
Beta   Started — PeerId: ...

── DEMO 1: Publish + Gossip Sync ──
Alpha  PUT did:sns:maria.sol/credentials/license v1
Alpha  Stored locally ✓
Alpha  Gossip sent ✓
Beta   RECEIVED via gossip ✓

── DEMO 2: Version Conflict + Solana Resolution ──
Alpha  CONFLICT: local=6f2a33ee v2
Beta   CONFLICT: local=2b71f95d v2
Alpha  RESOLVED — Winner: 6f2a33ee (anchor) ✓
       Solana anchor wins — slot 312847291

── DEMO 3: Version Pruning (20 → 2) ──
Alpha  Store: 22 versions
Alpha  Pruned 20 old versions
Alpha  Remaining: 2 versions (v22 canonical + v21 rollback) ✓

── DEMO 4: TTL Expiry + Tombstone Propagation ──
Alpha  TTL expired: 1 item(s) cleaned ✓
Alpha  TOMBSTONE did:sns:maria.sol
Beta   Tombstone received — 0 items remaining ✓

═══════════════════════════════════
  PROOF OF LOGIC — COMPLETE
═══════════════════════════════════
  ✓ Peer discovery via libp2p
  ✓ PUT + gossip sync between peers
  ✓ Conflict resolved via Solana anchor
  ✓ 20 versions → 2 after GC
  ✓ TTL expiry — ephemeral data auto-cleaned
  ✓ Tombstone propagation — DID revocation
  ✓ Storage metrics and node level reporting
```
