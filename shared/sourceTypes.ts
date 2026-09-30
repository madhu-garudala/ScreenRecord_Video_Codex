export type CaptureSourceType = 'screen' | 'window';

export type ScreenPermissionStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown';

export interface CaptureSource {
  id: string;
  name: string;
  type: CaptureSourceType;
  thumbnailDataUrl: string;
}

export type SourceListResult =
  | {
      ok: true;
      sources: CaptureSource[];
      selectedSourceId: string | null;
      screenPermission: ScreenPermissionStatus;
    }
  | {
      ok: false;
      sources: CaptureSource[];
      selectedSourceId: null;
      screenPermission: ScreenPermissionStatus;
      error: 'screen-permission' | 'enumeration-failed';
      message: string;
    };

export type SelectSourceResult =
  | { ok: true; selectedSourceId: string }
  | {
      ok: false;
      error: 'invalid-source' | 'stale-source' | 'enumeration-failed';
      message: string;
    };
