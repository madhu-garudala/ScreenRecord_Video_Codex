import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { packager } from '@electron/packager';

const execFileAsync = promisify(execFile);

if (process.platform !== 'darwin') throw new Error('The macOS package must be built on a Mac.');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staging = path.join(root, '.packaging');
const release = path.join(root, 'release');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const electronJson = JSON.parse(await readFile(path.join(root, 'node_modules/electron/package.json'), 'utf8'));
const zipName = `electron-v${electronJson.version}-darwin-${process.arch}.zip`;
const cacheRoot = process.env.ELECTRON_CACHE || path.join(os.homedir(), 'Library/Caches/electron');
let electronZipDir;
for (const entry of await readdir(cacheRoot, { withFileTypes: true }).catch(() => [])) {
  if (!entry.isDirectory()) continue;
  const files = await readdir(path.join(cacheRoot, entry.name)).catch(() => []);
  if (files.includes(zipName)) {
    electronZipDir = path.join(cacheRoot, entry.name);
    break;
  }
}

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
try {
  await cp(path.join(root, 'dist'), path.join(staging, 'dist'), { recursive: true });
  await cp(path.join(root, 'dist-electron'), path.join(staging, 'dist-electron'), { recursive: true });
  await writeFile(path.join(staging, 'package.json'), JSON.stringify({
    name: packageJson.name,
    productName: packageJson.productName,
    version: packageJson.version,
    private: true,
    main: packageJson.main,
  }, null, 2));

  const output = await packager({
    dir: staging,
    out: release,
    name: packageJson.productName,
    platform: 'darwin',
    arch: process.arch,
    electronVersion: electronJson.version,
    ...(electronZipDir ? { electronZipDir } : {}),
    appBundleId: 'com.madhugarudala.onetake',
    icon: path.join(root, 'assets/logo.icns'),
    asar: true,
    overwrite: true,
    osxSign: false,
    extendInfo: {
      NSMicrophoneUsageDescription: 'OneTake records microphone audio only when you enable a microphone for a screen recording.',
    },
  });
  for (const appPath of output) {
    const appBundle = path.join(appPath, `${packageJson.productName}.app`);
    // Electron's downloaded binary carries a partial signature after it is
    // repackaged. Re-sign locally so the bundle verifies; this is not a
    // Developer ID signature and does not notarize it for distribution.
    await execFileAsync('codesign', ['--force', '--deep', '--sign', '-', appBundle]);
    await execFileAsync('codesign', ['--verify', '--deep', '--strict', appBundle]);
    process.stdout.write(`Packaged locally signed app: ${appBundle}\n`);
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
