import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import net from 'node:net';

const { chromium } = createRequire(import.meta.url)(process.argv[2] || 'playwright');
const address = Object.values(networkInterfaces()).flat()
  .find(item => item.family === 'IPv4' && !item.internal
    && !item.address.startsWith('169.254.'))?.address;
assert(address);
const probe = net.createServer().listen(0, '0.0.0.0');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
let child;
let browser;
try {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, HOST: '0.0.0.0', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(() => { throw new Error('test server exited'); }),
  ]);
  const origin = `http://${address}:${port}`;
  console.log(`Temporary app test: ${origin}`);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext()));
  let [alice, bob, carol] = await Promise.all(contexts.map(context => context.newPage()));
  const errors = [];
  for (const page of [alice, bob, carol]) page.on('pageerror', error => errors.push(error.message));
  await alice.goto(origin);
  assert.equal(await alice.locator('#room-encrypted').isChecked(), true);
  assert.equal(await alice.locator('#room-approval').isChecked(), true);
  await alice.locator('#room-name').fill('MLS integration');
  await alice.locator('#create-form button').click();
  await alice.waitForFunction(() => document.querySelector('#message-input')?.disabled === false);
  const roomUrl = alice.url();
  assert.equal(await alice.evaluate(() => isSecureContext), false);
  await alice.locator('#message-input').fill('secret before Bob');
  await alice.locator('#send-message').click();
  await alice.getByText('secret before Bob', { exact: true }).waitFor();
  await bob.goto(roomUrl);
  await bob.locator('#invitation-form button').click();
  await alice.locator('[data-approve]').waitFor();
  assert.equal(await bob.locator('#destroy-room').isDisabled(), true);
  assert.equal(await bob.evaluate(async () => {
    const id = location.hash.split('/').at(-1);
    const response = await fetch(`/api/rooms/${id}/destroy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionStorage.getItem(`lan-note-room-token:${id}`)}` },
    });
    return response.status;
  }), 403);
  let loseAdmissionReply = true;
  const admissionAck = async route => {
    if (loseAdmissionReply && route.request().method() === 'POST'
      && route.request().postDataJSON()?.type === 'add') {
      loseAdmissionReply = false;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  };
  await alice.route('**/api/rooms/*/mls', admissionAck);
  await alice.locator('[data-approve]').click();
  await bob.waitForFunction(() => document.querySelector('#message-input')?.disabled === false);
  await alice.waitForFunction(() => document.querySelector('#message-input')?.disabled === false);
  await alice.unroute('**/api/rooms/*/mls', admissionAck);
  assert.equal(await bob.getByText('secret before Bob', { exact: true }).count(), 0);
  await bob.locator('#message-input').fill('secret from Bob');
  await bob.locator('#send-message').click();
  await alice.getByText('secret from Bob', { exact: true }).waitFor();
  let loseReply = true;
  const lostAck = async route => {
    const body = route.request().postDataJSON();
    if (loseReply && route.request().method() === 'POST' && body?.type === 'message') {
      loseReply = false;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  };
  await bob.route('**/api/rooms/*/mls', lostAck);
  await bob.locator('#message-input').fill('lost confirmation');
  await bob.locator('#send-message').click();
  await alice.getByText('lost confirmation', { exact: true }).waitFor();
  await bob.locator('#send-message:not([disabled])').waitFor();
  assert.equal(await bob.locator('#message-input').inputValue(), 'lost confirmation');
  await bob.locator('#send-message').click();
  await bob.waitForFunction(() => document.querySelector('#message-input').value === '');
  assert.equal(await alice.getByText('lost confirmation', { exact: true }).count(), 1);
  assert.equal(await bob.getByText('lost confirmation', { exact: true }).count(), 1);
  await bob.unroute('**/api/rooms/*/mls', lostAck);

  let captured;
  let release;
  const capturedPromise = new Promise(resolve => { captured = resolve; });
  const releasePromise = new Promise(resolve => { release = resolve; });
  let delayOnce = true;
  const conflict = async route => {
    if (delayOnce && route.request().method() === 'POST'
      && route.request().postDataJSON()?.type === 'message') {
      delayOnce = false;
      captured();
      await releasePromise;
    }
    await route.continue();
  };
  await bob.route('**/api/rooms/*/mls', conflict);
  await bob.locator('#message-input').fill('retry after conflict');
  await bob.locator('#send-message').click();
  await capturedPromise;
  await alice.locator('#message-input').fill('wins the relay revision');
  await alice.locator('#send-message').click();
  await alice.getByText('wins the relay revision', { exact: true }).waitFor();
  release();
  await bob.waitForFunction(() => document.querySelector('#message-input').value === '');
  await alice.getByText('retry after conflict', { exact: true }).waitFor();
  await bob.getByText('wins the relay revision', { exact: true }).waitFor();
  assert.equal(await alice.getByText('retry after conflict', { exact: true }).count(), 1);
  await bob.unroute('**/api/rooms/*/mls', conflict);
  const predecessorOwner = await bob.evaluate(() => new Promise((resolve, reject) => {
    const roomId = location.hash.split('/').at(-1);
    const session = sessionStorage.getItem(`lan-note-room-mls-session:${roomId}`);
    const request = indexedDB.open('lan-note-room-mls');
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction('leases').objectStore('leases').get(`${roomId}:${session}`);
      get.onsuccess = () => { db.close(); resolve(get.result.owner); };
      get.onerror = () => { db.close(); reject(get.error); };
    };
    request.onerror = () => reject(request.error);
  }));
  const refreshStarted = performance.now();
  await bob.reload();
  await bob.waitForFunction(() => document.querySelector('#message-input')?.disabled === false,
    null, { timeout: 20000 });
  const refreshMs = Math.round(performance.now() - refreshStarted);
  console.log(`Encrypted refresh ready: ${refreshMs} ms`);
  assert(refreshMs < 3000, `normal refresh took ${refreshMs} ms; expected no lease timeout`);
  await bob.getByText('secret from Bob', { exact: true }).waitFor();
  const fingerprint = await bob.locator('#encryption-fingerprints').textContent();
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = performance.now();
    await bob.reload();
    await bob.locator('#message-input:not([disabled])').waitFor({ timeout: 3000 });
    assert(performance.now() - started < 3000, 'repeated refresh must not wait for the lease');
    assert.equal(await bob.locator('#encryption-fingerprints').textContent(), fingerprint);
    assert.equal(await bob.getByText('secret from Bob', { exact: true }).count(), 1);
  }

  let acceptedDuringRefresh;
  let releaseOldRequest;
  const refreshAccepted = new Promise(resolve => { acceptedDuringRefresh = resolve; });
  const oldRequestReleased = new Promise(resolve => { releaseOldRequest = resolve; });
  let pendingCiphertext;
  const retriedCiphertexts = [];
  await bob.route('**/api/rooms/*/mls', async route => {
    if (route.request().method() === 'POST'
      && route.request().postDataJSON()?.type === 'message') {
      if (!pendingCiphertext) {
        pendingCiphertext = route.request().postDataJSON();
        await route.fetch();
        acceptedDuringRefresh();
        await oldRequestReleased;
        await route.abort('failed').catch(() => {});
        return;
      }
      retriedCiphertexts.push(route.request().postDataJSON());
    }
    await route.continue();
  });
  await bob.locator('#message-input').fill('refresh while confirmation is pending');
  await bob.locator('#send-message').click();
  await refreshAccepted;
  await bob.reload();
  releaseOldRequest();
  await bob.locator('#message-input:not([disabled])').waitFor({ timeout: 3000 });
  assert(retriedCiphertexts.length >= 1, 'persisted outbox must be recovered');
  for (const ciphertext of retriedCiphertexts) assert.deepEqual(ciphertext, pendingCiphertext);
  assert.equal(await alice.getByText('refresh while confirmation is pending', { exact: true }).count(), 1);
  assert.equal(await bob.getByText('refresh while confirmation is pending', { exact: true }).count(), 1);
  await bob.unroute('**/api/rooms/*/mls');

  // Simulate duplicating a tab, including a stale handoff marker copied from its predecessor.
  const copiedSession = await bob.evaluate(() => Object.entries(sessionStorage));
  copiedSession.push([`lan-note-room-mls-handoff:${new URL(roomUrl).hash.split('/').at(-1)}`,
    predecessorOwner]);
  const duplicate = await contexts[1].newPage();
  await duplicate.goto(origin);
  await duplicate.evaluate(entries => {
    for (const [key, value] of entries) sessionStorage.setItem(key, value);
  }, copiedSession);
  await duplicate.goto(roomUrl);
  await duplicate.waitForFunction(() =>
    document.querySelector('#encryption-status')?.textContent.includes('加密已暂停'),
  null, { timeout: 15000 });
  assert.equal(await duplicate.locator('#message-input').isDisabled(), true);
  assert.equal(await bob.locator('#message-input').isDisabled(), false);
  await duplicate.close();
  await bob.locator('#message-input').fill('original identity stays exclusive');
  await bob.locator('#send-message').click();
  await alice.getByText('original identity stays exclusive', { exact: true }).waitFor();

  // A crashed renderer cannot publish a normal-close handoff; retain timeout recovery.
  const crashSession = await bob.evaluate(() => Object.entries(sessionStorage));
  const devtools = await contexts[1].newCDPSession(bob);
  const crashed = bob.waitForEvent('crash');
  const crashCommand = devtools.send('Page.crash').catch(() => {});
  await crashed;
  await bob.close();
  await crashCommand;
  // Restore the crashed tab's storage into a replacement renderer.
  bob = await contexts[1].newPage();
  bob.on('pageerror', error => errors.push(error.message));
  await bob.goto(origin);
  await bob.evaluate(entries => {
    for (const [key, value] of entries) sessionStorage.setItem(key, value);
  }, crashSession);
  const crashRecoveryStarted = performance.now();
  await bob.goto(roomUrl);
  await bob.locator('#message-input:not([disabled])').waitFor({ timeout: 15000 });
  const crashRecoveryMs = Math.round(performance.now() - crashRecoveryStarted);
  assert(crashRecoveryMs >= 5000, 'crash recovery must not bypass the existing lease');
  await bob.locator('#message-input').fill('message after crash recovery');
  await bob.locator('#send-message').click();
  await alice.getByText('message after crash recovery', { exact: true }).waitFor();
  console.log(`PASS: repeated refresh, pending ciphertext recovery, duplicate identity protection; crash recovery ${crashRecoveryMs} ms`);
  await carol.goto(roomUrl);
  await carol.locator('#invitation-form button').click();
  await alice.locator('[data-approve]').waitFor();
  await bob.locator('[data-approve]').waitFor();
  let capturedAdmission;
  let releaseAdmission;
  const admissionCaptured = new Promise(resolve => { capturedAdmission = resolve; });
  const admissionReleased = new Promise(resolve => { releaseAdmission = resolve; });
  let delayAdmission = true;
  const admissionConflict = async route => {
    if (delayAdmission && route.request().method() === 'POST'
      && route.request().postDataJSON()?.type === 'add') {
      delayAdmission = false;
      capturedAdmission();
      await admissionReleased;
    }
    await route.continue();
  };
  await alice.route('**/api/rooms/*/mls', admissionConflict);
  await alice.locator('[data-approve]').click();
  await admissionCaptured;
  await bob.locator('[data-approve]').click();
  await carol.waitForFunction(() => document.querySelector('#message-input')?.disabled === false);
  releaseAdmission();
  await alice.waitForFunction(() => document.querySelector('#message-input')?.disabled === false);
  await alice.unroute('**/api/rooms/*/mls', admissionConflict);
  await carol.locator('#message-input').fill('three-person secret');
  await carol.locator('#send-message').click();
  await alice.getByText('three-person secret', { exact: true }).waitFor();
  await bob.getByText('three-person secret', { exact: true }).waitFor();
  const token = await alice.evaluate(() => sessionStorage.getItem(
    `lan-note-room-token:${location.hash.split('/').at(-1)}`));
  const apiUrl = `${origin}/api/rooms/${new URL(roomUrl).hash.split('/').at(-1)}`;
  const relay = await (await fetch(`${apiUrl}/mls`, {
    headers: { Authorization: `Bearer ${token}` },
  })).text();
  assert(!relay.includes('secret from Bob') && !relay.includes('three-person secret'));
  const dave = await contexts[1].newPage();
  dave.on('pageerror', error => errors.push(error.message));
  await dave.goto(roomUrl);
  await dave.locator('#invitation-form button').click();
  await alice.locator('[data-approve]').waitFor();
  await alice.locator('[data-approve]').click();
  await dave.waitForFunction(() => document.querySelector('#message-input')?.disabled === false);
  await bob.locator('#leave').click();
  await bob.locator('#create-form').waitFor();
  await bob.waitForFunction(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('lan-note-room-mls');
    request.onsuccess = () => {
      const db = request.result;
      const count = db.transaction('rooms').objectStore('rooms').count();
      count.onsuccess = () => { db.close(); resolve(count.result === 1); };
      count.onerror = () => { db.close(); reject(count.error); };
    };
    request.onerror = () => reject(request.error);
  }));
  await alice.waitForFunction(() => document.querySelector('#message-input')?.disabled === false);
  await alice.locator('#message-input').fill('after Bob left');
  await alice.locator('#send-message').click();
  await carol.getByText('after Bob left', { exact: true }).waitFor();
  await dave.getByText('after Bob left', { exact: true }).waitFor();
  await dave.locator('#message-input').fill('other tab still has its own keys');
  await dave.locator('#send-message').click();
  await alice.getByText('other tab still has its own keys', { exact: true }).waitFor();
  await carol.setViewportSize({ width: 375, height: 812 });
  await carol.screenshot({ path: 'mls-prototype/browser/app-mobile.png', fullPage: true });
  assert.equal(await carol.evaluate(() =>
    document.documentElement.scrollWidth > innerWidth), false);
  await alice.locator('#destroy-room').click();
  await carol.locator('.home-notice').waitFor();
  await dave.locator('.home-notice').waitFor();
  assert.equal(await carol.locator('.home-notice').textContent(), '有内鬼，终止交易');
  await alice.locator('#room-encrypted').uncheck();
  await alice.locator('#create-form button').click();
  await alice.locator('#message-input:not([disabled])').waitFor();
  await alice.locator('#message-input').fill('ordinary chat');
  await alice.locator('#send-message').click();
  await alice.getByText('ordinary chat', { exact: true }).waitFor();

  await alice.goto(origin);
  await alice.locator('#room-password').fill('auto-admit-secret');
  await alice.locator('#room-approval').uncheck();
  await alice.locator('#create-form button').click();
  await alice.locator('#message-input:not([disabled])').waitFor();
  const protectedUrl = alice.url();
  await bob.goto(protectedUrl);
  await bob.locator('#join-password').fill('wrong-password');
  await bob.locator('#invitation-form button').click();
  await bob.getByText('房间密码错误', { exact: true }).waitFor();
  // No existing browser is online: a valid password cannot generate an MLS Welcome.
  await alice.goto(origin);
  await bob.locator('#join-password').fill('auto-admit-secret');
  await bob.locator('#invitation-form button').click();
  await bob.waitForFunction(() =>
    document.querySelector('#encryption-status')?.textContent.includes('等待'));
  assert.equal(await bob.locator('#message-input').isDisabled(), true);
  await alice.goto(protectedUrl);
  await bob.waitForFunction(() => document.querySelector('#message-input')?.disabled === false,
    null, { timeout: 15000 });
  assert.equal(await alice.locator('[data-approve]').count(), 0);
  await bob.locator('#message-input').fill('automatically admitted secret');
  await bob.locator('#send-message').click();
  await alice.getByText('automatically admitted secret', { exact: true }).waitFor();

  // Stall the coordinator; another online member must take over after its lease.
  let releaseAutoAdmission;
  const autoReleased = new Promise(resolve => { releaseAutoAdmission = resolve; });
  let holdAutoAdmission = true;
  const autoAttempts = [];
  const autoCoordinator = async route => {
    if (holdAutoAdmission && route.request().method() === 'POST'
      && route.request().postDataJSON()?.type === 'add') {
      holdAutoAdmission = false;
      autoAttempts.push(route.request().postDataJSON());
      await autoReleased;
    } else if (route.request().method() === 'POST'
      && route.request().postDataJSON()?.type === 'add') {
      autoAttempts.push(route.request().postDataJSON());
    }
    await route.continue();
  };
  await alice.route('**/api/rooms/*/mls', autoCoordinator);
  await bob.route('**/api/rooms/*/mls', autoCoordinator);
  await carol.goto(protectedUrl);
  await carol.locator('#join-password').fill('auto-admit-secret');
  await carol.locator('#invitation-form button').click();
  await carol.locator('#message-input:not([disabled])').waitFor({ timeout: 20000 });
  assert.equal(autoAttempts.length, 2, 'only one coordinator plus its timeout successor should commit');
  assert(autoAttempts.every(body => body.coordinated === true));
  releaseAutoAdmission();
  await alice.locator('#message-input:not([disabled])').waitFor();
  await alice.unroute('**/api/rooms/*/mls');
  await bob.unroute('**/api/rooms/*/mls');
  await carol.locator('#message-input').fill('automatic admission race recovered');
  await carol.locator('#send-message').click();
  await alice.getByText('automatic admission race recovered', { exact: true }).waitFor();
  await bob.getByText('automatic admission race recovered', { exact: true }).waitFor();

  // Passwords do not disable manual approval.
  await alice.goto(origin);
  await alice.locator('#room-password').fill('manual-admit-secret');
  await alice.locator('#create-form button').click();
  await alice.locator('#message-input:not([disabled])').waitFor();
  await bob.goto(alice.url());
  await bob.locator('#join-password').fill('manual-admit-secret');
  await bob.locator('#invitation-form button').click();
  await alice.locator('[data-approve]').waitFor();
  assert.equal(await bob.locator('#message-input').isDisabled(), true);
  assert.equal(await bob.locator('#destroy-room').isDisabled(), true);
  await bob.reload();
  await bob.getByText('等待现有成员批准加入', { exact: true }).waitFor();
  assert.equal(await bob.locator('#destroy-room').isDisabled(), true);
  await alice.locator('[data-approve]').click();
  await bob.locator('#message-input:not([disabled])').waitFor();
  await bob.locator('#destroy-room:not([disabled])').waitFor();

  // An encrypted room without either a password or human approval.
  await alice.goto(origin);
  await alice.locator('#room-approval').uncheck();
  await alice.locator('#create-form button').click();
  await alice.locator('#message-input:not([disabled])').waitFor();
  await bob.goto(alice.url());
  await bob.locator('#invitation-form button').click();
  await bob.locator('#message-input:not([disabled])').waitFor();
  await bob.locator('#message-input').fill('open encrypted room');
  await bob.locator('#send-message').click();
  await alice.getByText('open encrypted room', { exact: true }).waitFor();

  // Admission is independent of encryption as well as password protection.
  for (const password of ['', 'plain-room-secret']) {
    for (const approval of [true, false]) {
      await alice.goto(origin);
      await alice.locator('#room-encrypted').uncheck();
      await alice.locator('#room-password').fill(password);
      if (!approval) await alice.locator('#room-approval').uncheck();
      await alice.locator('#create-form button').click();
      await alice.locator('#message-input:not([disabled])').waitFor();
      await alice.locator('#message-input').fill('plain history before admission');
      await alice.locator('#send-message').click();
      await alice.getByText('plain history before admission', { exact: true }).waitFor();
      await bob.goto(alice.url());
      await bob.locator('#join-password').fill(password);
      await bob.locator('#invitation-form button').click();
      if (approval) {
        await alice.locator('[data-approve]').waitFor();
        await bob.getByText('等待现有成员批准加入', { exact: true }).waitFor();
        assert.equal(await bob.locator('#destroy-room').isDisabled(), true);
        assert.equal(await bob.locator('#message-input').isDisabled(), true);
        assert.equal(await bob.getByText('plain history before admission', { exact: true }).count(), 0);
        await alice.locator('#message-input').fill('plain live message while pending');
        await alice.locator('#send-message').click();
        await alice.getByText('plain live message while pending', { exact: true }).waitFor();
        await bob.reload();
        await bob.getByText('等待现有成员批准加入', { exact: true }).waitFor();
        assert.equal(await bob.getByText('plain live message while pending', { exact: true }).count(), 0);
        await alice.locator('[data-approve]').click();
        await bob.getByText('plain live message while pending', { exact: true }).waitFor();
      }
      await bob.locator('#message-input:not([disabled])').waitFor();
      await bob.getByText('plain history before admission', { exact: true }).waitFor();
      await bob.locator('#message-input').fill('approved plaintext message');
      await bob.locator('#send-message').click();
      await alice.getByText('approved plaintext message', { exact: true }).waitFor();
      await bob.locator('#destroy-room:not([disabled])').click();
      await alice.locator('.home-notice').waitFor();
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS: encryption and approval enabled by default, independent password/approval/encryption combinations, pending destroy restrictions, offline waiting, automatic admission races, history exclusion, lost message/admission acknowledgments, message/admission revision conflicts, refresh, three-party chat, ciphertext relay, removal, local-key cleanup, mobile, destruction, plaintext opt-out');
} catch (error) {
  for (const context of browser?.contexts() || []) {
    for (const page of context.pages()) {
      console.error('Browser failure state:', await page.evaluate(() => ({
        url: location.href,
        encryption: document.querySelector('#encryption-status')?.textContent,
        send: document.querySelector('#send-status')?.textContent,
      })).catch(() => ({})));
    }
  }
  throw error;
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
}
