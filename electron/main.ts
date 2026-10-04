import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  protocol,
  session,
  safeStorage,
  shell,
  systemPreferences,
  type IpcMainInvokeEvent,
  type DisplayMediaRequestHandlerHandlerRequest,
} from 'electron';
import { createReadStream, mkdirSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CaptureSource,
  ScreenPermissionStatus,
  SelectSourceResult,
  SourceListResult,
} from '../shared/sourceTypes';
import type {
  AppendChunkResult,
  BeginRecordingResult,
  FinalizeRecordingResult,
  RecordingActionResult,
  SaveRecordingResult,
} from '../shared/recordingTypes';
import { EmptyRecordingError, recordingStore } from './recordingStore';
import { atomicCopyRecording, createRecordingFilename, ensureWebMExtension, explainSaveError } from './recordingSaveService';
import { authErrorMessage, GoogleAuthService } from './googleAuthService';
import type { GoogleAuthResult, GoogleAuthStatus } from '../shared/googleAuthTypes';
import type { DriveLinkActionResult, DriveShareResult, DriveUploadProgress, DriveUploadResponse } from '../shared/googleDriveTypes';
import { DriveShareError, DriveUploadError, GoogleDriveService, isValidDriveWebViewLink } from './googleDriveService';
import { migrateUserDataDirectory } from './userDataMigration';
import { createCaptureCleanup } from './captureCleanup';
import type { MicrophonePermissionResult, MicrophonePermissionStatus } from '../shared/microphoneTypes';

const currentDirectory = __dirname;
const LIST_SOURCES_CHANNEL = 'sources:list';
const SELECT_SOURCE_CHANNEL = 'sources:select';
const BEGIN_RECORDING_CHANNEL = 'recording:begin';
const APPEND_CHUNK_CHANNEL = 'recording:append';
const FINALIZE_RECORDING_CHANNEL = 'recording:finalize';
const ABORT_RECORDING_CHANNEL = 'recording:abort';
const DISCARD_RECORDING_CHANNEL = 'recording:discard';
const SAVE_RECORDING_CHANNEL = 'recording:save';
const MIC_PERMISSION_CHANNEL = 'microphone:permission-status';
const MIC_REQUEST_CHANNEL = 'microphone:request-access';
const GOOGLE_AUTH_STATUS_CHANNEL = 'google-auth:status';
const GOOGLE_AUTH_CONNECT_CHANNEL = 'google-auth:connect';
const GOOGLE_AUTH_DISCONNECT_CHANNEL = 'google-auth:disconnect';
const DRIVE_UPLOAD_CHANNEL = 'drive:upload';
const DRIVE_UPLOAD_PROGRESS_CHANNEL = 'drive:upload-progress';
const DRIVE_SHARE_CHANNEL = 'drive:share';
const DRIVE_COPY_LINK_CHANNEL = 'drive:copy-link';
const DRIVE_OPEN_LINK_CHANNEL = 'drive:open-link';
const THUMBNAIL_SIZE = { width: 240, height: 150 };
let mainWindow: BrowserWindow | null = null;
let selectedSourceId: string | null = null;
let activeCapture: { recordingId: string; sourceId: string; state: 'awaiting-stream' | 'stream-granted' | 'recording' } | null = null;
let captureStartPending = false;
const captureCleanups = new Map<string, Promise<void>>();
let googleAuthService: GoogleAuthService | null = null;
let googleDriveService: GoogleDriveService | null = null;

protocol.registerSchemesAsPrivileged([{
  scheme: 'onetake',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: false },
}]);

const explicitUserDataDirectory = app.commandLine.getSwitchValue('user-data-dir');
const userDataDirectory = explicitUserDataDirectory || path.join(app.getPath('appData'), 'OneTake');
if (!explicitUserDataDirectory) migrateUserDataDirectory(app.getPath('appData'), userDataDirectory);
mkdirSync(userDataDirectory, { recursive: true, mode: 0o700 });
app.setPath('userData', userDataDirectory);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function readScreenPermission(): ScreenPermissionStatus {
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch {
    return 'unknown';
  }
}

function readMicrophonePermission(): MicrophonePermissionStatus {
  try {
    return systemPreferences.getMediaAccessStatus('microphone');
  } catch {
    return 'unknown';
  }
}

