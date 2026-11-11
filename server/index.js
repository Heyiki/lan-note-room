import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createNickname } from './nicknames.js';
import { loadConfig } from './config.js';
import { MlsRelay } from './mls-relay.js';

const scrypt = promisify(scryptCallback);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const staticRoot = existsSync(dist) ? dist : root;
const { port: PORT, host: HOST, maxEncryptedMembers, maxPlainMembers } = loadConfig();
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_MESSAGES = 1_000;
const rooms = new Map();
const eventTickets = new Map();
const eventClients = new Map();

const id = (bytes = 16) => randomBytes(bytes).toString('base64url');
const json = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(body));
};
const readBody = req => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', chunk => {
    raw += chunk;
    if (raw.length > 1_000_000) {
      reject(new Error('请求内容过大'));
      req.destroy();
    }
  });
  req.on('end', () => {
    try { resolve(raw ? JSON.parse(raw) : {}); }
    catch { reject(new Error('JSON 格式错误')); }
  });
  req.on('error', reject);
});
const onlineCount = room => {
  const tokens = new Set();
  for (const client of eventClients.get(room.id) || []) {
    if (!client.destroyed && !client.writableEnded && room.members.has(client.memberToken)) {
      tokens.add(client.memberToken);
    }
  }
  return tokens.size;
};
const roomPublic = room => ({
  id: room.id,
  name: room.name,
  createdAt: room.createdAt,
  expiresAt: room.expiresAt,
  protected: Boolean(room.passwordHash),
  encrypted: Boolean(room.encrypted),
  approvalRequired: room.approvalRequired,
  maxMembers: room.maxMembers,
  onlineCount: onlineCount(room)
});
const isAdmitted = (room, member) => Boolean(member && (room.encrypted
  ? room.mls.roster.get(member.id)?.status === 'active'
  : !room.pendingMembers.has(member.id)));
