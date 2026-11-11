import { createHash } from 'node:crypto';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const digest = body => createHash('sha256').update(JSON.stringify(body)).digest('hex');
const opaque = (value, max = 262144) => typeof value === 'string'
  && value.length > 0 && value.length <= max && value.length % 4 === 0
  && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);

export class MlsRelay {
  constructor(founderId) {
    this.founderId = founderId;
    this.initialized = false;
    this.roster = new Map();
    this.removed = new Set();
    this.events = [];
    this.operations = new Map();
    this.epoch = 0;
    this.bytes = 0;
    this.rosterVersion = 0;
    this.coordinator = null;
  }

  register(member, body) {
    if (this.removed.has(member.id)) fail(403, '你已退出加密群组');
    if (!/^[a-f0-9]{64}$/.test(body.fingerprint || '')) fail(400, '身份指纹无效');
    const existing = this.roster.get(member.id);
    if (existing) {
      if (existing.fingerprint !== body.fingerprint) fail(409, '身份已注册，不能替换密钥');
      return;
    }
    if (body.initialize && member.id !== this.founderId) fail(403, '只有创建者能初始化群组');
    if (body.initialize && this.initialized) fail(409, '群组已初始化');
    if (!body.initialize && !opaque(body.keyPackage, 131072)) fail(400, '入群密钥包无效');
    this.roster.set(member.id, {
      ...member, fingerprint: body.fingerprint, keyPackage: body.keyPackage,
      status: body.initialize ? 'active' : 'pending', joinedAt: 0, welcome: null,
    });
    this.rosterVersion++;
    if (body.initialize) this.initialized = true;
  }

  coordinate(member, now = Date.now()) {
    if (this.roster.get(member.id)?.status !== 'active') fail(403, '尚未获准加入加密群组');
    if (!this.coordinator || this.coordinator.expiresAt <= now || this.coordinator.id === member.id) {
      this.coordinator = { id: member.id, expiresAt: now + 8000 };
    }
    return { granted: this.coordinator.id === member.id, expiresAt: this.coordinator.expiresAt };
  }

  view(member, after, rosterVersion) {
    if (this.removed.has(member.id)) fail(403, '你已退出加密群组');
    const own = this.roster.get(member.id);
    if (!own) return { status: 'unregistered', version: this.events.length, events: [], roster: [] };
    if (own.status === 'removing') fail(403, '你已退出加密群组');
    const active = own.status === 'active';
    return {
      status: own.status, version: this.events.length, epoch: this.epoch,
      rosterVersion: this.rosterVersion,
      welcome: own.welcome,
      ...(rosterVersion === this.rosterVersion ? {} : {
        roster: active ? [...this.roster.values()].map(({ welcome, joinedAt, ...item }) => item) : [],
      }),
      events: active ? this.events.slice(Math.max(after, own.joinedAt))
        .map(({ welcome, ...event }) => event) : [],
    };
  }

  submit(member, body) {
    const own = this.roster.get(member.id);
    if (own?.status !== 'active') fail(403, '尚未获准加入加密群组');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(body.operationId || '')) fail(400, '操作标识无效');
    const operationKey = `${member.id}:${body.operationId}`;
    const accepted = this.operations.get(operationKey);
    if (accepted) {
      if (accepted.request !== digest(body)) fail(409, '操作标识不能复用到其他内容');
      return accepted.event;
    }
    // Applications share an MLS epoch, not an exclusive relay cursor. Commits still use CAS.
    if (!Number.isSafeInteger(body.version) || body.version < own.joinedAt
      || body.version > this.events.length
      || (body.type === 'message' ? body.epoch !== this.epoch : body.version !== this.events.length)) {
      fail(409, '群组状态已更新，请同步后重试');
    }
    if (body.coordinated && (this.coordinator?.id !== member.id
      || this.coordinator.expiresAt <= Date.now())) fail(409, '自动入群协调权已变更，请同步后重试');
    if (!['message', 'add', 'remove'].includes(body.type) || !opaque(body.payload)
      || 'content' in body) fail(400, '加密协议数据无效，不接受明文消息');
    const removing = [...this.roster.values()].some(item => item.status === 'removing');
    if (removing && body.type !== 'remove') fail(409, '正在更新退出成员的密钥，请稍后重试');
    const target = this.roster.get(body.targetId);
    if (body.type === 'add' && (target?.status !== 'pending' || !opaque(body.welcome))) {
      fail(409, '入群申请已改变或 Welcome 无效');
    }
    if (body.type === 'remove' && target?.status !== 'removing') fail(409, '退出请求已改变');
    const size = body.payload.length + (body.welcome?.length || 0);
    if (this.events.length >= 10000 || this.bytes + size > 20_000_000) {
      fail(409, '加密房间容量已满，请创建新房间');
    }
    if (body.type !== 'message') this.epoch++;
    const event = {
      id: this.events.length + 1, type: body.type, epoch: this.epoch,
      memberId: member.id, nickname: member.nickname, createdAt: Date.now(),
      operationId: body.operationId, payload: body.payload, targetId: body.targetId,
    };
    this.events.push(event);
    this.bytes += size;
    this.operations.set(operationKey, { request: digest(body), event });
    if (body.type === 'add') {
      target.status = 'active';
      target.joinedAt = event.id;
      target.welcome = { id: event.id, payload: body.welcome };
      delete target.keyPackage;
      this.rosterVersion++;
    }
    if (body.type === 'remove') {
      this.roster.delete(body.targetId);
      this.removed.add(body.targetId);
      this.rosterVersion++;
    }
    const messages = this.events.filter(item => item.type === 'message' && item.payload);
    if (messages.length > 1000) messages[0].payload = null;
    return event;
  }

  leave(member) {
    const item = this.roster.get(member.id);
    if (!item) return;
    if (item.status === 'pending') this.roster.delete(member.id);
    else item.status = 'removing';
    this.rosterVersion++;
    if (this.coordinator?.id === member.id) this.coordinator = null;
  }
}
