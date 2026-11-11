import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNickname } from '../server/nicknames.js';

test('nicknames use adjective plus 的 plus fruit or animal without duplicates', () => {
  const used = new Set();
  for (let i = 0; i < 768; i++) {
    const before = used.size;
    const nickname = createNickname(used);
    assert.match(nickname, /^[\u4e00-\u9fff]+的[\u4e00-\u9fff]+$/);
    assert.equal(used.size, before + 1);
    assert.ok(used.has(nickname));
  }
  assert.ok([...used].some(name => name.endsWith('的小熊')));
  assert.ok([...used].some(name => name.endsWith('的草莓')));
});

test('exhausting the word combinations still produces unique nicknames', () => {
  const used = new Set();
  for (let i = 0; i < 770; i++) createNickname(used);
  assert.equal(used.size, 770);
});
