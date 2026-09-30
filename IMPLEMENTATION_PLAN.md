# Implementation plan

Historical implementation plan. For current setup and validation status, see [README.md](README.md).

## Working agreement

Sol owns architecture, milestone acceptance, code review, integration, security review, and final QA. Luna is the primary implementation engineer. Give Luna one milestone at a time with objective, architecture context, files to inspect, expected behavior, constraints, acceptance, and tests. After each milestone Sol inspects the diff, runs the stated checks, reviews cleanup/races/IPC/security, and sends corrective work to Luna before proceeding. Do not combine milestones to save turns. No feature creep.

The repository begins empty. File names below are targets, not a mandate to create every empty directory. Prefer one file per real responsibility. Proposed structure:

```text
electron/main.ts                 Electron lifecycle, window, permission and capture IPC
electron/preload.ts              narrow contextBridge API
electron/recordingStore.ts       temp file lifecycle and safe preview
electron/googleAuthService.ts    OAuth, refresh, protected token storage
electron/googleDriveService.ts   upload, metadata, permissions
src/App.tsx                      phase UI and top-level state
src/components/*                 source/mic chooser, timer, player, errors
src/hooks/useRecorder.ts         capture/MediaRecorder lifecycle
src/types/*                      shared DTOs/window API
src/utils/*                      filename, error mapping, formatting
tests/*                          critical pure/service tests
```

Naming may change when implementation makes a simpler layout obvious; update this plan if a major architecture choice changes. Each milestone should keep the app buildable. Use npm scripts for `dev`, `build`, `typecheck`, and `test` once they are useful.

## Milestone 0 — Architecture (Sol; no application coding)

**Goal:** Decide the smallest viable desktop architecture and record requirements before scaffolding.

**Files affected:** `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md`.

**Steps:** Inspect repository and host tooling; verify current Electron capture/permission APIs and Google desktop OAuth/Drive upload documentation; choose Electron/WebM/no FFmpeg; define main/renderer trust boundary, temp-file strategy, OAuth token storage, and sharing semantics; list all milestones and manual QA.

**Acceptance:** Documents explicitly answer framework, recording API, output format, FFmpeg, OAuth, token storage, upload, risks, and sequence. No application source exists.

**Tests/review:** Read documents for contradictions and compare API claims against linked primary docs.

**Failure cases:** Assuming `getDisplayMedia` can select by `deviceId`; treating desktop OAuth secret as confidential; confusing private URL with public sharing; designing a video path that keeps the whole recording in memory.

## Milestone 1 — Desktop application skeleton (Luna)

**Goal:** `npm install && npm run dev` launches a minimal secure Electron window with a React/TypeScript/Vite UI.

**Files affected:** `package.json`, lockfile, `index.html`, `vite.config.ts`, TS configs, `electron/main.ts`, `electron/preload.ts`, `src/App.tsx`, `src/main.tsx`, `src/styles.css`, `src/types/electron.d.ts`, `.gitignore`; initial `README.md`.

**Steps:** Use a simple dev setup with Vite and Electron; package main/preload compilation without introducing a monorepo. Create a fixed-size/resizable home window, source/mic placeholders, disabled Record button until selection is implemented, and Google status placeholder. Set `contextIsolation:true`, `nodeIntegration:false`, sandbox on; local-only renderer; restrictive navigation/new-window rules; no generic IPC API. Add clear dev/build/typecheck scripts and a short README startup section. Avoid backend or UI libraries unless essential.

**Acceptance:** Window opens, React renders, hot reload works, no Node global is available to page code, preload is available and typed, production renderer build succeeds.

**Tests:** `npm install`, `npm run typecheck`, `npm run build`, launch `npm run dev` on this Mac and inspect window/console. Sol reviews package count, Electron preferences, preload boundary, and scripts.

**Failure cases:** Main path wrong after compilation; preload not loaded in dev; Vite URL allowed to navigate externally; browser preview masquerading as Electron; unsupported Node/Electron version.

## Milestone 2 — Screen source selection (Luna)

**Goal:** Show and select actual displays and windows.

**Files affected:** `electron/main.ts`, `electron/preload.ts`, `src/App.tsx`, `src/components/SourcePicker.tsx` if warranted, shared DTO declarations, relevant tests.

**Steps:** Add main IPC to call `desktopCapturer.getSources({types:['screen','window']})` with modest thumbnail size. Return only serializable IDs, names, type, thumbnail data; distinguish screens/windows using source ID or source metadata carefully. Render source chooser and refresh. Store selection in React and validate that it still exists on refresh. Prepare a main `setDisplayMediaRequestHandler` that resolves only the selected source during a pending capture request; do not start recording yet. Surface empty list and permission status.

