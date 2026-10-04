import { contextBridge, ipcRenderer } from 'electron';
import type { SelectSourceResult, SourceListResult } from '../shared/sourceTypes';
import type {
  AppendChunkResult,
  BeginRecordingResult,
  FinalizeRecordingResult,
  RecordingActionResult,
  SaveRecordingResult,
} from '../shared/recordingTypes';
import type { MicrophonePermissionResult } from '../shared/microphoneTypes';
import type { GoogleAuthResult, GoogleAuthStatus } from '../shared/googleAuthTypes';
import type { DriveLinkActionResult, DriveShareResult, DriveSharingChoice, DriveUploadProgress, DriveUploadResponse } from '../shared/googleDriveTypes';

const api = Object.freeze({
  appVersion: '0.1.0',
  runtime: 'desktop' as const,
  listSources: (): Promise<SourceListResult> => ipcRenderer.invoke('sources:list'),
  selectSource: (sourceId: string): Promise<SelectSourceResult> =>
    ipcRenderer.invoke('sources:select', sourceId),
  beginRecording: (): Promise<BeginRecordingResult> => ipcRenderer.invoke('recording:begin'),
  appendRecordingChunk: (recordingId: string, chunk: ArrayBuffer): Promise<AppendChunkResult> =>
    ipcRenderer.invoke('recording:append', recordingId, chunk),
  finalizeRecording: (recordingId: string): Promise<FinalizeRecordingResult> =>
    ipcRenderer.invoke('recording:finalize', recordingId),
  abortRecording: (recordingId: string): Promise<RecordingActionResult> =>
    ipcRenderer.invoke('recording:abort', recordingId),
  discardRecording: (recordingId: string): Promise<RecordingActionResult> =>
    ipcRenderer.invoke('recording:discard', recordingId),
  saveRecording: (recordingId: string): Promise<SaveRecordingResult> =>
    ipcRenderer.invoke('recording:save', recordingId),
  getMicrophonePermission: (): Promise<MicrophonePermissionResult> =>
    ipcRenderer.invoke('microphone:permission-status'),
  requestMicrophoneAccess: (): Promise<MicrophonePermissionResult> =>
    ipcRenderer.invoke('microphone:request-access'),
  getGoogleAuthStatus: (): Promise<GoogleAuthStatus> => ipcRenderer.invoke('google-auth:status'),
  connectGoogle: (): Promise<GoogleAuthResult> => ipcRenderer.invoke('google-auth:connect'),
  disconnectGoogle: (): Promise<GoogleAuthStatus> => ipcRenderer.invoke('google-auth:disconnect'),
  uploadRecordingToDrive: (recordingId: string, sharingChoice: DriveSharingChoice): Promise<DriveUploadResponse> =>
    ipcRenderer.invoke('drive:upload', recordingId, sharingChoice),
  enableAnyoneDriveLink: (recordingId: string): Promise<DriveShareResult> =>
    ipcRenderer.invoke('drive:share', recordingId),
  copyDriveLink: (recordingId: string): Promise<DriveLinkActionResult> =>
    ipcRenderer.invoke('drive:copy-link', recordingId),
  openDriveLink: (recordingId: string): Promise<DriveLinkActionResult> =>
    ipcRenderer.invoke('drive:open-link', recordingId),
  onDriveUploadProgress: (listener: (progress: DriveUploadProgress) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: DriveUploadProgress) => listener(progress);
    ipcRenderer.on('drive:upload-progress', handler);
    return () => ipcRenderer.removeListener('drive:upload-progress', handler);
  },
});

contextBridge.exposeInMainWorld('oneTake', api);
