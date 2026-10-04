import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DRIVE_UPLOAD_CHUNK_BYTES,
  GoogleDriveService,
  isValidDriveWebViewLink,
  parseAcknowledgedRange,
  readChunkFully,
  validateUploadSessionUrl,
} from '../dist-electron/electron/googleDriveService.js';

const SESSION_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=test-session';
const FILE_ID = 'drive-file-123';

function response(status, payload, headers = {}) {
  return new Response(payload === undefined ? null : JSON.stringify(payload), { status, headers });
}

function header(init, name) {
  return new Headers(init.headers).get(name);
}

function metadata(name, bytes = 10) {
  return {
    id: FILE_ID,
    name,
    mimeType: 'video/webm',
    size: String(bytes),
    webViewLink: `https://drive.google.com/file/d/${FILE_ID}/view?usp=drivesdk`,
  };
}

async function createRecording(t, bytes = Buffer.from('0123456789')) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'onetake-drive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'temporary.webm');
  await writeFile(filePath, bytes);
  return { id: 'recording-id-1', path: filePath, sizeBytes: bytes.length, mimeType: 'video/webm' };
}

function tokenProvider() {
  let current = 'access-token';
  const invalidated = [];
  return {
    invalidated,
    getAccessToken: async () => current,
    invalidateAccessToken: (token) => {
      invalidated.push(token);
      current = 'refreshed-access-token';
    },
  };
}

