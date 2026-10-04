import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  atomicCopyRecording,
  createRecordingFilename,
  ensureWebMExtension,
} from '../dist-electron/electron/recordingSaveService.js';

test('filename uses local date and time at second precision', () => {
  const date = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(createRecordingFilename(date), 'Recording-2026-01-02-03-04-05.webm');
});

test('destination always has a WebM suffix without changing existing casing', () => {
  assert.equal(ensureWebMExtension('/tmp/Recording'), '/tmp/Recording.webm');
  assert.equal(ensureWebMExtension('/tmp/Recording.WEBM'), '/tmp/Recording.WEBM');
});

test('atomic copy preserves source and publishes a byte-identical finalized file', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'onetake-save-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.webm');
  const destination = path.join(directory, 'folder', 'saved.webm');
  await mkdir(path.dirname(destination));
  const content = Buffer.from('test webm payload');
  await writeFile(source, content);

  assert.equal(await atomicCopyRecording(source, destination, content.byteLength), content.byteLength);
  assert.deepEqual(await readFile(destination), content);
  assert.deepEqual(await readFile(source), content);
  assert.deepEqual(await readdir(path.dirname(destination)), ['saved.webm']);
});

test('failed copy leaves a preexisting destination untouched and removes staging file', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'onetake-save-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.webm');
  const destination = path.join(directory, 'saved.webm');
  const original = Buffer.from('existing user file');
  await writeFile(source, 'new recording');
  await writeFile(destination, original);

  await assert.rejects(atomicCopyRecording(source, destination, 999));
  assert.deepEqual(await readFile(destination), original);
  assert.deepEqual((await readdir(directory)).sort(), ['saved.webm', 'source.webm']);
});

test('extension-adjusted destination refuses overwrite when the final WebM path exists', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'onetake-save-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.webm');
  const finalDestination = path.join(directory, 'Recording.webm');
  const original = Buffer.from('existing unconfirmed file');
  await writeFile(source, 'new recording');
  await writeFile(finalDestination, original);

  // The dialog returned "Recording" and the app appended .webm, so overwrite
  // was not confirmed for this final path. Exclusive atomic publication must
  // fail rather than replace it.
  await assert.rejects(
    atomicCopyRecording(source, finalDestination, Buffer.byteLength('new recording'), false),
    { code: 'EEXIST' },
  );
  assert.deepEqual(await readFile(finalDestination), original);
  assert.deepEqual((await readdir(directory)).sort(), ['Recording.webm', 'source.webm']);
});