function microphonePermissionResult(granted: boolean): MicrophonePermissionResult {
  const status = granted ? 'granted' : readMicrophonePermission();
  if (status === 'granted') return { ok: true, status };
  const message = status === 'denied' || status === 'restricted'
    ? 'Microphone access is blocked. Choose Off or allow OneTake in System Settings → Privacy & Security → Microphone.'
    : 'Microphone access was not granted. Choose Off or try enabling the microphone again.';
  return { ok: false, status, message };
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (
    mainWindow === null ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    !isAllowedRendererUrl(event.senderFrame.url)
  ) {
    throw new Error('Rejected IPC call from an untrusted renderer.');
  }
}

async function loadGoogleClientId(): Promise<string | null> {
  const fromEnvironment = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  if (fromEnvironment) return fromEnvironment;
  if (!app.isPackaged) return null;
  try {
    const clientFile = JSON.parse(await readFileAsync(path.join(app.getPath('userData'), 'google-oauth-client.json'), 'utf8')) as {
      installed?: { client_id?: unknown };
    };
    return typeof clientFile.installed?.client_id === 'string' && clientFile.installed.client_id.trim()
      ? clientFile.installed.client_id.trim()
      : null;
  } catch {
    return null;
  }
}

async function fetchCaptureSources(): Promise<CaptureSource[]> {
  const rawSources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: THUMBNAIL_SIZE,
    fetchWindowIcons: false,
  });

  return rawSources.flatMap((source) => {
    const type = source.id.startsWith('screen:')
      ? 'screen'
      : source.id.startsWith('window:')
        ? 'window'
        : null;
    if (type === null) return [];

    return [{
      id: source.id,
      name: source.name.trim() || (type === 'screen' ? 'Display' : 'Untitled window'),
      type,
      thumbnailDataUrl: source.thumbnail.toDataURL(),
    }];
  });
}

ipcMain.handle(LIST_SOURCES_CHANNEL, async (event): Promise<SourceListResult> => {
  assertTrustedRenderer(event);
  const screenPermission = readScreenPermission();

  try {
    const sources = await fetchCaptureSources();
    if (selectedSourceId !== null && !sources.some(({ id }) => id === selectedSourceId)) {
      selectedSourceId = null;
    }

    if (
      sources.length === 0 &&
      (screenPermission === 'denied' || screenPermission === 'restricted')
    ) {
      return {
        ok: false,
        sources,
        selectedSourceId: null,
        screenPermission,
        error: 'screen-permission',
        message: 'Screen access is blocked. Allow OneTake in System Settings → Privacy & Security → Screen & System Audio Recording, then restart the app.',
      };
    }

    return { ok: true, sources, selectedSourceId, screenPermission };
  } catch {
    const blocked = screenPermission === 'denied' || screenPermission === 'restricted';
    selectedSourceId = null;
    return {
      ok: false,
      sources: [],
      selectedSourceId: null,
      screenPermission,
      error: blocked ? 'screen-permission' : 'enumeration-failed',
      message: blocked
        ? 'Screen access is blocked. Allow OneTake in System Settings → Privacy & Security → Screen & System Audio Recording, then restart the app.'
        : 'Could not load screens and windows. Try refreshing the list.',
    };
  }
});

ipcMain.handle(MIC_PERMISSION_CHANNEL, (event): MicrophonePermissionResult => {
  assertTrustedRenderer(event);
  return microphonePermissionResult(readMicrophonePermission() === 'granted');
});

ipcMain.handle(MIC_REQUEST_CHANNEL, async (event): Promise<MicrophonePermissionResult> => {
  assertTrustedRenderer(event);
  if (process.platform !== 'darwin') {
    return { ok: false, status: 'unknown', message: 'Microphone permission prompts are supported here only on macOS.' };
  }
  try {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    return microphonePermissionResult(granted);
  } catch {
    return microphonePermissionResult(false);
  }
});

