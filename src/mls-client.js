import init, { BrowserClient } from './mls-wasm/lan_chat_mls_prototype.js';
import {
  claimSession, saveSession, renewLease, releaseLease,
  removeRoomRecords, removeSessionRecord, pruneExpiredRecords,
} from './mls-storage.js';

let loaded;
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
  byte => byte.toString(16).padStart(2, '0')).join('');
const encode = bytes => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const decode = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const text = new TextEncoder();
const readText = new TextDecoder('utf-8', { fatal: true });

export { removeRoomRecords, removeSessionRecord, pruneExpiredRecords };

export class MlsSession {
  constructor({ roomId, member, expiresAt, autoAdmit = false, request, onMessage, onStatus }) {
    Object.assign(this, { roomId, member, expiresAt, autoAdmit, request, onMessage, onStatus });
    const storageKey = `lan-note-room-mls-session:${roomId}`;
    let session = sessionStorage.getItem(storageKey);
    if (!session) {
      session = randomId();
      sessionStorage.setItem(storageKey, session);
    }
    this.key = `${roomId}:${session}`;
    this.handoffKey = `lan-note-room-mls-handoff:${roomId}`;
    this.owner = randomId();
    this.queue = Promise.resolve();
    this.closed = false;
    this.ready = false;
  }

  serial(operation) {
    const result = this.queue.then(async () => {
      if (this.closed) return;
      try { return await operation(); }
      catch (error) {
        if (!this.closed && this.durable?.snapshot) {
          this.client?.free();
          this.client = BrowserClient.restore(this.durable.snapshot);
          this.record = { ...this.durable };
        }
        this.ready = false;
        this.onStatus({ ready: false, error: error.message });
        throw error;
      }
    });
    this.queue = result.catch(() => {});
    return result;
  }

  async start(founder = false) {
    return this.serial(async () => {
      loaded ||= init();
      await loaded;
      if (this.closed) return;
      const handoff = sessionStorage.getItem(this.handoffKey);
      sessionStorage.removeItem(this.handoffKey);
      for (let attempt = 0; ; attempt++) {
        try {
          if (this.closed) return;
          this.record = await claimSession(this.key, this.owner, handoff, this.expiresAt);
          this.durable = { ...this.record };
          break;
        } catch (error) {
          if (attempt >= 40) throw error;
          await new Promise(resolve => setTimeout(resolve, 250));
          if (this.closed) return;
        }
      }
      this.client = this.record.snapshot
        ? BrowserClient.restore(this.record.snapshot) : new BrowserClient(this.member.id);
      this.validateIdentity();
      this.heartbeat = setInterval(() => {
        this.serial(() => renewLease(this.key, this.owner)).catch(() => {});
      }, 2500);
      if (!this.record.snapshot) {
        if (founder) this.client.create_group(this.roomId);
        this.record.registration = {
          register: true, initialize: founder, fingerprint: this.description().fingerprint,
          ...(founder ? {} : { keyPackage: encode(this.client.key_package()) }),
        };
        await this.save();
      }
      if (this.record.registration) {
        await this.post(this.record.registration);
        delete this.record.registration;
        await this.save();
      }
      for (const message of this.record.history) this.onMessage(message, false);
      await this.synchronize(false);
    });
  }

  description() { return JSON.parse(this.client.describe()); }

  validateIdentity() {
    const description = this.description();
    if (description.identity !== this.member.id
      || (description.group_id !== null && description.group_id !== this.roomId)) {
      throw new Error('本地加密身份与房间不匹配，请退出后重新申请加入');
    }
  }

  async save(messages = []) {
    if (this.closed) throw new Error('加密会话已关闭');
    const next = {
      ...this.record, snapshot: this.client.snapshot(),
      owner: this.owner, lease: Date.now() + 10000,
    };
    await saveSession(this.key, next, this.owner, messages);
    this.durable = next;
    this.record = { ...next };
  }

  post(body) {
    if (this.closed) throw new Error('加密会话已关闭');
    return this.request(`/rooms/${this.roomId}/mls`, { method: 'POST', body });
  }

  sync(live = false) {
    this.syncAgain = true;
    this.syncLive ||= live;
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.serial(async () => {
      do {
        this.syncAgain = false;
        const notify = this.syncLive;
        this.syncLive = false;
        await this.synchronize(notify);
      } while (this.syncAgain && !this.closed);
    }).finally(() => { this.syncPromise = null; });
    return this.syncPromise;
  }

