#!/usr/bin/env tsx
/**
 * Attestto Mesh — Node Daemon
 *
 * Long-running mesh node entrypoint, env-driven, with persistent PeerID.
 * Run via Docker (see docker-compose.node.yml) or directly:
 *   pnpm exec tsx src/daemon.ts
 *
 * Environment:
 *   MESH_DATA_DIR        Persistent data dir (default /data/mesh)
 *   MESH_LISTEN_PORT     TCP listen port (default 4001)
 *   MESH_LISTEN_ADDRESS  Bind address (default 0.0.0.0)
 *   MESH_BOOTSTRAP_PEERS Comma-separated multiaddrs (optional)
 *   MESH_ID              Mesh isolation id (default attestto-cr)
 *   MESH_MAX_STORAGE_MB  Storage cap in MB (default 250)
 *   MESH_RELAY_SERVER    "1" to enable circuit-relay server (default off)
 *   MESH_STATUS_INTERVAL Status log interval ms (default 30000)
 *   MESH_RPC_PORT        HTTP RPC port (default 0 = disabled)
 *   MESH_RPC_BIND        HTTP RPC bind address (default 127.0.0.1)
 *   MESH_RPC_TOKEN       Bearer token, REQUIRED if RPC bind is non-loopback
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  generateKeyPair,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
} from '@libp2p/crypto/keys'
import type { PrivateKey } from '@libp2p/interface'
import { MeshNode } from './node.js'
import { MeshStore } from './store.js'
import { MeshProtocol } from './protocol.js'
import { MeshGC } from './gc.js'
import { MeshRpcServer } from './rpc.js'

const env = process.env
const DATA_DIR = env.MESH_DATA_DIR ?? '/data/mesh'
const LISTEN_PORT = parseInt(env.MESH_LISTEN_PORT ?? '4001', 10)
const LISTEN_ADDR = env.MESH_LISTEN_ADDRESS ?? '0.0.0.0'
const MESH_ID = env.MESH_ID ?? 'attestto-cr'
const MAX_STORAGE_BYTES = parseInt(env.MESH_MAX_STORAGE_MB ?? '250', 10) * 1024 * 1024
const RELAY_SERVER = env.MESH_RELAY_SERVER === '1'
const STATUS_INTERVAL_MS = parseInt(env.MESH_STATUS_INTERVAL ?? '30000', 10)
const RPC_PORT = parseInt(env.MESH_RPC_PORT ?? '0', 10)
const RPC_BIND = env.MESH_RPC_BIND ?? '127.0.0.1'
const RPC_TOKEN = env.MESH_RPC_TOKEN
const BOOTSTRAP_PEERS = (env.MESH_BOOTSTRAP_PEERS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)

function ts(): string {
  return new Date().toISOString()
}

function log(msg: string): void {
  console.log(`[${ts()}] ${msg}`)
}

async function loadOrCreatePrivateKey(dir: string): Promise<PrivateKey> {
  const keyPath = join(dir, 'peer.key')
  if (existsSync(keyPath)) {
    const buf = readFileSync(keyPath)
    log(`Loaded persistent PeerID key from ${keyPath}`)
    return privateKeyFromProtobuf(new Uint8Array(buf))
  }
  log(`No peer.key found — generating new Ed25519 keypair`)
  const key = await generateKeyPair('Ed25519')
  const protobuf = privateKeyToProtobuf(key)
  writeFileSync(keyPath, protobuf, { mode: 0o600 })
  log(`Saved new PeerID key to ${keyPath}`)
  return key
}

async function main(): Promise<void> {
  log(`Attestto Mesh Daemon starting`)
  log(`  data dir:    ${DATA_DIR}`)
  log(`  listen:      ${LISTEN_ADDR}:${LISTEN_PORT}`)
  log(`  mesh id:     ${MESH_ID}`)
  log(`  max storage: ${MAX_STORAGE_BYTES} bytes`)
  log(`  bootstrap:   ${BOOTSTRAP_PEERS.length === 0 ? '(none)' : BOOTSTRAP_PEERS.join(', ')}`)
  log(`  relay srv:   ${RELAY_SERVER ? 'on' : 'off'}`)
  log(`  rpc:         ${RPC_PORT > 0 ? `${RPC_BIND}:${RPC_PORT}` : 'disabled'}`)

  if (RPC_PORT > 0 && RPC_BIND !== '127.0.0.1' && RPC_BIND !== 'localhost' && RPC_BIND !== '::1' && !RPC_TOKEN) {
    throw new Error('MESH_RPC_TOKEN is required when MESH_RPC_BIND is non-loopback')
  }

  mkdirSync(DATA_DIR, { recursive: true })

  const privateKey = await loadOrCreatePrivateKey(DATA_DIR)

  const store = new MeshStore(DATA_DIR, MAX_STORAGE_BYTES)

  const node = new MeshNode({
    privateKey,
    dataDir: DATA_DIR,
    listenPort: LISTEN_PORT,
    listenAddress: LISTEN_ADDR,
    bootstrapPeers: BOOTSTRAP_PEERS,
    maxStorageBytes: MAX_STORAGE_BYTES,
    meshId: MESH_ID,
    enableRelayServer: RELAY_SERVER,
    enableRelayClient: true,
  })

  node.on('mesh:event', (evt) => {
    log(`event ${JSON.stringify(evt)}`)
  })

  const protocol = new MeshProtocol(node, store)
  const gc = new MeshGC(store, node)

  await node.start()

  let rpc: MeshRpcServer | null = null
  if (RPC_PORT > 0) {
    rpc = new MeshRpcServer(node, protocol, { port: RPC_PORT, bind: RPC_BIND, token: RPC_TOKEN })
    await rpc.start()
    log(`RPC listening on http://${RPC_BIND}:${RPC_PORT}`)
  }

  log(`Node started — PeerID: ${node.peerId}`)
  for (const ma of node.getMultiaddrs()) {
    log(`Listening on: ${ma}`)
  }

  const statusTimer = setInterval(() => {
    const s = node.getStatus()
    log(`status peers=${s.peerCount} level=${s.level} items=${s.storage.itemCount} used=${s.storage.usedBytes}`)
  }, STATUS_INTERVAL_MS)

  let stopping = false
  const shutdown = async (sig: string) => {
    if (stopping) return
    stopping = true
    log(`Received ${sig}, shutting down`)
    clearInterval(statusTimer)
    try {
      if (rpc) await rpc.stop()
      gc.stop()
      store.close()
      await node.stop()
    } catch (err) {
      log(`Shutdown error: ${(err as Error).message}`)
    }
    log(`Stopped cleanly`)
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  console.error(`[${ts()}] FATAL: ${err instanceof Error ? err.stack : String(err)}`)
  process.exit(1)
})
