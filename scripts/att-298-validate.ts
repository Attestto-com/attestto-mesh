#!/usr/bin/env tsx
/**
 * ATT-298 live validation — drives PUT/GET against two running mesh daemons
 * via their HTTP RPC, exercising the L3 (findProviders + fetchFromPeer) path.
 *
 * Usage:
 *   MESH_RPC_TOKEN=<token> \
 *   NODE_A=http://127.0.0.1:4101 \
 *   NODE_B=http://127.0.0.1:4102 \
 *   pnpm exec tsx scripts/att-298-validate.ts
 *
 * For the PC node, open an SSH tunnel first:
 *   ssh -L 4102:127.0.0.1:4101 ck-racing
 */

const NODE_A = process.env.NODE_A ?? 'http://127.0.0.1:4101'
const NODE_B = process.env.NODE_B ?? 'http://127.0.0.1:4102'
const TOKEN = process.env.MESH_RPC_TOKEN ?? ''

interface PutBody {
  didOwner: string
  path: string
  version: number
  blob_b64: string
  ttlSeconds?: number
}

function authHeaders(): Record<string, string> {
  return TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}
}

async function status(node: string): Promise<{ peerId: string; peerCount: number }> {
  const res = await fetch(`${node}/status`, { headers: authHeaders() })
  if (!res.ok) throw new Error(`${node}/status → ${res.status}`)
  return res.json() as Promise<{ peerId: string; peerCount: number }>
}

async function put(node: string, body: PutBody): Promise<string> {
  const res = await fetch(`${node}/put`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${node}/put → ${res.status} ${await res.text()}`)
  const { contentHash } = (await res.json()) as { contentHash: string }
  return contentHash
}

async function get(
  node: string,
  did: string,
  path: string
): Promise<{ blob_b64: string; metadata: { contentHash: string } } | null> {
  const url = `${node}/get?did=${encodeURIComponent(did)}&path=${encodeURIComponent(path)}`
  const res = await fetch(url, { headers: authHeaders() })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`${node}/get → ${res.status} ${await res.text()}`)
  return res.json() as Promise<{ blob_b64: string; metadata: { contentHash: string } }>
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

function unb64(s: string): string {
  return Buffer.from(s, 'base64').toString('utf8')
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

let pass = 0
let fail = 0

function ok(name: string): void {
  console.log(`  ✓ ${name}`)
  pass++
}

function bad(name: string, reason: string): void {
  console.log(`  ✗ ${name} — ${reason}`)
  fail++
}

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    ok(name)
  } catch (err) {
    bad(name, (err as Error).message)
  }
}

async function main(): Promise<void> {
  console.log(`ATT-298 live validation`)
  console.log(`  Node A: ${NODE_A}`)
  console.log(`  Node B: ${NODE_B}\n`)

  const [a, b] = await Promise.all([status(NODE_A), status(NODE_B)])
  console.log(`A peerId=${a.peerId.slice(0, 16)}… peers=${a.peerCount}`)
  console.log(`B peerId=${b.peerId.slice(0, 16)}… peers=${b.peerCount}\n`)

  if (a.peerId === b.peerId) {
    console.error('FAIL: NODE_A and NODE_B have the same peerId — point them at different daemons')
    process.exit(1)
  }
  if (a.peerCount === 0 || b.peerCount === 0) {
    console.error('FAIL: at least one node has zero peers — mesh not connected')
    process.exit(1)
  }

  const did = `did:sns:att298-test-${Date.now()}.sol`

  // -------------------------------------------------------------------------
  console.log('Test 1 — PUT on A, GET on B (L3 path: findProviders + fetchFromPeer)')
  // -------------------------------------------------------------------------
  await check('PUT succeeds on A', async () => {
    const payload = `hello-from-A-${Date.now()}`
    const hash = await put(NODE_A, { didOwner: did, path: '/t1', version: 1, blob_b64: b64(payload) })
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`bad hash: ${hash}`)
    ;(globalThis as unknown as { __t1: { payload: string; hash: string } }).__t1 = { payload, hash }
  })

  await sleep(2000) // let DHT provide propagate

  await check('GET on B returns the same blob with matching hash', async () => {
    const t1 = (globalThis as unknown as { __t1: { payload: string; hash: string } }).__t1
    const got = await get(NODE_B, did, '/t1')
    if (!got) throw new Error('not found on B')
    if (got.metadata.contentHash !== t1.hash) {
      throw new Error(`hash mismatch: ${got.metadata.contentHash} vs ${t1.hash}`)
    }
    if (unb64(got.blob_b64) !== t1.payload) throw new Error('blob payload mismatch')
  })

  // -------------------------------------------------------------------------
  console.log('\nTest 2 — symmetric: PUT on B, GET on A')
  // -------------------------------------------------------------------------
  await check('PUT succeeds on B', async () => {
    const payload = `hello-from-B-${Date.now()}`
    const hash = await put(NODE_B, { didOwner: did, path: '/t2', version: 1, blob_b64: b64(payload) })
    ;(globalThis as unknown as { __t2: { payload: string; hash: string } }).__t2 = { payload, hash }
  })

  await sleep(2000)

  await check('GET on A returns the same blob with matching hash', async () => {
    const t2 = (globalThis as unknown as { __t2: { payload: string; hash: string } }).__t2
    const got = await get(NODE_A, did, '/t2')
    if (!got) throw new Error('not found on A')
    if (got.metadata.contentHash !== t2.hash) throw new Error('hash mismatch')
    if (unb64(got.blob_b64) !== t2.payload) throw new Error('blob payload mismatch')
  })

  // -------------------------------------------------------------------------
  console.log('\nTest 3 — GET for unknown key returns 404')
  // -------------------------------------------------------------------------
  await check('GET unknown path returns null/404', async () => {
    const got = await get(NODE_A, did, '/does-not-exist')
    if (got !== null) throw new Error('expected null')
  })

  // -------------------------------------------------------------------------
  console.log('\nTest 4 — oversize blob is rejected by the fetch cap')
  // -------------------------------------------------------------------------
  // MAX_FETCH_BYTES = 64KB on the wire. The MeshItem envelope (JSON) carries
  // the blob plus metadata, so a ~50KB raw blob already overflows once
  // base64+JSON-encoded — the FETCH leg should return null on B.
  await check('PUT on A then GET on B with 50KB blob: B sees null (overflow)', async () => {
    const big = 'x'.repeat(50 * 1024)
    await put(NODE_A, { didOwner: did, path: '/t4-big', version: 1, blob_b64: b64(big) })
    await sleep(2000)
    const got = await get(NODE_B, did, '/t4-big')
    if (got !== null) throw new Error('expected null (oversize), got a blob')
  })

  console.log(`\nResults: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
