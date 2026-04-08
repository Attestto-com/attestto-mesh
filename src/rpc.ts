/**
 * Local RPC server for the mesh daemon.
 *
 * HTTP API on 127.0.0.1 (by default) for driving PUT/GET against a running
 * node. Used for ATT-298 live validation across the multi-node bench, and
 * as the foundation for /metrics observability.
 *
 * SECURITY: binds to 127.0.0.1 by default. If MESH_RPC_BIND is changed to a
 * routable address, MESH_RPC_TOKEN MUST be set — write endpoints reject
 * unauthenticated requests when bind != loopback.
 *
 * Endpoints:
 *   GET  /status                       → node status JSON
 *   GET  /metrics                      → status as text/plain (Prom-ish, future)
 *   POST /put     {didOwner,path,version,blob_b64,ttlSeconds?,signature?}
 *                                      → {contentHash}
 *   GET  /get?did=<did>&path=<path>   → {metadata, blob_b64} or 404
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { MeshNode } from './node.js'
import type { MeshProtocol } from './protocol.js'

interface RpcOptions {
  port: number
  bind: string
  token?: string
}

export class MeshRpcServer {
  private node: MeshNode
  private protocol: MeshProtocol
  private opts: RpcOptions
  private server: Server | null = null

  constructor(node: MeshNode, protocol: MeshProtocol, opts: RpcOptions) {
    this.node = node
    this.protocol = protocol
    this.opts = opts
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          this.send(res, 500, { error: (err as Error).message })
        })
      })
      this.server.once('error', reject)
      this.server.listen(this.opts.port, this.opts.bind, () => resolve())
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
  }

  private isLoopback(): boolean {
    return this.opts.bind === '127.0.0.1' || this.opts.bind === 'localhost' || this.opts.bind === '::1'
  }

  private authorized(req: IncomingMessage): boolean {
    if (this.isLoopback()) return true
    if (!this.opts.token) return false
    const header = req.headers['authorization']
    if (typeof header !== 'string') return false
    return header === `Bearer ${this.opts.token}`
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const payload = typeof body === 'string' ? body : JSON.stringify(body)
    res.writeHead(status, {
      'content-type': typeof body === 'string' ? 'text/plain' : 'application/json',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  private async readBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      req.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > maxBytes) {
          reject(new Error('payload too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const method = req.method ?? 'GET'

    if (method === 'GET' && url.pathname === '/status') {
      this.send(res, 200, this.node.getStatus())
      return
    }

    if (method === 'GET' && url.pathname === '/diag') {
      this.send(res, 200, {
        status: this.node.getStatus(),
        gossip: this.node.getGossipDiagnostic(),
        connections: this.node.getConnectionDiagnostic(),
        selfProtocols: this.node.getSelfProtocols(),
        multiaddrs: this.node.getMultiaddrs(),
      })
      return
    }

    if (method === 'GET' && url.pathname === '/metrics') {
      const s = this.node.getStatus()
      const lines = [
        `mesh_peer_count ${s.peerCount}`,
        `mesh_dht_ready ${s.dhtReady ? 1 : 0}`,
        `mesh_uptime_ms ${s.uptimeMs}`,
        `mesh_storage_used_bytes ${s.storage.usedBytes}`,
        `mesh_storage_limit_bytes ${s.storage.limitBytes}`,
        `mesh_storage_item_count ${s.storage.itemCount}`,
      ]
      this.send(res, 200, lines.join('\n') + '\n')
      return
    }

    if (method === 'POST' && url.pathname === '/put') {
      if (!this.authorized(req)) {
        this.send(res, 401, { error: 'unauthorized' })
        return
      }
      const body = JSON.parse(await this.readBody(req)) as {
        didOwner?: string
        path?: string
        version?: number
        blob_b64?: string
        ttlSeconds?: number
        signature?: string
      }
      if (!body.didOwner || !body.path || typeof body.version !== 'number' || !body.blob_b64) {
        this.send(res, 400, { error: 'didOwner, path, version, blob_b64 required' })
        return
      }
      const blob = new Uint8Array(Buffer.from(body.blob_b64, 'base64'))
      const contentHash = await this.protocol.put(
        {
          didOwner: body.didOwner,
          path: body.path,
          version: body.version,
          ttlSeconds: body.ttlSeconds ?? 3600,
          signature: body.signature ?? 'unsigned',
          solanaAnchor: null,
        },
        blob
      )
      this.send(res, 200, { contentHash })
      return
    }

    if (method === 'GET' && url.pathname === '/get') {
      const did = url.searchParams.get('did')
      const path = url.searchParams.get('path')
      if (!did || !path) {
        this.send(res, 400, { error: 'did and path required' })
        return
      }
      const item = await this.protocol.get(did, path)
      if (!item) {
        this.send(res, 404, { error: 'not found' })
        return
      }
      this.send(res, 200, {
        metadata: item.metadata,
        blob_b64: Buffer.from(item.blob).toString('base64'),
      })
      return
    }

    this.send(res, 404, { error: 'not found' })
  }
}
