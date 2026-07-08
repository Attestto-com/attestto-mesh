import { describe, it, expect, afterEach } from 'vitest'
import { DEFAULT_CONFIG } from '../src/types.js'
import { MeshNode } from '../src/node.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * mDNS local peer discovery.
 *
 * The config checks are pure-function and always run (mirrors bootstrap.test.ts):
 * they lock the default-off policy and the constructor merge so a refactor can't
 * silently flip mDNS on or drop the flag.
 *
 * The two-node discovery test actually starts libp2p and multicasts on the LAN,
 * so it is an integration concern — flaky under CI network policies that block
 * multicast (client isolation). It is gated behind MESH_MDNS_IT=1 and skipped by
 * default. Run locally for the offline/air-gapped demo:
 *
 *   MESH_MDNS_IT=1 pnpm test mdns
 */
describe('mDNS config', () => {
  it('is off by default', () => {
    expect(DEFAULT_CONFIG.enableMdns).toBe(false)
  })

  it('omitting enableMdns inherits the safe default (off)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mesh-mdns-test-'))
    const node = new MeshNode({ dataDir: tmp, bootstrapPeers: [] })
    expect(
      (node as unknown as { config: { enableMdns: boolean } }).config.enableMdns
    ).toBe(false)
  })

  it('an explicit enableMdns override wins over the default', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mesh-mdns-test-'))
    const node = new MeshNode({ dataDir: tmp, bootstrapPeers: [], enableMdns: true })
    expect(
      (node as unknown as { config: { enableMdns: boolean } }).config.enableMdns
    ).toBe(true)
  })
})

describe.skipIf(!process.env.MESH_MDNS_IT)('mDNS discovery (integration)', () => {
  const nodes: MeshNode[] = []

  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop().catch(() => {})))
    nodes.length = 0
  })

  it('two same-LAN nodes discover each other with NO bootstrap/anchor', async () => {
    const mk = () => {
      const tmp = mkdtempSync(join(tmpdir(), 'mesh-mdns-it-'))
      const node = new MeshNode({
        dataDir: tmp,
        bootstrapPeers: [], // no anchor — proves discovery is purely local
        enableMdns: true,
        listenAddress: '0.0.0.0', // MUST bind LAN, not loopback, for multicast
        enableRelayClient: false,
      })
      nodes.push(node)
      return node
    }

    const a = mk()
    const b = mk()

    const connected = new Promise<void>((resolve) => {
      a.on('mesh:event', (evt: { type: string }) => {
        if (evt.type === 'peer:connected') resolve()
      })
    })

    await a.start()
    await b.start()

    // mDNS announce + dial is not instant; fail loud if it never happens.
    await Promise.race([
      connected,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('mDNS peers did not connect within 15s')), 15_000)
      ),
    ])

    expect(a.getStatus().peerCount).toBeGreaterThan(0)
  }, 20_000)
})
