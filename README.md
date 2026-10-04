# OneTake

OneTake is a macOS screen recorder. Select a display or window, optionally add microphone audio, preview the WebM video, and save it on your Mac. Recording and local saving work without a Google account, OAuth credentials, or a backend.

Google Drive upload is optional. Its service logic has automated tests, but the real OAuth and upload flow still needs end-to-end testing with a Google account. You can set it up later without changing the local recording workflow.

## Requirements

- macOS on Apple Silicon or Intel.
- Node.js **22.12 or newer** and npm. `.nvmrc` selects Node 22 if you use nvm. `@electron/packager` requires Node 22.12 or newer.
- Internet access for the first `npm ci`, which downloads Electron and the project dependencies. Google credentials are not needed.

## Run from a fresh clone

```sh
git clone https://github.com/madhu-garudala/ScreenRecord_Video_Codex.git
cd ScreenRecord_Video_Codex
npm ci
npm run dev
```

No `.env` file is needed. Choose a screen or window, leave **Microphone** set to **Off** for a silent recording, and press **Start recording**. The app counts down for three seconds. Press **Stop recording**, review the preview, then choose **Save locally**. The Save dialog lets you pick a destination. OneTake creates WebM files; Chrome and VLC can play them, while QuickTime may not.

macOS may ask for screen capture access. If the source list is empty or recording is blocked, allow the app that appears in **System Settings → Privacy & Security → Screen & System Audio Recording**, then restart it. Development runs may appear as Electron or the launching terminal. Enable microphone access only if you want to record your voice.

The development app uses `~/Library/Application Support/onetake-dev` for its profile. The packaged app uses `~/Library/Application Support/OneTake`. On first launch, existing settings from the previous app name are migrated automatically, including the encrypted Google token. You can run development and packaged builds without sharing a live browser profile.

## Build the macOS app

```sh
npm run lint
npm test
npm run package:mac
open "release/OneTake-darwin-$(node -p 'process.arch')/OneTake.app"
```

`npm run package:mac` runs the type checks and build, then packages for the architecture of the current Node process (`arm64` or `x64`). The output is `release/OneTake-darwin-<arch>/OneTake.app`. It includes only compiled app files. Electron is taken from its local cache or downloaded if needed. The app is ad hoc signed for local use; it is not Developer ID signed or notarized for distribution to other Macs.

The clean install and package flow has been verified on Apple Silicon. The Intel (`x64`) path is configured but has not been run on an Intel Mac yet.

The packaged app has bundle ID `com.madhugarudala.onetake`. macOS treats it separately from development Electron and earlier builds, so grant screen and microphone permissions again if prompted. An earlier permission entry may remain in System Settings.

## Optional Google Drive setup

