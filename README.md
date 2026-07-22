# Player

Realtime media player client for the WirGroup CMS. Receives schedules over
Socket.IO from the CMS and plays local media files fullscreen through VLC.

## Features

- One-click install (NSIS) or portable `.exe`
- Login with `username + password`; server returns token + deviceId
- Single persistent VLC instance, fullscreen, playlist swap without restart
- Supports recurring schedules (daily / weekly) and one-shot
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

`Schedule`:
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
