# Architecture and decisions

## Decision summary

| Decision | Choice and reason |
| --- | --- |
| Desktop shell | **Electron.** `desktopCapturer`, `session.setDisplayMediaRequestHandler`, `systemPreferences`, native dialogs, clipboard, `safeStorage`, and packaging are available in one JavaScript runtime. Tauri would require more native/plugin work for capture and permissions. Bundle size is less important than a reliable one-developer path. |
| UI | React + TypeScript + Vite. Small components and one explicit phase state. No Redux or state-machine package. |
| Capture | Electron main enumerates `desktopCapturer` sources and routes a selected source to the renderer's `getDisplayMedia()` request. Renderer records the returned video track via `MediaRecorder`. Separate `getUserMedia({audio})` provides optional selected mic; combine tracks into one `MediaStream`. No system audio request. |
| Format | WebM using a `MediaRecorder.isTypeSupported()` check, preferring VP8/Opus when a microphone is present and VP8 without audio otherwise, with a supported WebM fallback. Save/upload extension and MIME match the actual recorder MIME. MP4 support varies by Chromium/OS and cannot be assumed. FFmpeg is **not required** for MVP; adding it creates binary packaging, licensing, and conversion failure concerns. Some default macOS players may not open WebM; Chromium, VLC, and Drive can play it. |
| File path | Main writes `MediaRecorder` chunks in order to a unique temp file under app-owned temporary storage; main owns only the active recording ID. Renderer never chooses an arbitrary write path. Save uses a native dialog then copies this finalized file. Preview is served from an app-owned, read-only media protocol or another narrowly scoped mechanism verified to support video seeking/range requests. |
| Google OAuth | Google **Desktop application** OAuth client, system browser, loopback callback on `127.0.0.1` with ephemeral port, authorization code + PKCE S256 and random `state`. Use `https://www.googleapis.com/auth/drive.file`, offline access, and refresh in main process. No embedded browser, password entry, custom backend, or deprecated OOB flow. |
| Token storage | Main encrypts refresh-token data using Electron `safeStorage` (macOS Keychain backed) and stores only encrypted bytes in an app-user-data file with restrictive permissions. Access tokens stay in memory. Fail closed when secure storage is unavailable. Desktop OAuth client ID is a public identifier; a packaged desktop client secret cannot be treated as confidential. Do not put real user tokens in source or logs. |
| Drive upload | Main initiates a Drive v3 resumable upload of the finalized temp file, streams bytes with bounded memory, and reports progress. It requests `id,name,mimeType,size,webViewLink` and uses the returned `webViewLink`; only a validated Drive URL reaches Open/Copy. Private is default. Anyone-with-link triggers `permissions.create` with `type:anyone`, `role:reader`. No folder in MVP. |

## Process diagram

```text
┌─────────────────────────────────────────────────────────────┐
│ Renderer: React                                             │
│ source/mic choice → countdown → MediaRecorder → preview UI  │
│       │ selected source       │ ordered binary chunks       │
└───────┼───────────────────────┼─────────────────────────────┘
        │ typed preload API     │ typed preload API
┌───────▼───────────────────────▼─────────────────────────────┐
│ Electron main                                                │
│ desktopCapturer + display request handler                    │
│ recording temp-file writer → native Save dialog/file copy   │
│ app-owned preview protocol                                   │
│ OAuth loopback + PKCE → safeStorage/Keychain                  │
│ Drive resumable upload → permission create → webViewLink     │
└──────────┬───────────────────────────┬──────────────────────┘
           │                           │
     macOS screen/mic              Google browser/Drive API
     permission & filesystem       (only network dependency)
```

## Source and recording flow

1. Main calls `desktopCapturer.getSources({types:['screen','window']})`, returns only ID, display name, type, and small thumbnail data URL. Renderer refreshes and selects an ID.
2. Main stores the selected source ID for the upcoming capture request. Its `setDisplayMediaRequestHandler` resolves the ID against a fresh source list and grants **video only**. Avoid `getUserMedia` legacy desktop constraints. `getDisplayMedia` cannot specify a source `deviceId`; selection must be enforced in the main handler. Serialize start requests so one selection cannot be stolen by another request.
3. The renderer obtains video, optionally obtains selected microphone audio via `getUserMedia`, combines tracks, constructs `MediaRecorder`, and starts it after the three-second countdown. If any step fails, it stops tracks already acquired and returns to a recoverable state.
4. On `dataavailable`, send each nonempty chunk through a bounded, ordered write path to main. Main awaits ordered writes and acknowledges them. Do not concatenate all chunks in memory. A 1–5 second timeslice balances IPC overhead and memory. The writer queues or rejects backpressure explicitly; a rejected write stops recording with an error.
5. Stop is idempotent. Wait for recorder `stop` and final `dataavailable`, flush pending writes, close and fsync the temp file as appropriate, then release all tracks and revoke any object URLs. `ended` on the screen track follows the same stop path. Empty output is an error.
6. Main exposes a restricted preview URL for the current finalized recording. The implementation must confirm seeking works and cannot traverse arbitrary paths. A new recording never deletes a currently needed file before user actions complete. Delete app-owned temp files at a clear lifecycle point; never delete user-saved copies.

