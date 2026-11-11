import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = fileURLToPath(new URL(
  'tools/wasm-bindgen-0.2.100-x86_64-pc-windows-msvc/wasm-bindgen.exe', import.meta.url));
const bindingTool = process.env.MLS_WASM_BINDGEN || (existsSync(local) ? local : 'wasm-bindgen');
for (const [command, args] of [
  ['cargo', ['build', '--locked', '--manifest-path', 'mls-prototype/Cargo.toml',
    '--target', 'wasm32-unknown-unknown', '--release']],
  [bindingTool, ['--target', 'web', '--out-dir', 'src/mls-wasm',
    'mls-prototype/target/wasm32-unknown-unknown/release/lan_chat_mls_prototype.wasm']],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