ipcMain.handle(SELECT_SOURCE_CHANNEL, async (event, sourceId: unknown): Promise<SelectSourceResult> => {
  assertTrustedRenderer(event);
  if (typeof sourceId !== 'string' || sourceId.length < 8 || sourceId.length > 512) {
    return { ok: false, error: 'invalid-source', message: 'Choose a screen or window from the list.' };
  }

  try {
    const sources = await fetchCaptureSources();
    if (!sources.some(({ id }) => id === sourceId)) {
      if (selectedSourceId === sourceId) selectedSourceId = null;
      return {
        ok: false,
        error: 'stale-source',
        message: 'That screen or window is no longer available. Refresh the list and choose another.',
      };
    }

    selectedSourceId = sourceId;
    return { ok: true, selectedSourceId };
  } catch {
    return {
      ok: false,
      error: 'enumeration-failed',
      message: 'Could not verify that source. Refresh the list and try again.',
    };
  }
});

ipcMain.handle(BEGIN_RECORDING_CHANNEL, async (event): Promise<BeginRecordingResult> => {
  assertTrustedRenderer(event);
  if (activeCapture !== null || captureStartPending) {
    return { ok: false, error: 'recording-active', message: 'A recording is already being started.' };
  }
  if (selectedSourceId === null) {
    return { ok: false, error: 'source-unavailable', message: 'Choose a screen or window before recording.' };
  }

  captureStartPending = true;
  try {
    await Promise.all([...captureCleanups.values()].map((cleanup) => cleanup.catch(() => undefined)));
    if (activeCapture !== null) {
      return { ok: false, error: 'recording-active', message: 'A recording is already being started.' };
    }
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    if (!sources.some(({ id }) => id === selectedSourceId)) {
      selectedSourceId = null;
      return { ok: false, error: 'source-unavailable', message: 'That screen or window is no longer available. Refresh the list and choose another.' };
    }

    const recordingId = await recordingStore.begin();
    activeCapture = { recordingId, sourceId: selectedSourceId, state: 'awaiting-stream' };
    return { ok: true, recordingId };
  } catch {
    return { ok: false, error: 'file-error', message: 'Could not prepare a temporary recording file.' };
  } finally {
    captureStartPending = false;
  }
});

ipcMain.handle(APPEND_CHUNK_CHANNEL, async (event, recordingId: unknown, chunk: unknown): Promise<AppendChunkResult> => {
  assertTrustedRenderer(event);
  if (
    typeof recordingId !== 'string' ||
    activeCapture === null ||
    activeCapture.recordingId !== recordingId ||
    (activeCapture.state !== 'stream-granted' && activeCapture.state !== 'recording')
  ) {
    return { ok: false, error: 'recording-unavailable', message: 'The recording writer is no longer active.' };
  }

  try {
    activeCapture.state = 'recording';
    await recordingStore.append(recordingId, chunk);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('invalid size or type')) {
      return { ok: false, error: 'invalid-chunk', message: 'A capture chunk had an invalid size.' };
    }
    if (message.includes('behind the capture stream')) {
      return { ok: false, error: 'backpressure', message: 'The recording disk writer fell behind. Stop and try again.' };
    }
    return { ok: false, error: 'write-failed', message: 'Could not write a capture chunk to disk.' };
  }
});

ipcMain.handle(FINALIZE_RECORDING_CHANNEL, async (event, recordingId: unknown): Promise<FinalizeRecordingResult> => {
  assertTrustedRenderer(event);
  if (
    typeof recordingId !== 'string' ||
    activeCapture === null ||
    activeCapture.recordingId !== recordingId ||
    (activeCapture.state !== 'stream-granted' && activeCapture.state !== 'recording')
  ) {
    return { ok: false, error: 'recording-unavailable', message: 'There is no active recording to finish.' };
  }

  try {
    const recording = await recordingStore.finalize(recordingId);
    activeCapture = null;
    return {
      ok: true,
      recordingId,
      previewUrl: recordingStore.createPreviewUrl(recordingId),
      sizeBytes: recording.sizeBytes,
      mimeType: recording.mimeType,
    };
  } catch (error) {
    activeCapture = null;
    if (error instanceof EmptyRecordingError) {
      return { ok: false, error: 'empty-recording', message: 'No playable video data was captured. Choose a source and try again.' };
    }
    return { ok: false, error: 'write-failed', message: 'The recording could not be finalized. Try recording again.' };
  }
});

