import test from 'node:test';
import assert from 'node:assert/strict';
import { MlsRelay } from '../server/mls-relay.js';

const alice = { id: 'alice', nickname: 'Alice' };
const bob = { id: 'bob', nickname: 'Bob' };
const bytes = Buffer.from('opaque MLS bytes').toString('base64');
const fingerprint = 'a'.repeat(64);
const operation = (version, type, extra = {}) => ({
  version, type, epoch: 0, operationId: `operation_${version}_${type}`,
  payload: bytes, ...extra,
});
function initialized() {
  const relay = new MlsRelay(alice.id);
  relay.register(alice, { initialize: true, fingerprint });
  return relay;
}

test('an applicant cannot read room traffic or send before approved admission', () => {
  const relay = initialized();
  relay.register(bob, { keyPackage: bytes, fingerprint });
  assert.deepEqual(relay.view(bob, 0).events, []);
  assert.throws(() => relay.submit(bob, operation(0, 'message')), { status: 403 });
  const entry = relay.submit(alice, operation(0, 'add', { targetId: 'bob', welcome: bytes }));
  assert.equal(entry.id, 1);
  assert.equal(relay.view(bob, 0).welcome.payload, bytes);
  assert.equal(relay.view(alice, 0).events[0].welcome, undefined);
  assert.equal(relay.view(bob, 0).status, 'active');
});

test('same-epoch messages do not conflict, but idempotency and commit ordering remain strict', () => {
  const relay = initialized();
  const body = operation(0, 'message');
  assert.equal(relay.submit(alice, body).id, 1);
  assert.equal(relay.submit(alice, body).id, 1);
  assert.equal(relay.view(alice, 0).events.length, 1);
  assert.equal(relay.submit(alice, operation(0, 'message', {
    operationId: 'different_operation',
  })).id, 2);
  assert.throws(() => relay.submit(alice, operation(2, 'message', {
    epoch: 1, operationId: 'invalid_epoch',
  })), { status: 409 });
  assert.throws(() => relay.submit(alice, operation(1, 'message', {
    content: 'plaintext', payload: undefined,
  })), { status: 400 });
  assert.throws(() => relay.submit(alice, { ...body, payload: Buffer.from('changed').toString('base64') }),
    { status: 409 });
});

test('membership changes invalidate earlier message epochs even with a current cursor', () => {
  const relay = initialized();
  relay.register(bob, { keyPackage: bytes, fingerprint });
  relay.submit(alice, operation(0, 'message', { epoch: 0 }));
  assert.throws(() => relay.submit(alice,
    operation(0, 'add', { targetId: bob.id, welcome: bytes })), { status: 409 });
  relay.submit(alice, operation(1, 'add', { targetId: bob.id, welcome: bytes }));
  assert.throws(() => relay.submit(alice,
    operation(2, 'message', { epoch: 0 })), { status: 409 });
  assert.equal(relay.submit(bob,
    operation(2, 'message', { epoch: 1, operationId: 'bob-message' })).id, 3);
});

test('roster is transmitted only when its revision changes, with exact event suffixes', () => {
  const relay = initialized();
  const initial = relay.view(alice, 0);
  assert.ok(Number.isSafeInteger(initial.rosterVersion));
  relay.submit(alice, operation(0, 'message'));
  const same = relay.view(alice, 0, initial.rosterVersion);
  assert.equal(same.roster, undefined);
  assert.deepEqual(same.events.map(event => event.id), [1]);
  relay.register(bob, { keyPackage: bytes, fingerprint });
  const changed = relay.view(alice, 1, initial.rosterVersion);
  assert.equal(changed.roster.length, 2);
  assert.notEqual(changed.rosterVersion, initial.rosterVersion);
  assert.deepEqual(changed.events, []);
});

test('automatic admission has one coordinator with timeout takeover and departure release', () => {
  const relay = initialized();
  relay.register(bob, { keyPackage: bytes, fingerprint });
  assert.throws(() => relay.coordinate(bob, 1000), { status: 403 });
  relay.submit(alice, operation(0, 'add', { targetId: bob.id, welcome: bytes }));
  const lease = relay.coordinate(alice, 1000);
  assert.equal(lease.granted, true);
  assert.equal(relay.coordinate(bob, 1001).granted, false);
  assert.equal(relay.coordinate(bob, lease.expiresAt + 1).granted, true);
  relay.leave(bob);
  assert.equal(relay.coordinate(alice, lease.expiresAt + 2).granted, true);
});

test('leaving blocks sends until another member commits the removal', () => {
  const relay = initialized();
  relay.register(bob, { keyPackage: bytes, fingerprint });
  relay.submit(alice, operation(0, 'add', { targetId: 'bob', welcome: bytes }));
  relay.leave(bob);
  assert.throws(() => relay.submit(alice, operation(1, 'message')), { status: 409 });
  relay.submit(alice, operation(1, 'remove', { targetId: 'bob' }));
  assert.equal(relay.submit(alice, operation(2, 'message', { epoch: 2 })).id, 3);
  assert.throws(() => relay.view(bob, 0), { status: 403 });
});

test('registrations cannot replace active identities or bootstrap another founder', () => {
  const relay = new MlsRelay(alice.id);
  assert.throws(() => relay.register(bob, { initialize: true, fingerprint }), { status: 403 });
  relay.register(alice, { initialize: true, fingerprint });
  assert.throws(() => relay.register(alice, { initialize: true, fingerprint: 'b'.repeat(64) }),
    { status: 409 });
  assert.throws(() => relay.register(bob, { keyPackage: '*', fingerprint }), { status: 400 });
});

test('an admitted member receives no application history before its Welcome', () => {
  const relay = initialized();
  relay.submit(alice, operation(0, 'message'));
  relay.register(bob, { keyPackage: bytes, fingerprint });
  relay.submit(alice, operation(1, 'add', { targetId: 'bob', welcome: bytes }));
  const view = relay.view(bob, 0);
  assert.equal(view.welcome.id, 2);
  assert.deepEqual(view.events, []);
});

test('ciphertext retention trims only old applications without deleting protocol positions', () => {
  const relay = initialized();
  relay.register(bob, { keyPackage: bytes, fingerprint });
  relay.submit(alice, operation(0, 'add', { targetId: bob.id, welcome: bytes }));
  for (let index = 0; index < 1001; index++) {
    relay.submit(alice, operation(index + 1, 'message', { epoch: 1 }));
  }
  const view = relay.view(alice, 0);
  assert.equal(view.events.length, 1002);
  assert.equal(view.events[0].type, 'add');
  assert.equal(view.events[0].payload, bytes);
  assert.equal(view.events[1].payload, null);
  assert.equal(view.events[2].payload, bytes);
  assert.equal(view.events.at(-1).id, 1002);
  assert.deepEqual(relay.view(alice, 1000).events.map(event => event.id), [1001, 1002]);
});