  async finishOutbox() {
    const outbox = this.record.outbox;
    if (!outbox) return;
    if (outbox.accepted) return;
    let event;
    try { ({ event } = await this.post(outbox.body)); }
    catch (error) {
      if (error.status === 400 || error.status === 403 || error.status === 409) {
        // A rejected application ciphertext still consumed a sender generation.
        if (outbox.body.type !== 'message') {
          this.client.free();
          this.client = BrowserClient.restore(outbox.before);
        }
        this.record.cursor = outbox.cursor;
        delete this.record.outbox;
        await this.save();
      }
      throw error;
    }
    if (!Number.isSafeInteger(event.id) || event.id <= outbox.body.version
      || (outbox.body.type !== 'message' && event.id !== outbox.body.version + 1)
      || event.memberId !== this.member.id || event.operationId !== outbox.body.operationId) {
      throw new Error('协议确认与发送状态不一致，已停止发送');
    }
    // Do not jump to this event: other senders may have appended earlier ciphertexts.
    this.record.outbox = { ...outbox, accepted: event.id };
  }

  async synchronize(live, conflicts = 0) {
    if (!this.client || !this.record) throw new Error('请刷新页面重新初始化加密');
    if (this.record.registration) {
      await this.post(this.record.registration);
      delete this.record.registration;
      await this.save();
    }
    await this.finishOutbox();
    const knownRoster = this.rosterVersion === undefined ? '' : `&rosterVersion=${this.rosterVersion}`;
    const { mls } = await this.request(`/rooms/${this.roomId}/mls?after=${this.record.cursor}${knownRoster}`);
    if (mls.roster) this.roster = mls.roster;
    this.rosterVersion = mls.rosterVersion;
    if (mls.status === 'unregistered') {
      throw new Error('加密身份未注册或本地密钥已丢失，请退出后重新加入');
    }
    if (mls.status === 'pending') {
      this.ready = false;
      this.onStatus({
        ready: false, waiting: true, autoAdmit: this.autoAdmit,
        fingerprint: this.description().fingerprint,
      });
      return;
    }
    if (!this.description().group_id) {
      if (!mls.welcome) throw new Error('缺少入群 Welcome，请重新加入');
      this.client.join(decode(mls.welcome.payload));
      this.validateIdentity();
      this.record.cursor = mls.welcome.id;
      await this.save();
    }
    const received = [];
    let changed = false;
    for (const event of mls.events) {
      if (event.id <= this.record.cursor) continue;
      if (event.id !== this.record.cursor + 1 || !event.payload) {
        throw new Error('离线期间的协议记录已缺失，请退出后重新申请加入');
      }
      const own = this.record.outbox;
      const local = own && event.memberId === this.member.id
        && event.operationId === own.body.operationId;
      let message;
      if (local) {
        if (own.accepted !== event.id || event.type !== own.body.type
          || event.payload !== own.body.payload) throw new Error('本地协议确认与日志不一致');
        message = own.message && { ...own.message, id: event.id };
        delete this.record.outbox;
      } else if (event.type === 'message') {
        const result = JSON.parse(this.client.process_from(decode(event.payload), event.memberId));
        if (!result || result.sender !== event.memberId) throw new Error('消息身份校验失败');
        const payload = JSON.parse(readText.decode(new Uint8Array(result.bytes)));
        if (payload.memberId !== result.sender || typeof payload.content !== 'string'
          || !payload.content.trim() || payload.content.length > 2000
          || typeof payload.nickname !== 'string' || payload.nickname.length > 80
          || !Number.isSafeInteger(payload.createdAt) || payload.createdAt < 0
          || payload.createdAt > 8_640_000_000_000_000) throw new Error('消息内容校验失败');
        message = { ...payload, id: event.id };
      } else {
        const beforeMembers = this.description().members;
        const result = JSON.parse(this.client.process_from(decode(event.payload), event.memberId));
        if (result !== null || !['add', 'remove'].includes(event.type)) {
          throw new Error('协议消息类型不匹配');
        }
        const afterMembers = this.description().members;
        const expected = event.type === 'remove'
          ? beforeMembers.filter(member => member.identity !== event.targetId)
          : [...beforeMembers, afterMembers.find(member => member.identity === event.targetId)];
        const normalize = members => JSON.stringify(members.map(member =>
          member && `${member.identity}:${member.fingerprint}`).sort());
        if (normalize(expected) !== normalize(afterMembers)
          || afterMembers.length !== beforeMembers.length + (event.type === 'add' ? 1 : -1)) {
          throw new Error('成员变更与批准的操作不一致');
        }
      }
      if (message) received.push(message);
      this.record.cursor = event.id;
      this.record.epoch = event.epoch;
      changed = true;
    }
    if (this.record.outbox?.accepted) throw new Error('已确认的本地消息未出现在协议日志中');
    if (changed) {
      this.record.history = this.record.history.concat(received).slice(-1000);
      await this.save(received);
      for (const message of received) this.onMessage(message, live);
    }
    this.record.epoch = mls.epoch;
    const leaving = this.roster.find(item => item.status === 'removing');
    const actual = this.description().members;
    const expected = new Map(this.roster.filter(item => item.status !== 'pending')
      .map(item => [item.id, item.fingerprint]));
    if (actual.length !== expected.size || actual.some(member =>
      expected.get(member.identity) !== member.fingerprint)) {
      throw new Error('群组成员密钥与已批准身份不一致');
    }
    if (leaving) {
      await this.change('remove', leaving);
      return this.synchronize(false);
    }
    const pending = this.roster.filter(item => item.status === 'pending');
    if (this.autoAdmit && pending.length) {
      const lease = await this.post({ coordinate: true });
      if (lease.granted) {
        try { await this.change('add', pending[0], true); }
        catch (error) {
          if (error.status !== 409 || conflicts >= 3) throw error;
          return this.synchronize(live, conflicts + 1);
        }
        return this.synchronize(live);
      }
      clearTimeout(this.coordinatorRetry);
      this.coordinatorRetry = setTimeout(() => this.sync(false).catch(() => {}),
        Math.max(100, lease.expiresAt - Date.now() + 100 + Math.random() * 200));
    } else {
      clearTimeout(this.coordinatorRetry);
    }
    this.ready = true;
    this.onStatus({
      ready: true, fingerprint: this.description().fingerprint,
      members: this.description().members, pending,
    });
  }