ipcMain.handle(ABORT_RECORDING_CHANNEL, async (event, recordingId: unknown): Promise<RecordingActionResult> => {
  assertTrustedRenderer(event);
  if (typeof recordingId !== 'string' || activeCapture === null || activeCapture.recordingId !== recordingId) {
    return { ok: false, error: 'recording-unavailable', message: 'There is no active recording to cancel.' };
  }
  try {
    await abortCapture(recordingId);
    return { ok: true };
  } catch {
    return { ok: false, error: 'file-error', message: 'The temporary recording could not be removed.' };
  }
});

ipcMain.handle(DISCARD_RECORDING_CHANNEL, async (event, recordingId: unknown): Promise<RecordingActionResult> => {
  assertTrustedRenderer(event);
  if (typeof recordingId !== 'string' || !recordingStore.getFinalized(recordingId)) {
    return { ok: false, error: 'recording-unavailable', message: 'That preview is no longer available.' };
  }
  try {
    await recordingStore.discard(recordingId);
    googleDriveService?.forgetRecording(recordingId);
    return { ok: true };
  } catch {
    return { ok: false, error: 'file-error', message: 'The temporary recording could not be removed.' };
  }
});

ipcMain.handle(SAVE_RECORDING_CHANNEL, async (event, recordingId: unknown): Promise<SaveRecordingResult> => {
  assertTrustedRenderer(event);
  if (typeof recordingId !== 'string') {
    return { ok: false, error: 'recording-unavailable', message: 'That preview is no longer available.' };
  }
  const recording = recordingStore.getFinalized(recordingId);
  if (!recording) {
    return { ok: false, error: 'recording-unavailable', message: 'That preview is no longer available.' };
  }

  let selectedPath: string;
  let overwriteConfirmedForPath: boolean;
  try {
    const selection = await dialog.showSaveDialog(mainWindow!, {
      title: 'Save Recording',
      defaultPath: path.join(app.getPath('documents'), createRecordingFilename()),
      filters: [{ name: 'WebM Video', extensions: ['webm'] }],
      properties: ['showOverwriteConfirmation'],
    });
    if (selection.canceled) return { ok: true, canceled: true };
    if (!selection.filePath) {
      return { ok: false, error: 'dialog-error', message: 'The save location was not available. Choose a location and try again.' };
    }
    selectedPath = ensureWebMExtension(selection.filePath);
    overwriteConfirmedForPath = selectedPath === selection.filePath;
  } catch {
    return { ok: false, error: 'dialog-error', message: 'The Save dialog could not open. Keep the preview open and try again.' };
  }

  const stillAvailable = recordingStore.getFinalized(recordingId);
  if (!stillAvailable || stillAvailable.path !== recording.path) {
    return { ok: false, error: 'recording-unavailable', message: 'That preview is no longer available.' };
  }

  try {
    // The native dialog confirmed overwrite only for its exact path. If we
    // appended .webm, publish exclusively so that adjusted paths cannot clobber
    // an unconfirmed file (including one created after the dialog closed).
    const sizeBytes = await atomicCopyRecording(recording.path, selectedPath, recording.sizeBytes, overwriteConfirmedForPath);
    return { ok: true, canceled: false, savedPath: selectedPath, sizeBytes };
  } catch (error) {
    return { ok: false, error: 'save-failed', message: explainSaveError(error) };
  }
});

ipcMain.handle(GOOGLE_AUTH_STATUS_CHANNEL, async (event): Promise<GoogleAuthStatus> => {
  assertTrustedRenderer(event);
  if (!googleAuthService) return { configured: Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID), connected: false, secureStorageAvailable: safeStorage.isEncryptionAvailable() };
  return googleAuthService.status();
});

ipcMain.handle(GOOGLE_AUTH_CONNECT_CHANNEL, async (event): Promise<GoogleAuthResult> => {
  assertTrustedRenderer(event);
  if (!googleAuthService) return { ok: false, error: 'not-configured', message: 'Google Drive is not configured yet. Add a Desktop OAuth client ID and restart OneTake.', status: { configured: false, connected: false, secureStorageAvailable: safeStorage.isEncryptionAvailable() } };
  try {
    return { ok: true, status: await googleAuthService.connect() };
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const status = await googleAuthService.status();
    const category = code === 'NOT_CONFIGURED' ? 'not-configured' : code === 'STORAGE_UNAVAILABLE' ? 'storage-unavailable' : code === 'AUTH_BUSY' ? 'busy' : 'oauth-failed';
    return { ok: false, error: category, message: authErrorMessage(error), status };
  }
});

