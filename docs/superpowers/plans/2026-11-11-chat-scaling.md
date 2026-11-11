# Chat Scaling Implementation Plan

**Goal:** Implement the four approved optimizations and independently configurable room limits, both defaulting to 100.

**Architecture:** Separate the MLS application epoch from relay ordering while keeping membership commits serialized. Coalesce synchronization, cache roster revisions, separate IndexedDB leases/history from key snapshots, and coordinate automatic admission using an expiring relay lease.

**Constraints:** Preserve HTTP support, admission permissions, ciphertext-only relay, idempotency, durable outbox and exclusive endpoint ownership. Never operate port 8181. Defaults are admission limits, not measured performance guarantees. No Git checkout is present.

## Steps

- [x] Configuration and limits: add `MAX_ENCRYPTED_MEMBERS` and `MAX_PLAIN_MEMBERS` to `server/config.js`, `.env`, `.env.example`, and README. Test defaults, precedence, invalid positive integers, full-room rejection, pending slots and concurrent joins. Apply limits to room membership before issuing tokens, not just MLS registration.
- [x] Concurrent applications: test independent same-epoch messages, stale-epoch rejection, strict commit ordering and idempotency in `test/mls-relay.test.js`. Change `server/mls-relay.js` and `src/mls-client.js`; consume acknowledged self events in order instead of jumping the local cursor past other senders.
- [x] Synchronization and coordination: use event-array slicing and optional `rosterVersion` in relay reads; coalesce browser sync work. Test a single expiring automatic admission lease, expiry takeover, departed-owner release, and pending-user rejection. Keep manual approval independent of the lease.
- [x] Storage: upgrade IndexedDB to separate `rooms`, `leases`, and `history` stores. Migrate v1 records atomically. Renew leases without snapshots; atomically persist snapshot/cursor/outbox plus changed history. Batch received events at a durable checkpoint before UI delivery; on failure reload durable state. Browser-test refresh, lost acknowledgment, duplicate identity, migration and cleanup.
- [x] Verify: run `npm test`, `npm run build`, and the real-browser suite with random-port temporary services. Add simultaneous-send, coordinator timeout takeover, storage/migration and multi-member tests. Record measured scope without claiming a 100-person capacity guarantee.

## Verification Results

- `npm test`: 60 passed, 0 failed.
- `npm run build`: passed.
- `verify-storage.mjs`: passed v1 migration, lease-only heartbeats, atomic abort/rollback, ownership, retention and cleanup.
- `verify-app.mjs`: passed real page/SSE, concurrent messages, lost acknowledgment, refresh, crash recovery, admission permissions and automatic coordinator timeout takeover.
- `verify-scale.mjs`: passed 100 independent real MLS sessions over HTTP with IndexedDB, 100 concurrent sends delivered to every identity, 101st-member rejection for both room modes, sync coalescing, batch checkpoints and key recovery after an injected persistence failure.
- Scale run uses one renderer and explicit sync, not 100 devices or SSE connections. No production pressure limit claimed.
- Independent reviewer dispatch returned no review because its task payload was not delivered; no independent review conclusion is claimed.

## Commands

```text
npm test
npm run build
node mls-prototype/verify-app.mjs <installed-playwright-module>
```