**Acceptance:** On this Mac, screens and capturable windows appear, source choice persists while valid, stale selection is rejected, refresh works. No source means Record is disabled.

**Tests:** Typecheck/build; manual source list with at least one display and window; source disappearance/refresh; unit test selection validation if logic is extracted.

**Failure cases:** System picker overrides app selection; leaking raw Electron source objects; thumbnails too large; duplicate titles used as IDs; permission denial appears as empty success.

## Milestone 3 — Screen recording (Luna; hard gate)

**Goal:** Reliable screen-only recording from selected source through playable finalized WebM. Do not proceed until Sol accepts a real recording.

**Files affected:** `src/hooks/useRecorder.ts`, `src/App.tsx`, `electron/main.ts`, `electron/preload.ts`, `electron/recordingStore.ts`, shared types, phase/format helpers, tests.

**Steps:** Implement 3-second cancelable countdown. Serialize `getDisplayMedia` request against the selected ID. Check WebM MIME with `MediaRecorder.isTypeSupported`; record video only with a 1–5 second timeslice. Begin a unique main-owned temp writer before `start`; send ordered nonempty chunks to it with bounded outstanding writes. Start elapsed clock on recorder `start`. Implement idempotent Stop: call `requestData` only if safe, stop recorder, await final data event and queued writes, finalize file, stop all tracks, show preview. Make stream `ended`, errors, component unmount, and app quit release resources and abort incomplete files. Main rejects invalid IDs, unexpected chunks, oversized chunks, and arbitrary path access. Implement limited preview URL and verify playback/seek without filesystem exposure.

**Acceptance:** Three separate 30-second display recordings stop and play in-app; one window capture works; elapsed time is plausible; no screen-sharing indicator remains after stop; double Stop does not corrupt output; failed/canceled start leaves no active tracks. Sol opens a temp output in an external player that supports WebM to prove validity.

**Tests:** `npm run typecheck`, `npm test`, `npm run build`; unit tests for phase transitions and writer ordering/stop idempotence where meaningful; manual 30-second capture, playback, external-open, double stop, source ends, restart recording. Inspect process memory trend for a longer trial if practical.

**Failure cases:** Final `dataavailable` arrives after finalize; chunks write out of order; file is empty or unseekable; selection races; async callbacks survive unmount; temporary file orphaned; screen indicator persists. A failure here blocks Milestone 4.

## Milestone 4 — Microphone (Luna)

**Goal:** Optional input audio in the same recording.

**Files affected:** `src/hooks/useRecorder.ts`, `src/components/MicrophonePicker.tsx`, `src/App.tsx`, `electron/main.ts` permission IPC/Info.plist configuration, shared types, tests.

**Steps:** Enumerate `audioinput` devices after appropriate permission prompt; render Off and named inputs with stable device IDs. Request selected mic via `getUserMedia({audio:{deviceId:{exact:id}}})`; combine one audio track with desktop video track. Select supported WebM+Opus MIME. If mic fails, show a choice to retry or continue with Off; never claim mic capture when missing. Stop and release both original streams/tracks on every exit path. Do not include system audio.

**Acceptance:** A 30-second test has audible microphone speech; Off test has no microphone track; plugging/unplugging or denying permission has clear recovery; macOS mic indicator turns off after stop.

**Tests:** Typecheck/build, manual audio playback and track release; test audio permission/error mapping. Check packaged Info.plist key in later packaging milestone.

**Failure cases:** Wrong input selected; duplicate audio tracks; mic request occurs before countdown and leaves indicator on; screen stream leaks if mic request fails; silent stream despite apparently successful UI.

## Milestone 5 — Preview (Luna)

**Goal:** Clear completed-recording screen with reliable playback and metadata.

**Files affected:** `src/App.tsx`, `src/components/RecordingPreview.tsx`, `electron/recordingStore.ts`, formatting helpers, tests.

**Steps:** Present video controls, duration measured from actual recording interval (and use media metadata when valid), byte size from finalized file, and Record Another. Preserve finalized temp file until Save/Upload/Record Another lifecycle is defined; clean up only app-owned temp files. Verify pause/seek/replay behavior and revoke stale preview handles.

**Acceptance:** Preview plays, pauses, replays, and seeks when supported; duration and size look correct; Record Another returns home and subsequent preview points to new content.

**Tests:** Typecheck/build; manual playback and record-again; formatting unit tests for time/size if nontrivial.

**Failure cases:** Stale preview URL, zero duration, file deleted before save/upload, media protocol allows arbitrary path traversal.

