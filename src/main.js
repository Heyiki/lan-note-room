import './style.css';
import { createTabNotifications } from './tab-notifications.js';
import { MlsSession, removeRoomRecords, removeSessionRecord, pruneExpiredRecords } from './mls-client.js';

const app = document.querySelector('#app');
const tabNotifications = createTabNotifications(document);
const MAX_LENGTH = 2_000;
const MAX_MESSAGES = 1_000;
const roomTokenKey = id => `lan-note-room-token:${id}`;
const getToken = id => sessionStorage.getItem(roomTokenKey(id));
const setToken = (id, token) => sessionStorage.setItem(roomTokenKey(id), token);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
let viewVersion = 0;
let chatState = null;
let homeNotice = '';

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const roomId = path.match(/^\/rooms\/([^/]+)/)?.[1];
  const token = roomId && getToken(roomId);
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch('/api' + path, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function setStatus(message, type = 'info', target = '#status') {
  const element = document.querySelector(target);
  if (element) {
    element.textContent = message;
    element.dataset.type = type;
  }
}

function header() {
  const dark = document.documentElement.dataset.theme !== 'light';
  return `<header class="topbar">
    <a class="brand" href="#/"><span class="brand-mark" aria-hidden="true">N</span>LAN Note <span class="brand-kind">/ CHAT</span></a>
    <div class="header-actions">
      <span class="local-tag"><span class="local-dot"></span>局域网临时群聊</span>
      <div class="theme-switch" role="group" aria-label="主题">
        <button type="button" data-theme-choice="light" aria-pressed="${!dark}" title="亮色主题">亮</button>
        <button type="button" data-theme-choice="dark" aria-pressed="${dark}" title="暗色主题">暗</button>
      </div>
    </div>
  </header>`;
}

function footer() {
  return '<footer>LAN Note Room · 局域网临时群聊</footer>';
}

function enterRoom(roomId) {
  const hash = `#/room/${roomId}`;
  if (location.hash === hash) dispatch();
  else location.hash = hash;
}

function renderHome() {
  const view = viewVersion;
  app.innerHTML = `<main class="shell">
    ${header()}
    <section class="home-heading"><h1>临时群聊</h1></section>
    ${homeNotice ? `<div class="home-notice" role="alert">${esc(homeNotice)}</div>` : ''}
    <div class="home-grid">
      <form class="panel" id="create-form">
        <h2>创建房间</h2>
        <label for="room-name">房间名称</label>
        <input id="room-name" maxlength="40" placeholder="例如：项目讨论" />
        <label for="room-password">房间密码 <span class="optional">可选</span></label>
        <input id="room-password" type="password" maxlength="128" autocomplete="new-password" placeholder="设置房间密码" />
        <label for="room-ttl">房间有效期（分钟，最多 24 小时）</label>
        <input id="room-ttl" type="number" min="1" max="1440" step="1" value="60" required />
        <label class="encryption-choice" for="room-encrypted"><input id="room-encrypted" type="checkbox" checked />端到端加密（MLS）</label>
        <label class="encryption-choice" for="room-approval"><input id="room-approval" type="checkbox" checked />入群需批准</label>
        <button class="primary full" type="submit">创建房间</button>
        <div id="status" class="status" role="status"></div>
      </form>
      <form class="panel" id="join-form">
        <h2>加入房间</h2>
        <label for="join-id">房间 ID</label>
        <input id="join-id" required placeholder="输入房间 ID" autocomplete="off" />
        <label for="join-password">房间密码</label>
        <input id="join-password" type="password" maxlength="128" placeholder="没有密码则留空" />
        <button class="secondary full" type="submit">加入房间</button>
        <div id="join-status" class="status" role="status"></div>
      </form>
    </div>
    ${footer()}
  </main>`;

  document.querySelector('#create-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const result = await request('/rooms', { method: 'POST', body: {
        name: document.querySelector('#room-name').value.trim() || '临时房间',
        password: document.querySelector('#room-password').value,
        ttlHours: Number(document.querySelector('#room-ttl').value) / 60,
        encrypted: document.querySelector('#room-encrypted').checked,
        approvalRequired: document.querySelector('#room-approval').checked
      } });
      if (view !== viewVersion) return;
      setToken(result.room.id, result.token);
      if (result.room.encrypted) sessionStorage.setItem(`lan-note-room-founder:${result.room.id}`, '1');
      enterRoom(result.room.id);
    } catch (error) {
      if (view === viewVersion) setStatus(error.message, 'error');
    } finally { button.disabled = false; }
  });

  document.querySelector('#join-form').addEventListener('submit', async event => {
    event.preventDefault();
    const roomId = document.querySelector('#join-id').value.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(roomId)) {
      return setStatus('请输入有效的房间 ID。', 'error', '#join-status');
    }
    await joinRoom(roomId, document.querySelector('#join-password').value, event.currentTarget, '#join-status', view);
  });
}

