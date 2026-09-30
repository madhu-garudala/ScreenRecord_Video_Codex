import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { GoogleAuthStatus } from '../shared/googleAuthTypes';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface SecureStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface OAuthCallback {
  code: string;
  state: string;
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function createOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

function matchesState(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

export class GoogleAuthService {
  private refreshToken: string | null = null;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private loaded = false;
  private tokenLoadInFlight: Promise<void> | null = null;
  private connecting = false;
  private refreshInFlight: Promise<string> | null = null;
  private activeServer: Server | null = null;

  constructor(
    private readonly clientId: string | null,
    private readonly tokenPath: string,
    private readonly secureStorage: SecureStorage,
    private readonly fetcher: typeof fetch = fetch,
    private readonly openExternal: (url: string) => Promise<void> = async () => undefined,
    private readonly createLoopbackServer: () => Server = () => createServer(),
  ) {}

  async status(): Promise<GoogleAuthStatus> {
    await this.loadToken();
    const secureStorageAvailable = this.secureStorage.isEncryptionAvailable();
    return {
      configured: Boolean(this.clientId),
      connected: Boolean(this.clientId && this.refreshToken && secureStorageAvailable),
      secureStorageAvailable,
    };
  }

  async connect(): Promise<GoogleAuthStatus> {
    if (this.connecting) throw new Error('AUTH_BUSY');
    if (!this.clientId) throw new Error('NOT_CONFIGURED');
    if (!this.secureStorage.isEncryptionAvailable()) throw new Error('STORAGE_UNAVAILABLE');
    this.connecting = true;
    let server: Server | null = null;
    try {
      await this.loadToken();
      const { verifier, challenge } = createPkcePair();
      const state = createOAuthState();
      const callbackServer = this.createLoopbackServer();
      server = callbackServer;
      this.activeServer = callbackServer;
      await new Promise<void>((resolve, reject) => {
        callbackServer.once('error', reject);
        callbackServer.listen(0, '127.0.0.1', () => {
          callbackServer.removeListener('error', reject);
          resolve();
        });
      });
      const address = callbackServer.address();
      if (!address || typeof address === 'string') throw new Error('CALLBACK_FAILED');
      const redirectUri = `http://127.0.0.1:${address.port}`;
      const authorizationUrl = new URL(AUTH_ENDPOINT);
      authorizationUrl.search = new URLSearchParams({
        client_id: this.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: DRIVE_FILE_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      }).toString();

      const callbackPromise = this.waitForCallback(callbackServer, state);
      try {
        await this.openExternal(authorizationUrl.toString());
      } catch (error) {
        callbackServer.close();
        await callbackPromise.catch(() => undefined);
        throw error;
      }
      const callback = await callbackPromise;
      const tokens = await this.exchangeCode(callback, verifier, redirectUri);
      const nextRefreshToken = tokens.refresh_token ?? this.refreshToken;
      if (!nextRefreshToken) throw new Error('NO_REFRESH_TOKEN');
      await this.persistRefreshToken(nextRefreshToken);
      this.refreshToken = nextRefreshToken;
      this.accessToken = tokens.access_token;
      this.accessTokenExpiresAt = Date.now() + tokens.expires_in * 1000;
      return await this.status();
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      if (this.activeServer === server) this.activeServer = null;
      this.connecting = false;
    }
  }

  cancelPendingConnect(): void {
    this.activeServer?.close();
  }

  async disconnect(): Promise<GoogleAuthStatus> {
    this.refreshToken = null;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.loaded = true;
    await rm(this.tokenPath, { force: true });
    return this.status();
  }

  async getAccessToken(): Promise<string> {
    if (!this.clientId) throw new Error('NOT_CONFIGURED');
    await this.loadToken();
    if (!this.refreshToken) throw new Error('NOT_CONNECTED');
    if (this.accessToken && this.accessTokenExpiresAt > Date.now() + 60_000) return this.accessToken;
    if (!this.secureStorage.isEncryptionAvailable()) throw new Error('STORAGE_UNAVAILABLE');

    if (this.refreshInFlight) return this.refreshInFlight;
    const refresh = this.refreshAccessToken();
    this.refreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      if (this.refreshInFlight === refresh) this.refreshInFlight = null;
    }
  }

  invalidateAccessToken(rejectedToken: string): void {
    if (this.accessToken !== rejectedToken) return;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  private async refreshAccessToken(): Promise<string> {
    const refreshToken = this.refreshToken;
    if (!refreshToken) throw new Error('NOT_CONNECTED');
    const response = await this.fetcher(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(30_000),
      body: new URLSearchParams({
        client_id: this.clientId ?? '',
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    const body = await response.json() as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string };
    if (!response.ok || !body.access_token || !body.expires_in) {
      if (body.error === 'invalid_grant') await this.disconnect();
      throw new Error(body.error === 'invalid_grant' ? 'INVALID_GRANT' : 'TOKEN_REFRESH_FAILED');
    }
    if (body.refresh_token && body.refresh_token !== refreshToken) {
      await this.persistRefreshToken(body.refresh_token);
      this.refreshToken = body.refresh_token;
    }
    this.accessToken = body.access_token;
    this.accessTokenExpiresAt = Date.now() + body.expires_in * 1000;
    return this.accessToken;
  }

  private async loadToken(): Promise<void> {
    if (this.loaded || !this.secureStorage.isEncryptionAvailable()) return;
    if (!this.tokenLoadInFlight) {
      this.tokenLoadInFlight = (async () => {
        try {
          const record = JSON.parse(await readFile(this.tokenPath, 'utf8')) as { version?: number; ciphertext?: string };
          if (record.version === 1 && typeof record.ciphertext === 'string') {
            this.refreshToken = this.secureStorage.decryptString(Buffer.from(record.ciphertext, 'base64'));
          }
        } catch {
          this.refreshToken = null;
        } finally {
          this.loaded = true;
          this.tokenLoadInFlight = null;
        }
      })();
    }
    await this.tokenLoadInFlight;
  }

  private async persistRefreshToken(token: string): Promise<void> {
    const ciphertext = this.secureStorage.encryptString(token).toString('base64');
    const temporaryPath = `${this.tokenPath}.${createOAuthState()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify({ version: 1, ciphertext }), { mode: 0o600, flag: 'wx' });
    try {
      await rename(temporaryPath, this.tokenPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private waitForCallback(server: Server, expectedState: string): Promise<OAuthCallback> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('CALLBACK_TIMEOUT')), CALLBACK_TIMEOUT_MS);
      const finish = (error?: Error, result?: OAuthCallback) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result!);
      };
      server.once('close', () => finish(new Error('AUTH_CLOSED')));
      server.on('request', (request, response) => {
        const address = request.url ? new URL(request.url, 'http://127.0.0.1') : null;
        if (request.method !== 'GET' || address?.pathname !== '/') {
          response.writeHead(404).end('Not found');
          return;
        }
        const receivedState = address.searchParams.get('state') ?? '';
        if (!matchesState(expectedState, receivedState)) {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Authorization response rejected. Return to OneTake.');
          finish(new Error('STATE_MISMATCH'));
          return;
        }
        const googleError = address.searchParams.get('error');
        const code = address.searchParams.get('code');
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><title>OneTake</title><p>You can close this tab and return to OneTake.</p>');
        if (googleError || !code) finish(new Error('AUTHORIZATION_DENIED'));
        else finish(undefined, { code, state: receivedState });
      });
    });
  }

  private async exchangeCode(callback: OAuthCallback, verifier: string, redirectUri: string): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
    const response = await this.fetcher(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(30_000),
      body: new URLSearchParams({
        client_id: this.clientId ?? '',
        code: callback.code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    const body = await response.json() as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string };
    if (!response.ok || !body.access_token || !body.expires_in) throw new Error(body.error ?? 'TOKEN_EXCHANGE_FAILED');
    return { access_token: body.access_token, expires_in: body.expires_in, refresh_token: body.refresh_token };
  }
}

export function authErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code === 'NOT_CONFIGURED') return 'Google Drive is not configured yet. Add a Desktop OAuth client ID and restart OneTake.';
  if (code === 'STORAGE_UNAVAILABLE') return 'Secure token storage is unavailable on this Mac. OneTake did not save Google credentials.';
  if (code === 'AUTH_BUSY') return 'A Google sign-in is already in progress.';
  if (code === 'CALLBACK_TIMEOUT') return 'Google sign-in timed out. Try connecting again.';
  if (code === 'AUTHORIZATION_DENIED') return 'Google sign-in was canceled or denied. You can try again.';
  if (code === 'AUTH_CLOSED') return 'Google sign-in was interrupted. You can connect again.';
  if (code === 'STATE_MISMATCH') return 'Google sign-in could not be verified. Start a new connection attempt.';
  if (code === 'NO_REFRESH_TOKEN') return 'Google did not provide offline access. Try connecting again.';
  if (code === 'INVALID_GRANT') return 'Google access expired or was revoked. Connect Google Drive again.';
  if (code === 'NOT_CONNECTED') return 'Connect Google Drive before continuing.';
  return 'Google Drive could not be connected. Check your connection and try again.';
}
