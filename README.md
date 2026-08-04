# Player

Realtime media player client for the WirGroup CMS. Receives schedules over
Socket.IO from the CMS and plays local media files fullscreen through VLC.

## Features

- One-click install (NSIS) or portable `.exe`
- Login with `username + password`; server returns token + deviceId
- Single persistent VLC instance, fullscreen, playlist swap without restart
- Supports recurring schedules (daily / weekly) and one-shot
- Deterministic overlap handling with schedule priority
- Versioned schedule/media contract with payload validation
- Resumable media download to local storage with size + SHA-256 verification
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
├── scheduler.cjs         Recurring timer engine
└── vlc-portable/         Put portable VLC build here (vlc.exe)
```

## CMS contract

### Login

`POST {serverURL}/api/player/login`

Request:
```json
{ "username": "...", "password": "..." }
```

Response (200):
```json
{
  "token": "<jwt>",
  "deviceId": "dev-abc-123",
  "user": { "username": "...", "name": "..." }
}
```

The CMS should auto-create / pair a `deviceId` for the player on first login
and return it. Subsequent logins for the same `(username, hostname)` pair
should return the same `deviceId`.

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
is downloaded and verified before VLC receives a local path.

The original local-path `Schedule` remains supported for Test Mode and older
CMS integrations:
```json
{
  "id": "sch-001",
  "startTime": "2026-07-21T14:30:00+07:00",
  "endTime":   "2026-07-21T16:00:00+07:00",
  "recurrence": { "freq": "daily", "daysOfWeek": [1,2,3,4,5] },
  "loop": true,
  "files": [ { "path": "D:\\media\\film.mp4", "title": "Film A" } ]
}
```

`recurrence` is optional. `freq` can be `daily` or `weekly`. `daysOfWeek`
uses 1..7 (Mon..Sun). `path` is an absolute local path on the player PC.
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
   to run the installer and log in with their CMS username/password.

## Development run

```
npm install
npm start
```

Note: during `npm start` VLC is loaded from `vlc-portable/` relative to the
source folder. After `npm run build` VLC is loaded from
`process.resourcesPath/vlc/vlc.exe` (bundled). `vlcController.cjs` checks
both locations.

## Notes

- `VLC`'s `--key-quit` and `--key-fullscreen` are unbound so the operator
  cannot accidentally close VLC with the keyboard. The player manages VLC
  through the RC interface on `127.0.0.1:4212` exclusively.
- Logout removes the cached config + schedules and relaunches the app
  (so the login window appears again).
- Quit closes VLC and exits the app.