test('resumable upload sends WebM metadata and returns validated Drive file details', async (t) => {
  const recording = await createRecording(t);
  const requests = [];
  const service = new GoogleDriveService(tokenProvider(), async (url, init) => {
    requests.push({ url: String(url), init });
    if (init.method === 'POST') {
      assert.equal(header(init, 'X-Upload-Content-Type'), 'video/webm');
      assert.equal(header(init, 'X-Upload-Content-Length'), '10');
      const body = JSON.parse(init.body);
      assert.equal(body.mimeType, 'video/webm');
      return response(200, undefined, { location: SESSION_URL });
    }
    assert.equal(init.method, 'PUT');
    assert.equal(header(init, 'Content-Range'), 'bytes 0-9/10');
    assert.equal(Buffer.from(init.body).toString(), '0123456789');
    return response(200, metadata(JSON.parse(requests[0].init.body).name));
  }, async () => {});
  const progress = [];

  const result = await service.upload(recording, (value) => progress.push(value));
  assert.equal(result.ok, true);
  assert.equal(result.fileId, FILE_ID);
  assert.equal(result.mimeType, 'video/webm');
  assert.equal(result.sizeBytes, 10);
  assert.match(result.name, /^Recording-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.webm$/);
  assert.equal(result.webViewLink, `https://drive.google.com/file/d/${FILE_ID}/view?usp=drivesdk`);
  assert.deepEqual(progress.map((item) => item.acknowledgedBytes), [0, 10]);
  assert.equal(requests[0].url, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size,webViewLink');
  assert.equal(requests[0].init.redirect, 'manual');
  assert.deepEqual(await readFile(recording.path), Buffer.from('0123456789'));
  const retry = await service.upload(recording, () => {});
  assert.equal(retry.fileId, result.fileId);
  assert.equal(requests.filter((item) => item.init.method === 'POST').length, 1);
  assert.equal(requests.some((item) => String(item.url).includes('/permissions')), false);
});

test('308 acknowledgement resumes from server-confirmed byte and reports acknowledged progress', async (t) => {
  const recording = await createRecording(t);
  const ranges = [];
  const progress = [];
  let name;
  const service = new GoogleDriveService(tokenProvider(), async (_url, init) => {
    if (init.method === 'POST') {
      name = JSON.parse(init.body).name;
      return response(200, undefined, { location: SESSION_URL });
    }
    ranges.push(header(init, 'Content-Range'));
    if (ranges.length === 1) return response(308, undefined, { range: 'bytes=0-3' });
    assert.equal(header(init, 'Content-Range'), 'bytes 4-9/10');
    assert.equal(Buffer.from(init.body).toString(), '456789');
    return response(201, metadata(name));
  }, async () => {});

  const result = await service.upload(recording, (value) => progress.push(value));
  assert.equal(result.fileId, FILE_ID);
  assert.deepEqual(ranges, ['bytes 0-9/10', 'bytes 4-9/10']);
  assert.deepEqual(progress.map((item) => item.acknowledgedBytes), [0, 4, 10]);
});

test('chunk read fills short reads until the requested byte range is complete', async () => {
  const contents = Buffer.from('short-read-loop');
  const fakeHandle = {
    async read(buffer, offset, length, position) {
      const bytesRead = Math.min(length, 3);
      contents.copy(buffer, offset, position, position + bytesRead);
      return { buffer, bytesRead };
    },
  };
  assert.deepEqual(await readChunkFully(fakeHandle, 2, 10), contents.subarray(2, 12));
});

test('multi-chunk upload uses exact Content-Range values and acknowledged progress', async (t) => {
  const totalBytes = DRIVE_UPLOAD_CHUNK_BYTES + 123;
  const content = Buffer.alloc(totalBytes, 0x61);
  const recording = await createRecording(t, content);
  const ranges = [];
  const progress = [];
  let name;
  const service = new GoogleDriveService(tokenProvider(), async (_url, init) => {
    if (init.method === 'POST') {
      name = JSON.parse(init.body).name;
      return response(200, undefined, { location: SESSION_URL });
    }
    const range = header(init, 'Content-Range');
    ranges.push(range);
    if (ranges.length === 1) {
      assert.equal(Buffer.from(init.body).length, DRIVE_UPLOAD_CHUNK_BYTES);
      assert.equal(range, `bytes 0-${DRIVE_UPLOAD_CHUNK_BYTES - 1}/${totalBytes}`);
      return response(308, undefined, { range: `bytes=0-${DRIVE_UPLOAD_CHUNK_BYTES - 1}` });
    }
    assert.equal(Buffer.from(init.body).length, 123);
    assert.equal(range, `bytes ${DRIVE_UPLOAD_CHUNK_BYTES}-${totalBytes - 1}/${totalBytes}`);
    return response(200, metadata(name, totalBytes));
  }, async () => {});

  const result = await service.upload(recording, (value) => progress.push(value));
  assert.equal(result.sizeBytes, totalBytes);
  assert.deepEqual(progress.map((item) => item.acknowledgedBytes), [0, DRIVE_UPLOAD_CHUNK_BYTES, totalBytes]);
  assert.equal(ranges.length, 2);
});

test('network interruption probes session status and resumes without opening another upload', async (t) => {
  const recording = await createRecording(t);
  let starts = 0;
  let sends = 0;
  const progress = [];
  let name;
  const service = new GoogleDriveService(tokenProvider(), async (_url, init) => {
    if (init.method === 'POST') {
      starts += 1;
      name = JSON.parse(init.body).name;
      return response(200, undefined, { location: SESSION_URL });
    }
    if (header(init, 'Content-Range') === 'bytes */10') return response(308, undefined, { range: 'bytes=0-3' });
    sends += 1;
    if (sends === 1) throw new Error('socket closed after partial server receipt');
    assert.equal(header(init, 'Content-Range'), 'bytes 4-9/10');
    return response(200, metadata(name));
  }, async () => {});
  const result = await service.upload(recording, (value) => progress.push(value));
  assert.equal(result.fileId, FILE_ID);
  assert.equal(starts, 1);
  assert.deepEqual(progress.map((item) => item.acknowledgedBytes), [0, 4, 10]);
});

test('401 refreshes the access token once before resuming the request', async (t) => {
  const recording = await createRecording(t);
  const auth = tokenProvider();
  const seenTokens = [];
  let first = true;
  let name;
  const service = new GoogleDriveService(auth, async (_url, init) => {
    seenTokens.push(new Headers(init.headers).get('Authorization'));
    if (init.method === 'POST' && first) {
      first = false;
      return response(401, {});
    }
    if (init.method === 'POST') {
      name = JSON.parse(init.body).name;
      return response(200, undefined, { location: SESSION_URL });
    }
    return response(200, metadata(name));
  }, async () => {});
  const result = await service.upload(recording, () => {});
  assert.equal(result.fileId, FILE_ID);
  assert.deepEqual(auth.invalidated, ['access-token']);
  assert.deepEqual(seenTokens.slice(0, 2), ['Bearer access-token', 'Bearer refreshed-access-token']);
});

test('expired refresh credentials surface auth failure without retrying or dropping the recording', async (t) => {
  const recording = await createRecording(t);
  const auth = {
    getAccessToken: async () => { throw new Error('INVALID_GRANT'); },
    invalidateAccessToken: () => {},
  };
  let requests = 0;
  const service = new GoogleDriveService(auth, async () => {
    requests += 1;
    return response(500, {});
  }, async () => {});
  await assert.rejects(service.upload(recording, () => {}), /INVALID_GRANT/);
  assert.equal(requests, 0);
  assert.deepEqual(await readFile(recording.path), Buffer.from('0123456789'));
});

test('transient session creation failures retry a bounded number of times', async (t) => {
  const recording = await createRecording(t);
  let name;
  let starts = 0;
  const service = new GoogleDriveService(tokenProvider(), async (_url, init) => {
    if (init.method === 'POST') {
      starts += 1;
      name = JSON.parse(init.body).name;
      if (starts < 3) return response(503, {});
      return response(200, undefined, { location: SESSION_URL });
    }
    return response(200, metadata(name));
  }, async () => {});
  const result = await service.upload(recording, () => {});
  assert.equal(result.fileId, FILE_ID);
  assert.equal(starts, 3);
});

test('Anyone link choice creates exactly an anyone reader permission', async (t) => {
  const recording = await createRecording(t);
  const requests = [];
  const service = new GoogleDriveService(tokenProvider(), async (url, init) => {
    requests.push({ url: String(url), init });
    if (init.method === 'POST' && String(url).includes('uploadType=resumable')) {
      const name = JSON.parse(init.body).name;
      requests[0].name = name;
      return response(200, undefined, { location: SESSION_URL });
    }
    if (header(init, 'Content-Range')) return response(200, metadata(requests[0].name));
    if (init.method === 'GET') return response(200, { permissions: [] });
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { type: 'anyone', role: 'reader' });
    assert.match(String(url), /\/permissions\?fields=id,type,role$/);
    return response(200, { id: 'permission-id', type: 'anyone', role: 'reader' });
  }, async () => {});

  const uploaded = await service.upload(recording, () => {});
  assert.equal(uploaded.sharing, 'private');
  const publicResult = await service.enableAnyoneLinkAccess(recording.id);
  assert.equal(publicResult.sharing, 'anyone');
  assert.equal(service.getUploadedResult(recording.id).sharing, 'anyone');
  assert.equal(requests.filter((item) => item.init.method === 'POST' && String(item.url).includes('/permissions')).length, 1);
});