ipcMain.handle(GOOGLE_AUTH_DISCONNECT_CHANNEL, async (event): Promise<GoogleAuthStatus> => {
  assertTrustedRenderer(event);
  if (!googleAuthService) return { configured: false, connected: false, secureStorageAvailable: safeStorage.isEncryptionAvailable() };
  return googleAuthService.disconnect();
});

ipcMain.handle(DRIVE_UPLOAD_CHANNEL, async (event, recordingId: unknown, sharingChoice: unknown): Promise<DriveUploadResponse> => {
  assertTrustedRenderer(event);
  if (typeof recordingId !== 'string') {
    return { ok: false, error: 'recording-unavailable', message: 'That preview is no longer available.' };
  }
  const recording = recordingStore.getFinalized(recordingId);
  if (!recording) {
    return { ok: false, error: 'recording-unavailable', message: 'That preview is no longer available.' };
  }
  if (sharingChoice !== 'private' && sharingChoice !== 'anyone') {
    return { ok: false, error: 'upload-failed', message: 'Choose a valid link access setting and try again.' };
  }
  if (!googleAuthService || !googleDriveService) {
    return { ok: false, error: 'auth-required', message: 'Connect Google Drive before uploading.' };
  }
  if (!(await googleAuthService.status()).connected) {
    return { ok: false, error: 'auth-required', message: 'Connect Google Drive before uploading.' };
  }

  try {
    const uploaded = await googleDriveService.upload(recording, (progress: DriveUploadProgress) => {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(DRIVE_UPLOAD_PROGRESS_CHANNEL, progress);
      }
    });
    if (sharingChoice === 'private') return uploaded;
    try {
      return await googleDriveService.enableAnyoneLinkAccess(recordingId);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const message = code === 'INVALID_GRANT' || code === 'NOT_CONNECTED' || code === 'NOT_CONFIGURED'
        ? 'The recording uploaded privately, but Google access expired before link sharing. Reconnect and retry link sharing.'
        : error instanceof DriveShareError && error.code === 'POLICY_REJECTED'
          ? 'The recording uploaded privately, but your Google account or organization does not allow link sharing. Contact your Google Workspace administrator or keep it private.'
          : 'The recording uploaded privately, but Anyone with the link access could not be enabled. Check your connection and retry link sharing.';
      return { ok: false, error: 'sharing-failed', message, uploaded };
    }
  } catch (error) {
    if (error instanceof DriveUploadError && error.code === 'UPLOAD_BUSY') {
      return { ok: false, error: 'busy', message: 'A Drive upload is already in progress.' };
    }
    if (error instanceof DriveUploadError && error.code === 'UPLOAD_STATE_UNKNOWN') {
      return { ok: false, error: 'upload-state-unknown', message: 'Drive has not confirmed whether the upload completed. Keep this preview and retry to check safely.' };
    }
    if (error instanceof DriveUploadError) {
      return { ok: false, error: 'upload-failed', message: error.message || 'The recording could not be uploaded. Keep the preview and try again.' };
    }
    const code = error instanceof Error ? error.message : '';
    if (code === 'NOT_CONNECTED' || code === 'NOT_CONFIGURED' || code === 'INVALID_GRANT' || code === 'STORAGE_UNAVAILABLE' || code === 'TOKEN_REFRESH_FAILED' || code === 'DRIVE_AUTH_REJECTED') {
      return { ok: false, error: 'auth-required', message: code === 'INVALID_GRANT'
        ? 'Google access expired or was revoked. Reconnect Google Drive and retry the upload.'
        : 'Connect Google Drive before uploading.' };
    }
    return { ok: false, error: 'upload-failed', message: 'The recording could not be uploaded. Check your connection and try again.' };
  }
});