  async change(type, target, coordinated = false) {
    const before = this.client.snapshot();
    try {
      let payload;
      let welcome;
      if (type === 'add') {
        const admission = JSON.parse(this.client.add_member(decode(target.keyPackage)));
        const actual = this.description().members.find(item => item.identity === target.id);
        if (!actual || actual.fingerprint !== target.fingerprint) throw new Error('入群申请身份不匹配');
        payload = encode(new Uint8Array(admission.commit));
        welcome = encode(new Uint8Array(admission.welcome));
      } else payload = encode(this.client.remove_member(target.id));
      this.record.outbox = {
        before, cursor: this.record.cursor,
        body: {
          type, targetId: target.id, version: this.record.cursor,
          operationId: randomId(), payload, ...(welcome ? { welcome } : {}),
          ...(coordinated ? { coordinated: true } : {}),
        },
      };
      await this.save();
    } catch (error) {
      this.client.free();
      this.client = BrowserClient.restore(before);
      delete this.record.outbox;
      throw error;
    }
    await this.finishOutbox();
  }

  approve(id) {
    return this.serial(async () => {
      await this.synchronize(false);
      const target = this.roster.find(item => item.id === id && item.status === 'pending');
      if (!target) throw new Error('申请已失效');
      await this.change('add', target);
      await this.synchronize(false);
    });
  }

  send(content, clientId) {
    return this.serial(async () => {
      await this.synchronize(false);
      if (this.record.history.some(message => message.clientId === clientId)) return;
      if (!this.ready) throw new Error('加密群组尚未就绪');
      const before = this.client.snapshot();
      const message = {
        content, nickname: this.member.nickname, memberId: this.member.id,
        createdAt: Date.now(), clientId,
      };
      this.record.outbox = {
        before, cursor: this.record.cursor, message,
        body: {
          type: 'message', version: this.record.cursor, epoch: this.record.epoch,
          operationId: message.clientId,
          payload: encode(this.client.encrypt(text.encode(JSON.stringify(message)))),
        },
      };
      await this.save();
      await this.finishOutbox();
      await this.synchronize(false);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    clearInterval(this.heartbeat);
    clearTimeout(this.coordinatorRetry);
    // sessionStorage survives reload in this tab; IndexedDB cleanup may be cut short by navigation.
    if (this.record?.owner === this.owner) sessionStorage.setItem(this.handoffKey, this.owner);
    this.queue.finally(async () => {
      this.client?.free();
      await releaseLease(this.key, this.owner);
    }).catch(() => {});
  }
}
