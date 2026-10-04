import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LEGACY_USER_DATA_FOLDER, migrateUserDataDirectory } from '../dist-electron/electron/userDataMigration.js';

test('moves legacy recordings and OAuth token into the OneTake profile', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'onetake-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, LEGACY_USER_DATA_FOLDER);
  await mkdir(legacy);
  await writeFile(path.join(legacy, 'google-token.json'), 'encrypted-token');
  migrateUserDataDirectory(root, path.join(root, 'OneTake'));
  assert.equal(await readFile(path.join(root, 'OneTake', 'google-token.json'), 'utf8'), 'encrypted-token');
  await assert.rejects(stat(legacy), { code: 'ENOENT' });
});

test('keeps existing new settings and copies only missing legacy files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'onetake-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, LEGACY_USER_DATA_FOLDER);
  const current = path.join(root, 'OneTake');
  await Promise.all([mkdir(legacy), mkdir(current)]);
  await writeFile(path.join(legacy, 'google-token.json'), 'old-token');
  await writeFile(path.join(current, 'google-token.json'), 'new-token');
  await writeFile(path.join(legacy, 'google-oauth-client.json'), 'client');
  migrateUserDataDirectory(root, current);
  assert.equal(await readFile(path.join(current, 'google-token.json'), 'utf8'), 'new-token');
  assert.equal(await readFile(path.join(current, 'google-oauth-client.json'), 'utf8'), 'client');
  assert.equal(await readFile(path.join(legacy, 'google-token.json'), 'utf8'), 'old-token');
});
