import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const devUserDataDirectory = path.join(os.homedir(), 'Library', 'Application Support', 'onetake-dev');
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
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  if (electronProcess && electronProcess.exitCode === null) {
    electronProcess.kill('SIGTERM');
    const forceQuit = setTimeout(() => electronProcess?.kill('SIGKILL'), 2000);
    electronProcess.once('exit', () => clearTimeout(forceQuit));
  }
  await server.close();
}

const server = await createServer({ configFile: path.join(root, 'vite.config.mts') });
try {
  execFileSync(npmBin, ['exec', '--', 'tsc', '-p', 'tsconfig.electron.json'], { cwd: root, stdio: 'inherit' });
  await server.listen();
  const electronBin = createRequire(import.meta.url)('electron');
  mkdirSync(devUserDataDirectory, { recursive: true, mode: 0o700 });
  electronProcess = spawn(electronBin, ['dist-electron/electron/main.js', `--user-data-dir=${devUserDataDirectory}`], {
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
