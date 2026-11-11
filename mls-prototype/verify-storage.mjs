import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.argv[2] || 'playwright');
const source = await readFile(new URL('../src/mls-storage.js', import.meta.url), 'utf8');
const server = createServer((_req, res) => res.end('<!doctype html><title>Storage test</title>'));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async code => {
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const expiry = Date.now() + 60000;
    // Existing v1 private state/history must survive the schema upgrade.
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('lan-note-room-mls', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('rooms');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('rooms', 'readwrite');
        transaction.objectStore('rooms').put({
          owner: 'old', lease: Date.now() + 10000, expiresAt: expiry,
          snapshot: new Uint8Array([1, 2]), cursor: 1,
          history: [{ id: 1, content: 'existing history' }],
        }, 'room:session');
        transaction.oncomplete = () => { db.close(); resolve(); };
      };
    });
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const storage = await import(url);
    URL.revokeObjectURL(url);
    const record = await storage.claimSession('room:session', 'new', 'old', expiry);
    check(record.history[0].content === 'existing history', 'v1 history migration');
    check(record.snapshot[1] === 2 && record.cursor === 1, 'v1 private state migration');
    let denied = false;
    try { await storage.claimSession('room:session', 'duplicate', 'old', expiry); }
    catch { denied = true; }
    check(denied, 'stale handoff must not steal the lease');

    const puts = [];
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      puts.push(this.name);
      return originalPut.apply(this, args);
    };
    await storage.renewLease('room:session', 'new');
    IDBObjectStore.prototype.put = originalPut;
    check(puts.length === 1 && puts[0] === 'leases', 'heartbeat must write only the lease');

    await storage.saveSession('room:session', {
      ...record, cursor: 2, snapshot: new Uint8Array([3]),
    }, 'new', [{ id: 2, content: 'durably received' }]);
    await storage.releaseLease('room:session', 'new');
    const restored = await storage.claimSession('room:session', 'next', null, expiry);
    check(restored.history.length === 2 && restored.cursor === 2
      && restored.snapshot[0] === 3, 'snapshot, cursor and history must restore together');
    denied = false;
    try { await storage.saveSession('room:session', record, 'new', []); }
    catch { denied = true; }
    check(denied, 'stale owner must not overwrite state');

    // Fail a real IDB transaction after writes were queued: all stores must roll back.
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'history') throw new Error('injected storage failure');
      return originalPut.apply(this, args);
    };
    denied = false;
    try {
      await storage.saveSession('room:session', {
        ...restored, cursor: 3, snapshot: new Uint8Array([9]),
      }, 'next', [{ id: 3, content: 'must not survive abort' }]);
    } catch { denied = true; }
    IDBObjectStore.prototype.put = originalPut;
    check(denied, 'failed history write must reject');
    await storage.releaseLease('room:session', 'next');
    const rolledBack = await storage.claimSession('room:session', 'last', null, expiry);
    check(rolledBack.cursor === 2 && rolledBack.snapshot[0] === 3
      && rolledBack.history.length === 2, 'atomic rollback across all stores');

    const messages = Array.from({ length: 1001 }, (_, index) => ({
      id: index + 3, content: `message ${index}`,
    }));
    await storage.saveSession('room:session', {
      ...rolledBack, cursor: 1003,
    }, 'last', messages);
    await storage.releaseLease('room:session', 'last');
    const bounded = await storage.claimSession('room:session', 'reader', null, expiry);
    check(bounded.history.length === 1000 && bounded.history[0].id === 4, 'bounded local history');

    await storage.claimSession('room:other', 'other', null, expiry);
    await storage.removeSessionRecord('room', 'session');
    const remaining = await storage.claimSession('room:other', 'other', null, expiry);
    check(remaining.owner === 'other', 'cleanup must preserve sibling sessions');
    await storage.removeRoomRecords('room');
    await storage.claimSession('expired:session', 'expired', null, Date.now() - 1);
    await storage.pruneExpiredRecords();
    const counts = await new Promise((resolve, reject) => {
      const request = indexedDB.open('lan-note-room-mls');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const names = ['rooms', 'leases', 'history'];
        const transaction = db.transaction(names);
        const counts = names.map(name => transaction.objectStore(name).count());
        transaction.oncomplete = () => {
          db.close(); resolve(counts.map(request => request.result));
        };
      };
    });
    check(counts.every(count => count === 0), 'room/session/expiry cleanup removes all stores');
    return 'PASS: v1 migration, lease-only heartbeats, atomic snapshots/history, stale owner rejection, bounded history and cleanup';
  }, source);
  assert.match(result, /^PASS:/);
  console.log(result);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
