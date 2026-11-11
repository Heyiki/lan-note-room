import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { after, before, test } from 'node:test';

let child;
let origin;
before(async () => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  const source = `
    let offset = 0;
    const realNow = Date.now;
    Date.now = () => realNow() + offset;
    process.on('message', ({ advance }) => {
      offset += advance;
      process.send('advanced');
    });
    await import('./server/index.js');
  `;
  child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port),
      MAX_ENCRYPTED_MEMBERS: '5', MAX_PLAIN_MEMBERS: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(() => { throw new Error('Server exited before startup'); })
  ]);
});
after(async () => {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
});

async function api(path, { token, body, method = body ? 'POST' : 'GET' } = {}) {
  const response = await fetch(origin + '/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, ...await response.json() };
}
const create = (password = '') => api('/rooms', {
  body: { name: 'Chat test', password, ttlHours: 1, approvalRequired: false }
});
const send = (roomId, token, content, clientId = 'test-message-1') =>
  api(`/rooms/${roomId}/messages`, { token, body: { content, clientId } });
async function advanceTime(milliseconds) {
  const advanced = once(child, 'message');
  child.send({ advance: milliseconds });
  await advanced;
}

test('independent capacity limits include pending identities and serialize concurrent joins', async () => {
  for (const [encrypted, capacity] of [[false, 4], [true, 5]]) {
    const first = await api('/rooms', { body: { encrypted, ttlHours: 1 } });
    const base = `/rooms/${first.room.id}`;
    const joined = await Promise.all(Array.from({ length: 8 }, () =>
      api(`${base}/join`, { body: {} })));
    const accepted = joined.filter(result => result.status === 200);
    assert.equal(accepted.length, capacity - 1);
    assert.equal(joined.filter(result => result.status === 409).length, 9 - capacity);
    await api(`${base}/leave`, { token: accepted[0].token, body: {} });
    assert.equal((await api(`${base}/join`, { body: {} })).status, 200);
    assert.equal((await api(`${base}/join`, { body: {} })).status, 409);
  }
});

async function events(roomId, token, afterId = 0) {
  const { ticket } = await api(`/rooms/${roomId}/events-ticket`, { token, body: {} });
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/rooms/${roomId}/events?ticket=${ticket}&after=${afterId}`, {
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const seen = [];
  return {
    ticket,
    seen,
    close: () => controller.abort(),
    async nextEvent(event = 'message') {
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const type = block.split('\n').find(line => line.startsWith('event: '))?.slice(7);
            const data = block.split('\n').find(line => line.startsWith('data: '));
            if (type && data) {
              const parsed = JSON.parse(data.slice(6));
              seen.push({ type, data: parsed });
              if (type === event) return parsed;
            }
          } else {
            const { value, done } = await reader.read();
            assert.equal(done, false, 'SSE unexpectedly ended');
            buffer += decoder.decode(value, { stream: true });
          }
        }
      } finally { clearTimeout(timeout); }
    }
  };
}

test('members receive unique nicknames and refresh preserves their identity', async () => {
  const first = await create();
  assert.equal(first.status, 201);
  assert.ok(first.member?.id, 'create must return member identity');
  assert.ok(first.member.nickname);
  assert.match(first.member.nickname, /^[\u4e00-\u9fff]+的[\u4e00-\u9fff]+$/);
  const second = await api(`/rooms/${first.room.id}/join`, { body: {} });
  assert.notEqual(first.member.id, second.member.id);
  assert.notEqual(first.member.nickname, second.member.nickname);
  assert.match(second.member.nickname, /^[\u4e00-\u9fff]+的[\u4e00-\u9fff]+$/);
  const refreshed = await api(`/rooms/${first.room.id}`, { token: first.token });
  assert.deepEqual(refreshed.member, first.member);
  assert.deepEqual(refreshed.messages, []);
  assert.equal(refreshed.document, undefined);
});

test('local env configuration cannot be downloaded over HTTP', async () => {
  for (const pathname of ['/.env', '/%2eenv', '/.env.example']) {
    assert.equal((await fetch(origin + pathname)).status, 403);
  }
});

test('encrypted rooms expose immutable mode and reject the ordinary message endpoint', async () => {
  const first = await api('/rooms', { body: { ttlHours: 1, encrypted: true } });
  assert.equal(first.room.encrypted, true);
  assert.equal((await send(first.room.id, first.token, 'must not be stored')).status, 400);
  const base = `/rooms/${first.room.id}`;
  const registration = await api(`${base}/mls`, {
    token: first.token, body: { register: true, initialize: true, fingerprint: 'a'.repeat(64) },
  });
  assert.equal(registration.status, 200);
  assert.equal((await api(`${base}/mls`, { token: first.token })).mls.status, 'active');
  const second = await api(`${base}/join`, { body: {} });
  assert.equal(second.room.encrypted, true);
  const read = await api(base, { token: second.token });
  assert.deepEqual(read.messages, []);
  assert.equal(read.room.encrypted, true);
  const plain = await create();
  assert.equal((await api(`/rooms/${plain.room.id}/mls`, { token: plain.token })).status, 400);
});

test('approval defaults on independently of encryption and passwords', async () => {
  for (const encrypted of [false, true]) {
    for (const password of ['', 'secret']) {
      const first = await api('/rooms', { body: { ttlHours: 1, encrypted, password } });
      assert.equal(first.room.approvalRequired, true);
      const base = `/rooms/${first.room.id}`;
      if (password) {
        assert.equal((await api(base + '/join', { body: { password: 'wrong' } })).status, 403);
      }
      const joined = await api(base + '/join', { body: { password } });
      const read = await api(base, { token: joined.token });
      assert.equal(read.admitted, false, 'a password must not bypass approval');
      assert.deepEqual(read.messages, []);
      assert.equal((await api(base + '/destroy', { token: joined.token, body: {} })).status, 403);
      assert.equal((await api(base, { token: first.token })).status, 200);
    }
  }
});

test('approval can be disabled without a password, including encrypted rooms', async () => {
  for (const encrypted of [false, true]) {
    for (const password of ['', 'secret']) {
      const first = await api('/rooms', {
        body: { ttlHours: 1, encrypted, password, approvalRequired: false },
      });
      assert.equal(first.room.approvalRequired, false);
      const joined = await api(`/rooms/${first.room.id}/join`, { body: { password } });
      assert.equal(joined.status, 200);
      const read = await api(`/rooms/${first.room.id}`, { token: joined.token });
      // MLS admission still requires a Welcome, even with human approval disabled.
      assert.equal(read.admitted, !encrypted);
    }
  }
});

test('approval settings reject non-booleans', async () => {
  for (const approvalRequired of [null, '', 'false', 0, 1]) {
    assert.equal((await api('/rooms', { body: { ttlHours: 1, approvalRequired } })).status, 400);
  }
});

test('pending plaintext applicants cannot read, send, approve or destroy until admitted', async () => {
  const first = await api('/rooms', { body: { ttlHours: 1, password: 'secret' } });
  const base = `/rooms/${first.room.id}`;
  await send(first.room.id, first.token, 'before admission');
  const second = await api(base + '/join', { body: { password: 'secret' } });
  const third = await api(base + '/join', { body: { password: 'secret' } });
  assert.deepEqual((await api(base, { token: second.token })).pending, []);
  assert.equal((await send(first.room.id, second.token, 'not admitted')).status, 403);
  assert.equal((await api(base + '/approve', {
    token: second.token, body: { memberId: third.member.id },
  })).status, 403);
  const stream = await events(first.room.id, second.token);
  try {
    // Neither replay nor live traffic may leak to an applicant.
    assert.deepEqual(await stream.nextEvent('sync-complete'), {});
    assert.deepEqual(await stream.nextEvent('admission-update'), {});
    await send(first.room.id, first.token, 'while pending', 'pending-live-message');
    const refreshed = await api(base, { token: first.token });
    assert.equal(refreshed.pending.length, 2);
    assert.equal((await api(base + '/approve', {
      token: first.token, body: { memberId: second.member.id },
    })).status, 200);
    assert.deepEqual(await stream.nextEvent('admission-update'), {});
    assert.equal(stream.seen.some(event => event.type === 'message'), false);
    const read = await api(base, { token: second.token });
    assert.equal(read.admitted, true);
    assert.deepEqual(read.messages.map(message => message.content), ['before admission', 'while pending']);
    assert.equal((await api(base + '/approve', {
      token: first.token, body: { memberId: second.member.id },
    })).status, 200, 'approval retries must be idempotent');
    const sent = await send(first.room.id, second.token, 'after admission', 'admitted-live-message');
    assert.deepEqual(await stream.nextEvent(), sent.message);
    assert.equal((await api(base + '/destroy', { token: third.token, body: {} })).status, 403);
    assert.equal((await api(base + '/destroy', { token: second.token, body: {} })).status, 200);
  } finally { stream.close(); }
});

test('MLS applicants cannot destroy or bypass Welcome using plaintext approval', async () => {
  const first = await api('/rooms', { body: { ttlHours: 1, encrypted: true } });
  const base = `/rooms/${first.room.id}`;
  const second = await api(base + '/join', { body: {} });
  const bytes = Buffer.from('opaque MLS test bytes').toString('base64');
  await api(base + '/mls', {
    token: first.token, body: { register: true, initialize: true, fingerprint: 'a'.repeat(64) },
  });
  await api(base + '/mls', {
    token: second.token, body: { register: true, keyPackage: bytes, fingerprint: 'b'.repeat(64) },
  });
  assert.equal((await api(base + '/destroy', { token: second.token, body: {} })).status, 403);
  assert.equal((await api(base + '/approve', {
    token: first.token, body: { memberId: second.member.id },
  })).status, 400);
  assert.equal((await api(base + '/mls', {
    token: first.token, body: {
      type: 'add', targetId: second.member.id, version: 0, operationId: 'admit-mls-member',
      payload: bytes, welcome: bytes,
    },
  })).status, 200);
  assert.equal((await api(base, { token: second.token })).admitted, true);
  assert.equal((await api(base + '/destroy', { token: second.token, body: {} })).status, 200);
});

test('custom room lifetimes accept one minute through 24 hours', async () => {
  for (const [ttlHours, duration] of [[1 / 60, 60_000], [17 / 60, 1_020_000], [2.5, 9_000_000], [24, 86_400_000]]) {
    const result = await api('/rooms', { body: { ttlHours } });
    assert.equal(result.status, 201);
    assert.equal(result.room.expiresAt - result.room.createdAt, duration);
  }
});

test('new joins do not reuse departed nicknames or rewrite historical attribution', async () => {
  const first = await create();
  const base = `/rooms/${first.room.id}`;
  const used = new Set([first.member.nickname]);
  const sent = await send(first.room.id, first.token, 'keep my nickname');
  for (let i = 0; i < 40; i++) {
    const joined = await api(base + '/join', { body: {} });
    assert.equal(joined.status, 200);
    assert.equal(used.has(joined.member.nickname), false);
    used.add(joined.member.nickname);
    const refreshed = await api(base, { token: joined.token });
    assert.deepEqual(refreshed.member, joined.member);
    await api(base + '/leave', { token: joined.token, body: {} });
  }
  const history = await api(base, { token: first.token });
  assert.deepEqual(history.messages[0], sent.message);
  assert.equal(history.messages[0].nickname, first.member.nickname);
});

test('room lifetimes reject missing, nonnumeric and out-of-range values', async () => {
  for (const ttlHours of [undefined, null, '', '1', true, 0, -1, 0.5 / 60, 24.01]) {
    assert.equal((await api('/rooms', { body: { ttlHours } })).status, 400);
  }
});

test('password and tokens protect history, sending and event tickets', async () => {
  const room = await create('secret');
  const base = `/rooms/${room.room.id}`;
  assert.equal((await api(base + '/join', { body: { password: 'wrong' } })).status, 403);
  assert.equal((await api(base)).status, 401);
  assert.equal((await api(base + '/events-ticket', { body: {} })).status, 401);
  assert.equal((await send(room.room.id, 'bad', 'hello')).status, 401);
  const joined = await api(base + '/join', { body: { password: 'secret' } });
  assert.equal(joined.status, 200);
  assert.ok(joined.member?.nickname);
});

test('messages are ordered, attributed by server, and visible to new members', async () => {
  const first = await create();
  const roomId = first.room.id;
  const second = await api(`/rooms/${roomId}/join`, { body: {} });
  const one = await api(`/rooms/${roomId}/messages`, {
    token: first.token,
    body: { content: '<script>alert(1)</script>\nhello', clientId: 'message-one', nickname: 'spoof' }
  });
  assert.equal(one.status, 201);
  const two = await send(roomId, second.token, 'reply', 'message-two');
  assert.equal(two.status, 201);
  assert.equal(one.message.id, 1);
  assert.equal(two.message.id, 2);
  assert.equal(one.message.nickname, first.member.nickname);
  assert.equal(one.message.memberId, first.member.id);
  assert.equal(one.message.content, '<script>alert(1)</script>\nhello');
  assert.ok(Number.isFinite(one.message.createdAt));
  const joined = await api(`/rooms/${roomId}/join`, { body: {} });
  const history = await api(`/rooms/${roomId}`, { token: joined.token });
  assert.deepEqual(history.messages, [one.message, two.message]);
});

test('invalid messages are rejected and a retry does not duplicate a send', async () => {
  const room = await create();
  const roomId = room.room.id;
  for (const content of ['', ' \n ', 123, 'x'.repeat(2001)]) {
    assert.equal((await send(roomId, room.token, content)).status, 400);
  }
  assert.equal((await send(roomId, room.token, 'hello', '')).status, 400);
  const one = await send(roomId, room.token, 'hello', 'retry-message');
  assert.equal(one.status, 201);
  const retry = await send(roomId, room.token, 'hello', 'retry-message');
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.message, one.message);
  const history = await api(`/rooms/${roomId}`, { token: room.token });
  assert.equal(history.messages.length, 1);
});

test('SSE broadcasts live messages, replays missed messages and consumes tickets', async () => {
  const room = await create();
  const roomId = room.room.id;
  const stream = await events(roomId, room.token);
  try {
    const one = await send(roomId, room.token, 'live', 'live-message');
    assert.equal(one.status, 201);
    assert.deepEqual(await stream.nextEvent(), one.message);
    const reused = await fetch(`${origin}/api/rooms/${roomId}/events?ticket=${stream.ticket}`);
    assert.equal(reused.status, 401);
  } finally { stream.close(); }
  const two = await send(roomId, room.token, 'missed', 'missed-message');
  const replay = await events(roomId, room.token, 1);
  try {
    assert.deepEqual(await replay.nextEvent(), two.message);
    const three = await send(roomId, room.token, 'after reconnect', 'next-message');
    assert.deepEqual(await replay.nextEvent(), three.message);
  } finally { replay.close(); }
});

test('retained history is bounded while message IDs remain increasing', async () => {
  const room = await create();
  for (let i = 1; i <= 1002; i++) {
    const result = await send(room.room.id, room.token, `text ${i}`, `history-${i}`);
    assert.equal(result.status, 201);
  }
  const history = await api(`/rooms/${room.room.id}`, { token: room.token });
  assert.equal(history.messages.length, 1000);
  assert.equal(history.messages[0].id, 3);
  assert.equal(history.messages.at(-1).id, 1002);
  assert.equal((await api(`/rooms/${room.room.id}/document`, {
    token: room.token, body: { content: 'old', version: 0 }
  })).status, 404);
});

test('room tokens and SSE tickets cannot be used in another room', async () => {
  const first = await create();
  const second = await create();
  assert.equal((await api(`/rooms/${second.room.id}`, { token: first.token })).status, 401);
  assert.equal((await send(second.room.id, first.token, 'no access')).status, 401);
  const { ticket } = await api(`/rooms/${first.room.id}/events-ticket`, { token: first.token, body: {} });
  const response = await fetch(`${origin}/api/rooms/${second.room.id}/events?ticket=${ticket}`);
  assert.equal(response.status, 401);
});

test('the same send identifier belongs to its member, not the entire room', async () => {
  const first = await create();
  const joined = await api(`/rooms/${first.room.id}/join`, { body: {} });
  assert.equal((await send(first.room.id, first.token, 'x'.repeat(2000))).status, 201);
  const second = await send(first.room.id, joined.token, 'other member');
  assert.equal(second.status, 201);
  assert.equal(second.message.id, 2);
  assert.equal(second.message.memberId, joined.member.id);
});

test('SSE rejects expired tickets and invalid replay cursors', async () => {
  const room = await create();
  const { ticket } = await api(`/rooms/${room.room.id}/events-ticket`, { token: room.token, body: {} });
  const invalid = await fetch(`${origin}/api/rooms/${room.room.id}/events?ticket=${ticket}&after=-1`);
  assert.equal(invalid.status, 400);
  await advanceTime(31_000);
  const expired = await fetch(`${origin}/api/rooms/${room.room.id}/events?ticket=${ticket}`);
  assert.equal(expired.status, 401);
});

test('disconnected rooms survive 30 minutes until explicit leave or fixed expiry', async () => {
  const room = await api('/rooms', { body: { ttlHours: 24 } });
  const stream = await events(room.room.id, room.token);
  stream.close();
  await advanceTime(30 * 60 * 1000 + 1);
  const refreshed = await api(`/rooms/${room.room.id}`, { token: room.token });
  assert.equal(refreshed.status, 200);
  assert.deepEqual(refreshed.member, room.member);
});

test('leaving revokes only that member while other members keep room history', async () => {
  const first = await create();
  const base = `/rooms/${first.room.id}`;
  const second = await api(base + '/join', { body: {} });
  await send(first.room.id, first.token, 'keep history');
  const stream = await events(first.room.id, first.token, 1);
  const { ticket } = await api(base + '/events-ticket', { token: first.token, body: {} });
  try {
    assert.equal((await api(base + '/leave', { token: 'bad', body: {} })).status, 401);
    const left = await api(base + '/leave', { token: first.token, body: {} });
    assert.equal(left.status, 200);
    assert.equal(left.destroyed, false);
    assert.ok((await stream.nextEvent('member-left')).reason);
    assert.equal((await api(base, { token: first.token })).status, 401);
    assert.equal((await send(first.room.id, first.token, 'not allowed')).status, 401);
    const staleTicket = await fetch(`${origin}/api${base}/events?ticket=${ticket}`);
    assert.equal(staleTicket.status, 401);
    const room = await api(base, { token: second.token });
    assert.equal(room.status, 200);
    assert.equal(room.messages[0].content, 'keep history');
    assert.equal((await send(first.room.id, second.token, 'still here')).status, 201);
  } finally { stream.close(); }
});

test('the last explicit leave immediately destroys the room and closes streams', async () => {
  const room = await create();
  const base = `/rooms/${room.room.id}`;
  const stream = await events(room.room.id, room.token);
  try {
    const result = await api(base + '/leave', { token: room.token, body: {} });
    assert.equal(result.status, 200);
    assert.equal(result.destroyed, true);
    assert.ok((await stream.nextEvent('room-expired')).reason);
    assert.equal((await api(base, { token: room.token })).status, 404);
    assert.equal((await api(base + '/join', { body: {} })).status, 404);
  } finally { stream.close(); }
});

test('fixed expiration closes live rooms and notifies SSE members', async () => {
  const room = await api('/rooms', { body: { ttlHours: 0.5 } });
  const stream = await events(room.room.id, room.token);
  try {
    await advanceTime(20 * 60 * 1000);
    assert.equal((await api(`/rooms/${room.room.id}`, { token: room.token })).status, 200);
    await advanceTime(11 * 60 * 1000);
    assert.equal((await api(`/rooms/${room.room.id}`, { token: room.token })).status, 404);
    assert.ok((await stream.nextEvent('room-expired')).reason);
  } finally { stream.close(); }
});

test('only current members can destroy a room', async () => {
  const first = await create();
  const other = await create();
  const base = `/rooms/${first.room.id}`;
  const joined = await api(base + '/join', { body: {} });
  await api(base + '/leave', { token: joined.token, body: {} });
  for (const token of [undefined, 'bad', other.token, joined.token]) {
    assert.equal((await api(base + '/destroy', { token, body: {} })).status, 401);
  }
  assert.equal((await api(base, { token: first.token })).status, 200);
});

test('any member can destroy the room, notifying everyone and revoking access', async () => {
  const first = await create();
  const other = await create();
  const base = `/rooms/${first.room.id}`;
  const second = await api(base + '/join', { body: {} });
  await send(first.room.id, first.token, 'erase this');
  const streams = [
    await events(first.room.id, first.token, 1),
    await events(first.room.id, second.token, 1)
  ];
  const { ticket } = await api(base + '/events-ticket', { token: first.token, body: {} });
  try {
    assert.equal((await api(base + '/destroy', { token: second.token, body: {} })).status, 200);
    for (const stream of streams) {
      assert.ok((await stream.nextEvent('room-destroyed')).reason);
    }
    for (const token of [first.token, second.token]) {
      assert.equal((await api(base, { token })).status, 404);
      assert.equal((await send(first.room.id, token, 'blocked')).status, 404);
    }
    assert.equal((await api(base + '/join', { body: {} })).status, 404);
    assert.equal((await fetch(`${origin}/api${base}/events?ticket=${ticket}`)).status, 404);
    assert.equal((await api(`/rooms/${other.room.id}`, { token: other.token })).status, 200);
  } finally { streams.forEach(stream => stream.close()); }
});

test('SSE marks the boundary between replay and live messages', async () => {
  const room = await create();
  const old = await send(room.room.id, room.token, 'history');
  const stream = await events(room.room.id, room.token);
  try {
    assert.deepEqual(await stream.nextEvent(), old.message);
    assert.deepEqual(await stream.nextEvent('sync-complete'), {});
    const live = await send(room.room.id, room.token, 'live', 'boundary-live');
    assert.deepEqual(await stream.nextEvent(), live.message);
  } finally { stream.close(); }
});

test('presence tracks connected members and reconnects, not offline room membership', async () => {
  const first = await create();
  const base = `/rooms/${first.room.id}`;
  const second = await api(base + '/join', { body: {} });
  assert.equal((await api(base, { token: first.token })).room.onlineCount, 0);
  const one = await events(first.room.id, first.token);
  let two;
  try {
    assert.deepEqual(await one.nextEvent('presence'), { onlineCount: 1 });
    two = await events(first.room.id, second.token);
    assert.deepEqual(await two.nextEvent('presence'), { onlineCount: 2 });
    assert.deepEqual(await one.nextEvent('presence'), { onlineCount: 2 });
    two.close();
    assert.deepEqual(await one.nextEvent('presence'), { onlineCount: 1 });
    const room = await api(base, { token: second.token });
    assert.equal(room.status, 200, 'disconnect must not revoke membership');
    assert.equal(room.room.onlineCount, 1);
    two = await events(first.room.id, second.token);
    assert.deepEqual(await two.nextEvent('presence'), { onlineCount: 2 });
    assert.deepEqual(await one.nextEvent('presence'), { onlineCount: 2 });
  } finally { one.close(); two?.close(); }
});

test('multiple streams with the same identity count once, including when one closes', async () => {
  const room = await create();
  const one = await events(room.room.id, room.token);
  let duplicate;
  try {
    assert.deepEqual(await one.nextEvent('presence'), { onlineCount: 1 });
    duplicate = await events(room.room.id, room.token);
    assert.deepEqual(await duplicate.nextEvent('presence'), { onlineCount: 1 });
    assert.deepEqual(await one.nextEvent('presence'), { onlineCount: 1 });
    duplicate.close();
    assert.deepEqual(await one.nextEvent('presence'), { onlineCount: 1 });
    assert.equal((await api(`/rooms/${room.room.id}`, { token: room.token })).room.onlineCount, 1);
  } finally { one.close(); duplicate?.close(); }
});

test('explicit leave removes all streams of that identity from presence', async () => {
  const first = await create();
  const base = `/rooms/${first.room.id}`;
  const second = await api(base + '/join', { body: {} });
  const one = await events(first.room.id, first.token);
  const duplicate = await events(first.room.id, first.token);
  const observer = await events(first.room.id, second.token);
  try {
    assert.deepEqual(await observer.nextEvent('presence'), { onlineCount: 2 });
    assert.equal((await api(base + '/leave', { token: first.token, body: {} })).destroyed, false);
    assert.deepEqual(await observer.nextEvent('presence'), { onlineCount: 1 });
    assert.ok((await one.nextEvent('member-left')).reason);
    assert.ok((await duplicate.nextEvent('member-left')).reason);
    assert.equal((await api(base, { token: second.token })).room.onlineCount, 1);
  } finally { one.close(); duplicate.close(); observer.close(); }
});

test('presence is isolated by room and all disconnected rooms remain accessible with zero online', async () => {
  const first = await create();
  const second = await create();
  const one = await events(first.room.id, first.token);
  const two = await events(second.room.id, second.token);
  let duplicate;
  try {
    assert.deepEqual(await one.nextEvent('presence'), { onlineCount: 1 });
    assert.deepEqual(await two.nextEvent('presence'), { onlineCount: 1 });
    const joined = await api(`/rooms/${second.room.id}/join`, { body: {} });
    duplicate = await events(second.room.id, joined.token);
    assert.deepEqual(await two.nextEvent('presence'), { onlineCount: 2 });
    assert.equal((await api(`/rooms/${first.room.id}`, { token: first.token })).room.onlineCount, 1);
    one.close();
    let result;
    for (let i = 0; i < 100; i++) {
      result = await api(`/rooms/${first.room.id}`, { token: first.token });
      if (result.room.onlineCount === 0) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(result.status, 200);
    assert.equal(result.room.onlineCount, 0);
  } finally { one.close(); two.close(); duplicate?.close(); }
});
