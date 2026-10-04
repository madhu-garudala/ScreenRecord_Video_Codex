export type CapturePermissionState = 'awaiting-stream' | 'stream-granted' | 'recording';

export function isDisplayCapturePermitted(state: CapturePermissionState | null): boolean {
  // Chromium may check permission both before and after the selected source is granted.
  return state === 'awaiting-stream' || state === 'stream-granted';
}