ipcMain.handle(DRIVE_SHARE_CHANNEL, async (event, recordingId: unknown): Promise<DriveShareResult> => {
  assertTrustedRenderer(event);
  if (typeof recordingId !== 'string' || !googleDriveService) {
    return { ok: false, error: 'not-uploaded', message: 'Upload this recording to Google Drive before changing link access.' };
  }
  const uploaded = googleDriveService.getUploadedResult(recordingId);
  if (!uploaded) {
    return { ok: false, error: 'not-uploaded', message: 'Upload this recording to Google Drive before changing link access.' };
  }
  try {
    return { ok: true, result: await googleDriveService.enableAnyoneLinkAccess(recordingId) };
  } catch (error) {
    const message = error instanceof DriveShareError && error.code === 'NOT_UPLOADED'
      ? 'Upload this recording to Google Drive before changing link access.'
      : error instanceof DriveShareError && error.code === 'POLICY_REJECTED'
        ? 'The recording uploaded privately, but your Google account or organization does not allow link sharing. Contact your Google Workspace administrator or keep it private.'
        : 'The recording is still private. Anyone with the link access could not be enabled; check your connection and try again.';
    return { ok: false, error: 'sharing-failed', message, uploaded };
  }
});

ipcMain.handle(DRIVE_COPY_LINK_CHANNEL, async (event, recordingId: unknown): Promise<DriveLinkActionResult> => {
  assertTrustedRenderer(event);
  const uploaded = typeof recordingId === 'string' ? googleDriveService?.getUploadedResult(recordingId) : null;
  if (!uploaded || !isValidDriveWebViewLink(uploaded.webViewLink, uploaded.fileId)) {
    return { ok: false, error: 'not-uploaded', message: 'There is no validated Drive link to copy yet.' };
  }
  try {
    clipboard.writeText(uploaded.webViewLink);
    return { ok: true };
  } catch {
    return { ok: false, error: 'link-action-failed', message: 'The Drive link could not be copied. Try again.' };
  }
});

ipcMain.handle(DRIVE_OPEN_LINK_CHANNEL, async (event, recordingId: unknown): Promise<DriveLinkActionResult> => {
  assertTrustedRenderer(event);
  const uploaded = typeof recordingId === 'string' ? googleDriveService?.getUploadedResult(recordingId) : null;
  if (!uploaded || !isValidDriveWebViewLink(uploaded.webViewLink, uploaded.fileId)) {
    return { ok: false, error: 'not-uploaded', message: 'There is no validated Drive link to open yet.' };
  }
  try {
    await shell.openExternal(uploaded.webViewLink);
    return { ok: true };
  } catch {
    return { ok: false, error: 'link-action-failed', message: 'Google Drive could not be opened. Try again.' };
  }
});

function installDisplayCaptureHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => void routeDisplayCaptureRequest(request, callback),
    { useSystemPicker: false },
  );
}

function installMediaPermissionHandlers(): void {
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    if (
      webContents !== mainWindow?.webContents ||
      !details.isMainFrame ||
      !isAllowedRendererUrl(details.requestingUrl ?? '')
    ) return false;

    if (permission === 'display-capture') return activeCapture?.state === 'awaiting-stream';
    if (permission === 'media') {
      return details.mediaType === 'audio' && readMicrophonePermission() === 'granted';
    }
    return false;
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (
      webContents !== mainWindow?.webContents ||
      !details.isMainFrame ||
      !isAllowedRendererUrl(details.requestingUrl)
    ) {
      callback(false);
      return;
    }

    if (permission === 'display-capture') {
      callback(activeCapture?.state === 'awaiting-stream');
      return;
    }
    if (permission === 'media') {
      const mediaTypes = 'mediaTypes' in details ? details.mediaTypes ?? [] : [];
      callback(
        mediaTypes.length === 1 &&
        mediaTypes[0] === 'audio' &&
        readMicrophonePermission() === 'granted',
      );
      return;
    }
    callback(false);
  });
}

