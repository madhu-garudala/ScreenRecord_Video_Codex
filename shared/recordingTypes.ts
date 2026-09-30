export type BeginRecordingResult =
  | { ok: true; recordingId: string }
  | {
      ok: false;
      error: 'source-unavailable' | 'recording-active' | 'file-error';
      message: string;
    };

export type AppendChunkResult =
  | { ok: true }
  | {
      ok: false;
      error: 'invalid-chunk' | 'recording-unavailable' | 'backpressure' | 'write-failed';
      message: string;
    };

export type FinalizeRecordingResult =
  | {
      ok: true;
      recordingId: string;
      previewUrl: string;
      sizeBytes: number;
      mimeType: 'video/webm';
    }
  | {
      ok: false;
      error: 'recording-unavailable' | 'empty-recording' | 'write-failed';
      message: string;
    };

export type RecordingActionResult =
  | { ok: true }
  | { ok: false; error: 'recording-unavailable' | 'file-error'; message: string };

export type SaveRecordingResult =
  | { ok: true; canceled: true }
  | { ok: true; canceled: false; savedPath: string; sizeBytes: number }
  | {
      ok: false;
      error: 'recording-unavailable' | 'dialog-error' | 'save-failed';
      message: string;
    };
