import assert from 'node:assert/strict';
import test from 'node:test';
import { isDisplayCapturePermitted } from '../dist-electron/electron/capturePermission.js';

test('display capture remains permitted while the granted stream is being delivered', () => {
  assert.equal(isDisplayCapturePermitted('awaiting-stream'), true);
  assert.equal(isDisplayCapturePermitted('stream-granted'), true);
  assert.equal(isDisplayCapturePermitted('recording'), false);
  assert.equal(isDisplayCapturePermitted(null), false);
});
