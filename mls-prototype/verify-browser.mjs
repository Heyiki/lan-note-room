import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { createProbeServer } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || 'playwright');
const address = Object.values(networkInterfaces()).flat()
  .find(item => item.family === 'IPv4' && !item.internal
    && !item.address.startsWith('169.254.'))?.address;
assert(address, 'A non-loopback IPv4 address is needed for actual LAN HTTP testing');
const server = createProbeServer();
let browser;
try {
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  const url = `http://${address}:${server.address().port}/`;
  console.log(`Temporary probe: ${url}`);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const bindingResponse = page.waitForResponse(response =>
      response.url().endsWith('/pkg/lan_chat_mls_prototype.js'));
    await page.goto(url);
    assert.equal((await bindingResponse).status(), 200, 'generated MLS binding must exist');
    await page.waitForFunction(() => window.prototypeResult !== undefined, null, { timeout: 15000 });
    const result = await page.evaluate(() => window.prototypeResult);
    console.log(JSON.stringify({ viewport, result, errors }));
    await page.screenshot({
      path: new URL(`browser/result-${viewport.width}.png`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      fullPage: true,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.checks.length, 6);
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
