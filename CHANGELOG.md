# Changelog

All notable changes to `@attestto/mesh` will be documented in this file.

This project adheres to [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-10

### Added
- Initial release: distributed P2P mesh for sovereign identity state over libp2p.
- **MeshNode:** libp2p networking with gossipsub, Kademlia DHT, TCP/WebRTC transports, circuit relay, per-peer rate limiting (50 msg/sec), 64 KB payload caps.
- **MeshStore:** SQLite-backed local storage with content-addressed blobs (SHA-256), versioning, TTL expiration, LRU tracking, DID-scoped queries.
- **MeshProtocol:** PUT/GET/TOMBSTONE operations with three-layer resolution (L1 local, L2 DHT, L3 peer fetch). Hash re-verification on fetch. Conflict resolution favoring Solana anchors.
- **MeshGC:** Garbage collection with TTL expiration, version pruning (keep canonical + 1 rollback), LRU eviction with DHT holder-count safety rail (ATT-299 — refuses eviction if fewer than 6 peers hold the blob).
- **MeshRpcServer:** Local HTTP server for status, metrics (Prometheus), diagnostics, and PUT/GET operations. Bearer auth required for non-loopback binds.
- **Anchor adapter pattern:** pluggable `AnchorAdapter` interface. `MockAnchorAdapter` with production guard. `anchorToSolana()` stub for future Solana integration.
- **Crypto:** SHA-256 hashing, Ed25519 signing/verification with key zeroization.
- **Daemon:** Docker/CLI entry point with persistent PeerID, env-driven config, SIGTERM cleanup.
- Conflict resolution: Solana anchor > version number > timestamp > deterministic hash tiebreak.
- Public bootstrap peer: Fly.io dfw anchor baked into DEFAULT_CONFIG.
- Fly.io deployment config for anchor nodes.
- Test suite: 62 tests covering anchor adapter, crypto, store CRUD, conflict resolution, bootstrap config, GC safety rails, and security regressions (SQL injection, rate limiting, key zeroization, production guards).
- CI workflow for lint, test, build.

### Security
- SEC-01: Remote tombstone blocked without signature verification.
- SEC-02: SQL injection protection in `list()` filters (parameterized queries + whitelist).
- SEC-03: MockAnchorAdapter production guard (throws in NODE_ENV=production).
- SEC-04: Default listen address is 127.0.0.1 (loopback only).
- SEC-05: Per-peer gossip rate limit (50/sec window).
- SEC-06: Oversized gossip payload rejection.
- SEC-07: Ed25519 key buffer zeroization after signing.