The initial UI has `IDLE → COUNTDOWN → RECORDING → PROCESSING → PREVIEW → UPLOADING → UPLOAD_COMPLETE`, plus recoverable `ERROR` states. Source enumeration can be a loading flag rather than a separate phase. Centralize transitions in one hook/reducer; guard duplicate Start/Stop/Upload actions.

## macOS permissions

- Query `systemPreferences.getMediaAccessStatus('screen'|'microphone')`. Electron can ask for **microphone** access via `askForMediaAccess('microphone')`; it cannot prompt for screen via that method. The screen capture request invokes the OS path. Denied/restricted screen access requires System Settings instructions and often an app restart.
- Use the packaged app's Info.plist `NSMicrophoneUsageDescription`; add only capture purpose strings needed by chosen APIs. Screen/system-audio permission names vary by macOS release. Do not request system audio in this MVP.
- During `npm run dev`, macOS may attribute permission to Electron or the launching terminal. A signed packaged app has a stable identity and should be used for final permission QA.
- On permission errors, distinguish screen from microphone and provide an Off option for microphone.

## File and preview boundary

All filesystem operations stay in main. IPC methods are purpose-specific: list sources, get permission status, select capture source, begin/append/finalize/abort recording, save current recording, and upload current recording. Main validates the sender, recording ID, chunk type/size, state, and allowed transitions. It never accepts renderer-supplied absolute paths for reading, writing, previewing, or uploading. The Save dialog result is the only chosen output path. Keep a size limit per IPC chunk and bound pending writes. Do not load remote pages into the app renderer. Use a restrictive CSP and validate external URLs before `shell.openExternal`.

## Google authentication and storage

The app starts a listener on a random loopback port bound to `127.0.0.1`, creates high-entropy PKCE verifier and state, opens Google's authorization URL in the default browser, and waits with a timeout. It checks callback path and state, exchanges the one-time code with Google's token endpoint, closes the listener, and retains the refresh token. Refresh-token replacement is atomic; if Google omits a new refresh token, keep the prior one. On `invalid_grant`, delete unusable token state and ask to reconnect. Never expose tokens or authorization codes to React. A single OAuth attempt at a time prevents callback confusion.

Configure `GOOGLE_OAUTH_CLIENT_ID` for development and packaged builds. Google Desktop client credentials are installed-app credentials and cannot be made secret inside the binary; PKCE and loopback state provide the relevant protection. If Google's generated client JSON is used, keep it local and gitignored. Do not embed a service-account key. `drive.file` permits files created/opened by the app and is enough for upload and permission changes on those files. A Google consent screen in External/Testing status can issue refresh tokens that expire after seven days; documentation must explain this operational limitation.

## Drive operation

Initiate `files.create?uploadType=resumable&fields=id,name,mimeType,size,webViewLink` with a WebM name/MIME. Stream the local temp file to the session URI in chunks, tracking acknowledged bytes. Handle Drive's `308 Resume Incomplete` and `Range`, retry transient 5xx/rate-limit errors with bounded exponential backoff, and avoid restarting blindly after an uncertain final response. Finish by using file metadata (request `files.get` if needed) for `webViewLink`. Private requires no permission call. For anyone-with-link, call `permissions.create`; if it fails, preserve the file ID and report that upload succeeded but sharing did not. The recipient of a private link must already have access; the UI must state that.

## Packaging and security

Use one npm package and a conventional Electron packaging tool only when Milestone 11 arrives. Target Apple Silicon first; document x64/universal as later work. A distributable DMG/app needs stable bundle ID, macOS code signing and preferably notarization for frictionless installation and stable Keychain/TCC identity. Local unsigned builds can be used for development but do not represent final permission behavior. The current machine has Command Line Tools but not full Xcode; signing/notarization may need additional Apple setup.

Keep `contextIsolation: true`, `nodeIntegration: false`, and renderer sandbox enabled. The preload exposes explicit functions only; never expose raw `ipcRenderer`, `fs`, `shell`, or `safeStorage`. Restrict navigation and new windows; open only expected `https://drive.google.com` or `https://docs.google.com` links after URL validation. Handle protocol requests only for current app-owned recording IDs. Credentials and tokens stay in main. Logs redact secrets and user file paths when possible.

## Evidence and known uncertainties

- Electron documents desktop source enumeration, `setDisplayMediaRequestHandler`, and the inability to select `getDisplayMedia` sources by `deviceId`: [desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer), [session](https://www.electronjs.org/docs/latest/api/session).
- Electron documents screen/microphone access status and microphone prompts: [systemPreferences](https://www.electronjs.org/docs/latest/api/system-preferences).
- Electron documents isolation and OS-backed token encryption: [security](https://www.electronjs.org/docs/latest/tutorial/security), [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
- Google recommends system-browser installed-app OAuth with PKCE and desktop loopback: [OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app).
- Drive documents resumable uploads, permission creation, and `webViewLink`: [uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [permissions.create](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/create), [files resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/files).
- Codec/container support must be checked at runtime: [MediaRecorder.isTypeSupported](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static).

The exact WebM seek behavior from streamed MediaRecorder output and app protocol must be proven in Milestone 3 on this Mac. If the file plays but duration/seek metadata is weak, use measured elapsed duration for display and document seeking limitation; do not silently introduce FFmpeg. The exact screen/window picker behavior and TCC prompts must also be tested in a signed build before release.
