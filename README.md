# Local Loom

Local Loom is a small macOS desktop app that records a selected screen or window with an optional microphone. It previews the WebM video, saves it anywhere on your Mac, and can upload it to your existing Google Drive. Uploads are Private by default. There is no backend, Cloud Storage bucket, account system, subscription, or analytics.

## Requirements and development

- macOS, Node.js 20 or newer, and npm. The packaged build currently targets Apple Silicon.
- Internet and a Google Desktop OAuth client ID only for Drive uploads. Recording and saving work without Google setup.

```sh
npm install
npm run dev
npm test
npm run typecheck
npm run build
npm run package:mac
```

Select a source, optionally enable a microphone, and press **Start Recording**. Capture starts after a three-second countdown. Stop to preview; **Save Locally** opens the native Save dialog. Video uses Chromium MediaRecorder and WebM, with no FFmpeg dependency. Compatible external players include Chrome and VLC; QuickTime may not play WebM.

`npm run package:mac` builds `release/Local Loom-darwin-arm64/Local Loom.app` on an Apple Silicon Mac. The package script includes only compiled application files. It uses Electron's cached ZIP when available; otherwise it downloads Electron. The bundle is **ad hoc signed locally, not Developer ID signed or notarized**. It is for local development, and macOS may block it or treat its permissions separately from the development app. Sign and notarize with an Apple Developer identity before distributing to other Macs. There is no DMG yet.

## Google Drive setup

**Google Cloud Console provides only the OAuth client ID and Drive API enablement. Recordings use your existing Google Drive storage and quota, not Google Cloud Storage.** A Cloud Storage bucket and Cloud billing account are unnecessary for standard Drive API use. Check [current Drive API usage terms](https://developers.google.com/workspace/drive/api/guides/limits) before relying on any future pricing assumption.

1. Open [Google Cloud Console](https://console.cloud.google.com/). Create or select a project. Do not link billing for this setup.
2. Under **APIs & Services → Library**, enable **Google Drive API**.
3. Configure **Google Auth Platform** or **OAuth consent screen**. Use your app name and support email. For a personal account, choose External and add your Google account as a test user while the app is in Testing. Configure `https://www.googleapis.com/auth/drive.file` if the console requests scopes.
4. Under **Clients** or **Credentials**, create an **OAuth client ID** of type **Desktop app**. Download its JSON. Do not use a service account or Web application client.
5. For development, copy `.env.example` to `.env` and set `GOOGLE_OAUTH_CLIENT_ID` to the JSON's `installed.client_id`. Restart `npm run dev`. Keep the JSON and `.env` out of Git.
6. For the packaged app, place that Desktop client JSON at `~/Library/Application Support/Local Loom/google-oauth-client.json`. Create the directory after first launch if needed, then restart the app. Only `installed.client_id` is read; the client secret is unused.
7. Click **Connect**. Google opens in your default browser and returns via a temporary localhost callback. Approve `drive.file`. Record a short video and test Private upload first. Then test Anyone with the link in a signed-out browser.

The Desktop client ID is a public identifier. OAuth uses PKCE and random state. The refresh token is encrypted by Electron `safeStorage` (macOS Keychain backed) in the app's user-data directory; access tokens stay in main-process memory. Passwords and tokens are never passed to React or logged. Google's External/Testing consent status can make refresh tokens expire after seven days. See the [Desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app) and [Drive quickstart](https://developers.google.com/workspace/drive/api/quickstart/nodejs).

Uploads use resumable Drive API requests with bounded 8 MiB chunks. Private skips a permission change; Anyone with the link adds a reader permission. If that change fails, the uploaded file remains private and the app offers a retry. A Private link works only for the owner or people who already have access.

## macOS permissions

- **Screen:** If capture is denied, open **System Settings → Privacy & Security → Screen & System Audio Recording**, allow Local Loom (or Electron/the launching terminal in development), then restart and refresh sources.
- **Microphone:** Select Off for silent video. If permission is denied, open **System Settings → Privacy & Security → Microphone** and allow the app. The packaged app includes `NSMicrophoneUsageDescription`.
- Development Electron and the packaged app can appear as separate macOS permission entries.

## Architecture

React, TypeScript, and Vite run in an Electron renderer with isolation, sandboxing, and no Node integration. A narrow preload API calls main-process services. `desktopCapturer` selects a source; `getDisplayMedia` and optional `getUserMedia` feed `MediaRecorder`. Main writes ordered WebM chunks to an app-owned temporary file, serves a restricted preview URL, and uses a native Save dialog. Google OAuth, Keychain-backed token storage, Drive HTTP, clipboard, and browser opening stay in main. See [ARCHITECTURE.md](ARCHITECTURE.md) and [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## Troubleshooting

| Symptom | Action |
| --- | --- |
| No capture source or screen access denied | Check Screen & System Audio Recording permission, restart the app, refresh sources. |
| Microphone absent or denied | Choose Off, reconnect the device, or grant permission and refresh inputs. |
| WebM will not open in QuickTime | Play it in Local Loom, Chrome, or VLC. |
| Drive says not configured | Add a Desktop OAuth client ID as above and restart. |
| Google asks for sign-in again | Reconnect; Testing-mode tokens can expire, and revoked access needs reconnection. |
| Upload stops | Check the network and retry while keeping the preview open. |
| Anyone link fails | Retry sharing; a Google Workspace policy may prohibit public links. The file stays private. |
| Packaged app is blocked | Use the development app for local testing, or sign and notarize the bundle. |

## Manual QA checklist

- [ ] Launch development and packaged apps; choose a full screen and a window.
- [ ] Record 30 seconds without mic; stop, confirm the sharing indicator ends, play and seek preview.
- [ ] Record 30 seconds with mic; listen and confirm the microphone indicator ends.
- [ ] Save to a chosen folder; open the WebM in a compatible external player and compare sizes.
- [ ] Cancel Save and confirm preview remains available.
- [ ] Connect Google; upload Private, confirm My Drive file, and test link while signed out.
- [ ] Upload with Anyone selected; copy/open link and test it signed out if account policy permits.
- [ ] Exercise screen/mic denial, unplugged mic, canceled OAuth, offline upload, and rapid double clicks; verify recoverable messages.

## Current limits

WebM only. No system audio, camera bubble, editing, transcription, or automatic Drive folder. Live OAuth/Drive QA requires your Desktop client ID. Public distribution requires Apple signing credentials.
