export {};

import type { SelectSourceResult, SourceListResult } from '../../shared/sourceTypes';
import type {
  AppendChunkResult,
  BeginRecordingResult,
  FinalizeRecordingResult,
  RecordingActionResult,
  SaveRecordingResult,
} from '../../shared/recordingTypes';
import type { MicrophonePermissionResult } from '../../shared/microphoneTypes';
import type { GoogleAuthResult, GoogleAuthStatus } from '../../shared/googleAuthTypes';
import type { DriveLinkActionResult, DriveShareResult, DriveSharingChoice, DriveUploadProgress, DriveUploadResponse } from '../../shared/googleDriveTypes';

declare global {
  interface Window {
    oneTake: Readonly<{
      appVersion: string;
      runtime: 'desktop';
      listSources: () => Promise<SourceListResult>;
      selectSource: (sourceId: string) => Promise<SelectSourceResult>;
      beginRecording: () => Promise<BeginRecordingResult>;
      appendRecordingChunk: (recordingId: string, chunk: ArrayBuffer) => Promise<AppendChunkResult>;
      finalizeRecording: (recordingId: string) => Promise<FinalizeRecordingResult>;
      abortRecording: (recordingId: string) => Promise<RecordingActionResult>;
      discardRecording: (recordingId: string) => Promise<RecordingActionResult>;
      saveRecording: (recordingId: string) => Promise<SaveRecordingResult>;
      getMicrophonePermission: () => Promise<MicrophonePermissionResult>;
      requestMicrophoneAccess: () => Promise<MicrophonePermissionResult>;
      getGoogleAuthStatus: () => Promise<GoogleAuthStatus>;
      connectGoogle: () => Promise<GoogleAuthResult>;
      disconnectGoogle: () => Promise<GoogleAuthStatus>;
      uploadRecordingToDrive: (recordingId: string, sharingChoice: DriveSharingChoice) => Promise<DriveUploadResponse>;
      enableAnyoneDriveLink: (recordingId: string) => Promise<DriveShareResult>;
      copyDriveLink: (recordingId: string) => Promise<DriveLinkActionResult>;
      openDriveLink: (recordingId: string) => Promise<DriveLinkActionResult>;
      onDriveUploadProgress: (listener: (progress: DriveUploadProgress) => void) => () => void;
    }>;
  }
}