test('failed permission grant retains private upload and retry enables sharing without another file upload', async (t) => {
  const recording = await createRecording(t);
  let uploadSessions = 0;
  let permissionAttempts = 0;
  let name;
  const service = new GoogleDriveService(tokenProvider(), async (url, init) => {
    if (init.method === 'POST' && String(url).includes('uploadType=resumable')) {
      uploadSessions += 1;
      name = JSON.parse(init.body).name;
      return response(200, undefined, { location: SESSION_URL });
    }
    if (header(init, 'Content-Range')) return response(200, metadata(name));
    if (init.method === 'GET') return response(200, { permissions: [] });
    permissionAttempts += 1;
    if (permissionAttempts === 1) return response(400, {});
    return response(200, { id: 'permission-id', type: 'anyone', role: 'reader' });
  }, async () => {});

  const uploaded = await service.upload(recording, () => {});
  await assert.rejects(service.enableAnyoneLinkAccess(recording.id), /SHARING_FAILED/);
  assert.equal(service.getUploadedResult(recording.id).fileId, FILE_ID);
  assert.equal(service.getUploadedResult(recording.id).sharing, 'private');
  assert.deepEqual(await readFile(recording.path), Buffer.from('0123456789'));
  const publicResult = await service.enableAnyoneLinkAccess(recording.id);
  assert.equal(publicResult.sharing, 'anyone');
  assert.equal(uploadSessions, 1);
  assert.equal(uploaded.fileId, publicResult.fileId);
});

test('permission retry detects an already-created anyone reader and avoids duplicate permissions', async (t) => {
  const recording = await createRecording(t);
  let name;
  let creates = 0;
  const service = new GoogleDriveService(tokenProvider(), async (url, init) => {
    if (init.method === 'POST' && String(url).includes('uploadType=resumable')) {
      name = JSON.parse(init.body).name;
      return response(200, undefined, { location: SESSION_URL });
    }
    if (header(init, 'Content-Range')) return response(200, metadata(name));
    if (init.method === 'GET') return response(200, { permissions: [{ id: 'already-there', type: 'anyone', role: 'reader' }] });
    creates += 1;
    return response(200, { id: 'unexpected', type: 'anyone', role: 'reader' });
  }, async () => {});

  await service.upload(recording, () => {});
  assert.equal((await service.enableAnyoneLinkAccess(recording.id)).sharing, 'anyone');
  assert.equal(creates, 0);
});

