# Player

Realtime media player client for the WirGroup CMS. Receives schedules over
Socket.IO from the CMS and plays local media files fullscreen through VLC.

## Features

- One-click install (NSIS) or portable `.exe`
- Operator login followed by assigned-device selection
- Encrypted player token storage through Electron `safeStorage`
- Ten-second CMS heartbeat with bounded reconnect backoff
- Manual CMS refresh from the dashboard or system tray, including assigned
  Player list refresh while pairing
- Managed VLC lifecycle with UI-free production kiosk mode and RC controls
- Local Playback Settings for output monitor, fullscreen/windowed mode,
  resolution, scaling, display identification, and test output
- Supports recurring schedules (daily / weekly) and one-shot
- Deterministic overlap handling with schedule priority
- Versioned schedule/media contract with payload validation
- Resumable media download to local storage with size + SHA-256 verification
- LDG v1 encrypted media with device-bound licenses and local range decryption
- Searchable Media Folder for preloaded films in Test Mode
- Persistent Test Mode Schedule Manager with edit, duplicate, enable/disable,
  delete, search, and status filters
- One-time, daily, and weekly schedule creation from the local UI
- Offline-resilient: plays the last known cached schedule when CMS is unreachable
- Auto-start with Windows on login
- Tray icon with status, device id, reconnect, logout, quit
- VLC is bundled (portable) so end users do not need to install VLC separately

## File layout

```
player/
├── package.json
├── main.cjs              Electron main: login window, tray, socket, runtime
├── login.html            Login form
├── vlcController.cjs     VLC singleton + RC interface
├── ldg.cjs               LDG validation + localhost decryption gateway
├── scheduler.cjs         Recurring timer engine
└── vlc-portable/         Put portable VLC build here (vlc.exe)
```

## CMS contract

### Operator login and device claim

The setup screen first calls `POST {serverURL}/api/auth/login`, then requests
`GET {serverURL}/api/operator/devices/available`. The operator selects a device
and the player calls `POST {serverURL}/api/player/claim`.

Request:
```json
{
  "device_id": "device-uuid-from-cms",
  "device_fingerprint": "stable-install-uuid",
  "app_version": "1.1.0",
  "platform": "win32-x64",
  "timezone": "Asia/Jakarta"
}
```

Response (200):
```json
{ "data": { "token": "<token>", "device_id": "<uuid>", "device_name": "Lobby Player" } }
```

The claim request is authenticated by a short-lived operator token. After a
successful claim, that operator session is discarded. The player stores a
stable installation UUID separately from pairing state. Its device token is
encrypted at rest and sent as a Bearer token to
`POST /api/player/heartbeat` every ten seconds. Only a CMS administrator can
revoke pairing. A revoked Player stops playback, clears its local credentials,
shows a notification, and returns to the pairing screen on its next heartbeat.
The **Refresh from CMS** action sends that heartbeat immediately. While pairing,
the tray action instead reloads the assigned Player list using the current
short-lived setup session. Refresh never interrupts local VLC playback.
Pending Players without an assigned operator are hidden and cannot be claimed.
Each dashboard unlock is authorized against the current device assignment.

The Media Folder is created automatically at startup. After the first
successful heartbeat, the Player scans local and managed media and sends an
authenticated snapshot to `POST /api/player/assets/sync`. The same sync runs
from **Refresh from CMS** and **Refresh Assets**. Local items receive a
deterministic `local:<sha256-of-normalized-relative-path>` media key; no
absolute Windows path is sent to the CMS. Duration probing uses the existing
size/modified-time cache, so unchanged films are not probed again.

### Socket

Namespace `/player`, websocket transport, auth via `auth: { token }`.

Client emits `register` with `{ deviceId }` after connect.

Server pushes to that client (room `device:<deviceId>`):

- `sync:initial` → `Schedule[]` (full snapshot, on connect)
- `schedule:set` → `Schedule[]` (merge into cache)
- `schedule:replaceAll` → `Schedule[]` (full replace)
- `schedule:clear` → `{ ids: string[] }` (remove from cache)

The recommended CMS contract is documented in `CMS_CONTRACT.md`. The player
accepts a versioned envelope containing schedules plus an asset catalog. Media
is downloaded and verified before playback. Legacy media gives VLC a local
path; LDG media remains encrypted and gives VLC a temporary localhost URL.

The original local-path `Schedule` remains supported for Test Mode and older
CMS integrations:
```json
{
  "id": "sch-001",
  "startTime": "2026-07-21T14:30:00+07:00",
  "endTime":   "2026-07-21T16:00:00+07:00",
  "recurrence": { "freq": "daily", "daysOfWeek": [], "until": "2026-12-31T23:59:59+07:00" },
  "loop": true,
  "files": [ { "path": "D:\\media\\film.mp4", "title": "Film A" } ]
}
```

`recurrence` is optional. `freq` can be `daily` or `weekly`. `daysOfWeek`
uses 1..7 (Mon..Sun). `until` is an optional inclusive ISO timestamp; `null`
keeps the series active until it is disabled. `path` is an absolute local path on the player PC.
`startTime`/`endTime` are ISO 8601 with timezone offset; the player
compares in epoch ms so the player device clock must be roughly correct.

