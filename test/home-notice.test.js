import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { test } from 'node:test';
import { createTabNotifications } from '../src/tab-notifications.js';

async function loadPage(environment = {}) {
  const elements = new Map();
  const document = {
    title: 'LAN Note Room', documentElement: { dataset: {} },
    addEventListener() {},
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, { innerHTML: '', dataset: {}, addEventListener() {} });
      return elements.get(selector);
    }
  };
  const storage = new Map([['lan-note-room-token:test', 'token']]);
  const context = createContext({
    document, createTabNotifications, clearTimeout,
    location: { hash: '#/' }, window: { addEventListener() {} },
    sessionStorage: { getItem: key => storage.get(key), removeItem: key => storage.delete(key) },
    ...environment
  });
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  runInContext(source.replace(/^import .+;\r?\n/gm, ''), context);
  return { context, elements, storage };
}

test('destroy notice survives the home hashchange rerender and clears on entering another room', async () => {
  const page = await loadPage();
  runInContext(`
    chatState = {roomId: 'test', view: viewVersion};
    returnHome(chatState, '有内鬼，终止交易');
    dispatch();
  `, page.context);
  assert.match(page.elements.get('#app').innerHTML, /有内鬼，终止交易/);
  assert.equal(page.storage.has('lan-note-room-token:test'), false);
  runInContext(`location.hash = '#/room/another'; dispatch(); location.hash = '#/'; dispatch();`, page.context);
  assert.doesNotMatch(page.elements.get('#app').innerHTML, /有内鬼，终止交易/);
});

test('normal explicit leave does not show a destruction warning', async () => {
  const page = await loadPage();
  runInContext(`chatState = {roomId: 'test', view: viewVersion}; returnHome(chatState);`, page.context);
  assert.doesNotMatch(page.elements.get('#app').innerHTML, /有内鬼，终止交易/);
});

test('presence events update the room label and stale connections cannot overwrite it', async () => {
  const streams = [];
  const page = await loadPage({
    fetch: async () => ({ ok: true, json: async () => ({ ticket: 'ticket' }) }),
    EventSource: class {
      constructor() { this.listeners = new Map(); streams.push(this); }
      addEventListener(type, listener) { this.listeners.set(type, listener); }
      close() {}
      emit(type, data) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
    }
  });
  await runInContext(`
    chatState = {roomId: 'test', view: viewVersion, lastEventId: 0};
    connectEventStream(chatState);
  `, page.context);
  streams[0].emit('presence', { onlineCount: 2 });
  assert.equal(page.elements.get('#online-count')?.textContent, '2 人在线');
  await runInContext('connectEventStream(chatState)', page.context);
  streams[1].emit('presence', { onlineCount: 1 });
  streams[0].emit('presence', { onlineCount: 3 });
  assert.equal(page.elements.get('#online-count').textContent, '1 人在线');
  runInContext('closeRoom()', page.context);
  streams[1].emit('presence', { onlineCount: 9 });
  assert.equal(page.elements.get('#online-count').textContent, '1 人在线');
});

test('connection loss marks presence as unknown instead of showing a stale count', async () => {
  const page = await loadPage();
  runInContext(`chatState = {roomId: 'test', view: viewVersion};`, page.context);
  const label = page.context.document.querySelector('#online-count');
  label.textContent = '2 人在线';
  runInContext(`connectionStatus(chatState, '连接中断，正在重连');`, page.context);
  assert.equal(label.textContent, '在线人数未知');
});