The Drive flow requires a Google Cloud project with the Drive API enabled and a Desktop OAuth client. Recordings go to your own Google Drive; OneTake does not use Google Cloud Storage. Google may change API quotas and billing rules, so check the [current Drive API usage limits](https://developers.google.com/workspace/drive/api/guides/limits) before relying on them.

1. Open [Google Cloud Console](https://console.cloud.google.com/). Create or select a project.
2. Under **APIs & Services → Library**, enable **Google Drive API**.
3. Configure **Google Auth Platform** or **OAuth consent screen**. Use your app name and support email. For a personal account, choose External and add your Google account as a test user while the app is in Testing. Configure `https://www.googleapis.com/auth/drive.file` if the console requests scopes.
4. Under **Clients** or **Credentials**, create an **OAuth client ID** of type **Desktop app**. Download its JSON. Do not use a service account or Web application client.
5. For development, copy `.env.example` to `.env` and set `GOOGLE_OAUTH_CLIENT_ID` to the JSON's `installed.client_id`. Restart `npm run dev`. `.env` is ignored by Git.
6. For the packaged app, place that Desktop client JSON at `~/Library/Application Support/OneTake/google-oauth-client.json`. Create the directory after first launch if needed, then restart the app. Only `installed.client_id` is read; the client secret is unused.
7. Click **Connect**. Google opens in your default browser and returns via a temporary localhost callback. Approve `drive.file`. Record a short video and test Private upload first. Then test Anyone with the link in a signed-out browser.

The Desktop client ID is a public identifier. OAuth uses PKCE and random state. The refresh token is encrypted by Electron `safeStorage` (macOS Keychain backed) in the app's user-data directory; access tokens stay in main-process memory. Passwords and tokens are never passed to React or logged. Google's External/Testing consent status can make refresh tokens expire after seven days. See the [Desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app) and [Drive quickstart](https://developers.google.com/workspace/drive/api/quickstart/nodejs).

Uploads use resumable Drive API requests with bounded 8 MiB chunks. Private skips a permission change; Anyone with the link adds a reader permission. If that change fails, the uploaded file remains private and the app offers a retry. A Private link works only for the owner or people who already have access.

## macOS permissions

- **Screen:** If capture is denied, open **System Settings → Privacy & Security → Screen & System Audio Recording**, allow OneTake (or Electron/the launching terminal in development), then restart and refresh sources.
- **Microphone:** Select Off for silent video. If permission is denied, open **System Settings → Privacy & Security → Microphone** and allow the app. The packaged app includes `NSMicrophoneUsageDescription`.
- Development Electron and the packaged app can appear as separate macOS permission entries.

## Architecture

React, TypeScript, and Vite run in an Electron renderer with isolation, sandboxing, and no Node integration. A narrow preload API calls main-process services. `desktopCapturer` selects a source; `getDisplayMedia` and optional `getUserMedia` feed `MediaRecorder`. Main writes ordered WebM chunks to an app-owned temporary file, serves a restricted preview URL, and uses a native Save dialog. Google OAuth, Keychain-backed token storage, Drive HTTP, clipboard, and browser opening stay in main. See [ARCHITECTURE.md](ARCHITECTURE.md), [implementation plan](docs/IMPLEMENTATION_PLAN.md), and [product spec](docs/PRODUCT_SPEC.md).

## Troubleshooting

| Symptom | Action |
| --- | --- |
| No capture source or screen access denied | Check Screen & System Audio Recording permission, restart the app, refresh sources. |
| Microphone absent or denied | Choose Off, reconnect the device, or grant permission and refresh inputs. |
| WebM will not open in QuickTime | Play it in OneTake, Chrome, or VLC. |
| Drive says not configured | Add a Desktop OAuth client ID as above and restart. |
| Google asks for sign-in again | Reconnect; Testing-mode tokens can expire, and revoked access needs reconnection. |
| Upload stops | Check the network and retry while keeping the preview open. |
| Anyone link fails | Retry sharing; a Google Workspace policy may prohibit public links. The file stays private. |
| Packaged app is blocked | Use the development app for local testing, or sign and notarize the bundle. |
| `npm ci` rejects the Node version | Install Node 22.12 or newer; run `nvm use` if you use nvm. |
| `npm run dev` cannot bind port 5173 | Stop the process using that port, then rerun the command. |

## Manual QA checklist

Local recording (no Google configuration):

- [ ] Launch development and packaged apps; choose a full screen and a window.
- [ ] Record 30 seconds without mic; stop, confirm the sharing indicator ends, play and seek preview.
- [ ] Record 30 seconds with mic; listen and confirm the microphone indicator ends.
- [ ] Save to a chosen folder; open the WebM in a compatible external player and compare sizes.
- [ ] Cancel Save and confirm preview remains available.
- [ ] Exercise screen/mic denial, unplugged mic, and rapid double clicks; verify recoverable messages.

Optional Google Drive validation, still pending with a real account:

- [ ] Connect Google; upload Private, confirm My Drive file, and test link while signed out.
- [ ] Upload with Anyone selected; copy/open link and test it signed out if account policy permits.
- [ ] Exercise canceled OAuth and offline upload; verify recoverable messages.

## Current limits

WebM only. MediaRecorder does not add duration/cue metadata, so seeking can be unreliable and some players show an unknown duration. QuickTime may not open WebM. No system audio, camera bubble, editing, transcription, or automatic Drive folder. Live OAuth/Drive QA requires your Desktop client ID. Public distribution requires Apple signing credentials.