async function routeDisplayCaptureRequest(
  request: DisplayMediaRequestHandlerHandlerRequest,
  callback: (streams: Electron.Streams) => void,
): Promise<void> {
  const capture = activeCapture;
  if (
    !request.frame ||
    !mainWindow ||
    request.frame !== mainWindow.webContents.mainFrame ||
    !isAllowedRendererUrl(request.frame.url) ||
    !request.videoRequested ||
    request.audioRequested ||
    capture === null ||
    capture.state !== 'awaiting-stream'
  ) {
    callback({});
    return;
  }

  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    if (activeCapture !== capture) {
      callback({});
      return;
    }
    const source = sources.find(({ id }) => id === capture.sourceId);
    if (!source) {
      selectedSourceId = null;
      activeCapture = null;
      void abortCapture(capture.recordingId);
      callback({});
      return;
    }
    capture.state = 'stream-granted';
    callback({ video: source });
  } catch {
    activeCapture = null;
    void abortCapture(capture.recordingId);
    callback({});
  }
}

function installPreviewProtocol(): void {
  protocol.handle('onetake', async (request) => {
    try {
      const url = new URL(request.url);
      const recordingId = url.hostname === 'recording' ? url.pathname.slice(1) : '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recordingId)) {
        return new Response('Not found', { status: 404 });
      }
      const recording = recordingStore.getFinalized(recordingId);
      if (!recording) return new Response('Not found', { status: 404 });
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });

      const range = request.headers.get('range');
      const rangeResult = range ? parseByteRange(range, recording.sizeBytes) : null;
      if (range && !rangeResult) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${recording.sizeBytes}`, 'Accept-Ranges': 'bytes' },
        });
      }

      const start = rangeResult?.start ?? 0;
      const end = rangeResult?.end ?? recording.sizeBytes - 1;
      const responseHeaders = new Headers({
        'Accept-Ranges': 'bytes',
        'Content-Type': recording.mimeType,
        'Content-Length': String(end - start + 1),
        'Cache-Control': 'no-store',
      });
      if (rangeResult) responseHeaders.set('Content-Range', `bytes ${start}-${end}/${recording.sizeBytes}`);
      if (request.method === 'HEAD') return new Response(null, { status: rangeResult ? 206 : 200, headers: responseHeaders });

      const nodeStream = createReadStream(recording.path, { start, end });
      const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
      return new Response(body, { status: rangeResult ? 206 : 200, headers: responseHeaders });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function abortCapture(recordingId: string): Promise<void> {
  if (activeCapture?.recordingId === recordingId) activeCapture = null;
  return createCaptureCleanup(captureCleanups, recordingId, (id) => recordingStore.abort(id));
}

function parseByteRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size < 1) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function isAllowedRendererUrl(candidate: string): boolean {
  if (app.isPackaged) {
    return candidate === pathToFileURL(path.join(currentDirectory, '../../dist/index.html')).href;
  }

  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === '5173';
  } catch {
    return false;
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 820,
    minHeight: 640,
    backgroundColor: '#f7f7f4',
    title: 'OneTake',
    webPreferences: {
      preload: path.join(currentDirectory, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
      selectedSourceId = null;
      googleAuthService?.cancelPendingConnect();
      const capture = activeCapture;
      if (capture) void abortCapture(capture.recordingId);
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedRendererUrl(targetUrl)) event.preventDefault();
  });

  if (app.isPackaged) {
    void window.loadFile(path.join(currentDirectory, '../../dist/index.html'));
  } else {
    void window.loadURL('http://127.0.0.1:5173');
  }
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  googleAuthService = new GoogleAuthService(
    await loadGoogleClientId(),
    path.join(app.getPath('userData'), 'google-refresh-token.json'),
    safeStorage,
    fetch,
    async (url) => shell.openExternal(url),
  );
  googleDriveService = new GoogleDriveService(googleAuthService);
  return recordingStore.cleanupOrphanedFiles().catch(() => {
    console.warn('Could not remove stale OneTake temporary recordings.');
  });
}).then(() => {
  if (!hasSingleInstanceLock) return;
  installDisplayCaptureHandler();
  installMediaPermissionHandlers();
  installPreviewProtocol();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let shutdownCleanupStarted = false;
app.on('before-quit', (event) => {
  if (shutdownCleanupStarted) return;
  event.preventDefault();
  shutdownCleanupStarted = true;
  googleAuthService?.cancelPendingConnect();
  activeCapture = null;
  void recordingStore.dispose().finally(() => app.quit());
});
