import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureSource } from '../shared/sourceTypes';
import type { MicrophonePermissionStatus } from '../shared/microphoneTypes';
import type { GoogleAuthStatus } from '../shared/googleAuthTypes';
import type { DriveSharingChoice, DriveUploadProgress, DriveUploadResult } from '../shared/googleDriveTypes';

type RecorderPhase = 'idle' | 'countdown' | 'starting' | 'recording' | 'processing' | 'preview' | 'error';
type PreviewPlaybackState = 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';

interface CaptureSession {
  recordingId: string;
  streams: MediaStream[];
  audioIncluded: boolean;
  recorder: MediaRecorder | null;
  writeTail: Promise<void>;
  pendingChunks: number;
  failure: string | null;
  cancelled: boolean;
  startedAt: number | null;
  stoppedAt: number | null;
  stopped: Promise<void>;
  resolveStopped: () => void;
  stopPromise: Promise<void> | null;
}

interface PreviewDetails {
  recordingId: string;
  previewUrl: string;
  sizeBytes: number;
  durationMs: number;
  audioIncluded: boolean;
}

interface MicrophoneInput {
  deviceId: string;
  label: string;
}

const MAX_PENDING_CHUNKS = 4;
const TIMESLICE_MS = 1000;
const RECORDER_STOP_TIMEOUT_MS = 10_000;

function waitForRecorderStop(stopped: Promise<void>): Promise<void> {
  let timeout = 0;
  return Promise.race([
    stopped,
    new Promise<void>((_, reject) => {
      timeout = window.setTimeout(() => reject(new Error('The video recorder did not finish stopping.')), RECORDER_STOP_TIMEOUT_MS);
    }),
  ]).finally(() => window.clearTimeout(timeout));
}

