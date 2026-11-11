import http from 'node:http';
import { readFile } from 'node:fs/promises';

const files = new Map([
  ['/', ['browser/index.html', 'text/html']],
  ['/browser/check.js', ['browser/check.js', 'text/javascript']],
  ['/pkg/lan_chat_mls_prototype.js', ['pkg/lan_chat_mls_prototype.js', 'text/javascript']],
  ['/pkg/lan_chat_mls_prototype_bg.wasm', ['pkg/lan_chat_mls_prototype_bg.wasm', 'application/wasm']],
]);

export function createProbeServer() {
  return http.createServer(async (req, res) => {
    const file = files.get(new URL(req.url, 'http://probe').pathname);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    try {
      const data = await readFile(new URL(file[0], import.meta.url));
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
}
