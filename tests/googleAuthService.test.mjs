import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createOAuthState,
  createPkcePair,
  DRIVE_FILE_SCOPE,
  GoogleAuthService,
} from '../dist-electron/electron/googleAuthService.js';

function createSecureStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`test:${value}`),
    decryptString: (value) => value.toString().slice('test:'.length),
  };
}

class MockLoopbackServer extends EventEmitter {
  listen(_port, _host, callback) { setImmediate(callback); }
  address() { return { port: 41234 }; }
  close(callback) { this.emit('close'); callback?.(); }
}

function emitCallback(server, authorizationUrl, mismatchState = false) {
  const url = new URL(authorizationUrl);
  const callback = new URL(url.searchParams.get('redirect_uri'));
  callback.searchParams.set('code', 'one-time-code');
  callback.searchParams.set('state', mismatchState ? 'wrong-state' : url.searchParams.get('state'));
  const response = {
    statusCode: 0,
    writeHead(statusCode) { this.statusCode = statusCode; return this; },
    end() { return this; },
  };
  server.emit('request', { method: 'GET', url: `${callback.pathname}${callback.search}` }, response);
  return response;
}

test('PKCE challenge is S256 and OAuth state is high entropy', () => {
  const { verifier, challenge } = createPkcePair();
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.ok(verifier.length >= 43);
  assert.notEqual(createOAuthState(), createOAuthState());
});

test('connect uses only drive.file and persists encrypted refresh token for later refresh', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'local-loom-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenPath = path.join(directory, 'refresh.json');
  const secureStorage = createSecureStorage();
  const loopbackServer = new MockLoopbackServer();
  let tokenRequests = 0;
  const fetcher = async (_url, init) => {
    tokenRequests += 1;
    const body = new URLSearchParams(init.body);
    if (body.get('grant_type') === 'authorization_code') {
      return new Response(JSON.stringify({ access_token: 'short-lived-token', expires_in: 3600, refresh_token: 'secret-refresh-token' }), { status: 200 });
    }
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'secret-refresh-token');
    await new Promise((resolve) => setTimeout(resolve, 25));
    return new Response(JSON.stringify({ access_token: 'refreshed-token', expires_in: 3600 }), { status: 200 });
  };
  const service = new GoogleAuthService('client-id', tokenPath, secureStorage, fetcher, async (url) => {
    const authorization = new URL(url);
    assert.equal(authorization.searchParams.get('scope'), DRIVE_FILE_SCOPE);
    assert.equal(authorization.searchParams.get('access_type'), 'offline');
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    emitCallback(loopbackServer, url);
  }, () => loopbackServer);

  const connected = await service.connect();
  assert.equal(connected.connected, true);
  const stored = await readFile(tokenPath, 'utf8');
  assert.ok(!stored.includes('secret-refresh-token'));

  const relaunchedService = new GoogleAuthService('client-id', tokenPath, secureStorage, fetcher);
  assert.equal((await relaunchedService.status()).connected, true);
  assert.deepEqual(await Promise.all([relaunchedService.getAccessToken(), relaunchedService.getAccessToken()]), ['refreshed-token', 'refreshed-token']);
  assert.equal(tokenRequests, 2);
});

test('secure storage unavailable fails closed without launching the browser', async () => {
  let browserOpened = false;
  const service = new GoogleAuthService('client-id', '/unused/token', createSecureStorage(false), fetch, async () => { browserOpened = true; });
  await assert.rejects(service.connect(), /STORAGE_UNAVAILABLE/);
  assert.equal(browserOpened, false);
  assert.deepEqual(await service.status(), { configured: true, connected: false, secureStorageAvailable: false });
});

test('callback state mismatch is rejected without exchanging the authorization code', async () => {
  let exchangeCalls = 0;
  const loopbackServer = new MockLoopbackServer();
  const service = new GoogleAuthService('client-id', '/unused/token', createSecureStorage(), async () => {
    exchangeCalls += 1;
    return new Response('{}', { status: 500 });
  }, async (url) => { emitCallback(loopbackServer, url, true); }, () => loopbackServer);
  await assert.rejects(service.connect(), /STATE_MISMATCH/);
  assert.equal(exchangeCalls, 0);
});

test('browser launch failure closes the callback listener and settles its promise', async () => {
  const loopbackServer = new MockLoopbackServer();
  const service = new GoogleAuthService('client-id', '/unused/token', createSecureStorage(), fetch, async () => {
    throw new Error('browser unavailable');
  }, () => loopbackServer);
  await assert.rejects(service.connect(), /browser unavailable/);
});

test('invalid_grant clears encrypted credentials and reports reconnect state', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'local-loom-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenPath = path.join(directory, 'refresh.json');
  const secureStorage = createSecureStorage();
  await writeFile(tokenPath, JSON.stringify({ version: 1, ciphertext: secureStorage.encryptString('revoked').toString('base64') }));
  const service = new GoogleAuthService('client-id', tokenPath, secureStorage, async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
  await assert.rejects(service.getAccessToken(), /INVALID_GRANT/);
  assert.deepEqual(await service.status(), { configured: true, connected: false, secureStorageAvailable: true });
  await assert.rejects(readFile(tokenPath), { code: 'ENOENT' });
});

test('stored credentials do not report connected or refresh without a configured client ID', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'local-loom-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenPath = path.join(directory, 'refresh.json');
  const secureStorage = createSecureStorage();
  await writeFile(tokenPath, JSON.stringify({ version: 1, ciphertext: secureStorage.encryptString('saved-refresh').toString('base64') }));
  let fetchCalls = 0;
  const service = new GoogleAuthService(null, tokenPath, secureStorage, async () => {
    fetchCalls += 1;
    return new Response('{}', { status: 500 });
  });

  assert.deepEqual(await service.status(), { configured: false, connected: false, secureStorageAvailable: true });
  await assert.rejects(service.getAccessToken(), /NOT_CONFIGURED/);
  assert.equal(fetchCalls, 0);
});