async function joinRoom(roomId, password, form, target, view) {
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const result = await request(`/rooms/${roomId}/join`, { method: 'POST', body: { password } });
    if (view !== viewVersion) return;
    setToken(roomId, result.token);
    enterRoom(roomId);
  } catch (error) {
    if (view === viewVersion) setStatus(error.message, 'error', target);
  } finally { button.disabled = false; }
}

function renderJoinRequired(roomId) {
  const view = viewVersion;
  app.innerHTML = `<main class="shell narrow">
    ${header()}
    <form class="panel" id="invitation-form">
      <h1 class="small-title">加入群聊</h1>
      <p class="room-code">房间 ID：<code>${esc(roomId)}</code></p>
      <label for="join-password">房间密码</label>
      <input id="join-password" type="password" maxlength="128" placeholder="没有密码则留空" />
      <button class="primary full" type="submit">加入房间</button>
      <div id="status" class="status" role="status"></div>
    </form>${footer()}</main>`;
  document.querySelector('#invitation-form').addEventListener('submit', event => {
    event.preventDefault();
    joinRoom(roomId, document.querySelector('#join-password').value, event.currentTarget, '#status', view);
  });
}

function closeRoom() {
  tabNotifications.reset();
  if (!chatState) return;
  clearTimeout(chatState.reconnectTimer);
  chatState.stream?.close();
  chatState.mls?.close();
  chatState = null;
}

const isActive = state => chatState === state && state.view === viewVersion;

function returnHome(state, notice = '') {
  if (!isActive(state)) return;
  homeNotice = notice;
  sessionStorage.removeItem(roomTokenKey(state.roomId));
  if (state.encrypted) {
    const session = sessionStorage.getItem(`lan-note-room-mls-session:${state.roomId}`);
    if (notice) removeRoomRecords(state.roomId).catch(() => {});
    else if (session) removeSessionRecord(state.roomId, session).catch(() => {});
    sessionStorage.removeItem(`lan-note-room-founder:${state.roomId}`);
    sessionStorage.removeItem(`lan-note-room-mls-session:${state.roomId}`);
  }
  closeRoom();
  location.hash = '#/';
  dispatch();
}

function roomFailed(state, error) {
  if (!isActive(state)) return;
  sessionStorage.removeItem(roomTokenKey(state.roomId));
  state.mls?.close();
  if (state.encrypted) {
    const session = sessionStorage.getItem(`lan-note-room-mls-session:${state.roomId}`);
    if (session) removeSessionRecord(state.roomId, session).catch(() => {});
  }
  if (state.member) {
    clearTimeout(state.reconnectTimer);
    state.stream?.close();
    state.stream = null;
    state.unavailable = true;
    connectionStatus(state, '房间已失效');
    setStatus(error, 'error', '#send-status');
    updateComposer(state);
    return;
  }
  closeRoom();
  app.innerHTML = `<main class="shell narrow">${header()}<section class="error-view">
    <h1 class="small-title">无法打开房间</h1><p>${esc(error)}</p><a href="#/">返回首页</a>
  </section>${footer()}</main>`;
}

function connectionStatus(state, message, connected = false) {
  if (!isActive(state)) return;
  const status = document.querySelector('#connection-status');
  status.textContent = message;
  status.dataset.connected = String(connected);
  if (!connected) document.querySelector('#online-count').textContent = '在线人数未知';
}

