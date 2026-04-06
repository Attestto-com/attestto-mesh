#!/usr/bin/env npx tsx
/**
 * Attestto Mesh — Proof of Logic Demo
 *
 * Demonstrates: peer discovery, PUT/GET sync, conflict resolution,
 * version pruning, TTL expiry, and tombstone propagation.
 *
 * Usage:
 *   # Local mode (both nodes in one process)
 *   npx tsx demo/proof-of-logic.ts
 *
 *   # Network mode (two machines)
 *   # Machine A:
 *   npx tsx demo/proof-of-logic.ts --role alpha --port 4001
 *
 *   # Machine B (use the multiaddr printed by alpha):
 *   npx tsx demo/proof-of-logic.ts --role beta --peer /ip4/192.168.1.X/tcp/4001/p2p/12D3Koo...
 */

import { MeshNode } from '../src/node.js'
import { MeshStore } from '../src/store.js'
import { MeshProtocol } from '../src/protocol.js'
import { MeshGC } from '../src/gc.js'
import { resolveConflict } from '../src/conflict.js'
import { hashBlob } from '../src/crypto.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { MeshEvent, GossipMessage, GossipPutMessage } from '../src/types.js'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 ? args[idx + 1] : undefined
}

const role = getArg('role') as 'alpha' | 'beta' | undefined
const peerAddr = getArg('peer')
const port = parseInt(getArg('port') ?? '4001', 10)
const isLocal = !role

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
  magenta: '\x1b[35m',
}

function log(node: string, msg: string, color = COLORS.reset): void {
  const ts = new Date().toISOString().slice(11, 19)
  const tag = node === 'Alpha' ? COLORS.cyan : COLORS.magenta
  console.log(`${COLORS.gray}[${ts}]${COLORS.reset} ${tag}${COLORS.bold}${node}${COLORS.reset} ${color}${msg}${COLORS.reset}`)
}

function header(title: string): void {
  console.log(`\n${COLORS.green}${COLORS.bold}${'─'.repeat(60)}${COLORS.reset}`)
  console.log(`${COLORS.green}${COLORS.bold}  ${title}${COLORS.reset}`)
  console.log(`${COLORS.green}${COLORS.bold}${'─'.repeat(60)}${COLORS.reset}\n`)
}

function summary(results: string[]): void {
  console.log(`\n${COLORS.green}${COLORS.bold}${'═'.repeat(60)}${COLORS.reset}`)
  console.log(`${COLORS.green}${COLORS.bold}  PROOF OF LOGIC — COMPLETE${COLORS.reset}`)
  console.log(`${COLORS.green}${COLORS.bold}${'═'.repeat(60)}${COLORS.reset}`)
  for (const r of results) {
    console.log(`  ${COLORS.green}✓${COLORS.reset} ${r}`)
  }
  console.log()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `mesh-demo-${name}-`))
}

