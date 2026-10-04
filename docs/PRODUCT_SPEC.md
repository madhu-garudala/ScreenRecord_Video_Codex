# Product specification

This describes the intended product. For verified setup steps and the current Google Drive testing status, see [README.md](../README.md).

## Goal and user

OneTake is a small macOS desktop recorder for one person who wants to capture a display or window, optionally include a microphone, save a playable file, or upload it to their own Google Drive and copy a sharing link. All recording and file operations run on the Mac. Only Google sign-in and Drive upload require the network.

## Main flows

1. Launch the app. The home screen lists available displays/windows, a microphone choice including **Off**, and Google connection status. The sharing choice appears after a recording is ready; **Private** is the default.
2. Select a source and press **Start recording**. The app counts down 3, 2, 1; then records. A compact control displays elapsed time and **Stop recording**.
3. Stop. The app finalizes the file, releases capture devices, and shows a video preview, duration, and file size.
4. Press **Save locally**. A native Save dialog proposes `Recording-YYYY-MM-DD-HH-MM-SS.webm`; the user can choose any writable location. Cancellation returns to preview.
5. Press **Upload to Google Drive**. If necessary, a system browser handles Google OAuth. The app uploads the recording, applies the selected sharing setting, and shows the Drive link. The user can copy the link, open it in a browser, or record another video.

## Functional requirements

- Enumerate screens and windows with names and useful thumbnails; refresh the list; require a valid source selection before recording.
- Enumerate available microphone inputs and offer Off. A missing or unplugged microphone must not prevent screen-only recording when Off is selected.
- Request macOS screen and microphone access as required. Explain denied/restricted access in plain language, including the relevant System Settings path and likely need to restart the app after a screen grant.
- Count down before capture begins; avoid recording the countdown UI where practical. Show elapsed time from actual recorder start, not button press.
- Stop exactly once, wait for the final MediaRecorder data, persist a playable temporary WebM, and stop every screen and microphone track on success, failure, cancellation, window close, or app quit.
- Preview the finalized recording in the app. Report duration and exact file size. Let the user record again without overwriting the prior saved file.
- Save by native dialog and copy the finalized temporary file to the chosen destination. Never claim success on cancellation or a failed write.
- Connect to Google using installed-app OAuth in the system browser. Retain a refresh token with OS-backed protection and refresh access tokens when needed. Disconnect should delete local token material.
- Upload to the user's My Drive using the official Drive v3 API. Show determinate progress when bytes sent are known. Return the file ID and Google's `webViewLink`.
- For **Private**, leave the uploaded file private to its owner and label the result as an owner-only link. For **Anyone with the link**, create an `anyone`/`reader` permission after upload. Report partial success explicitly if upload works but sharing fails; preserve the private file and allow retry of sharing.
- Copy the resulting link to the clipboard and open only a validated Google Drive link in the system browser.
- Permit retry of authentication, upload, sharing, and save without rerecording.

## Non-functional requirements

- `npm ci` and `npm run dev` launch the development app without Google configuration. Recording and local saving work without Google configuration.
- One Electron app with React/TypeScript/Vite; no server, database, account store, analytics, telemetry, or background cloud job.
- Electron renderer uses context isolation, no Node integration, and a narrow typed preload API. Main process validates IPC inputs and controls paths, OAuth, tokens, upload, and external URLs.
- Recording data is written incrementally to a temporary file so a normal-length capture does not require keeping the entire video in renderer memory. The app must avoid silently dropping chunks under backpressure.
- Logs show lifecycle events and error categories, but never tokens, OAuth codes, full authorization URLs, or recording contents.
- The UI is legible, keyboard operable, and clear about active recording and upload state. No large design system is required.
- Unit tests target pure logic and mocked service boundaries; real macOS capture and Google workflows have a manual QA checklist.

## Edge cases and expected behavior

| Case | Expected behavior |
| --- | --- |
| No sources or selected source disappears | Refresh/choose another source; no stuck countdown. |
| Screen permission denied/restricted | Explain System Settings → Privacy & Security → Screen & System Audio Recording (or Screen Recording on older macOS). |
| Microphone denied, disconnected, or silent | Explain the problem; offer Off and a retry. Do not falsely claim audio was captured. |
| User stops during countdown | Cancel countdown and return home; create no recording. |
| User stops twice or closes the window while recording | Stop once; release tracks; finalize or report recoverable failure. |
| Source stream ends outside the app | Stop and finalize what was captured, or clearly report empty/invalid output. |
| No data, unsupported codec, disk full, temp-file failure | Show a specific failure; no success screen; clean partial temp files. |
| User cancels Save dialog | Stay on preview; retain temp file. |
| Save destination already exists | Native dialog handles overwrite confirmation. |
| OAuth denied, callback times out, token revoked | Explain and allow reconnect; no token in renderer. |
| Offline, rate limited, upload interrupted | Keep local temp recording; allow retry; avoid duplicate files when resumable state can be recovered. |
| Workspace policy rejects public sharing | Show uploaded/private status and a sharing-specific error. |
| Private link copied | Explain that recipients need access; do not imply public sharing. |
| App relaunches after unsigned development build | Recording works; Google may need reconnect if Keychain identity changes. |

## Explicitly out of scope

Camera bubble, system audio, editing, trim, annotation, transcription, AI, automatic titles, teams, comments, hosted pages, custom share service, Dropbox/S3/OneDrive, folder organization, a library of prior recordings, cross-platform packaging, and MP4 conversion. A later version may add them behind the existing recorder/file/Drive boundaries.

## Release acceptance

On a Mac, a user can launch the app, choose a screen/window and microphone or Off, record and stop 30 seconds, preview it, save a playable WebM, connect Google, upload it, select a sharing policy, copy a working Drive link, and open that link. Every active capture track is released after stop. The full test is repeated with microphone Off and with microphone On.