For schedule overlap, the largest `priority` wins. If priorities are equal,
the occurrence with the latest start time wins. A lower-priority occurrence
can resume if it is still within its active window after the winner ends.

## Tests

```text
npm test
```

Tests cover recurrence, active-window detection, overlap priority, payload
validation, legacy compatibility, and verified local media download.

## Test Mode media sources

Test Mode can create a schedule from either:

- **Available Media** — a combined, searchable list containing films preloaded
  under `C:\Users\Public\Videos\WirPlayer` and assets previously downloaded by
  the player. Downloaded assets retain their `assetId` and can be scheduled
  again without re-entering URL, size, or SHA-256.
- **Import New Remote Asset** — an HTTP(S) URL, filename, byte size, and
  SHA-256 digest. Verified downloads are stored under Electron's managed
  `userData/media` directory and then become Available Media.

If a registered downloaded asset is missing or has the wrong byte size,
selecting it triggers verification and re-download from its saved URL.

Selecting an Available Media item automatically detects its playback duration
and fills the schedule duration fields. Operators can edit the result or use
**Reset to Film Duration**. Detection prefers saved asset metadata, then a
size/modified-time cache, then `ffprobe`. MP4/MOV/M4V files also have an
internal metadata fallback when ffprobe is unavailable. Set `FFPROBE_PATH` to
an explicit executable path when needed.

Set `PLAYER_MEDIA_LIBRARY` before launching the app to override the Media
Folder path. The configured value is also available as `MEDIA_LIBRARY_DIR`
in `config.cjs`.

## Test Mode Schedule Manager

Use **Manage Schedules** on the dashboard to inspect all local schedules.
Schedules persist across Test Mode restarts and can be edited, duplicated,
enabled/disabled, or deleted. The Add/Edit form supports:

- one-time schedules;
- daily recurrence;
- weekly recurrence with Monday–Sunday selection;
- playback priority and playlist looping;
- automatic media-duration filling with manual override.

Duplicating a schedule creates an enabled copy starting five minutes from the
current time while retaining its duration, media, recurrence, and priority.

## Build

1. Place portable VLC inside `player/vlc-portable/`. The directory must
   contain `vlc.exe`. Easiest: download the VLC zip build, copy `vlc.exe`
   and the `plugins/` folder into `vlc-portable/`. (If `vlc.exe` is in a
   subfolder, `vlcController.cjs` will look for `vlc-portable/vlc.exe`,
   `vlc-portable/VLC/vlc.exe`, or `vlc-portable/vlc/vlc.exe`.)

2. (Optional) Add a tray icon at `assets/tray.png` and an installer icon at
   `assets/icon.ico`. If missing, Electron uses defaults.

3. From `player/`:
   ```
   npm install
   npm run build
   ```
   The output installer is in `dist/`.

4. Distribute the NSIS installer to each player PC. End users only need
   to run the installer, enter the CMS URL, sign in as an operator, and select
   the assigned device.

## CMS-assigned media downloads

After pairing, the Player requests its assigned asset manifest on startup,
whenever the CMS `asset_revision` changes on heartbeat, and whenever **Refresh**
or **Refresh Assets** is selected. Assigned films download
into Electron's managed `userData/media` directory with at most two concurrent
downloads. Each file is written as `.part`, checked against the CMS byte size
and SHA-256 digest, and renamed only after verification succeeds. The Player
then reports `ready`, `missing`, `corrupt`, or `unreadable` back to the CMS.

Interrupted downloads retain both `.part` data and a small ETag metadata file.
On the next startup or refresh, the Player requests only the remaining bytes
with `Range` and protects the resume with `If-Range`. A mismatched range or
`416` response clears the stale partial state and safely restarts once from
zero. A final checksum mismatch is also retried once from zero before failure.

The device Bearer token is attached only to download URLs on the configured CMS
origin. Removing an assignment stops the asset from appearing in the managed
catalog; the existing local file is retained until a separate safe-cleanup
policy is implemented.

When an administrator chooses **Unassign & Remove**, or a film reaches its CMS
valid-through date, the next heartbeat/startup/manual refresh removes the exact
managed asset file and matching `.part` metadata, then acknowledges the
removal. Cleanup is deferred while VLC is actively using that file and retried
on following heartbeats. A normal **Unassign** deliberately retains the local
cache. Expiry also advances the schedule revision so the film disappears from
the active schedule cache before deferred cleanup is retried.

The **Assets → Remote Downloads** panel shows every CMS assignment and its
`queued`, `downloading`, `verifying`, `ready`, or `failed` state. Downloading
items include byte and percentage progress; failed items can be retried. The
local Assets inventory refreshes automatically after a download completes.
Local Media Folder scans return immediately while remote downloads continue in
the background, so an assigned large film does not hide already available
media or block the dashboard and tray refresh actions.

### Encrypted LDG playback

