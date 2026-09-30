import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
if (existsSync(envPath)) {
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^GOOGLE_OAUTH_CLIENT_ID\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || process.env.GOOGLE_OAUTH_CLIENT_ID) continue;
    const value = match[1].replace(/^(?:"([^"]*)"|'([^']*)')$/, (_whole, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
    process.env.GOOGLE_OAUTH_CLIENT_ID = value;
  }
}
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let electronProcess;

async function stop() {
  if (electronProcess && !electronProcess.killed) electronProcess.kill('SIGTERM');
  await server.close();
}

const server = await createServer({ configFile: path.join(root, 'vite.config.mts') });
try {
  execFileSync(npmBin, ['exec', '--', 'tsc', '-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' });
  await server.listen();
  const electronBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  electronProcess = spawn(electronBin, ['dist-electron/electron/main.js'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' },
  });
  electronProcess.on('exit', async (code) => {
    await stop();
    process.exit(code ?? 0);
  });
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
} catch (error) {
  await server.close();
  throw error;
}
