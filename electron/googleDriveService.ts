import { open, stat, type FileHandle } from 'node:fs/promises';
import type { FinalizedRecording } from './recordingStore';
import { createRecordingFilename } from './recordingSaveService';
import type { DriveUploadProgress, DriveUploadResult } from '../shared/googleDriveTypes';

export const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
export const DRIVE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const TRANSIENT_RETRIES = 3;
const MAX_NO_PROGRESS_RETRIES = 3;

export interface DriveTokenProvider {
  getAccessToken(): Promise<string>;
  invalidateAccessToken(token: string): void;
}

interface UploadSession {
  uri: string;
  recordingId: string;
  name: string;
  totalBytes: number;
  acknowledgedBytes: number;
  result: DriveUploadResult | null;
}

interface DriveMetadata {
  id?: unknown;
  name?: unknown;
  mimeType?: unknown;
  size?: unknown;
  webViewLink?: unknown;
}

export class DriveUploadError extends Error {
  constructor(readonly code: 'UPLOAD_FAILED' | 'UPLOAD_STATE_UNKNOWN' | 'UPLOAD_BUSY', message: string = code) {
    super(message);
    this.name = 'DriveUploadError';
  }
}

export class DriveShareError extends Error {
  constructor(readonly code: 'NOT_UPLOADED' | 'SHARING_FAILED' | 'POLICY_REJECTED', message = code) {
    super(message);
    this.name = 'DriveShareError';
  }
}

export class GoogleDriveService {
  private readonly sessions = new Map<string, UploadSession>();
  private readonly sharingInFlight = new Map<string, Promise<DriveUploadResult>>();
  private uploadActive = false;