const createMember = (room, pending = false) => {
  const member = {
    id: id(12),
    nickname: createNickname(room.usedNicknames)
  };
  const token = id(32);
  room.members.set(token, member);
  if (pending) room.pendingMembers.add(member.id);
  return { token, member };
};
const getAuth = (req, room) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return token && room.members.has(token) ? room.members.get(token) : null;
};
const hashPassword = async password => {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `${salt.toString('base64url')}.${Buffer.from(derived).toString('base64url')}`;
};
const verifyPassword = async (password, stored) => {
  if (!stored) return !password;
  if (!password) return false;
  const [saltText, hashText] = stored.split('.');
  const salt = Buffer.from(saltText, 'base64url');
  const expected = Buffer.from(hashText, 'base64url');
  const actual = Buffer.from(await scrypt(password, salt, expected.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const sendEvent = (res, event, data) => {
  res.write(`${event === 'message' ? `id: ${data.id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};
const broadcast = (roomId, event, data) => {
  const clients = eventClients.get(roomId);
  if (!clients) return;
  for (const res of clients) {
    if (event === 'message' && !isAdmitted(rooms.get(roomId),
      rooms.get(roomId)?.members.get(res.memberToken))) continue;
    try { sendEvent(res, event, data); } catch { /* closed response */ }
  }
};
const roomRoute = pathname => pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)(?:\/(join|approve|leave|destroy|messages|events-ticket|events|mls))?$/);

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (req.method === 'POST' && pathname === '/api/rooms') {
    const body = await readBody(req);
    if (body.encrypted !== undefined && typeof body.encrypted !== 'boolean') {
      return json(res, 400, { error: '加密模式必须为布尔值' });
    }
    if (body.approvalRequired !== undefined && typeof body.approvalRequired !== 'boolean') {
      return json(res, 400, { error: '入群审批必须为布尔值' });
    }
    const name = String(body.name || '临时房间').trim().slice(0, 40) || '临时房间';
    const ttlHours = body.ttlHours;
    if (!Number.isFinite(ttlHours) || ttlHours < 1 / 60 || ttlHours > 24) {
      return json(res, 400, { error: '房间有效期必须在 1 分钟至 24 小时之间' });
    }
    const password = String(body.password || '');
    if (password.length > 128) return json(res, 400, { error: '房间密码不能超过 128 个字符' });
    const roomId = id(12);
    const now = Date.now();
    const room = {
      id: roomId,
      name,
      createdAt: now,
      expiresAt: now + ttlHours * 60 * 60 * 1000,
      passwordHash: password ? await hashPassword(password) : null,
      encrypted: body.encrypted === true,
      approvalRequired: body.approvalRequired !== false,
      maxMembers: body.encrypted === true ? maxEncryptedMembers : maxPlainMembers,
      members: new Map(),
      pendingMembers: new Set(),
      usedNicknames: new Set(),
      messageSequence: 0,
      messages: []
    };
    const { token, member } = createMember(room);
    if (room.encrypted) room.mls = new MlsRelay(member.id);
    rooms.set(roomId, room);
    return json(res, 201, { room: roomPublic(room), token, member });
  }

  const match = roomRoute(pathname);
  if (!match) return json(res, 404, { error: '接口不存在' });
  const [, roomId, action] = match;
  const room = rooms.get(roomId);
  if (!room || room.expiresAt <= Date.now()) {
    if (room) destroyRoom(roomId, '房间已过期');
    return json(res, 404, { error: '房间不存在或已过期' });
  }

  if (req.method === 'POST' && action === 'join') {
    const body = await readBody(req);
    if (!(await verifyPassword(String(body.password || ''), room.passwordHash))) {
      return json(res, 403, { error: '房间密码错误' });
    }
    if (rooms.get(roomId) !== room || room.expiresAt <= Date.now()) {
      return json(res, 404, { error: '房间不存在或已过期' });
    }
    if (room.members.size >= room.maxMembers) {
      return json(res, 409, { error: `房间人数已满（最多 ${room.maxMembers} 人，包含待审核及离线未退出成员）` });
    }
    const { token, member } = createMember(room, !room.encrypted && room.approvalRequired);
    if (!room.encrypted) broadcast(roomId, 'admission-update', {});
    return json(res, 200, { token, member, room: roomPublic(room) });
  }

  if (req.method === 'GET' && action === 'events') {
    const afterId = Number(url.searchParams.get('after') || 0);
    if (!Number.isSafeInteger(afterId) || afterId < 0) {
      return json(res, 400, { error: '消息游标无效' });
    }
    const ticket = url.searchParams.get('ticket');
    const ticketData = eventTickets.get(ticket);
    if (!ticketData || ticketData.roomId !== roomId || ticketData.expiresAt < Date.now() || !room.members.has(ticketData.memberToken)) {
      eventTickets.delete(ticket);
      return json(res, 401, { error: '事件连接凭证无效，请刷新页面' });
    }
    eventTickets.delete(ticket);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    // Replay and subscribe in the same synchronous turn so no send can fall between them.
    if (isAdmitted(room, room.members.get(ticketData.memberToken))) {
      for (const message of room.messages) {
        if (message.id > afterId) sendEvent(res, 'message', message);
      }
    }
    sendEvent(res, 'sync-complete', {});
    if (!eventClients.has(roomId)) eventClients.set(roomId, new Set());
    res.memberToken = ticketData.memberToken;
    eventClients.get(roomId).add(res);
    broadcast(roomId, 'presence', { onlineCount: onlineCount(room) });
    if (room.encrypted) sendEvent(res, 'mls-update', { initial: true });
    else sendEvent(res, 'admission-update', {});
    const heartbeat = setInterval(() => {
      if (!rooms.has(roomId)) return;
      try { res.write(`: ping ${Date.now()}\n\n`); } catch { clearInterval(heartbeat); }
    }, 20_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      if (!eventClients.get(roomId)?.delete(res)) return;
      if (eventClients.get(roomId)?.size === 0) eventClients.delete(roomId);
      if (rooms.has(roomId)) broadcast(roomId, 'presence', { onlineCount: onlineCount(room) });
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    return;
  }

  const member = getAuth(req, room);
  if (!member) return json(res, 401, { error: '无权访问，请重新加入房间' });

  if (action === 'mls') {
    if (!room.encrypted) return json(res, 400, { error: '普通房间不使用 MLS' });
    try {
      if (req.method === 'GET') {
        const after = Number(url.searchParams.get('after') || 0);
        if (!Number.isSafeInteger(after) || after < 0) {
          return json(res, 400, { error: '协议游标无效' });
        }
        const rosterVersion = url.searchParams.has('rosterVersion')
          ? Number(url.searchParams.get('rosterVersion')) : undefined;
        if (rosterVersion !== undefined && (!Number.isSafeInteger(rosterVersion) || rosterVersion < 0)) {
          return json(res, 400, { error: '成员列表版本无效' });
        }
        return json(res, 200, { mls: room.mls.view(member, after, rosterVersion) });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (!getAuth(req, room)) return json(res, 401, { error: '成员已退出' });
        if (rooms.get(roomId) !== room || room.expiresAt <= Date.now()) {
          return json(res, 404, { error: '房间不存在或已过期' });
        }
        if (body.register) {
          room.mls.register(member, body);
          broadcast(roomId, 'mls-update', {});
          return json(res, 200, { registered: true });
        }
        if (body.coordinate === true) {
          return json(res, 200, room.mls.coordinate(member));
        }
        const event = room.mls.submit(member, body);
        broadcast(roomId, 'mls-update', {});
        return json(res, 200, { event });
      }
    } catch (error) {
      if (error.status) return json(res, error.status, { error: error.message });
      throw error;
    }
  }

  if (req.method === 'POST' && action === 'destroy') {
    if (!isAdmitted(room, member)) return json(res, 403, { error: '尚未获准加入，不能销毁房间' });
    destroyRoom(roomId, '有内鬼，终止交易', 'room-destroyed');
    return json(res, 200, { destroyed: true });
  }

  if (req.method === 'POST' && action === 'approve') {
    if (room.encrypted) return json(res, 400, { error: '加密房间必须通过 MLS 完成入群' });
    if (!isAdmitted(room, member)) return json(res, 403, { error: '尚未获准加入，不能批准申请' });
    const body = await readBody(req);
    if (!getAuth(req, room)) return json(res, 401, { error: '成员已退出' });
    if (rooms.get(roomId) !== room || room.expiresAt <= Date.now()) {
      return json(res, 404, { error: '房间不存在或已过期' });
    }
    const target = [...room.members.values()].find(item => item.id === body.memberId);
    if (!target) return json(res, 404, { error: '申请已失效' });
    if (room.pendingMembers.delete(target.id)) broadcast(roomId, 'admission-update', {});
    return json(res, 200, { approved: true });
  }

  if (req.method === 'POST' && action === 'leave') {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    room.members.delete(token);
    room.pendingMembers.delete(member.id);
    room.mls?.leave(member);
    for (const [ticket, data] of eventTickets) {
      if (data.roomId === roomId && data.memberToken === token) eventTickets.delete(ticket);
    }
    const destroyed = room.members.size === 0;
    if (destroyed) {
      destroyRoom(roomId, '所有成员已退出，房间已销毁');
    } else {
      for (const client of eventClients.get(roomId) || []) {
        if (client.memberToken === token) {
          sendEvent(client, 'member-left', { reason: '你已退出房间，请重新加入' });
          client.end();
        }
      }
      broadcast(roomId, 'presence', { onlineCount: onlineCount(room) });
      if (room.encrypted) broadcast(roomId, 'mls-update', {});
      else broadcast(roomId, 'admission-update', {});
    }
    return json(res, 200, { destroyed });
  }

  if (req.method === 'GET' && !action) {
    const admitted = isAdmitted(room, member);
    return json(res, 200, {
      room: roomPublic(room), member, admitted,
      pending: admitted && !room.encrypted
        ? [...room.members.values()].filter(item => room.pendingMembers.has(item.id)) : [],
      messages: admitted ? room.messages : [],
    });
  }

  if (req.method === 'POST' && action === 'events-ticket') {
    const ticket = id(24);
    eventTickets.set(ticket, { roomId, memberToken: (req.headers.authorization || '').replace(/^Bearer\s+/i, ''), expiresAt: Date.now() + 30_000 });
    return json(res, 200, { ticket });
  }

  if (req.method === 'POST' && action === 'messages') {
    if (room.encrypted) return json(res, 400, { error: '加密房间不接受明文消息' });
    const body = await readBody(req);
    if (!getAuth(req, room)) {
      return json(res, 401, { error: '无权访问，请重新加入房间' });
    }
    if (!isAdmitted(room, member)) return json(res, 403, { error: '尚未获准加入，不能发送消息' });
    if (typeof body.content !== 'string' || !body.content.trim() || body.content.length > MAX_MESSAGE_LENGTH) {
      return json(res, 400, { error: `消息不能为空，且不能超过 ${MAX_MESSAGE_LENGTH.toLocaleString()} 个字符` });
    }
    if (typeof body.clientId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.clientId)) {
      return json(res, 400, { error: '消息发送标识无效' });
    }
    if (rooms.get(roomId) !== room || room.expiresAt <= Date.now()) {
      return json(res, 404, { error: '房间不存在或已过期' });
    }
    const existing = room.messages.find(message => message.memberId === member.id && message.clientId === body.clientId);
    if (existing) return json(res, 200, { message: existing });
    const message = {
      id: ++room.messageSequence,
      memberId: member.id,
      nickname: member.nickname,
      content: body.content,
      createdAt: Date.now(),
      clientId: body.clientId
    };
    room.messages.push(message);
    if (room.messages.length > MAX_MESSAGES) room.messages.shift();
    broadcast(roomId, 'message', message);
    return json(res, 201, { message });
  }

  return json(res, 404, { error: '接口不存在' });
}

function destroyRoom(roomId, reason, event = 'room-expired') {
  rooms.delete(roomId);
  broadcast(roomId, event, { reason });
  const clients = eventClients.get(roomId);
  if (clients) for (const res of clients) res.end();
  eventClients.delete(roomId);
  for (const [ticket, data] of eventTickets) if (data.roomId === roomId) eventTickets.delete(ticket);
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm'
};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname === '/health') return json(res, 200, { ok: true, rooms: rooms.size });
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.split(/[\\/]/).some(segment => segment === '.env' || segment.startsWith('.env.'))) {
      return json(res, 403, { error: 'Forbidden' });
    }
    let filePath = path.resolve(staticRoot, '.' + pathname);
    if (!filePath.startsWith(staticRoot)) return json(res, 403, { error: 'Forbidden' });
    if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
    if (!existsSync(filePath) || !path.extname(filePath)) filePath = path.join(staticRoot, 'index.html');
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: '服务器内部错误' });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (room.expiresAt <= now) destroyRoom(roomId, '房间已过期');
  }
  for (const [ticket, data] of eventTickets) if (data.expiresAt <= now) eventTickets.delete(ticket);
}, 30_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`LAN Note Room running: http://localhost:${PORT}`);
  console.log(`Bind address: ${HOST}:${PORT}`);
  console.log('Room messages are stored in memory and will be lost when the process exits.');
});
