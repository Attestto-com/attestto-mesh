[English](./README.md) | **[Espanol](./README.es.md)**

---

# Demo Proof of Logic

Valida todas las primitivas del mesh de extremo a extremo en menos de 30 segundos.

## Que Demuestra

| Demo | Que sucede | Por que importa |
|:-----|:-----------|:----------------|
| **1. Publicar + Sincronizar** | Nodo A publica una credencial verificable, Nodo B la recibe via gossip | Los datos se replican entre pares sin servidor central |
| **2. Resolucion de Conflictos** | Ambos nodos publican versiones diferentes simultaneamente, el ancla Solana gana | Arbitraje deterministico — sin coordinador, sin protocolo de consenso |
| **3. Poda de Versiones** | Se publican 20 versiones, el GC las reduce a 2 (canonica + rollback) | El almacenamiento se mantiene acotado — el mesh se limpia solo |
| **4. TTL + Tombstone** | Mensaje efimero expira automaticamente; revocacion de DID se propaga a todos los pares | Los datos tienen un ciclo de vida — nada persiste para siempre sin estar anclado |
| **5. Metricas de Almacenamiento** | Ambos nodos reportan cantidad de pares, items, bytes usados, nivel de nodo | Observabilidad integrada — cada nodo conoce su propio estado |

## Como Ejecutar

### Demo rapido — un comando, 15 segundos

```bash
pnpm demo
```

Ambos nodos corren en un solo proceso. Sin configuracion de red. Observa como se descubren, sincronizan, resuelven conflictos y limpian en tiempo real.

### Dos maquinas en la misma red

```bash
# Maquina A
pnpm demo:alpha

# Maquina B (usar el multiaddr que imprime Maquina A)
pnpm demo:beta --peer /ip4/192.168.1.X/tcp/4001/p2p/12D3Koo...
```

Demuestra que el protocolo funciona entre maquinas independientes sobre TCP real, no solo en proceso.

### Docker — sin dependencias locales

```bash
# Construir y ejecutar (no necesita Node.js)
docker build -t attestto-mesh .. && docker run attestto-mesh

# Dos contenedores
docker compose -f ../docker-compose.yml up
```

Para revisores y auditores que quieran verificar sin instalar nada.

## Salida Esperada

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