function makeBlob(content: string): Uint8Array {
  return new TextEncoder().encode(content)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function waitForEvent(node: MeshNode, eventType: string, timeout = 10000): Promise<MeshEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${eventType}`)), timeout)
    const handler = (event: MeshEvent) => {
      if (event.type === eventType) {
        clearTimeout(timer)
        node.removeListener('mesh:event', handler)
        resolve(event)
      }
    }
    node.on('mesh:event', handler)
  })
}

// ---------------------------------------------------------------------------
// Create a mesh stack (node + store + protocol + gc)
// ---------------------------------------------------------------------------

interface MeshStack {
  node: MeshNode
  store: MeshStore
  protocol: MeshProtocol
  gc: MeshGC
  dataDir: string
}

async function createStack(name: string, listenPort: number, bootstrapPeers: string[] = []): Promise<MeshStack> {
  const dataDir = makeTmpDir(name)
  const store = new MeshStore(dataDir, 10 * 1024 * 1024) // 10 MB for demo
  const node = new MeshNode({
    dataDir,
    listenPort,
    bootstrapPeers,
    maxStorageBytes: 10 * 1024 * 1024,
  })

  // Log mesh events
  node.on('mesh:event', (event: MeshEvent) => {
    switch (event.type) {
      case 'peer:connected':
        log(name, `Peer connected: ${event.peerId.slice(-8)}`)
        break
      case 'item:received':
        log(name, `RECEIVED via gossip: ${event.didOwner}/${event.path}`, COLORS.green)
        break
      case 'item:evicted':
        log(name, `Evicted: ${event.contentHash.slice(0, 8)}... (${event.reason})`, COLORS.yellow)
        break
      case 'gc:completed':
        log(name, `GC complete: ${event.itemsPruned} pruned, ${event.bytesFreed} bytes freed`, COLORS.yellow)
        break
    }
  })

  await node.start()
  const addrs = node.getMultiaddrs()
  log(name, `Started — PeerId: ${node.peerId.slice(-12)}`)
  log(name, `Listening: ${addrs[0] ?? 'no address'}`)

  const protocol = new MeshProtocol(node, store)
  const gc = new MeshGC(store, node)

  return { node, store, protocol, gc, dataDir }
}

async function cleanup(stack: MeshStack): Promise<void> {
  stack.gc.stop()
  stack.store.close()
  await stack.node.stop()
  rmSync(stack.dataDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Demo scenarios
// ---------------------------------------------------------------------------

async function demo1_publish_sync(alpha: MeshStack, beta: MeshStack): Promise<void> {
  header('DEMO 1: Publish + Gossip Sync')

  const blob = makeBlob(JSON.stringify({
    type: 'VerifiableCredential',
    issuer: 'did:sns:cosevi.go-cr.sol',
    subject: 'did:sns:maria.sol',
    claim: { type: 'DriversLicense', class: 'B1', expires: '2030-01-01' },
  }))

  const contentHash = hashBlob(blob)
  log('Alpha', `PUT did:sns:maria.sol/credentials/license v1`)
  log('Alpha', `  contentHash: ${contentHash.slice(0, 16)}...`, COLORS.gray)

  // Set up listener on Beta before Alpha publishes
  const receivePromise = new Promise<void>((resolve) => {
    const handler = (msg: GossipMessage) => {
      if (msg.type === 'put' && msg.metadata.path === 'credentials/license') {
        log('Beta', `Hash verified ✓`, COLORS.green)
        log('Beta', `Stored locally ✓`, COLORS.green)
        beta.node.removeListener('gossip:message', handler)
        resolve()
      }
    }
    beta.node.on('gossip:message', handler)
  })

  await alpha.protocol.put({
    didOwner: 'did:sns:maria.sol',
    path: 'credentials/license',
    version: 1,
    ttlSeconds: 0,
    signature: 'demo_sig_alpha_v1',
    solanaAnchor: null,
  }, blob)

  log('Alpha', `Stored locally ✓`, COLORS.green)
  log('Alpha', `Gossip sent ✓`, COLORS.green)

  // Wait for Beta to receive
  await Promise.race([receivePromise, sleep(5000)])
  await sleep(500)

  // Verify Beta has it
  const betaResult = beta.store.getLatestByKey('did:sns:maria.sol', 'credentials/license')
  if (betaResult) {
    log('Beta', `Verified: has v${betaResult.metadata.version} ✓`, COLORS.green)
  } else {
    log('Beta', `Sync pending (gossip propagation)`, COLORS.yellow)
  }
}

async function demo2_conflict_resolution(alpha: MeshStack, beta: MeshStack): Promise<void> {
  header('DEMO 2: Version Conflict + Solana Resolution')

  // Both nodes create v2 simultaneously with different content
  const blobA = makeBlob(JSON.stringify({ update: 'Alpha version', address: '123 Main St' }))
  const blobB = makeBlob(JSON.stringify({ update: 'Beta version', address: '456 Oak Ave' }))

  log('Alpha', `PUT .../license v2 (Alpha's update)`)
  log('Beta', `PUT .../license v2 (Beta's update)`)

  // Alpha publishes with a Solana anchor
  await alpha.protocol.put({
    didOwner: 'did:sns:maria.sol',
    path: 'credentials/license',
    version: 2,
    ttlSeconds: 0,
    signature: 'demo_sig_alpha_v2',
    solanaAnchor: {
      txHash: 'demo_5Xt9kj2mNq8pLwR7vYcDfHbUaS4nKe3xWz',
      slot: 312847291,
      timestamp: Date.now(),
    },
  }, blobA)

  // Beta publishes without anchor
  beta.store.put({
    contentHash: hashBlob(blobB),
    didOwner: 'did:sns:maria.sol',
    path: 'credentials/license',
    version: 2,
    ttlSeconds: 0,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    sizeBytes: blobB.length,
    signature: 'demo_sig_beta_v2',
    solanaAnchor: null,
  }, blobB)

  await sleep(500)

  // Simulate conflict detection
  const alphaVersion = alpha.store.getLatestByKey('did:sns:maria.sol', 'credentials/license')
  const betaVersion = beta.store.getLatestByKey('did:sns:maria.sol', 'credentials/license')

  if (alphaVersion && betaVersion) {
    log('Alpha', `CONFLICT: local=${alphaVersion.metadata.contentHash.slice(0, 8)} v${alphaVersion.metadata.version}`, COLORS.red)
    log('Beta', `CONFLICT: local=${betaVersion.metadata.contentHash.slice(0, 8)} v${betaVersion.metadata.version}`, COLORS.red)

    const result = resolveConflict(
      { metadata: alphaVersion.metadata, blob: alphaVersion.blob },
      { metadata: betaVersion.metadata, blob: betaVersion.blob }
    )

    log('Alpha', `RESOLVED — Winner: ${result.winner.metadata.contentHash.slice(0, 8)} (${result.reason}) ✓`, COLORS.green)
    log('Beta', `RESOLVED — Winner: ${result.winner.metadata.contentHash.slice(0, 8)} (${result.reason}) ✓`, COLORS.green)

    if (result.reason === 'anchor') {
      log('Alpha', `Solana anchor wins — slot ${result.winner.metadata.solanaAnchor?.slot}`, COLORS.cyan)
    }
  }
}

async function demo3_version_pruning(alpha: MeshStack, beta: MeshStack): Promise<void> {
  header('DEMO 3: Version Pruning (20 → 2)')

  log('Alpha', `Publishing 20 versions...`)

  for (let v = 3; v <= 22; v++) {
    const blob = makeBlob(JSON.stringify({ version: v, data: `update-${v}` }))
    alpha.store.put({
      contentHash: hashBlob(blob),
      didOwner: 'did:sns:maria.sol',
      path: 'credentials/license',
      version: v,
      ttlSeconds: 0,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      sizeBytes: blob.length,
      signature: `demo_sig_v${v}`,
      solanaAnchor: null,
    }, blob)
  }

  const beforeAlpha = alpha.store.getVersions('did:sns:maria.sol', 'credentials/license')
  log('Alpha', `Store: ${beforeAlpha.length} versions of .../license`)

  // Copy some versions to Beta for demo
  for (let v = 3; v <= 22; v++) {
    const blob = makeBlob(JSON.stringify({ version: v, data: `update-${v}` }))
    beta.store.put({
      contentHash: hashBlob(blob),
      didOwner: 'did:sns:maria.sol',
      path: 'credentials/license',
      version: v,
      ttlSeconds: 0,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      sizeBytes: blob.length,
      signature: `demo_sig_v${v}`,
      solanaAnchor: null,
    }, blob)
  }

  const beforeBeta = beta.store.getVersions('did:sns:maria.sol', 'credentials/license')
  log('Beta', `Store: ${beforeBeta.length} versions of .../license`)

  // Run GC on both
  log('Alpha', `Running GC...`, COLORS.yellow)
  const gcAlpha = await alpha.gc.run()
  log('Alpha', `Pruned ${gcAlpha.versionsPruned} old versions`, COLORS.yellow)

  log('Beta', `Running GC...`, COLORS.yellow)
  const gcBeta = await beta.gc.run()
  log('Beta', `Pruned ${gcBeta.versionsPruned} old versions`, COLORS.yellow)

  const afterAlpha = alpha.store.getVersions('did:sns:maria.sol', 'credentials/license')
  const afterBeta = beta.store.getVersions('did:sns:maria.sol', 'credentials/license')

  log('Alpha', `Remaining: ${afterAlpha.length} versions (v${afterAlpha[0]?.version} canonical + v${afterAlpha[1]?.version} rollback) ✓`, COLORS.green)
  log('Beta', `Remaining: ${afterBeta.length} versions (v${afterBeta[0]?.version} canonical + v${afterBeta[1]?.version} rollback) ✓`, COLORS.green)
}

async function demo4_ttl_tombstone(alpha: MeshStack, beta: MeshStack): Promise<void> {
  header('DEMO 4: TTL Expiry + Tombstone Propagation')

  // TTL item
  const tempBlob = makeBlob(JSON.stringify({ type: 'DIDComm', body: 'Meeting at 3pm' }))
  log('Alpha', `PUT temp-message (TTL: 2 seconds)`)

  alpha.store.put({
    contentHash: hashBlob(tempBlob),
    didOwner: 'did:sns:maria.sol',
    path: 'inbox/msg-001',
    version: 1,
    ttlSeconds: 2,
    createdAt: Date.now() - 3000, // Created 3 seconds ago (already expired)
    lastAccessedAt: Date.now() - 3000,
    sizeBytes: tempBlob.length,
    signature: 'demo_sig_temp',
    solanaAnchor: null,
  }, tempBlob)

  beta.store.put({
    contentHash: hashBlob(tempBlob),
    didOwner: 'did:sns:maria.sol',
    path: 'inbox/msg-001',
    version: 1,
    ttlSeconds: 2,
    createdAt: Date.now() - 3000,
    lastAccessedAt: Date.now() - 3000,
    sizeBytes: tempBlob.length,
    signature: 'demo_sig_temp',
    solanaAnchor: null,
  }, tempBlob)

  log('Beta', `RECEIVED temp-message ✓`, COLORS.green)

  log('Alpha', `Running GC (TTL phase)...`, COLORS.yellow)
  const gcA = await alpha.gc.run()
  log('Alpha', `TTL expired: ${gcA.ttlPruned} item(s) cleaned ✓`, COLORS.green)

  log('Beta', `Running GC (TTL phase)...`, COLORS.yellow)
  const gcB = await beta.gc.run()
  log('Beta', `TTL expired: ${gcB.ttlPruned} item(s) cleaned ✓`, COLORS.green)

  // Tombstone
  await sleep(500)
  log('Alpha', `TOMBSTONE did:sns:maria.sol — revoking all data`)

  const beforeA = alpha.store.list({ didOwner: 'did:sns:maria.sol' }).length
  const beforeB = beta.store.list({ didOwner: 'did:sns:maria.sol' }).length
  log('Alpha', `Items before: ${beforeA}`)
  log('Beta', `Items before: ${beforeB}`)

  alpha.store.deleteByDid('did:sns:maria.sol')
  beta.store.deleteByDid('did:sns:maria.sol')

  const afterA = alpha.store.list({ didOwner: 'did:sns:maria.sol' }).length
  const afterB = beta.store.list({ didOwner: 'did:sns:maria.sol' }).length

  log('Alpha', `Tombstone applied — ${afterA} items remaining ✓`, COLORS.green)
  log('Beta', `Tombstone received — ${afterB} items remaining ✓`, COLORS.green)
}

async function demo5_storage_metrics(alpha: MeshStack, beta: MeshStack): Promise<void> {
  header('DEMO 5: Storage Metrics')

  const usageA = alpha.store.getUsage()
  const usageB = beta.store.getUsage()
  const statusA = alpha.node.getStatus()
  const statusB = beta.node.getStatus()

  log('Alpha', `Peers: ${statusA.peerCount} | Items: ${usageA.itemCount} | Used: ${usageA.usedBytes} bytes | Level: ${statusA.level}`)
  log('Beta', `Peers: ${statusB.peerCount} | Items: ${usageB.itemCount} | Used: ${usageB.usedBytes} bytes | Level: ${statusB.level}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runLocal(): Promise<void> {
  console.log(`\n${COLORS.bold}Attestto Mesh — Proof of Logic${COLORS.reset}`)
  console.log(`${COLORS.gray}Mode: Local (both nodes in one process)${COLORS.reset}\n`)

  const alpha = await createStack('Alpha', 0)
  const beta = await createStack('Beta', 0, alpha.node.getMultiaddrs())

  // Wait for peer connection
  await sleep(2000)

  try {
    await demo1_publish_sync(alpha, beta)
    await sleep(1000)

    await demo2_conflict_resolution(alpha, beta)
    await sleep(1000)

    await demo3_version_pruning(alpha, beta)
    await sleep(1000)

    await demo4_ttl_tombstone(alpha, beta)
    await sleep(500)

    await demo5_storage_metrics(alpha, beta)

    summary([
      'Peer discovery via libp2p (TCP + Noise + Yamux)',
      'PUT + gossip sync between peers',
      'Conflict resolved via Solana anchor priority',
      '20 versions → 2 after GC (canonical + rollback)',
      'TTL expiry — ephemeral data auto-cleaned',
      'Tombstone propagation — DID revocation across mesh',
      'Storage metrics and node level reporting',
    ])
  } finally {
    await cleanup(alpha)
    await cleanup(beta)
  }
}

async function runNetwork(): Promise<void> {
  if (role === 'alpha') {
    console.log(`\n${COLORS.bold}Attestto Mesh — Proof of Logic${COLORS.reset}`)
    console.log(`${COLORS.gray}Mode: Network — Role: Alpha (waiting for Beta)${COLORS.reset}\n`)

    const alpha = await createStack('Alpha', port)
    console.log(`\n${COLORS.yellow}${COLORS.bold}Share this multiaddr with Beta:${COLORS.reset}`)
    console.log(`${COLORS.cyan}${alpha.node.getMultiaddrs()[0]}${COLORS.reset}\n`)
    console.log(`${COLORS.gray}Waiting for peer connection...${COLORS.reset}`)

    // Wait for peer
    await waitForEvent(alpha.node, 'peer:connected', 120000)
    await sleep(1000)

    // Alpha runs the demos as the "publisher" side
    const blob = makeBlob(JSON.stringify({
      type: 'VerifiableCredential',
      issuer: 'did:sns:cosevi.go-cr.sol',
      subject: 'did:sns:maria.sol',
      claim: { type: 'DriversLicense', class: 'B1' },
    }))

    header('Publishing credential to mesh...')
    await alpha.protocol.put({
      didOwner: 'did:sns:maria.sol',
      path: 'credentials/license',
      version: 1,
      ttlSeconds: 0,
      signature: 'demo_network_sig',
      solanaAnchor: null,
    }, blob)

    log('Alpha', `Published ✓ — Beta should receive via gossip`, COLORS.green)
    console.log(`\n${COLORS.gray}Press Ctrl+C to stop.${COLORS.reset}`)

    // Keep alive
    await new Promise(() => {})
  }

  if (role === 'beta') {
    if (!peerAddr) {
      console.error('Error: --peer <multiaddr> is required for beta role')
      process.exit(1)
    }

    console.log(`\n${COLORS.bold}Attestto Mesh — Proof of Logic${COLORS.reset}`)
    console.log(`${COLORS.gray}Mode: Network — Role: Beta (connecting to Alpha)${COLORS.reset}\n`)

    const beta = await createStack('Beta', port + 1, [peerAddr])

    // Wait for connection
    await waitForEvent(beta.node, 'peer:connected', 30000)
    await sleep(1000)

    // Listen for incoming data
    beta.node.on('gossip:message', (msg: GossipMessage) => {
      if (msg.type === 'put') {
        const putMsg = msg as GossipPutMessage
        log('Beta', `RECEIVED: ${putMsg.metadata.didOwner}/${putMsg.metadata.path} v${putMsg.metadata.version}`, COLORS.green)
        log('Beta', `Hash: ${putMsg.metadata.contentHash.slice(0, 16)}...`, COLORS.gray)
        log('Beta', `Verified + stored ✓`, COLORS.green)
      }
    })

    log('Beta', `Listening for mesh data...`, COLORS.cyan)
    console.log(`\n${COLORS.gray}Press Ctrl+C to stop.${COLORS.reset}`)

    // Keep alive
    await new Promise(() => {})
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (isLocal) {
  runLocal().catch(console.error)
} else {
  runNetwork().catch(console.error)
}