function stopTracks(streams: readonly MediaStream[]) {
  const tracks = new Set(streams.flatMap((stream) => stream.getTracks()));
  tracks.forEach((track) => track.stop());
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes === 0) return '0 bytes';
  if (sizeBytes < 1024 * 1024) return `${Math.max(1, Math.round(sizeBytes / 1024))} KB · ${sizeBytes.toLocaleString()} bytes`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB · ${sizeBytes.toLocaleString()} bytes`;
}

function ScreenGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="line-icon">
      <rect x="3.5" y="4" width="17" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

function MicGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="line-icon">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-4 0h8" />
    </svg>
  );
}

function DriveGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="drive-icon">
      <path fill="#4285f4" d="m8.4 3.5 4.1 0 7.7 13.2h-4.6z" />
      <path fill="#34a853" d="M8.4 3.5 1.1 16.7l2.3 4 7.4-13.1z" />
      <path fill="#fbbc04" d="M3.4 20.7h15.2l2.3-4H5.7z" />
    </svg>
  );
}

export default function App() {
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSelecting, setIsSelecting] = useState(false);
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [countdown, setCountdown] = useState(3);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [microphones, setMicrophones] = useState<MicrophoneInput[]>([]);
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState<string | null>(null);
  const [microphonePermission, setMicrophonePermission] = useState<MicrophonePermissionStatus>('not-determined');
  const [microphoneError, setMicrophoneError] = useState<string | null>(null);
  const [isRequestingMicrophone, setIsRequestingMicrophone] = useState(false);
  const [preview, setPreview] = useState<PreviewDetails | null>(null);
  const [previewPlaybackState, setPreviewPlaybackState] = useState<PreviewPlaybackState>('loading');
  const [previewPlaybackError, setPreviewPlaybackError] = useState<string | null>(null);
  const [previewActionError, setPreviewActionError] = useState<string | null>(null);
  const [isDiscardingPreview, setIsDiscardingPreview] = useState(false);
  const [isSavingRecording, setIsSavingRecording] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedRecording, setSavedRecording] = useState<{ path: string; sizeBytes: number } | null>(null);
  const [driveUploadProgress, setDriveUploadProgress] = useState<DriveUploadProgress | null>(null);
  const [driveUploadResult, setDriveUploadResult] = useState<DriveUploadResult | null>(null);
  const [driveUploadError, setDriveUploadError] = useState<string | null>(null);
  const [isUploadingDrive, setIsUploadingDrive] = useState(false);
  const [isConnectingForUpload, setIsConnectingForUpload] = useState(false);
  const [driveSharingChoice, setDriveSharingChoice] = useState<DriveSharingChoice>('private');
  const [isSharingDrive, setIsSharingDrive] = useState(false);
  const [driveLinkBusy, setDriveLinkBusy] = useState(false);
  const [driveLinkMessage, setDriveLinkMessage] = useState<string | null>(null);
  const [googleAuthStatus, setGoogleAuthStatus] = useState<GoogleAuthStatus | null>(null);
  const [googleAuthBusy, setGoogleAuthBusy] = useState(false);
  const [googleAuthError, setGoogleAuthError] = useState<string | null>(null);
  const requestNumber = useRef(0);
  const countdownTimer = useRef<number | null>(null);
  const sessionRef = useRef<CaptureSession | null>(null);
  const actionLocked = useRef(false);
  const previewActionLocked = useRef(false);
  const saveActionLocked = useRef(false);
  const driveUploadLocked = useRef(false);
  const driveSharingLocked = useRef(false);
  const driveLinkActionLocked = useRef(false);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (phase !== 'preview' || !preview) return;
    setPreviewPlaybackState('loading');
    setPreviewPlaybackError(null);
    setPreviewActionError(null);
    setSaveError(null);
    setSavedRecording(null);
    setDriveUploadProgress(null);
    setDriveUploadResult(null);
    setDriveUploadError(null);
    setDriveSharingChoice('private');
    setIsSharingDrive(false);
    setDriveLinkMessage(null);
  }, [phase, preview?.previewUrl]);

  useEffect(() => {
    if (!preview) return;
    return window.localLoom.onDriveUploadProgress((progress) => {
      if (progress.recordingId === preview.recordingId) setDriveUploadProgress(progress);
    });
  }, [preview?.recordingId]);

  const refreshMicrophones = useCallback(async (selectFirst = false) => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === 'audioinput').map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label.trim() || `Microphone ${index + 1}`,
    })).filter((device) => device.deviceId.length > 0);
    setMicrophones(inputs);
    setSelectedMicrophoneId((current) => {
      if (selectFirst) return inputs[0]?.deviceId ?? null;
      return current && inputs.some((input) => input.deviceId === current) ? current : null;
    });
    if (inputs.length > 0) setMicrophoneError(null);
    if (selectFirst && inputs.length === 0) {
      setMicrophoneError('No microphone input is available. Connect one or choose Off.');
    }
    return inputs;
  }, []);

  const refreshSources = useCallback(async () => {
    const currentRequest = ++requestNumber.current;
    setIsRefreshing(true);
    setSourceError(null);
    try {
      const result = await window.localLoom.listSources();
      if (currentRequest !== requestNumber.current) return;
      setSources(result.sources);
      setSelectedSourceId(result.selectedSourceId);
      if (!result.ok) setSourceError(result.message);
    } catch {
      if (currentRequest !== requestNumber.current) return;
      setSources([]);
      setSelectedSourceId(null);
      setSourceError('Could not load screens and windows. Try refreshing the list.');
    } finally {
      if (currentRequest === requestNumber.current) setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refreshSources();
  }, [refreshSources]);

  useEffect(() => {
    let mounted = true;
    void window.localLoom.getGoogleAuthStatus().then((status) => {
      if (mounted) setGoogleAuthStatus(status);
    }).catch(() => {
      if (mounted) setGoogleAuthError('Google Drive status is unavailable. Restart Local Loom and try again.');
    });
    return () => { mounted = false; };
  }, []);

  const connectGoogle = async () => {
    if (googleAuthBusy) return;
    setGoogleAuthBusy(true);
    setGoogleAuthError(null);
    try {
      const result = await window.localLoom.connectGoogle();
      setGoogleAuthStatus(result.status);
      if (!result.ok) setGoogleAuthError(result.message);
    } catch {
      setGoogleAuthError('Google Drive could not be connected. Try again.');
    } finally {
      setGoogleAuthBusy(false);
    }
  };

  const disconnectGoogle = async () => {
    if (googleAuthBusy || isUploadingDrive) return;
    setGoogleAuthBusy(true);
    setGoogleAuthError(null);
    try {
      setGoogleAuthStatus(await window.localLoom.disconnectGoogle());
    } catch {
      setGoogleAuthError('Google credentials could not be removed. Try again.');
    } finally {
      setGoogleAuthBusy(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    void window.localLoom.getMicrophonePermission().then(async (result) => {
      if (!mounted) return;
      setMicrophonePermission(result.status);
      if (result.ok) await refreshMicrophones();
      else if (result.status === 'denied' || result.status === 'restricted') setMicrophoneError(result.message);
    }).catch(() => {
      if (mounted) setMicrophonePermission('unknown');
    });
    const handleDeviceChange = () => {
      if (microphonePermission === 'granted') void refreshMicrophones();
    };
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      mounted = false;
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [microphonePermission, refreshMicrophones]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = window.setInterval(() => {
      const startedAt = sessionRef.current?.startedAt;
      if (startedAt !== null && startedAt !== undefined) setElapsedMs(performance.now() - startedAt);
    }, 200);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => () => {
    if (countdownTimer.current !== null) window.clearTimeout(countdownTimer.current);
    const session = sessionRef.current;
    if (!session) return;
    session.cancelled = true;
    stopTracks(session.streams);
    sessionRef.current = null;
    void window.localLoom.abortRecording(session.recordingId);
  }, []);

  const finishCapture = (session: CaptureSession): Promise<void> => {
    if (session.stopPromise) return session.stopPromise;
    actionLocked.current = true;
    setPhase('processing');

    session.stopPromise = (async () => {
      try {
        const recorder = session.recorder;
        if (!recorder) {
          if (!session.cancelled) throw new Error('Screen capture did not start.');
          stopTracks(session.streams);
          await window.localLoom.abortRecording(session.recordingId);
          if (sessionRef.current === session) sessionRef.current = null;
          setPhase('idle');
          return;
        }

        if (recorder.state !== 'inactive') {
          try {
            recorder.stop();
          } catch {
            if ((recorder.state as string) !== 'inactive') throw new Error('The video recorder could not stop cleanly.');
          }
        }
        await waitForRecorderStop(session.stopped);
        session.stoppedAt ??= performance.now();
        stopTracks(session.streams);
        await session.writeTail;

        if (session.cancelled) {
          await window.localLoom.abortRecording(session.recordingId);
          if (sessionRef.current === session) sessionRef.current = null;
          setCaptureError(null);
          setPhase('idle');
          return;
        }
        if (session.failure) throw new Error(session.failure);

        const result = await window.localLoom.finalizeRecording(session.recordingId);
        if (!result.ok) throw new Error(result.message);
        const durationMs = session.startedAt === null ? 0 : Math.max(0, (session.stoppedAt ?? performance.now()) - session.startedAt);
        sessionRef.current = null;
        setElapsedMs(durationMs);
        setPreview({
          recordingId: result.recordingId,
          previewUrl: result.previewUrl,
          sizeBytes: result.sizeBytes,
          durationMs,
          audioIncluded: session.audioIncluded,
        });
        setPhase('preview');
      } catch (error) {
        stopTracks(session.streams);
        await window.localLoom.abortRecording(session.recordingId).catch(() => undefined);
        if (sessionRef.current === session) sessionRef.current = null;
        if (session.cancelled) {
          setCaptureError(null);
          setPhase('idle');
          return;
        }
        setCaptureError(error instanceof Error ? error.message : 'The recording could not be completed. Try again.');
        if (error instanceof Error && /microphone/i.test(error.message)) {
          setMicrophoneError(error.message);
          void window.localLoom.getMicrophonePermission().then((permission) => setMicrophonePermission(permission.status));
        }
        setPhase('error');
      } finally {
        actionLocked.current = false;
      }
    })();

    return session.stopPromise;
  };

  const queueCaptureChunk = (session: CaptureSession, blob: Blob) => {
    if (blob.size === 0 || session.cancelled) return;
    if (session.pendingChunks >= MAX_PENDING_CHUNKS) {
      session.failure = 'The recording writer fell behind. The incomplete video was discarded; try again.';
      void finishCapture(session);
      return;
    }

    session.pendingChunks += 1;
    const write = session.writeTail.then(async () => {
      if (session.failure) throw new Error(session.failure);
      const chunk = await blob.arrayBuffer();
      const result = await window.localLoom.appendRecordingChunk(session.recordingId, chunk);
      if (!result.ok) throw new Error(result.message);
    }).finally(() => {
      session.pendingChunks -= 1;
    });
    session.writeTail = write;
    void write.catch((error: unknown) => {
      session.failure ??= error instanceof Error ? error.message : 'A video chunk could not be written.';
      void finishCapture(session);
    });
  };

  const beginCapture = async () => {
    setPhase('starting');
    setCaptureError(null);
    setElapsedMs(0);
    try {
      const begun = await window.localLoom.beginRecording();
      if (!begun.ok) {
        if (begun.error === 'source-unavailable') await refreshSources();
        throw new Error(begun.message);
      }

      let resolveStopped: () => void = () => undefined;
      const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
      const session: CaptureSession = {
        recordingId: begun.recordingId,
        streams: [],
        audioIncluded: selectedMicrophoneId !== null,
        recorder: null,
        writeTail: Promise.resolve(),
        pendingChunks: 0,
        failure: null,
        cancelled: false,
        startedAt: null,
        stoppedAt: null,
        stopped,
        resolveStopped,
        stopPromise: null,
      };
      sessionRef.current = session;

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 } },
        audio: false,
      });
      session.streams.push(stream);
      if (session.cancelled) {
        stopTracks(session.streams);
        await window.localLoom.abortRecording(session.recordingId);
        if (sessionRef.current === session) sessionRef.current = null;
        setPhase('idle');
        actionLocked.current = false;
        return;
      }
      if (stream.getVideoTracks().length !== 1 || stream.getAudioTracks().length > 0) {
        throw new Error('Screen capture did not return a video-only stream.');
      }

      let microphoneStream: MediaStream | null = null;
      if (selectedMicrophoneId !== null) {
        try {
          microphoneStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: selectedMicrophoneId } },
            video: false,
          });
        } catch (error) {
          const name = error instanceof Error ? error.name : '';
          if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
            throw new Error('Microphone access was denied. Choose Off or allow Local Loom in System Settings → Privacy & Security → Microphone.');
          }
          if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
            throw new Error('The selected microphone is unavailable. Refresh the microphone list or choose Off.');
          }
          if (name === 'NotReadableError' || name === 'TrackStartError') {
            throw new Error('The selected microphone could not start. Close other apps using it, or choose Off.');
          }
          throw new Error('Could not start the selected microphone. Choose Off or try another input.');
        }
        session.streams.push(microphoneStream);
        if (session.cancelled) {
          stopTracks(session.streams);
          await window.localLoom.abortRecording(session.recordingId);
          if (sessionRef.current === session) sessionRef.current = null;
          setPhase('idle');
          actionLocked.current = false;
          return;
        }
        if (microphoneStream.getAudioTracks().length !== 1 || microphoneStream.getVideoTracks().length > 0) {
          throw new Error('The selected microphone did not return an audio-only stream.');
        }
      }

      const audioTracks = microphoneStream?.getAudioTracks() ?? [];
      const supportedMime = (audioTracks.length > 0 ? [
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm',
      ] : [
        'video/webm;codecs=vp8',
        'video/webm;codecs=vp9',
        'video/webm',
      ]).find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
      if (!supportedMime) throw new Error('This system does not support WebM screen recording.');

      const recorderStream = new MediaStream([...stream.getVideoTracks(), ...audioTracks]);
      const recorder = new MediaRecorder(recorderStream, { mimeType: supportedMime });
      session.recorder = recorder;
      recorder.addEventListener('dataavailable', (event) => queueCaptureChunk(session, event.data));
      recorder.addEventListener('start', () => {
        if (session.cancelled || session.stopPromise) return;
        session.startedAt = performance.now();
        actionLocked.current = false;
        setPhase('recording');
      }, { once: true });
      recorder.addEventListener('stop', () => {
        session.stoppedAt = performance.now();
        stopTracks(session.streams);
        session.resolveStopped();
      }, { once: true });
      recorder.addEventListener('error', () => {
        session.failure ??= 'The browser recorder encountered an error. The incomplete video was discarded.';
        void finishCapture(session);
      }, { once: true });
      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => {
          if (!session.stopPromise) void finishCapture(session);
        }, { once: true });
      }
      for (const track of audioTracks) {
        track.addEventListener('ended', () => {
          if (session.stopPromise) return;
          session.failure = 'The selected microphone disconnected. The incomplete recording was discarded; reconnect it or choose Off.';
          void finishCapture(session);
        }, { once: true });
      }
      recorder.start(TIMESLICE_MS);
    } catch (error) {
      const session = sessionRef.current;
      if (session) {
        stopTracks(session.streams);
        await window.localLoom.abortRecording(session.recordingId).catch(() => undefined);
        if (sessionRef.current === session) sessionRef.current = null;
      }
      if (session?.cancelled) {
        setCaptureError(null);
        setPhase('idle');
        actionLocked.current = false;
        return;
      }
      const name = error instanceof Error ? error.name : '';
      const message = name === 'NotAllowedError' || name === 'PermissionDeniedError'
        ? 'Screen access was denied. Allow Local Loom in System Settings → Privacy & Security → Screen & System Audio Recording, then restart the app.'
        : error instanceof Error ? error.message : 'Could not start screen capture. Refresh the source list and try again.';
      setCaptureError(message);
      if (/microphone/i.test(message)) {
        setMicrophoneError(message);
        void window.localLoom.getMicrophonePermission().then((permission) => setMicrophonePermission(permission.status));
      }
      setPhase('error');
      actionLocked.current = false;
    }
  };

  const tickCountdown = (value: number) => {
    setCountdown(value);
    countdownTimer.current = window.setTimeout(() => {
      if (value > 1) tickCountdown(value - 1);
      else {
        countdownTimer.current = null;
        void beginCapture();
      }
    }, 1000);
  };

  const startCountdown = () => {
    if (actionLocked.current || selectedSourceId === null) return;
    actionLocked.current = true;
    setCaptureError(null);
    setPhase('countdown');
    tickCountdown(3);
  };

  const cancelCountdown = () => {
    if (countdownTimer.current !== null) window.clearTimeout(countdownTimer.current);
    countdownTimer.current = null;
    actionLocked.current = false;
    setPhase('idle');
  };

  const cancelStartingCapture = () => {
    const session = sessionRef.current;
    if (!session) return;
    session.cancelled = true;
    if (session.recorder) void finishCapture(session);
    else {
      stopTracks(session.streams);
      setCaptureError('Capture start cancelled. If a macOS permission prompt is open, dismiss it to return home.');
      void window.localLoom.abortRecording(session.recordingId);
    }
  };

  const selectMicrophone = async (value: string) => {
    setMicrophoneError(null);
    if (value === 'off') {
      setSelectedMicrophoneId(null);
      return;
    }
    if (value !== 'enable') {
      setSelectedMicrophoneId(value);
      return;
    }

    setIsRequestingMicrophone(true);
    try {
      const permission = await window.localLoom.requestMicrophoneAccess();
      setMicrophonePermission(permission.status);
      if (!permission.ok) {
        setSelectedMicrophoneId(null);
        setMicrophoneError(permission.message);
        return;
      }
      const inputs = await refreshMicrophones(true);
      if (inputs.length === 0) setSelectedMicrophoneId(null);
    } catch {
      setSelectedMicrophoneId(null);
      setMicrophoneError('Could not load microphone inputs. Choose Off or try again.');
    } finally {
      setIsRequestingMicrophone(false);
    }
  };

  const returnToSourcePicker = () => {
    setCaptureError(null);
    setPhase('idle');
    actionLocked.current = false;
  };

  const replayPreview = async () => {
    const video = previewVideoRef.current;
    if (!video || previewPlaybackState === 'loading') return;
    setPreviewPlaybackError(null);
    try {
      video.currentTime = 0;
      await video.play();
      setPreviewPlaybackState('playing');
    } catch {
      setPreviewPlaybackState('error');
      setPreviewPlaybackError('The preview could not be played. Reload it and try again.');
    }
  };

  const reloadPreview = () => {
    const video = previewVideoRef.current;
    if (!video) return;
    setPreviewPlaybackError(null);
    setPreviewPlaybackState('loading');
    video.load();
  };

  const updatePreviewDuration = (video: HTMLVideoElement, recordingId: string) => {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    const durationMs = Math.round(video.duration * 1000);
    setPreview((current) => current?.recordingId === recordingId ? { ...current, durationMs } : current);
    setPreviewPlaybackError(null);
  };

  const markPreviewReady = () => {
    setPreviewPlaybackState((current) => current === 'playing' ? current : 'ready');
    setPreviewPlaybackError(null);
  };

  const recordAnother = async () => {
    if (previewActionLocked.current || saveActionLocked.current || driveUploadLocked.current || driveSharingLocked.current || driveLinkActionLocked.current || !preview) return;
    previewActionLocked.current = true;
    setIsDiscardingPreview(true);
    setPreviewActionError(null);
    try {
      previewVideoRef.current?.pause();
      const result = await window.localLoom.discardRecording(preview.recordingId);
      if (!result.ok) {
        setPreviewActionError(result.message);
        return;
      }
      if (previewVideoRef.current) {
        previewVideoRef.current.removeAttribute('src');
        previewVideoRef.current.load();
      }
      setPreview(null);
      setElapsedMs(0);
      setCaptureError(null);
      setSavedRecording(null);
      setPreviewPlaybackError(null);
      setPhase('idle');
    } catch {
      setPreviewActionError('The temporary preview could not be discarded. You can keep using this preview and try again.');
    } finally {
      previewActionLocked.current = false;
      setIsDiscardingPreview(false);
    }
  };

  const saveLocally = async () => {
    if (saveActionLocked.current || previewActionLocked.current || !preview) return;
    saveActionLocked.current = true;
    setIsSavingRecording(true);
    setSaveError(null);
    try {
      const result = await window.localLoom.saveRecording(preview.recordingId);
      if (!result.ok) {
        setSaveError(result.message);
        return;
      }
      if (result.canceled) return;
      setSavedRecording({ path: result.savedPath, sizeBytes: result.sizeBytes });
    } catch {
      setSaveError('The recording could not be saved. Choose another location or try again.');
    } finally {
      saveActionLocked.current = false;
      setIsSavingRecording(false);
    }
  };

  const uploadToDrive = async () => {
    if (driveUploadLocked.current || previewActionLocked.current || !preview || driveUploadResult) return;
    driveUploadLocked.current = true;
    setIsUploadingDrive(true);
    setIsConnectingForUpload(false);
    setDriveUploadError(null);
    setDriveUploadProgress({ recordingId: preview.recordingId, acknowledgedBytes: 0, totalBytes: preview.sizeBytes });
    try {
      if (!googleAuthStatus?.connected) {
        setIsConnectingForUpload(true);
        setGoogleAuthBusy(true);
        const connection = await window.localLoom.connectGoogle();
        setGoogleAuthStatus(connection.status);
        setGoogleAuthBusy(false);
        setIsConnectingForUpload(false);
        if (!connection.ok) {
          setDriveUploadError(connection.message);
          return;
        }
      }
      const result = await window.localLoom.uploadRecordingToDrive(preview.recordingId, driveSharingChoice);
      if (!result.ok) {
        setDriveUploadError(result.message);
        if (result.uploaded) setDriveUploadResult(result.uploaded);
        if (result.error === 'auth-required') {
          setGoogleAuthStatus(await window.localLoom.getGoogleAuthStatus());
        } else if (result.error === 'sharing-failed') {
          setGoogleAuthStatus(await window.localLoom.getGoogleAuthStatus());
        }
        return;
      }
      setDriveUploadResult(result);
      setDriveUploadProgress({ recordingId: preview.recordingId, acknowledgedBytes: result.sizeBytes, totalBytes: result.sizeBytes });
    } catch {
      setDriveUploadError('The recording could not be uploaded. Keep the preview and try again.');
    } finally {
      setGoogleAuthBusy(false);
      setIsConnectingForUpload(false);
      setIsUploadingDrive(false);
      driveUploadLocked.current = false;
    }
  };

  const retryDriveSharing = async () => {
    if (!preview || !driveUploadResult || driveSharingChoice !== 'anyone' || driveSharingLocked.current || previewActionLocked.current) return;
    driveSharingLocked.current = true;
    setIsSharingDrive(true);
    setDriveUploadError(null);
    setDriveLinkMessage(null);
    try {
      if (!googleAuthStatus?.connected) {
        setGoogleAuthBusy(true);
        const connection = await window.localLoom.connectGoogle();
        setGoogleAuthStatus(connection.status);
        setGoogleAuthBusy(false);
        if (!connection.ok) {
          setDriveUploadError(connection.message);
          return;
        }
      }
      const result = await window.localLoom.enableAnyoneDriveLink(preview.recordingId);
      if (result.ok) setDriveUploadResult(result.result);
      else {
        if (result.uploaded) setDriveUploadResult(result.uploaded);
        setDriveUploadError(result.message);
      }
    } catch {
      setDriveUploadError('The recording is still private. Anyone with the link access could not be enabled; try again.');
    } finally {
      setGoogleAuthBusy(false);
      driveSharingLocked.current = false;
      setIsSharingDrive(false);
    }
  };

  const useDriveLinkAction = async (action: 'copy' | 'open') => {
    if (!preview || !driveUploadResult || driveLinkActionLocked.current) return;
    driveLinkActionLocked.current = true;
    setDriveLinkBusy(true);
    setDriveLinkMessage(null);
    try {
      const result = action === 'copy'
        ? await window.localLoom.copyDriveLink(preview.recordingId)
        : await window.localLoom.openDriveLink(preview.recordingId);
      if (!result.ok) setDriveLinkMessage(result.message);
      else setDriveLinkMessage(action === 'copy' ? 'Drive link copied.' : 'Opened Google Drive in your browser.');
    } catch {
      setDriveLinkMessage(action === 'copy' ? 'The Drive link could not be copied. Try again.' : 'Google Drive could not be opened. Try again.');
    } finally {
      driveLinkActionLocked.current = false;
      setDriveLinkBusy(false);
    }
  };

  const chooseSource = async (sourceId: string) => {
    setIsSelecting(true);
    setSourceError(null);
    try {
      const result = await window.localLoom.selectSource(sourceId);
      if (result.ok) {
        setSelectedSourceId(result.selectedSourceId);
        return;
      }
      if (result.error === 'stale-source' || result.error === 'enumeration-failed') {
        await refreshSources();
      }
      setSourceError(result.message);
    } catch {
      setSourceError('Could not select that source. Refresh the list and try again.');
    } finally {
      setIsSelecting(false);
    }
  };

  const busy = isRefreshing || isSelecting || isRequestingMicrophone || phase !== 'idle';

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#home" aria-label="Local Loom home">
          <span className="brand-mark"><span /></span>
          <span>local loom</span>
        </a>
        <div className="topbar-right">
          <span className="local-badge"><span className="status-dot" /> Saved on this Mac</span>
          <button className="avatar" aria-label="Account menu">M</button>
        </div>
      </header>

      <section className="workspace">
        <div className="welcome">
          <div className="eyebrow"><span className="eyebrow-rule" /> YOUR PERSONAL STUDIO</div>
          <h1>Make it easy<br />to <em>show</em> what you mean.</h1>
          <p className="intro">A little screen recording goes a long way.<br />Choose what to capture and you’re ready.</p>
        </div>

        {phase === 'preview' && preview ? (
          <section className="preview-card" aria-labelledby="preview-title">
            <div className="preview-heading">
              <div>
                <span className="step-label">RECORDING READY</span>
                <h2 id="preview-title">Your screen recording</h2>
              </div>
              <span className="complete-mark" aria-label="Ready">✓</span>
            </div>
            <div className="video-preview-wrap">
              <video
                ref={previewVideoRef}
                className="video-preview"
                src={preview.previewUrl}
                controls
                preload="metadata"
                playsInline
                aria-label="Recording preview"
                onLoadStart={() => {
                  setPreviewPlaybackState('loading');
                  setPreviewPlaybackError(null);
                }}
                onLoadedMetadata={(event) => updatePreviewDuration(event.currentTarget, preview.recordingId)}
                onDurationChange={(event) => updatePreviewDuration(event.currentTarget, preview.recordingId)}
                onCanPlay={markPreviewReady}
                onPlaying={() => setPreviewPlaybackState('playing')}
                onPause={(event) => setPreviewPlaybackState((current) => current === 'loading' ? current : event.currentTarget.ended ? 'ended' : 'paused')}
                onEnded={() => setPreviewPlaybackState('ended')}
                onError={() => {
                  setPreviewPlaybackState('error');
                  setPreviewPlaybackError('This preview could not be loaded or played. Reload it and try again.');
                }}
              />
              {previewPlaybackState === 'loading' && (
                <div className="video-preview-message" role="status" aria-live="polite">
                  <span className="capture-spinner" /> Preparing your preview…
                </div>
              )}
              {previewPlaybackState === 'error' && (
                <div className="video-preview-message video-preview-error" role="alert">
                  <span>{previewPlaybackError ?? 'This preview could not be played.'}</span>
                  <button className="quiet-action" onClick={reloadPreview}>Reload preview</button>
                </div>
              )}
            </div>
            <div className="preview-details">
              <span><small>DURATION</small><strong>{formatDuration(preview.durationMs)}</strong></span>
              <span><small>FILE SIZE</small><strong>{formatBytes(preview.sizeBytes)}</strong></span>
              <span className="format-chip">{preview.audioIncluded ? 'WEBM · MIC AUDIO' : 'WEBM · VIDEO ONLY'}</span>
            </div>
            <fieldset className="drive-sharing-picker" disabled={Boolean(driveUploadResult) || isUploadingDrive || isSharingDrive}>
              <legend>Link access</legend>
              <label>
                <input type="radio" name="drive-sharing" value="private" checked={driveSharingChoice === 'private'} onChange={() => setDriveSharingChoice('private')} />
                <span><strong>Private</strong><small>Only you can access</small></span>
              </label>
              <label>
                <input type="radio" name="drive-sharing" value="anyone" checked={driveSharingChoice === 'anyone'} onChange={() => setDriveSharingChoice('anyone')} />
                <span><strong>Anyone with the link</strong><small>Anyone with the link can view</small></span>
              </label>
            </fieldset>
            {previewActionError && <p className="preview-action-error" role="alert">{previewActionError}</p>}
            {saveError && <p className="preview-action-error" role="alert">{saveError}</p>}
            {savedRecording && (
              <div className="saved-recording-status" role="status" aria-live="polite">
                <strong>Saved locally · {formatBytes(savedRecording.sizeBytes)}</strong>
                <code>{savedRecording.path}</code>
              </div>
            )}
            {driveUploadError && <p className="preview-action-error" role="alert">{driveUploadError}</p>}
            {isUploadingDrive && driveUploadProgress && (
              <div className="drive-upload-progress" role="status" aria-live="polite">
                  <div><strong>{isConnectingForUpload ? 'Connecting to Google…' : driveSharingChoice === 'anyone' && driveUploadProgress.acknowledgedBytes >= driveUploadProgress.totalBytes ? 'Enabling link access…' : 'Uploading to your Drive…'}</strong><span>{formatBytes(driveUploadProgress.acknowledgedBytes)} / {formatBytes(driveUploadProgress.totalBytes)}</span></div>
                <progress max={driveUploadProgress.totalBytes} value={driveUploadProgress.acknowledgedBytes} aria-label="Drive upload progress" />
              </div>
            )}
            {driveUploadResult && (
              <div className="drive-upload-success" role="status" aria-live="polite">
                <strong>Uploaded to your My Drive · {driveUploadResult.sharing === 'anyone' ? 'Anyone with the link can view' : 'Private · Only you can access'}</strong>
                <span>{driveUploadResult.name} · {formatBytes(driveUploadResult.sizeBytes)}</span>
                <small>File ID · {driveUploadResult.fileId}</small>
                <code>{driveUploadResult.webViewLink}</code>
                {driveSharingChoice === 'anyone' && driveUploadResult.sharing === 'private' && (
                  <button className="quiet-action retry-sharing-button" disabled={isSharingDrive} onClick={() => void retryDriveSharing()}>
                    {isSharingDrive ? 'Enabling link access…' : 'Retry link sharing'}
                  </button>
                )}
                <div className="drive-link-actions">
                  <button className="quiet-action" disabled={driveLinkBusy} onClick={() => void useDriveLinkAction('copy')}>Copy link</button>
                  <button className="quiet-action" disabled={driveLinkBusy} onClick={() => void useDriveLinkAction('open')}>Open in Google Drive</button>
                </div>
                {driveLinkMessage && <small className="drive-link-message" role="status">{driveLinkMessage}</small>}
              </div>
            )}
            <div className="preview-footer">
              <span className="preview-note">Your video is stored temporarily on this Mac.</span>
              <div className="preview-actions">
                <button className="replay-button" onClick={() => void replayPreview()} disabled={previewPlaybackState === 'loading' || previewPlaybackState === 'error'}>
                  {previewPlaybackState === 'ended' ? 'Play again' : 'Replay'}
                </button>
                <button className="save-recording-button" onClick={() => void saveLocally()} disabled={isSavingRecording || isDiscardingPreview}>
                  {isSavingRecording ? 'Choose save location…' : 'Save locally'}
                </button>
                <button className="drive-upload-button" onClick={() => void uploadToDrive()} disabled={isUploadingDrive || isDiscardingPreview || isSharingDrive || Boolean(driveUploadResult) || !googleAuthStatus?.configured || !googleAuthStatus.secureStorageAvailable}>
                  {isUploadingDrive ? (isConnectingForUpload ? 'Connecting…' : 'Uploading…') : driveUploadResult ? 'Uploaded' : googleAuthStatus?.connected ? 'Upload to Drive' : 'Connect & upload'}
                </button>
                <button className="record-another-button" onClick={() => void recordAnother()} disabled={isDiscardingPreview || isSavingRecording || isUploadingDrive || isSharingDrive || driveLinkBusy}>
                  {isDiscardingPreview ? 'Removing temporary video…' : 'Record another'}
                </button>
              </div>
            </div>
          </section>
        ) : (
        <section className="setup-card" aria-labelledby="setup-title">
          <div className="card-heading">
            <div>
              <span className="step-label">LET’S GET SET UP</span>
              <h2 id="setup-title">Your recording</h2>
            </div>
            <span className="step-count">01 <i /> 03</span>
          </div>

          <div className="source-picker-heading">
            <div className="source-picker-title">
              <div className="setting-icon"><ScreenGlyph /></div>
              <div className="setting-copy">
                <strong>Screen or window</strong>
                <span>Choose what you’d like to capture</span>
              </div>
            </div>
            <button className="refresh-button" onClick={() => void refreshSources()} disabled={busy}>
              <span className={isRefreshing ? 'refresh-icon spinning' : 'refresh-icon'} aria-hidden="true">↻</span>
              {isRefreshing ? 'Refreshing' : 'Refresh'}
            </button>
          </div>

          {phase === 'idle' && sourceError ? (
            <div className="source-message source-error" role="alert">
              <span className="message-mark" aria-hidden="true">!</span>{sourceError}
            </div>
          ) : phase === 'idle' && sources.length === 0 ? (
            <div className="source-message source-empty" aria-live="polite">
              {isRefreshing ? 'Looking for available screens and windows…' : 'No screens or windows found. Refresh to try again.'}
            </div>
          ) : phase === 'idle' ? (
            <div className="source-grid" aria-label="Available screens and windows">
              {sources.map((source) => (
                <button
                  className={`source-option${selectedSourceId === source.id ? ' selected' : ''}`}
                  key={source.id}
                  type="button"
                  aria-pressed={selectedSourceId === source.id}
                  disabled={busy}
                  onClick={() => void chooseSource(source.id)}
                >
                  <span className="thumbnail-wrap">
                    {source.thumbnailDataUrl ? (
                      <img src={source.thumbnailDataUrl} alt="" className="source-thumbnail" />
                    ) : (
                      <span className="thumbnail-fallback"><ScreenGlyph /></span>
                    )}
                    {selectedSourceId === source.id && <span className="selected-check" aria-label="Selected">✓</span>}
                  </span>
                  <span className="source-option-label">
                    <span className="source-kind">{source.type === 'screen' ? 'DISPLAY' : 'WINDOW'}</span>
                    <strong title={source.name}>{source.name}</strong>
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="setting-row">
            <div className="setting-icon mic"><MicGlyph /></div>
            <div className="setting-copy">
              <strong>Microphone</strong>
              <span>{selectedMicrophoneId ? 'Your voice will be included' : 'Off by default; no system audio'}</span>
            </div>
            <select
              className="select-button mic-select"
              aria-label="Microphone input"
              value={selectedMicrophoneId ?? 'off'}
              onChange={(event) => void selectMicrophone(event.target.value)}
              disabled={busy}
            >
              <option value="off">Off</option>
              {microphonePermission === 'granted' ? (
                microphones.length > 0
                  ? microphones.map((microphone) => <option key={microphone.deviceId} value={microphone.deviceId}>{microphone.label}</option>)
                  : <option value="enable">Refresh microphones…</option>
              ) : microphonePermission === 'denied' || microphonePermission === 'restricted' ? (
                <option value="enable">Check microphone access…</option>
              ) : (
                <option value="enable">Enable microphone…</option>
              )}
            </select>
          </div>
          {microphoneError && phase === 'idle' && (
            <div className="microphone-message" role="status">
              <span className="message-mark" aria-hidden="true">!</span>
              <span>{microphoneError}</span>
              <button className="quiet-action" onClick={() => void selectMicrophone('enable')} disabled={isRequestingMicrophone}>
                {isRequestingMicrophone ? 'Checking…' : 'Try again'}
              </button>
            </div>
          )}

          {phase === 'countdown' && (
            <div className="capture-state countdown-state" aria-live="assertive">
              <div className="countdown-number">{countdown}</div>
              <div className="capture-state-copy"><strong>Get ready</strong><span>Recording starts in {countdown}…</span></div>
              <button className="quiet-action" onClick={cancelCountdown}>Cancel</button>
            </div>
          )}
          {phase === 'starting' && (
            <div className="capture-state" aria-live="polite">
              <span className="capture-spinner" />
              <div className="capture-state-copy"><strong>Starting screen capture</strong><span>Waiting for macOS screen access…</span></div>
              <button className="quiet-action" onClick={cancelStartingCapture}>Cancel</button>
            </div>
          )}
          {phase === 'recording' && (
            <div className="capture-state recording-state" aria-live="polite">
              <span className="live-dot" />
              <div className="capture-state-copy"><strong>Recording</strong><span>{formatDuration(elapsedMs)} · {selectedMicrophoneId ? 'Screen and microphone' : 'Screen only'}</span></div>
              <button className="stop-button" onClick={() => { const session = sessionRef.current; if (session) void finishCapture(session); }}><span className="stop-square" /> Stop recording</button>
            </div>
          )}
          {phase === 'processing' && (
            <div className="capture-state" aria-live="polite"><span className="capture-spinner" /><div className="capture-state-copy"><strong>Finishing your video</strong><span>Writing the final video data…</span></div></div>
          )}
          {phase === 'error' && (
            <div className="capture-state capture-error" role="alert">
              <div className="message-mark">!</div>
              <div className="capture-state-copy"><strong>Recording didn’t finish</strong><span>{captureError}</span></div>
              <button className="quiet-action" onClick={returnToSourcePicker}>Back</button>
            </div>
          )}
          {phase === 'idle' && (
            <div className="card-footer">
              <div className="record-hint"><span className="hint-icon">i</span> {selectedSourceId ? 'Source selected — ready when you are' : 'Choose a screen to get started'}</div>
              <button className="record-button" disabled={selectedSourceId === null} onClick={startCountdown}><span className="record-dot" /> Start recording</button>
            </div>
          )}
        </section>
        )}

        <section className="drive-card" aria-label="Google Drive connection">
          <div className="drive-brand"><DriveGlyph /><span>Google Drive</span></div>
          <div className="drive-status"><span className={`drive-dot${googleAuthStatus?.connected ? ' connected' : ''}`} />{googleAuthStatus?.connected ? 'Connected' : !googleAuthStatus?.secureStorageAvailable ? 'Secure storage unavailable' : googleAuthStatus?.configured ? 'Not connected' : 'OAuth not configured'}</div>
          {googleAuthStatus?.connected
            ? <button className="connect-button" disabled={googleAuthBusy || isUploadingDrive} onClick={() => void disconnectGoogle()}>{googleAuthBusy ? 'Disconnecting…' : 'Disconnect'}</button>
            : <button className="connect-button" disabled={googleAuthBusy || !googleAuthStatus?.configured || !googleAuthStatus.secureStorageAvailable} onClick={() => void connectGoogle()}>{googleAuthBusy ? 'Connecting…' : 'Connect'} <span aria-hidden="true">↗</span></button>}
        </section>
        {googleAuthError && <p className="google-auth-message" role="alert">{googleAuthError}</p>}

        <p className="privacy-note"><span aria-hidden="true">◈</span> Your recordings stay on your Mac unless you choose to share.</p>
      </section>

      <footer className="footer">
        <span>LOCAL LOOM <b>·</b> A QUIETER WAY TO COMMUNICATE</span>
        <span className="version">v{window.localLoom.appVersion}</span>
      </footer>
    </main>
  );
}
