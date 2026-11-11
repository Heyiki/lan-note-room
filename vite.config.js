import { defineConfig } from 'vite';
import { loadConfig } from './server/config.js';

const { host, port } = loadConfig();
export default defineConfig({ server: { host, port, strictPort: true } });
