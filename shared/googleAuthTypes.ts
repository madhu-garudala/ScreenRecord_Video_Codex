export interface GoogleAuthStatus {
  configured: boolean;
  connected: boolean;
  secureStorageAvailable: boolean;
}

export type GoogleAuthResult =
  | { ok: true; status: GoogleAuthStatus }
  | { ok: false; error: 'not-configured' | 'storage-unavailable' | 'oauth-failed' | 'busy'; message: string; status: GoogleAuthStatus };