## Milestone 6 — Save locally (Luna)

**Goal:** User saves a playable file to an arbitrary chosen Mac location.

**Files affected:** `electron/main.ts`, `electron/recordingStore.ts` or `electron/fileService.ts`, `electron/preload.ts`, `src/App.tsx`, `src/utils/filename.ts`, tests.

**Steps:** Generate timestamped `.webm` filename, matching actual MIME. Main invokes native Save dialog and copies finalized temp file to returned path. Check canceled result separately. Surface permission/disk/full errors; avoid returning user file paths in logs. Keep recording available after cancel/failure. Reject saves while file is not finalized.

**Acceptance:** Save to Desktop and custom folder; externally open file and hear audio when recorded; cancellation leaves preview unchanged; overwrite follows native dialog confirmation.

**Tests:** Filename unit test, mocked save cancellation/failure test, typecheck/build, manual save/open and file-size comparison.

**Failure cases:** Empty output, wrong extension/MIME, accidental overwrite, partial copy reported as success, temp file deleted before retry.

## Milestone 7 — Google OAuth (Luna; Sol security gate)

**Goal:** Connect and persist a Google Drive authorization safely.

**Files affected:** `electron/googleAuthService.ts`, `electron/main.ts`, `electron/preload.ts`, `src/App.tsx`, shared types, `.env.example`, `.gitignore`, `README.md`, tests.

**Steps:** Load Desktop OAuth client ID from development env/build config; keep optional generated client JSON gitignored. Use system browser, loopback listener on `127.0.0.1` random port, PKCE S256 and random state; timeout/cancel and close listener on all outcomes. Request only `drive.file` with offline access. Exchange code in main, save refresh token with `safeStorage` encrypted file, keep access token in memory, refresh on expiry, preserve old refresh token when refresh response omits new one. Expose only connected/disconnected and connect/disconnect operations to UI. Handle invalid grant and storage failure. Document External/Testing seven-day refresh-token expiration.

**Acceptance:** Connect works with a configured Google test user; relaunch retains connection when token remains valid; disconnect removes local token; renderer/devtools never see token; denied consent returns a readable error.

**Tests:** Typecheck/build; mocked PKCE/state/callback/refresh/storage tests; manual browser sign-in and relaunch. Sol reviews callback binding, state, token leakage, scope, log redaction, error handling, packaged credential approach.

**Failure cases:** Embedded webview, fixed callback port, missing state/PKCE, token in localStorage/plaintext source, duplicate auth requests, expired testing token, invalid_grant loop.

## Milestone 8 — Google Drive upload (Luna)

**Goal:** Upload the finalized WebM to My Drive and return a usable Drive URL.

**Files affected:** `electron/googleDriveService.ts`, `electron/main.ts`, `electron/preload.ts`, `src/App.tsx`, upload progress component, tests.

**Steps:** Resolve valid access token; initiate Drive v3 resumable `files.create` with name/MIME/size; stream file in bounded chunks from disk; handle 308 status/range, token refresh, transient retries, cancellation as feasible, and report acknowledged progress through typed IPC. Request file metadata including ID and `webViewLink`, use `files.get` if needed, validate URL. Do not create folder yet. Persist enough in-memory session state during a retry to avoid duplicate upload after uncertain completion.

**Acceptance:** A recorded file appears in My Drive with correct name, MIME, and byte size; UI shows progress and resulting link; network failure leaves local temp recording available for retry.

**Tests:** Mocked HTTP success/308/401/5xx/timeout tests; typecheck/build; manual upload of a 30-second file, compare Drive size and play in Drive.

**Failure cases:** Full file buffered in memory, fake progress based only on bytes read, duplicate uploads on retry, expired auth not refreshed, bad metadata fields, temp file gone.

## Milestone 9 — Sharing and link actions (Luna)

**Goal:** Explicit Private/Anyone setting with truthful links, Copy, and Open.

**Files affected:** `electron/googleDriveService.ts`, `electron/main.ts`, `electron/preload.ts`, `src/App.tsx`, sharing selector/result component, tests.

**Steps:** Default UI to Private. For Private, skip permissions.create and label link owner-only. For Anyone, create `type:anyone,role:reader` permission on uploaded file, then show link; on failure report upload success and sharing failure, retain ID and permit retry. Copy via Electron clipboard, open via validated system browser URL. Disable Copy/Open until a valid URL exists.

**Acceptance:** Private file is inaccessible to an unauthenticated browser; Anyone link opens for a separate signed-out browser profile where policy permits; copy contains the displayed URL; Open launches default browser.

**Tests:** Permission call unit tests, URL validation tests, typecheck/build, manual signed-out access checks.

