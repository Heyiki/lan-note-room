import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

// Run the actual pre-paint script with only its browser environment substituted.
async function loadTheme(saved, blocked = false) {
  const script = await readFile(new URL('../public/theme.js', import.meta.url), 'utf8');
  const values = new Map(saved === undefined ? [] : [['lan-note-room-theme', saved]]);
  const listeners = new Map();
  const root = { dataset: {} };
  const meta = { content: '' };
  const buttons = ['light', 'dark'].map(theme => ({
    dataset: { themeChoice: theme },
    attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; }
  }));
  const document = {
    documentElement: root,
    querySelector: () => meta,
    querySelectorAll: () => buttons,
    addEventListener: (type, listener) => listeners.set(type, listener)
  };
  const localStorage = {
    getItem(key) { if (blocked) throw new Error('denied'); return values.get(key) ?? null; },
    setItem(key, value) { if (blocked) throw new Error('denied'); values.set(key, value); }
  };
  runInNewContext(script, { document, localStorage });
  return {
    root, meta, buttons, values,
    choose(theme) {
      listeners.get('click')?.({ target: { closest: () => buttons.find(button => button.dataset.themeChoice === theme) } });
    }
  };
}

test('first visit and invalid preference use dark theme before rendering', async () => {
  for (const saved of [undefined, 'invalid']) {
    const page = await loadTheme(saved);
    assert.equal(page.root.dataset.theme, 'dark');
    assert.equal(page.meta.content, '#181a1d');
  }
});

test('choosing light updates the page and survives a new page load', async () => {
  const page = await loadTheme();
  page.choose('light');
  assert.equal(page.root.dataset.theme, 'light');
  assert.equal(page.buttons[0].attributes['aria-pressed'], 'true');
  assert.equal(page.buttons[1].attributes['aria-pressed'], 'false');
  assert.equal(page.meta.content, '#f5f6f8');
  const refreshed = await loadTheme(page.values.get('lan-note-room-theme'));
  assert.equal(refreshed.root.dataset.theme, 'light');
  refreshed.choose('dark');
  assert.equal(refreshed.root.dataset.theme, 'dark');
  assert.equal(refreshed.values.get('lan-note-room-theme'), 'dark');
});

test('blocked browser storage does not prevent default or manual switching', async () => {
  const page = await loadTheme(undefined, true);
  assert.equal(page.root.dataset.theme, 'dark');
  page.choose('light');
  assert.equal(page.root.dataset.theme, 'light');
});