CMS uploads created after LDG support are stored locally as `.ldg`. Renaming
one to `.mp4` or opening it directly in raw VLC does not decrypt it. The Player
unwraps the device-bound license using its DPAPI-protected pairing token,
validates the LDG header and authenticated chunks, and starts an HTTP server
bound only to `127.0.0.1`. VLC receives a random unguessable URL and requests
plaintext byte ranges for playback, seek, rewind, jump-to, resume, and
playlists. No decrypted film is written to disk. The gateway and in-memory keys
are cleared when the Player logs out or exits.

Licenses are renewed automatically before expiry. The default offline window
is 24 hours and is configured by the CMS. HTTPS is mandatory when the CMS is
deployed outside a trusted development machine because device authentication
and license envelopes travel between the CMS and Player.

## CMS schedules

On startup, manual refresh, and any changed heartbeat `schedule_revision`, a
paired Player requests its device-scoped schedule snapshot from
`GET /api/player/schedules`. Schedule synchronization is
separate from remote download work, so a large unrelated download does not
delay a new schedule revision. CMS-managed playlist items resolve through their
catalog asset ID; Media Folder items resolve through the stable `local:` media
key. Absolute paths remain local to this PC.

The accepted snapshot is written to the local schedule cache before the
scheduler is updated. VLC starts the resolved ordered playlist when a one-time
or recurring occurrence becomes active. If the CMS later becomes unavailable, the
Player continues using the last valid cached revision.

### Test an interrupted download locally

Localhost downloads can finish too quickly to interrupt. Source runs support an
optional per-file development speed limit. In PowerShell, set the limit before
starting the Player:

```powershell
$env:PLAYER_DOWNLOAD_LIMIT_KBPS="2048"
npm start
```

This limits each download to approximately 2 MB/s. Force-close the Player while
an item is downloading, start it again with the same environment variable, and
the retained `.part` file should continue from its saved byte position. Remove
the variable with `Remove-Item Env:PLAYER_DOWNLOAD_LIMIT_KBPS`, or open a new
terminal, to restore normal speed. Packaged builds ignore this variable.

## Development run

```
npm install
npm start
```

Note: during `npm start` VLC is loaded from `vlc-portable/` relative to the
source folder. After `npm run build` VLC is loaded from
`process.resourcesPath/vlc/vlc.exe` (bundled). `vlcController.cjs` checks
both locations. Idle output uses the bundled text-free
`assets/idle-black.mp4`; packaged builds copy it to
`process.resourcesPath/idle/idle-black.mp4`. FFmpeg is not required at
runtime.

## Playback Settings

Authorized operators can open **Playback Settings** from the Player sidebar.
Settings are stored locally in `playback-settings.json` under Electron's
`userData` directory and never alter CMS pairing credentials. Auto display
selection uses a non-primary Windows display when available. If only one
display exists, idle mode closes VLC so the operator desktop remains usable.
With multiple displays, **Idle loop monitor** can follow the film output or
target another connected monitor. A disconnected saved idle monitor falls
back to the current film output monitor. Electron loops the bundled black
video in a dedicated kiosk window covering the selected display while no
schedule is active. VLC is stopped during idle so its Qt window, console,
logo, and taskbar entry cannot leak onto the operator display. The idle window
remains visible through the playback startup transition and is removed only
after scheduled VLC output is ready.

**Hide VLC interface** is enabled by default. It starts VLC with the `dummy`
interface, keeps the localhost RC interface available, and hides the Qt menu,
fullscreen controller, video title, window decoration, and console during
scheduled playback. Disabling it restores the Qt interface for diagnostics.
It does not affect the Electron-owned idle loop. Settings saved during
playback are applied at the next safe schedule boundary.

Scheduled video is rendered by VLC into a native Electron output window using
VLC's `drawable-hwnd` output. Electron owns that window's monitor, bounds,
fullscreen/kiosk state, and taskbar behavior; VLC continues to own decoding,
audio, playlists, seeking, and RC control. This prevents VLC native fullscreen
from moving scheduled films back to the Windows primary display.

Source/development runs expose **Test VLC Recovery** in Playback Settings while
a schedule is active. After operator confirmation it terminates only the VLC
child process owned by that Player instance. The normal watchdog must then
detect the failure, recreate VLC against the same Electron output window, and
resume the active playlist checkpoint. This control is rejected by the main
process and hidden from the UI in packaged builds.

## Notes

- `VLC`'s `--key-quit` and `--key-fullscreen` are unbound so the operator
  cannot accidentally close VLC with the keyboard. The player manages VLC
  through the RC interface on `127.0.0.1:4212` exclusively.
- Pairing lifecycle is controlled by the CMS administrator. Operators cannot
  revoke a Player from the local dashboard.
- Production builds never expose Test Mode. For source-only development, set
  `PLAYER_ENABLE_TEST_MODE=1` before `npm start`.
- Playback and heartbeat continue while the dashboard is locked. Operator
  controls require a fresh CMS login and lock again after 15 minutes idle.
- Quit closes VLC and exits the app.