**Failure cases:** Public default, success message before permission call completes, inaccessible private link described as shareable, Workspace policy failure treated as upload failure, arbitrary external URL accepted.

## Milestone 10 — Error handling and adversarial review (Luna fixes; Sol reviews)

**Goal:** All named failures show useful messages and leave app in a recoverable state.

**Files affected:** Error mapping/helper, recorder/auth/upload services, UI, tests, README troubleshooting.

**Steps:** Build a small typed error catalog or direct mapping; cover screen/mic denied, no source, mic unavailable, recorder error, save failure, OAuth denied/timeout/invalid_grant, Drive API/permission failures, offline/upload interruption. Prevent duplicate Start/Stop/Save/Upload clicks and stale async updates. Check track closure, temp cleanup, listener closure, IPC sender validation, CSP, navigation, URL validation, log redaction. Avoid a large generic error framework.

**Acceptance:** Every minimum error in product spec is understandable and retryable when possible; no active capture after failure; no secret appears in logs.

**Tests:** Targeted unit tests and manual denial/offline/double-click cases; typecheck/build. Sol performs adversarial review and gives exact fixes to Luna.

**Failure cases:** Error swallowed by promise callback, retry duplicates a file, permanent spinner, track leak, token exposed in message, stale renderer state after rapid actions.

## Milestone 11 — Packaging and documentation (Luna)

**Goal:** Build a locally installable macOS app and document setup completely.

**Files affected:** packaging config, `package.json`, Info.plist entitlements/usage descriptions as needed, `README.md`, `.env.example`, `.gitignore`.

**Steps:** Choose one conventional packaging tool; set stable app name/bundle ID and include main/preload/renderer assets. Configure microphone usage description and required capture permissions. Build Apple Silicon app/DMG; inspect bundled files for unintended secrets; smoke test launch. Document Xcode/signing/notarization requirements, installation, permission reset/restart, Google Cloud project, Drive API enablement, consent screen, test users, Desktop OAuth client, client ID configuration, `drive.file`, auth testing, token storage, seven-day Testing limitation, build command, troubleshooting, and known WebM/macOS player limits. Do not claim signed/notarized distribution without credentials.

**Acceptance:** Package command creates an app that opens locally on this Mac; recording UI starts; README allows another developer to configure Google without hidden steps. State exactly whether artifact is signed/notarized.

**Tests:** `npm run build`, package command, launch packaged app, inspect Info.plist, check archive contents for `.env`, tokens, and OAuth JSON. Full permission/OAuth test may require a signed build and Google credentials.

**Failure cases:** Dev-only asset paths, missing preload, incorrect macOS usage string, Keychain identity changes each build, unsigned app misleadingly called release-ready, credential accidentally packed.

## Milestone 12 — Final QA and integration (Sol; Luna corrects defects)

**Goal:** Prove the entire product on the local Mac and report any external setup limitation honestly.

**Files affected:** Fixes as necessary, final `README.md`, optional `QA.md` or README checklist.

**Steps:** Inspect final diff and dependency list. Run typecheck/tests/build/package. Launch app; choose display; choose mic; count down; record 30 seconds; stop; verify both indicators end; preview and listen; save; open saved file outside app; upload; copy link; open link; test Private and Anyone policies from a signed-out browser. Repeat screen-only and a window capture. Exercise denied mic/screen permissions, canceled Save, offline upload, and OAuth cancellation where practical. Review security and resource cleanup once more. Ask Luna for focused fixes and repeat failed scenarios.

**Acceptance:** Complete requested workflow works locally, with actual Google credentials and permissions supplied. If credentials, Xcode signing identity, or macOS permission state are unavailable, distinguish verified steps from blocked external integration and give exact remaining actions; never fabricate success.

**Tests:** Full manual checklist above, automated checks, saved file byte-size and playback check, Drive metadata/link verification. Record outcomes in final report.

**Failure cases:** App works only in Vite browser, fails after packaging, recorder stream leaks, files save but cannot play, link copied before sharing completes, private/public semantics wrong.

## Review checklist at every milestone

- Does the diff solve only this milestone, with minimal dependencies and no unused abstraction?
- Does TypeScript express IPC inputs/results precisely? Are untrusted inputs validated again in main?
- Does every async failure leave the UI usable? Are actions idempotent and stale results ignored?
- Are screen and microphone tracks, MediaRecorder handlers, timers, temp handles, OAuth listeners, and event subscriptions released?
- Are Electron security defaults explicit and preserved? Are tokens, paths, URLs, and logs handled safely?
- Does the stated manual acceptance actually run on the Mac, beyond passing mocked tests?