async function connectEventStream(state) {
  if (!isActive(state)) return;
  try {
    const { ticket } = await request(`/rooms/${state.roomId}/events-ticket`, { method: 'POST', body: {} });
    if (!isActive(state)) return;
    const stream = new EventSource(`/api/rooms/${state.roomId}/events?ticket=${encodeURIComponent(ticket)}&after=${state.lastEventId}`);
    let live = false;
    state.stream = stream;
    stream.onopen = () => {
      if (state.stream === stream) connectionStatus(state, '已连接', true);
    };
    stream.addEventListener('message', event => {
      if (!isActive(state) || state.stream !== stream) return;
      const message = JSON.parse(event.data);
      tabNotifications.receive(message, state.member.id, live);
      receiveMessage(state, message);
      state.lastEventId = Math.max(state.lastEventId, message.id);
    });
    stream.addEventListener('sync-complete', () => { live = true; });
    stream.addEventListener('presence', event => {
      if (!isActive(state) || state.stream !== stream) return;
      document.querySelector('#online-count').textContent = `${JSON.parse(event.data).onlineCount} 人在线`;
    });
    stream.addEventListener('mls-update', event => {
      if (!isActive(state) || state.stream !== stream || !state.mls) return;
      state.mls.sync(!JSON.parse(event.data).initial).catch(() => {});
    });
    stream.addEventListener('admission-update', () => {
      if (isActive(state) && state.stream === stream && !state.encrypted) refreshAdmission(state);
    });
    stream.addEventListener('room-destroyed', event => {
      if (state.stream === stream) returnHome(state, JSON.parse(event.data).reason);
    });
    stream.addEventListener('room-expired', event => roomFailed(state, JSON.parse(event.data).reason));
    stream.addEventListener('member-left', event => roomFailed(state, JSON.parse(event.data).reason));
    stream.onerror = () => {
      stream.close();
      if (!isActive(state) || state.stream !== stream) return;
      state.stream = null;
      connectionStatus(state, '连接中断，正在重连');
      state.reconnectTimer = setTimeout(() => connectEventStream(state), 1500);
    };
  } catch (error) {
    if (!isActive(state)) return;
    if (error.status === 401 || error.status === 404) return roomFailed(state, error.message);
    connectionStatus(state, '暂时无法连接，正在重试');
    state.reconnectTimer = setTimeout(() => connectEventStream(state), 2500);
  }
}

function scrollToLatest(state) {
  state.list.scrollTop = state.list.scrollHeight;
  document.querySelector('#latest-messages').hidden = true;
}

function receiveMessage(state, message, initial = false) {
  if (!isActive(state) || state.messages.has(message.id)) return;
  const nearBottom = state.list.scrollHeight - state.list.scrollTop - state.list.clientHeight < 80;
  state.messages.set(message.id, message);
  document.querySelector('#empty-messages').hidden = true;
  const item = document.createElement('li');
  const own = message.memberId === state.member.id;
  item.className = `message${own ? ' own' : ''}`;
  item.dataset.id = message.id;
  const date = new Date(message.createdAt);
  item.innerHTML = `<span class="avatar" aria-hidden="true">${esc(message.nickname.slice(0, 1))}</span>
    <div class="message-main">
      <div class="message-meta"><span class="message-name">${esc(message.nickname)}${own ? '（你）' : ''}</span>
        <time datetime="${date.toISOString()}" title="${esc(date.toLocaleString())}">${esc(date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }))}</time>
      </div>
      <div class="message-body">${esc(message.content)}</div>
    </div>`;
  const next = Array.from(state.list.children).find(child => Number(child.dataset.id) > message.id);
  state.list.insertBefore(item, next || null);
  while (state.messages.size > MAX_MESSAGES) {
    const first = state.list.firstElementChild;
    state.messages.delete(Number(first.dataset.id));
    first.remove();
  }
  if (!initial) {
    if (nearBottom || own) scrollToLatest(state);
    else document.querySelector('#latest-messages').hidden = false;
  }
}

function updateComposer(state) {
  if (!isActive(state)) return;
  state.input.disabled = state.unavailable || !state.admitted || (state.encrypted && !state.mls?.ready);
  document.querySelector('#destroy-room').disabled = state.unavailable || !state.admitted || state.destroying;
  document.querySelector('#char-count').textContent = `${state.input.value.length.toLocaleString()} / ${MAX_LENGTH.toLocaleString()}`;
  document.querySelector('#send-message').disabled = state.unavailable || !state.admitted || state.sending
    || (state.encrypted && !state.mls?.ready) || !state.input.value.trim();
}

