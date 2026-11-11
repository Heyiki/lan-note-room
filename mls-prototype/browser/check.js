import init, { BrowserClient } from '../pkg/lan_chat_mls_prototype.js';

const text = new TextEncoder();
const decode = bytes => new TextDecoder().decode(new Uint8Array(bytes));
const assert = (condition, name) => { if (!condition) throw new Error(name); };
const rejects = (operation, name) => {
  let rejected = false;
  try { operation(); } catch { rejected = true; }
  assert(rejected, name);
};

async function storeSnapshot(snapshot) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('lan-chat-mls-prototype', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('state', 'readwrite');
      transaction.objectStore('state').put(snapshot, 'bob');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    return await new Promise((resolve, reject) => {
      const request = db.transaction('state').objectStore('state').get('bob');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('lan-chat-mls-prototype');
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
  }
}

export async function runChecks() {
  const results = [];
  assert(!window.isSecureContext, 'requires actual insecure HTTP origin');
  results.push('Non-localhost HTTP origin');
  crypto.getRandomValues(new Uint8Array(32));
  const originalRandom = Math.random;
  Math.random = () => { throw new Error('insecure randomness forbidden'); };
  const clients = [];
  try {
    await init();
    const make = name => {
      const client = new BrowserClient(name);
      clients.push(client);
      return client;
    };
    const alice = make('alice');
    alice.create_group('browser-test');
    let bob = make('bob');
    const admission = JSON.parse(alice.add_member(bob.key_package()));
    bob.join(new Uint8Array(admission.welcome));
    const oldMessage = alice.encrypt(text.encode('before carol'));
    const received = JSON.parse(bob.process(oldMessage));
    assert(received.sender === 'alice' && decode(received.bytes) === 'before carol',
      'authenticated message');
    results.push('Two-member authenticated encryption, no Math.random fallback');
    const carol = make('carol');
    const third = JSON.parse(alice.add_member(carol.key_package()));
    bob.process(new Uint8Array(third.commit));
    carol.join(new Uint8Array(third.welcome));
    rejects(() => carol.process(oldMessage), 'pre-admission history must be rejected');
    results.push('New member cannot decrypt earlier epoch');

    const snapshot = await storeSnapshot(bob.snapshot());
    bob.free();
    clients.splice(clients.indexOf(bob), 1);
    bob = BrowserClient.restore(snapshot);
    clients.push(bob);
    const next = bob.encrypt(text.encode('restored sender'));
    assert(decode(JSON.parse(alice.process(next)).bytes) === 'restored sender', 'restored send');
    assert(decode(JSON.parse(carol.process(next)).bytes) === 'restored sender', 'third receiver');
    results.push('IndexedDB state roundtrip and restored sender');

    const corrupt = alice.encrypt(text.encode('integrity'));
    corrupt[corrupt.length - 1] ^= 128;
    rejects(() => carol.process(corrupt), 'tamper must fail');
    rejects(() => carol.process(text.encode('plaintext')), 'plaintext must fail');
    results.push('Tampered ciphertext and plaintext rejected');

    const removal = alice.remove_member('bob');
    carol.process(removal);
    const final = alice.encrypt(text.encode('after removal'));
    rejects(() => bob.process(final), 'removed member must not decrypt');
    assert(decode(JSON.parse(carol.process(final)).bytes) === 'after removal',
      'remaining member decrypts');
    bob.process(removal);
    rejects(() => bob.encrypt(text.encode('removed sender')), 'removed member must not send');
    results.push('Removal excludes old keys from future messages');
    return results;
  } finally {
    for (const client of clients) client.free();
    Math.random = originalRandom;
  }
}

window.prototypeResult = runChecks().then(
  checks => {
    document.querySelector('#result').textContent = checks.map(check => `PASS: ${check}`).join('\n');
    return { ok: true, checks };
  },
  error => {
    document.querySelector('#result').textContent = `FAIL: ${error.message}`;
    return { ok: false, error: error.message, stack: error.stack };
  },
);
