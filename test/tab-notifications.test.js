import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTabNotifications } from '../src/tab-notifications.js';

function setup() {
  const document = new EventTarget();
  document.title = 'LAN Note Room';
  document.hidden = true;
  return { document, notifications: createTabNotifications(document) };
}

test('hidden tabs count only new live messages from other members', () => {
  const { document, notifications } = setup();
  notifications.receive({ id: 1, memberId: 'other' }, 'me', false);
  notifications.receive({ id: 2, memberId: 'me' }, 'me', true);
  assert.equal(document.title, 'LAN Note Room');
  notifications.receive({ id: 3, memberId: 'other' }, 'me', true);
  notifications.receive({ id: 3, memberId: 'other' }, 'me', true);
  assert.equal(document.title, '（1 条新消息）LAN Note Room');
  notifications.receive({ id: 4, memberId: 'other' }, 'me', true);
  assert.equal(document.title, '（2 条新消息）LAN Note Room');
});

test('returning to the tab clears unread without counting visible messages', () => {
  const { document, notifications } = setup();
  notifications.receive({ id: 1, memberId: 'other' }, 'me', true);
  document.hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(document.title, 'LAN Note Room');
  notifications.receive({ id: 2, memberId: 'other' }, 'me', true);
  assert.equal(document.title, 'LAN Note Room');
  document.hidden = true;
  notifications.receive({ id: 2, memberId: 'other' }, 'me', true);
  assert.equal(document.title, 'LAN Note Room');
});

test('leaving or destroying a room resets title and message tracking', () => {
  const { document, notifications } = setup();
  notifications.receive({ id: 20, memberId: 'other' }, 'me', true);
  notifications.reset();
  assert.equal(document.title, 'LAN Note Room');
  notifications.receive({ id: 1, memberId: 'other' }, 'me', true);
  assert.equal(document.title, '（1 条新消息）LAN Note Room');
});