  constructor(
    private readonly tokenProvider: DriveTokenProvider,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async upload(
    recording: FinalizedRecording,
    onProgress: (progress: DriveUploadProgress) => void,
  ): Promise<DriveUploadResult> {
    if (this.uploadActive) throw new DriveUploadError('UPLOAD_BUSY');
    this.uploadActive = true;
    try {
      const cached = this.sessions.get(recording.id);
      if (cached?.result) return cached.result;
      if (recording.mimeType !== 'video/webm' || !Number.isSafeInteger(recording.sizeBytes) || recording.sizeBytes <= 0) {
        throw new DriveUploadError('UPLOAD_FAILED', 'The finalized WebM recording is invalid.');
      }
      const fileInfo = await stat(recording.path);
      if (!fileInfo.isFile() || fileInfo.size !== recording.sizeBytes) {
        throw new DriveUploadError('UPLOAD_FAILED', 'The finalized recording changed before upload.');
      }

      const session = cached ?? await this.startSession(recording);
      if (session.recordingId !== recording.id || session.totalBytes !== recording.sizeBytes) {
        throw new DriveUploadError('UPLOAD_STATE_UNKNOWN', 'The previous upload state no longer matches this recording.');
      }
      this.sessions.set(recording.id, session);
      onProgress({ recordingId: recording.id, acknowledgedBytes: session.acknowledgedBytes, totalBytes: session.totalBytes });

      const handle = await open(recording.path, 'r');
      try {
        let noProgressCount = 0;
        while (session.acknowledgedBytes < session.totalBytes) {
          const start = session.acknowledgedBytes;
          const chunkLength = Math.min(DRIVE_UPLOAD_CHUNK_BYTES, session.totalBytes - start);
          const chunk = await readChunkFully(handle, start, chunkLength);

          let response: Response;
          try {
            response = await this.authorizedRequest(session.uri, {
              method: 'PUT',
              redirect: 'manual',
              signal: AbortSignal.timeout(60_000),
              headers: {
                'Content-Type': 'video/webm',
                'Content-Length': String(chunkLength),
                'Content-Range': `bytes ${start}-${start + chunkLength - 1}/${session.totalBytes}`,
              },
              body: chunk as unknown as BodyInit,
            });
          } catch (error) {
            if (isAuthFailure(error)) throw error;
            const recovered = await this.recoverSession(session, onProgress);
            if (recovered) return recovered;
            noProgressCount = session.acknowledgedBytes === start ? noProgressCount + 1 : 0;
            if (noProgressCount > MAX_NO_PROGRESS_RETRIES) throw new DriveUploadError('UPLOAD_STATE_UNKNOWN', 'Drive has not confirmed how many bytes were received. Retry to resume safely.');
            await this.sleep(200 * 2 ** (noProgressCount - 1));
            continue;
          }

          if (response.status === 308) {
            const acknowledged = parseAcknowledgedRange(response.headers.get('range'), session.totalBytes);
            if (acknowledged === null || acknowledged < start) {
              throw new DriveUploadError('UPLOAD_STATE_UNKNOWN', 'Drive returned an invalid upload position. Retry to check the saved progress.');
            }
            if (acknowledged === start) noProgressCount += 1;
            else noProgressCount = 0;
            if (noProgressCount > MAX_NO_PROGRESS_RETRIES) {
              throw new DriveUploadError('UPLOAD_STATE_UNKNOWN', 'Drive has not confirmed upload progress. Retry to resume safely.');
            }
            if (acknowledged === start) await this.sleep(200 * 2 ** (noProgressCount - 1));
            session.acknowledgedBytes = acknowledged;
            onProgress({ recordingId: recording.id, acknowledgedBytes: acknowledged, totalBytes: session.totalBytes });
            continue;
          }
          if (response.status === 200 || response.status === 201) {
            return await this.completeSession(session, response, onProgress);
          }
          if (response.status === 429 || response.status >= 500) {
            const recovered = await this.recoverSession(session, onProgress);
            if (recovered) return recovered;
            noProgressCount = session.acknowledgedBytes === start ? noProgressCount + 1 : 0;
            if (noProgressCount > MAX_NO_PROGRESS_RETRIES) throw new DriveUploadError('UPLOAD_STATE_UNKNOWN', 'Drive has not confirmed upload progress. Retry to resume safely.');
            await this.sleep(200 * 2 ** (noProgressCount - 1));
            continue;
          }
          if (response.status === 404 || response.status === 410) {
            throw new DriveUploadError('UPLOAD_STATE_UNKNOWN', 'Drive no longer recognizes this upload session. Check your Drive before starting another upload.');
          }
          if (response.status === 401) throw new Error('DRIVE_AUTH_REJECTED');
          throw new DriveUploadError('UPLOAD_FAILED', `Drive rejected the upload (${response.status}).`);
        }

        const recovered = await this.recoverSession(session, onProgress);
        if (recovered) return recovered;
        throw new DriveUploadError('UPLOAD_STATE_UNKNOWN', 'Drive has not confirmed whether the upload completed. Retry to check its status.');
      } finally {
        await handle.close();
      }
    } finally {
      this.uploadActive = false;
    }
  }

  private async startSession(recording: FinalizedRecording): Promise<UploadSession> {
    const name = createRecordingFilename();
    const url = `${DRIVE_UPLOAD_BASE}/files?uploadType=resumable&fields=id,name,mimeType,size,webViewLink`;
    let response: Response | null = null;
    for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt += 1) {
      if (attempt > 0) await this.sleep(200 * 2 ** (attempt - 1));
      try {
        response = await this.authorizedRequest(url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': 'video/webm',
            'X-Upload-Content-Length': String(recording.sizeBytes),
          },
          body: JSON.stringify({ name, mimeType: 'video/webm' }),
        });
      } catch (error) {
        if (error instanceof DriveUploadError || isAuthFailure(error) || attempt === TRANSIENT_RETRIES) throw error;
        continue;
      }
      if (response.status !== 429 && response.status < 500) break;
      if (attempt === TRANSIENT_RETRIES) break;
    }
    if (!response) throw new DriveUploadError('UPLOAD_FAILED', 'Drive could not start the upload. Check your connection and retry.');
    if (!response.ok) {
      if (response.status === 401) throw new Error('DRIVE_AUTH_REJECTED');
      throw new DriveUploadError('UPLOAD_FAILED', `Drive could not start the upload (${response.status}).`);
    }
    const location = response.headers.get('location');
    const safeLocation = validateUploadSessionUrl(location);
    if (!safeLocation) throw new DriveUploadError('UPLOAD_FAILED', 'Drive returned an invalid resumable upload location.');
    return {
      uri: safeLocation,
      recordingId: recording.id,
      name,
      totalBytes: recording.sizeBytes,
      acknowledgedBytes: 0,
      result: null,
    };
  }

  forgetRecording(recordingId: string): void {
    this.sessions.delete(recordingId);
  }

  getUploadedResult(recordingId: string): DriveUploadResult | null {
    return this.sessions.get(recordingId)?.result ?? null;
  }

  enableAnyoneLinkAccess(recordingId: string): Promise<DriveUploadResult> {
    const existing = this.sharingInFlight.get(recordingId);
    if (existing) return existing;
    const operation = this.enableAnyoneLinkAccessOnce(recordingId);
    this.sharingInFlight.set(recordingId, operation);
    void operation.then(
      () => { if (this.sharingInFlight.get(recordingId) === operation) this.sharingInFlight.delete(recordingId); },
      () => { if (this.sharingInFlight.get(recordingId) === operation) this.sharingInFlight.delete(recordingId); },
    );
    return operation;
  }

  private async enableAnyoneLinkAccessOnce(recordingId: string): Promise<DriveUploadResult> {
    const session = this.sessions.get(recordingId);
    if (!session?.result) throw new DriveShareError('NOT_UPLOADED');
    if (session.result.sharing === 'anyone') return session.result;

    const permissionsUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(session.result.fileId)}/permissions`;
    for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt += 1) {
      if (attempt > 0) await this.sleep(200 * 2 ** (attempt - 1));
      let listResponse: Response;
      try {
        listResponse = await this.authorizedRequest(`${permissionsUrl}?fields=permissions(id,type,role)`, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        if (isAuthFailure(error)) throw error;
        if (attempt === TRANSIENT_RETRIES) throw new DriveShareError('SHARING_FAILED');
        continue;
      }
      if (listResponse.status === 429 || listResponse.status >= 500) continue;
      if (!listResponse.ok) {
        if (listResponse.status === 403) throw new DriveShareError('POLICY_REJECTED');
        throw new DriveShareError('SHARING_FAILED');
      }

      let permissions: Array<{ type?: unknown; role?: unknown }>;
      try {
        const body = await listResponse.json() as { permissions?: Array<{ type?: unknown; role?: unknown }> };
        permissions = Array.isArray(body.permissions) ? body.permissions : [];
      } catch {
        throw new DriveShareError('SHARING_FAILED');
      }
      if (permissions.some((permission) => permission.type === 'anyone' && permission.role === 'reader')) {
        session.result = { ...session.result, sharing: 'anyone' };
        return session.result;
      }

      let createResponse: Response;
      try {
        createResponse = await this.authorizedRequest(`${permissionsUrl}?fields=id,type,role`, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
          headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({ type: 'anyone', role: 'reader' }),
        });
      } catch (error) {
        if (isAuthFailure(error)) throw error;
        if (attempt === TRANSIENT_RETRIES) throw new DriveShareError('SHARING_FAILED');
        continue;
      }
      if (createResponse.status === 429 || createResponse.status >= 500) continue;
      if (createResponse.status === 403) throw new DriveShareError('POLICY_REJECTED');
      if (!createResponse.ok) throw new DriveShareError('SHARING_FAILED');
      try {
        const permission = await createResponse.json() as { type?: unknown; role?: unknown };
        if (permission.type !== 'anyone' || permission.role !== 'reader') throw new Error('Unexpected permission.');
      } catch {
        // A missing or malformed response may follow a successful create. The
        // next retry lists permissions first so it will not create duplicates.
        if (attempt === TRANSIENT_RETRIES) throw new DriveShareError('SHARING_FAILED');
        continue;
      }
      session.result = { ...session.result, sharing: 'anyone' };
      return session.result;
    }
    throw new DriveShareError('SHARING_FAILED');
  }

  private async recoverSession(
    session: UploadSession,
    onProgress: (progress: DriveUploadProgress) => void,
  ): Promise<DriveUploadResult | null> {
    for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt += 1) {
      if (attempt > 0) await this.sleep(200 * 2 ** (attempt - 1));
      let response: Response;
      try {
        response = await this.authorizedRequest(session.uri, {
          method: 'PUT',
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
          headers: {
            'Content-Length': '0',
            'Content-Range': `bytes */${session.totalBytes}`,
          },
          body: '',
        });
      } catch (error) {
        if (isAuthFailure(error)) throw error;
        continue;
      }
      if (response.status === 200 || response.status === 201) {
        return this.completeSession(session, response, onProgress);
      }
      if (response.status === 308) {
        const acknowledged = parseAcknowledgedRange(response.headers.get('range'), session.totalBytes);
        if (acknowledged === null || acknowledged < session.acknowledgedBytes) {
          throw new DriveUploadError('UPLOAD_STATE_UNKNOWN', 'Drive returned an invalid upload position.');
        }
        session.acknowledgedBytes = acknowledged;
        onProgress({ recordingId: session.recordingId, acknowledgedBytes: acknowledged, totalBytes: session.totalBytes });
        return null;
      }
      if (response.status === 404 || response.status === 410) {
        throw new DriveUploadError('UPLOAD_STATE_UNKNOWN', 'Drive no longer recognizes this upload session. Check your Drive before starting another upload.');
      }
      if (response.status === 401) throw new Error('DRIVE_AUTH_REJECTED');
      if (response.status !== 429 && response.status < 500) {
        throw new DriveUploadError('UPLOAD_FAILED', `Drive could not confirm upload status (${response.status}).`);
      }
    }
    throw new DriveUploadError('UPLOAD_STATE_UNKNOWN', 'Drive could not confirm upload progress. Retry to resume safely.');
  }

  private async completeSession(
    session: UploadSession,
    response: Response,
    onProgress: (progress: DriveUploadProgress) => void,
  ): Promise<DriveUploadResult> {
    let metadata: DriveMetadata;
    try {
      metadata = await response.json() as DriveMetadata;
    } catch {
      throw new DriveUploadError('UPLOAD_STATE_UNKNOWN', 'Drive may have completed the upload, but did not return valid file details. Retry to check its status.');
    }
    const result = validateDriveMetadata(metadata, session);
    session.result = result;
    session.acknowledgedBytes = session.totalBytes;
    onProgress({ recordingId: session.recordingId, acknowledgedBytes: session.totalBytes, totalBytes: session.totalBytes });
    return result;
  }

  private async authorizedRequest(url: string, init: RequestInit): Promise<Response> {
    let accessToken = await this.tokenProvider.getAccessToken();
    const send = (token: string) => this.fetcher(url, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${token}` },
    });
    let response = await send(accessToken);
    if (response.status === 401) {
      this.tokenProvider.invalidateAccessToken(accessToken);
      accessToken = await this.tokenProvider.getAccessToken();
      response = await send(accessToken);
    }
    return response;
  }
}

