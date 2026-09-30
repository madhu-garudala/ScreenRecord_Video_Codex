export type MicrophonePermissionStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown';

export type MicrophonePermissionResult =
  | { ok: true; status: MicrophonePermissionStatus }
  | { ok: false; status: MicrophonePermissionStatus; message: string };
