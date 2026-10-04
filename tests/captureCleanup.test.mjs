import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptureCleanup } from '../dist-electron/electron/captureCleanup.js';

test('a second recording is aborted while the first cleanup is pending', async () => {
  const cleanups = new Map();
  const calls = [];
  const resolvers = new Map();
  const abort = (id) => {
    calls.push(id);
    return new Promise((resolve) => resolvers.set(id, resolve));
  };
  const first = createCaptureCleanup(cleanups, 'A', abort);
  assert.equal(createCaptureCleanup(cleanups, 'A', abort), first);
  const second = createCaptureCleanup(cleanups, 'B', abort);
  await Promise.resolve();
  assert.deepEqual(calls, ['A', 'B']);
  resolvers.get('B')();
  await second;
  assert.equal(cleanups.has('A'), true);
  assert.equal(cleanups.has('B'), false);
  resolvers.get('A')();
  await first;
  assert.equal(cleanups.size, 0);
});
