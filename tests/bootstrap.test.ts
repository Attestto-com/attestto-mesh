import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG, PUBLIC_BOOTSTRAP_PEERS } from '../src/types.js'
import { MeshNode } from '../src/node.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Locks in the policy that @attestto/mesh consumers join the public mesh by
 * default and that the bootstrap list stays well-formed across refactors.
 *
 * These are pure-function checks — no network, no libp2p start. The point is
 * to fail fast in CI if someone accidentally drops or corrupts the public
 * anchor entry, not to test connectivity (which is an integration concern).
 */
describe('bootstrap peers', () => {
  it('PUBLIC_BOOTSTRAP_PEERS is non-empty', () => {
    expect(PUBLIC_BOOTSTRAP_PEERS.length).toBeGreaterThan(0)
  })

  it('DEFAULT_CONFIG.bootstrapPeers contains exactly PUBLIC_BOOTSTRAP_PEERS', () => {
    expect(DEFAULT_CONFIG.bootstrapPeers).toEqual([...PUBLIC_BOOTSTRAP_PEERS])
  })

  it('every public bootstrap entry uses a /dns4/ hostname (we own it, IPs can rotate)', () => {
    for (const addr of PUBLIC_BOOTSTRAP_PEERS) {
      expect(addr).toMatch(/^\/dns4\//)
    }
  })

  it('every public bootstrap entry has a /p2p/<peerId> suffix', () => {
    for (const addr of PUBLIC_BOOTSTRAP_PEERS) {
      expect(addr).toMatch(/\/p2p\/12D3KooW[1-9A-HJ-NP-Za-km-z]+$/)
    }
  })

  it('every public bootstrap entry uses tcp transport on port 4001', () => {
    for (const addr of PUBLIC_BOOTSTRAP_PEERS) {
      expect(addr).toMatch(/\/tcp\/4001\//)
    }
  })

  it('passing an empty bootstrapPeers override drops the public anchor (test isolation)', () => {
    // Tests must NOT accidentally dial the production mesh. Verify that
    // explicitly passing [] wins over DEFAULT_CONFIG.bootstrapPeers via the
    // shallow merge in MeshNode's constructor.
    const tmp = mkdtempSync(join(tmpdir(), 'mesh-bootstrap-test-'))
    const node = new MeshNode({ dataDir: tmp, bootstrapPeers: [] })
    // node.config is private — read via JSON snapshot of the spread merge.
    // We don't await start(), so no libp2p side effects occur.
    expect((node as unknown as { config: { bootstrapPeers: string[] } }).config.bootstrapPeers).toEqual([])
  })

  it('omitting bootstrapPeers inherits the public anchor list', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mesh-bootstrap-test-'))
    const node = new MeshNode({ dataDir: tmp })
    expect((node as unknown as { config: { bootstrapPeers: string[] } }).config.bootstrapPeers).toEqual([
      ...PUBLIC_BOOTSTRAP_PEERS,
    ])
  })
})
