export interface DriveUploadProgress {
  recordingId: string;
  acknowledgedBytes: number;
  totalBytes: number;
}

export type DriveSharingChoice = 'private' | 'anyone';

export interface DriveUploadResult {
  ok: true;
  fileId: string;
  name: string;
  mimeType: 'video/webm';
  sizeBytes: number;
  webViewLink: string;
  sharing: DriveSharingChoice;
}

export type DriveUploadErrorCode =
  | 'recording-unavailable'
  | 'not-connected'
  | 'auth-required'
  | 'upload-failed'
  | 'upload-state-unknown'
  | 'sharing-failed'
  | 'busy';

export type DriveUploadResponse = DriveUploadResult | {
  ok: false;
  error: DriveUploadErrorCode;
  message: string;
  uploaded?: DriveUploadResult;
};

export type DriveLinkActionResult =
  | { ok: true }
  | { ok: false; error: 'not-uploaded' | 'link-action-failed'; message: string };

export type DriveShareResult =
  | { ok: true; result: DriveUploadResult }
  | { ok: false; error: 'not-uploaded' | 'sharing-failed'; message: string; uploaded?: DriveUploadResult };
