import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';

const { chromium } = createRequire(import.meta.url)(process.argv[2] || 'playwright');
const count = 100;
const probe = net.createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const sources = {
  client: await readFile(new URL('../src/mls-client.js', import.meta.url), 'utf8'),
  storage: await readFile(new URL('../src/mls-storage.js', import.meta.url), 'utf8'),
  binding: await readFile(new URL('../src/mls-wasm/lan_chat_mls_prototype.js', import.meta.url), 'utf8'),
  wasm: (await readFile(new URL('../src/mls-wasm/lan_chat_mls_prototype_bg.wasm', import.meta.url))).toString('base64'),
};
let child;
let browser;
try {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('../', import.meta.url),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port),
      MAX_ENCRYPTED_MEMBERS: '100', MAX_PLAIN_MEMBERS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(() => { throw new Error('scale server exited'); }),
  ]);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  await page.goto(`http://127.0.0.1:${port}`);
  page.on('console', message => console.log(message.text()));
  // Production MLS sessions, WASM, IndexedDB and HTTP relay; one renderer, not 100 devices.
  const report = await page.evaluate(async ({ sources, count }) => {
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const moduleUrl = source => URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const bindingUrl = moduleUrl(sources.binding);
    const storageUrl = moduleUrl(sources.storage);
    const binding = await import(bindingUrl);
    await binding.default({
      module_or_path: Uint8Array.from(atob(sources.wasm), char => char.charCodeAt(0)),
    });
    const clientUrl = moduleUrl(sources.client
      .replace("'./mls-wasm/lan_chat_mls_prototype.js'", JSON.stringify(bindingUrl))
      .replace("'./mls-storage.js'", JSON.stringify(storageUrl)));
    const { MlsSession } = await import(clientUrl);
    const api = async (path, token, body) => {
      const response = await fetch(`/api${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status });
      return value;
    };
    const sessions = [];
    let room;
    try {
      const founder = await api('/rooms', null, { encrypted: true, approvalRequired: false, ttlHours: 1 });
      room = founder.room;
      const started = performance.now();
      const received = Array.from({ length: count }, () => new Map());
      const states = [];
      let syncGets = 0;
      let captureGet;
      let releaseGet;
      let getGate;
      let coalescing = false;
      const makeSession = (member, token, index) => {
        sessionStorage.setItem(`lan-note-room-mls-session:${room.id}`, `scale-${index}`);
        return new MlsSession({
          roomId: room.id, member, expiresAt: room.expiresAt, autoAdmit: true,
          request: async (path, options = {}) => {
            if (coalescing && index === 0 && !options.method) {
              syncGets++;
              if (captureGet) { captureGet(); captureGet = null; await getGate; }
            }
            return api(path, token, options.body);
          },
          onMessage: message => received[index].set(message.id, message),
          onStatus: status => { states[index] = status; },
        });
      };
      sessions.push(makeSession(founder.member, founder.token, 0));
      await sessions[0].start(true);
      const members = await Promise.all(Array.from({ length: count - 1 }, () =>
        api(`/rooms/${room.id}/join`, null, {})));
      for (const [index, joined] of members.entries()) {
        sessions.push(makeSession(joined.member, joined.token, index + 1));
      }
      await Promise.all(sessions.slice(1).map(session => session.start()));
      await sessions[0].sync();
      await Promise.all(sessions.slice(1).map(session => session.sync()));
      check(states.every(state => state.ready), 'all 100 encrypted identities must become ready');
      let full = false;
      try { await api(`/rooms/${room.id}/join`, null, {}); }
      catch (error) { full = error.status === 409; }
      check(full, 'encrypted member 101 must be refused');
      const admissionMs = Math.round(performance.now() - started);
      console.log(`100 encrypted sessions admitted: ${admissionMs} ms`);

      coalescing = true;
      const captured = new Promise(resolve => { captureGet = resolve; });
      getGate = new Promise(resolve => { releaseGet = resolve; });
      const inFlight = sessions[0].sync();
      await captured;
      const duplicateSignals = Array.from({ length: 100 }, () => sessions[0].sync(true));
      releaseGet();
      await Promise.all([inFlight, ...duplicateSignals]);
      check(syncGets <= 2, `sync storm should coalesce to at most 2 GETs, got ${syncGets}`);
      coalescing = false;

      const sendStart = performance.now();
      await Promise.all(sessions.map((session, index) =>
        session.send(`concurrent secret ${index}`, `scale-message-${index}`)));
      await Promise.all(sessions.map(session => session.sync()));
      for (const [index, messages] of received.entries()) {
        check(messages.size === count, `identity ${index} lost concurrent messages: ${messages.size}`);
        check(new Set([...messages.values()].map(message => message.content)).size === count,
          `identity ${index} contains duplicate plaintext`);
      }
      const sendMs = Math.round(performance.now() - sendStart);
      console.log(`100 concurrent encrypted sends and complete delivery: ${sendMs} ms`);

      // Hundreds of messages received in one sync should not cause one snapshot write per message.
      for (let index = 0; index < 12; index++) {
        await sessions[0].send(`batch ${index}`, `batch-message-${index}`);
      }
      let snapshots = 0;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'rooms') snapshots++;
        return put.apply(this, args);
      };
      await sessions[1].sync();
      IDBObjectStore.prototype.put = put;
      check(snapshots === 1, `12 received messages should use one snapshot checkpoint, got ${snapshots}`);
      check(received[1].size === 112, 'batch checkpoint must retain all messages');

      await sessions[0].send('recover after IDB abort', 'storage-abort-message');
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'history') throw new Error('injected receive checkpoint failure');
        return put.apply(this, args);
      };
      let aborted = false;
      try { await sessions[1].sync(); }
      catch { aborted = true; }
      IDBObjectStore.prototype.put = put;
      check(aborted && received[1].size === 112, 'uncommitted plaintext must not reach the UI');
      await sessions[1].sync();
      check(received[1].size === 113
        && [...received[1].values()].some(message => message.content === 'recover after IDB abort'),
      'retry after a failed checkpoint must restore keys/cursor and decrypt the event again');

      const plain = await api('/rooms', null, { encrypted: false, approvalRequired: false, ttlHours: 1 });
      try {
        await Promise.all(Array.from({ length: 99 }, () => api(`/rooms/${plain.room.id}/join`, null, {})));
        full = false;
        try { await api(`/rooms/${plain.room.id}/join`, null, {}); }
        catch (error) { full = error.status === 409; }
        check(full, 'plaintext member 101 must be refused');
      } finally { await api(`/rooms/${plain.room.id}/destroy`, plain.token, {}); }
      await api(`/rooms/${room.id}/destroy`, founder.token, {});
      return { identities: count, admissionMs, sendMs, syncGets, batchSnapshots: snapshots };
    } finally {
      for (const session of sessions) session.close();
      await Promise.all(sessions.map(session => session.queue));
      if (room) await (await import(storageUrl)).removeRoomRecords(room.id);
      for (const url of [bindingUrl, storageUrl, clientUrl]) URL.revokeObjectURL(url);
    }
  }, { sources, count });
  assert.equal(report.identities, 100);
  console.log('PASS: real 100-identity MLS/HTTP/IndexedDB functional scale check; not a 100-device load guarantee');
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
}