export async function readChunkFully(
  handle: Pick<FileHandle, 'read'>,
  position: number,
  length: number,
): Promise<Buffer> {
  const chunk = Buffer.alloc(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await handle.read(chunk, bytesRead, length - bytesRead, position + bytesRead);
    if (result.bytesRead === 0) {
      throw new DriveUploadError('UPLOAD_FAILED', 'The finalized recording could not be read completely.');
    }
    bytesRead += result.bytesRead;
  }
  return chunk;
}

export function validateUploadSessionUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'www.googleapis.com' ||
      (url.port !== '' && url.port !== '443') ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== '' ||
      url.pathname !== '/upload/drive/v3/files' ||
      !url.searchParams.get('upload_id')
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function parseAcknowledgedRange(value: string | null, totalBytes: number): number | null {
  if (value === null) return 0;
  const match = /^bytes=0-(\d+)$/.exec(value);
  if (!match) return null;
  const lastByte = Number(match[1]);
  if (!Number.isSafeInteger(lastByte) || lastByte < 0 || lastByte >= totalBytes) return null;
  return lastByte + 1;
}

function validateDriveMetadata(metadata: DriveMetadata, session: UploadSession): DriveUploadResult {
  const fileId = typeof metadata.id === 'string' ? metadata.id : '';
  const name = typeof metadata.name === 'string' ? metadata.name : '';
  const mimeType = metadata.mimeType;
  const sizeBytes = typeof metadata.size === 'string' ? Number(metadata.size) : metadata.size;
  const webViewLink = typeof metadata.webViewLink === 'string' ? metadata.webViewLink : '';
  if (
    !fileId ||
    name !== session.name ||
    mimeType !== 'video/webm' ||
    sizeBytes !== session.totalBytes ||
    !isValidDriveWebViewLink(webViewLink, fileId)
  ) {
    throw new DriveUploadError('UPLOAD_STATE_UNKNOWN', 'Drive completed the upload but returned incomplete or unexpected file details. Retry to check its status.');
  }
  return { ok: true, fileId, name, mimeType, sizeBytes, webViewLink, sharing: 'private' };
}

export function isValidDriveWebViewLink(value: string, fileId: string): boolean {
  try {
    const url = new URL(value);
    const expectedPath = `/file/d/${encodeURIComponent(fileId)}`;
    return url.protocol === 'https:' &&
      url.hostname === 'drive.google.com' &&
      (url.port === '' || url.port === '443') &&
      url.username === '' &&
      url.password === '' &&
      (url.pathname === expectedPath || url.pathname.startsWith(`${expectedPath}/`));
  } catch {
    return false;
  }
}

function isAuthFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return ['NOT_CONFIGURED', 'NOT_CONNECTED', 'INVALID_GRANT', 'STORAGE_UNAVAILABLE', 'TOKEN_REFRESH_FAILED', 'DRIVE_AUTH_REJECTED'].includes(error.message);
}