test('concurrent sharing retries share one permission operation', async (t) => {
  const recording = await createRecording(t);
  let name;
  let listCalls = 0;
  let createCalls = 0;
  let releaseCreate;
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  const service = new GoogleDriveService(tokenProvider(), async (url, init) => {
    if (init.method === 'POST' && String(url).includes('uploadType=resumable')) {
      name = JSON.parse(init.body).name;
      return response(200, undefined, { location: SESSION_URL });
    }
    if (header(init, 'Content-Range')) return response(200, metadata(name));
    if (init.method === 'GET') {
      listCalls += 1;
      return response(200, { permissions: [] });
    }
    createCalls += 1;
    await createGate;
    return response(200, { id: 'permission-id', type: 'anyone', role: 'reader' });
  }, async () => {});

  await service.upload(recording, () => {});
  const first = service.enableAnyoneLinkAccess(recording.id);
  const second = service.enableAnyoneLinkAccess(recording.id);
  assert.equal(first, second);
  releaseCreate();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.sharing, 'anyone');
  assert.equal(right.sharing, 'anyone');
  assert.equal(listCalls, 1);
  assert.equal(createCalls, 1);
});

test('403 policy rejection explains that anyone link sharing is not allowed', async (t) => {
  const recording = await createRecording(t);
  let name;
  const service = new GoogleDriveService(tokenProvider(), async (url, init) => {
    if (init.method === 'POST' && String(url).includes('uploadType=resumable')) {
      name = JSON.parse(init.body).name;
      return response(200, undefined, { location: SESSION_URL });
    }
    if (header(init, 'Content-Range')) return response(200, metadata(name));
    if (init.method === 'GET') return response(200, { permissions: [] });
    return response(403, { error: { message: 'policy' } });
  }, async () => {});
  await service.upload(recording, () => {});
  await assert.rejects(service.enableAnyoneLinkAccess(recording.id), (error) => error.code === 'POLICY_REJECTED');
  assert.equal(service.getUploadedResult(recording.id).sharing, 'private');
});

test('link validation accepts only the returned file link for Google Drive', () => {
  const valid = `https://drive.google.com/file/d/${FILE_ID}/view?usp=drivesdk`;
  assert.equal(isValidDriveWebViewLink(valid, FILE_ID), true);
  assert.equal(isValidDriveWebViewLink('https://evil.example/file/d/drive-file-123', FILE_ID), false);
  assert.equal(isValidDriveWebViewLink(`https://drive.google.com/file/d/another-id/view`, FILE_ID), false);
  assert.equal(isValidDriveWebViewLink(`javascript:alert(1)`, FILE_ID), false);
});

test('uncertain final response probes status and recovers completion metadata', async (t) => {
  const recording = await createRecording(t);
  let name;
  const service = new GoogleDriveService(tokenProvider(), async (_url, init) => {
    if (init.method === 'POST') {
      name = JSON.parse(init.body).name;
      return response(200, undefined, { location: SESSION_URL });
    }
    if (header(init, 'Content-Range') === 'bytes */10') return response(201, metadata(name));
    throw new Error('connection reset after server received final chunk');
  }, async () => {});
  const result = await service.upload(recording, () => {});
  assert.equal(result.fileId, FILE_ID);
  assert.equal(result.name, name);
});

test('transient upload failure keeps session for safe retry and never starts a duplicate session', async (t) => {
  const recording = await createRecording(t);
  let starts = 0;
  let failedAttempt = true;
  let name;
  const service = new GoogleDriveService(tokenProvider(), async (_url, init) => {
    if (init.method === 'POST') {
      starts += 1;
      name = JSON.parse(init.body).name;
      return response(200, undefined, { location: SESSION_URL });
    }
    if (failedAttempt) throw new Error('offline');
    return response(200, metadata(name));
  }, async () => {});
  await assert.rejects(service.upload(recording, () => {}), /could not confirm upload progress/);
  failedAttempt = false;
  const result = await service.upload(recording, () => {});
  assert.equal(result.fileId, FILE_ID);
  assert.equal(starts, 1);
});

test('upload session and Drive result URLs reject untrusted origins', () => {
  assert.equal(validateUploadSessionUrl(SESSION_URL), new URL(SESSION_URL).toString());
  assert.equal(validateUploadSessionUrl('http://www.googleapis.com/upload/drive/v3/files?upload_id=x'), null);
  assert.equal(validateUploadSessionUrl('https://evil.example/upload/drive/v3/files?upload_id=x'), null);
  assert.equal(parseAcknowledgedRange('bytes=0-3', 10), 4);
  assert.equal(parseAcknowledgedRange('bytes=0-99', 10), null);
});