async function sendMessage(state) {
  if (!isActive(state) || state.unavailable || !state.admitted || state.sending || !state.input.value.trim()) return;
  const content = state.input.value;
  if (!state.pending || state.pending.content !== content) {
    const clientId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    state.pending = { content, clientId };
  }
  state.sending = true;
  updateComposer(state);
  setStatus('正在发送…', 'info', '#send-status');
  try {
    let message;
    if (state.encrypted) await state.mls.send(content, state.pending.clientId);
    else ({ message } = await request(`/rooms/${state.roomId}/messages`, {
      method: 'POST', body: state.pending,
    }));
    if (!isActive(state)) return;
    if (message) receiveMessage(state, message);
    if (state.input.value === content) state.input.value = '';
    state.pending = null;
    setStatus('', 'info', '#send-status');
    scrollToLatest(state);
  } catch (error) {
    if (!isActive(state)) return;
    if (error.status === 401 || error.status === 404) {
      roomFailed(state, error.message);
      return;
    }
    setStatus(`发送失败：${error.message}`, 'error', '#send-status');
  } finally {
    state.sending = false;
    updateComposer(state);
  }
}

async function renderRoom(roomId) {
  if (!getToken(roomId)) return renderJoinRequired(roomId);
  const state = {
    roomId, view: viewVersion, stream: null, reconnectTimer: null,
    messages: new Map(), lastEventId: 0, member: null, sending: false, pending: null, unavailable: false,
    admitted: false, destroying: false
  };
  chatState = state;
  app.innerHTML = `<main class="shell chat-shell">
    ${header()}
    <section class="room-heading">
      <div class="room-title">
        <div class="room-name-row"><h1 id="room-name-title">正在加载房间…</h1><span id="online-count" class="online-count" role="status">在线人数…</span></div>
        <p id="room-meta"></p>
      </div>
      <div class="room-actions">
        <button id="leave" class="text-button">退出房间</button>
        <div class="destroy-action">
          <button id="destroy-room" class="ghost-button" type="button" aria-label="有内鬼，终止交易" aria-describedby="destroy-tooltip" disabled><span aria-hidden="true">👻</span></button>
          <span id="destroy-tooltip" class="action-tooltip" role="tooltip">有内鬼，终止交易</span>
        </div>
      </div>
    </section>
    <section class="room-share" aria-label="房间邀请">
      <label for="room-url">邀请链接</label>
      <input id="room-url" readonly />
      <button id="copy-room" class="secondary">复制链接</button>
      <span id="copy-status" class="status" role="status"></span>
    </section>
    <section class="chat" aria-label="群聊">
      <div class="chat-toolbar"><span id="my-nickname"></span><span id="connection-status" role="status" data-connected="false">正在连接…</span></div>
      <section id="admission-panel" class="encryption-panel" hidden>
        <span id="admission-status" role="status"></span>
        <div id="admission-requests"></div>
      </section>
      <section id="encryption-panel" class="encryption-panel" hidden>
        <div class="encryption-status-row"><span id="encryption-status" role="status"></span><button id="retry-encryption" class="text-button" type="button" hidden>重新同步</button></div>
        <details id="encryption-details"><summary>成员身份指纹</summary><div id="encryption-fingerprints"></div></details>
        <div id="encryption-requests"></div>
      </section>
      <div class="conversation">
        <p id="empty-messages">暂无消息</p>
        <ol id="message-list" aria-label="聊天消息" role="log" aria-live="polite" aria-relevant="additions"></ol>
        <button id="latest-messages" class="secondary latest-button" hidden>查看新消息</button>
      </div>
      <form id="message-form" class="composer">
        <label class="sr-only" for="message-input">消息</label>
        <textarea id="message-input" maxlength="${MAX_LENGTH}" rows="3" placeholder="发送消息…" disabled></textarea>
        <div class="composer-bottom">
          <div id="send-status" class="status" role="status"></div>
          <span id="char-count">0 / ${MAX_LENGTH.toLocaleString()}</span>
          <button id="send-message" type="submit" class="primary" disabled>发送</button>
        </div>
      </form>
    </section>
    <div class="chat-footnote">最近 1,000 条消息 · 房间过期或服务停止后清空</div>
  </main>`;

  document.querySelector('#leave').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await request(`/rooms/${roomId}/leave`, { method: 'POST', body: {} });
    } catch (error) {
      if (!isActive(state)) return;
      if (error.status !== 401 && error.status !== 404) {
        setStatus(`退出失败：${error.message}，请重试。`, 'error', '#send-status');
        button.disabled = false;
        return;
      }
    }
    returnHome(state);
  });
  document.querySelector('#destroy-room').addEventListener('click', async event => {
    if (!state.admitted || state.unavailable || state.destroying) return;
    const button = event.currentTarget;
    state.destroying = true;
    button.disabled = true;
    try {
      await request(`/rooms/${roomId}/destroy`, { method: 'POST', body: {} });
      returnHome(state, '有内鬼，终止交易');
    } catch (error) {
      if (!isActive(state)) return;
      if (error.status === 401 || error.status === 404) return returnHome(state);
      setStatus(`销毁失败：${error.message}，请重试。`, 'error', '#send-status');
      state.destroying = false;
      updateComposer(state);
    }
  });
  try {
    const data = await request(`/rooms/${roomId}`);
    if (!isActive(state)) return;
    state.member = data.member;
    state.encrypted = data.room.encrypted;
    state.admitted = data.admitted;
    state.list = document.querySelector('#message-list');
    state.input = document.querySelector('#message-input');
    document.querySelector('#room-name-title').textContent = data.room.name;
    document.querySelector('#room-meta').textContent = `${data.room.encrypted ? 'MLS 端到端加密' : '普通群聊 · 未加密'} · 到期 ${new Date(data.room.expiresAt).toLocaleString()} · 全员主动退出即销毁`;
    document.querySelector('#my-nickname').textContent = `你的昵称：${data.member.nickname}`;
    document.querySelector('#room-url').value = `${location.origin}${location.pathname}#/room/${roomId}`;
    for (const message of data.messages) receiveMessage(state, message, true);
    state.lastEventId = data.messages.at(-1)?.id || 0;
    scrollToLatest(state);
    if (!state.encrypted) renderAdmission(state, data);
    updateComposer(state);
    state.input.addEventListener('input', () => updateComposer(state));
    state.input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        sendMessage(state);
      }
    });
    document.querySelector('#message-form').addEventListener('submit', event => {
      event.preventDefault();
      sendMessage(state);
    });
    state.list.addEventListener('scroll', () => {
      if (state.list.scrollHeight - state.list.scrollTop - state.list.clientHeight < 80) {
        document.querySelector('#latest-messages').hidden = true;
      }
    });
    document.querySelector('#latest-messages').addEventListener('click', () => scrollToLatest(state));
    document.querySelector('#copy-room').addEventListener('click', async () => {
      const field = document.querySelector('#room-url');
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(field.value);
        else {
          field.select();
          if (!document.execCommand('copy')) throw new Error('copy failed');
        }
        if (isActive(state)) setStatus('已复制', 'success', '#copy-status');
      } catch {
        if (isActive(state)) {
          field.select();
          setStatus('请手动复制', 'error', '#copy-status');
        }
      }
    });
    for (const selector of ['#admission-requests', '#encryption-requests']) {
      document.querySelector(selector).addEventListener('click', async event => {
        const button = event.target.closest('[data-approve]');
        if (!button) return;
        button.disabled = true;
        try {
          if (state.encrypted) await state.mls.approve(button.dataset.approve);
          else {
            await request(`/rooms/${roomId}/approve`, {
              method: 'POST', body: { memberId: button.dataset.approve },
            });
            await refreshAdmission(state);
          }
        } catch (error) {
          if (isActive(state)) setStatus(error.message, 'error', '#send-status');
        } finally { button.disabled = false; }
      });
    }
    if (state.encrypted) {
      document.querySelector('#encryption-panel').hidden = false;
      document.querySelector('#encryption-status').textContent = '正在初始化加密…';
      state.mls = new MlsSession({
        roomId, member: state.member, expiresAt: data.room.expiresAt,
        autoAdmit: !data.room.approvalRequired, request,
        onMessage: (message, live) => {
          if (!isActive(state) || state.unavailable) return;
          tabNotifications.receive(message, state.member.id, live);
          receiveMessage(state, message, !live);
        },
        onStatus: status => renderEncryptionStatus(state, status),
      });
      document.querySelector('#retry-encryption').addEventListener('click', () => {
        state.mls.sync(false).catch(() => {});
      });
      try {
        await state.mls.start(sessionStorage.getItem(`lan-note-room-founder:${roomId}`) === '1');
      } catch (error) {
        if (isActive(state)) renderEncryptionStatus(state, { ready: false, error: error.message });
      }
      if (!isActive(state)) return;
    }
    connectEventStream(state);
  } catch (error) {
    if (isActive(state)) roomFailed(state, error.message);
  }
}

