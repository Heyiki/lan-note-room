import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';

export function loadConfig(envFile = new URL('../.env', import.meta.url), env = process.env) {
  let fileEnv = {};
  try {
    fileEnv = parse(readFileSync(envFile));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const portText = env.PORT ?? fileEnv.PORT ?? '8181';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT 必须是 1 至 65535 之间的整数');
  }
  const capacity = key => {
    const value = env[key] ?? fileEnv[key] ?? '100';
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error(`${key} 必须是正整数，且不能超出 JavaScript 安全整数范围`);
    }
    return parsed;
  };
  return {
    host: env.HOST ?? fileEnv.HOST ?? '0.0.0.0', port,
    maxEncryptedMembers: capacity('MAX_ENCRYPTED_MEMBERS'),
    maxPlainMembers: capacity('MAX_PLAIN_MEMBERS'),
  };
}