function renderAdmission(state, data) {
  state.admitted ||= data.admitted;
  document.querySelector('#admission-panel').hidden = state.admitted && !data.pending.length;
  document.querySelector('#admission-status').textContent = state.admitted
    ? '待审核申请' : '等待现有成员批准加入';
  document.querySelector('#admission-requests').innerHTML = data.pending.map(member =>
    `<div class="encryption-request"><span>${esc(member.nickname)}申请加入</span><button class="secondary" type="button" data-approve="${esc(member.id)}">批准加入</button></div>`
  ).join('');
  updateComposer(state);
}

async function refreshAdmission(state) {
  try {
    const data = await request(`/rooms/${state.roomId}`);
    if (!isActive(state) || state.unavailable) return;
    renderAdmission(state, data);
    for (const message of data.messages) receiveMessage(state, message, true);
    state.lastEventId = Math.max(state.lastEventId, data.messages.at(-1)?.id || 0);
  } catch (error) {
    if (!isActive(state) || state.unavailable) return;
    if (error.status === 401 || error.status === 404) roomFailed(state, error.message);
    else setStatus(`入群状态同步失败：${error.message}`, 'error', '#send-status');
  }
}

function renderEncryptionStatus(state, status) {
  if (!isActive(state) || state.unavailable) return;
  document.querySelector('#encryption-status').textContent = status.error
    ? `加密已暂停：${status.error}`
    : status.waiting
      ? status.autoAdmit ? '等待在线成员完成加密入群' : '等待现有成员批准加入'
      : 'MLS 加密已就绪';
  document.querySelector('#retry-encryption').hidden = !status.error;
  if (status.ready) state.admitted = true;
  const members = status.members || (status.fingerprint
    ? [{ identity: state.member.id, fingerprint: status.fingerprint }] : []);
  const names = new Map((state.mls.roster || []).map(item => [item.id, item.nickname]));
  document.querySelector('#encryption-fingerprints').innerHTML = members.map(member =>
    `<p><span>${esc(names.get(member.identity) || state.member.nickname)}${member.identity === state.member.id ? '（你）' : ''}</span><code>${esc(member.fingerprint.match(/.{1,8}/g).join(' '))}</code></p>`
  ).join('');
  document.querySelector('#encryption-requests').innerHTML = (status.pending || []).map(member =>
    `<div class="encryption-request"><span>${esc(member.nickname)}申请加入<code>${esc(member.fingerprint.match(/.{1,8}/g).join(' '))}</code></span><button class="secondary" type="button" data-approve="${esc(member.id)}">批准加入</button></div>`
  ).join('');
  updateComposer(state);
}

function dispatch() {
  viewVersion++;
  closeRoom();
  const path = (location.hash.slice(1) || '/').split('?')[0];
  const roomMatch = path.match(/^\/room\/([A-Za-z0-9_-]+)$/);
  if (roomMatch) {
    homeNotice = '';
    renderRoom(roomMatch[1]);
  }
  else renderHome();
}

window.addEventListener('hashchange', dispatch);
window.addEventListener('pagehide', closeRoom);
window.addEventListener('pageshow', event => { if (event.persisted) dispatch(); });
dispatch();
if (typeof indexedDB !== 'undefined') pruneExpiredRecords().catch(() => {});
