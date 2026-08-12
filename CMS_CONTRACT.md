# Player–CMS Contract v1

The CMS is the source of truth. Socket.IO only announces state changes; the
player persists the last successfully applied revision and can request a full
snapshot after reconnecting.

## Device registration

Before Socket.IO is enabled, an operator authenticates through
`POST /api/auth/login`, lists assigned pending devices through
`GET /api/operator/devices/available`, and claims one through
`POST /api/player/claim`. The short-lived operator token is then discarded.
Unassigned devices are never listed or claimable; both listing and claim
require an exact assignment to the authenticated operator. Dashboard unlock
also requires `POST /api/operator/devices/{deviceId}/control-access` so an
operator cannot control a Player assigned to another account.
The resulting device token is used for `POST /api/player/heartbeat` every ten
seconds. Pairing can only be revoked by an authenticated CMS administrator;
the Player has no unregister endpoint.

## Asset inventory snapshot

After the first successful heartbeat, and whenever an operator refreshes the
Player or its Assets page, the Player sends its current inventory to:

```text
POST /api/player/assets/sync
Authorization: Bearer <device-token>
```

```json
{
  "assets": [{
    "media_key": "local:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "source": "local",
    "title": "Lobby Campaign",
    "filename": "Lobby Campaign.mp4",
    "relative_path": "Campaign/Lobby Campaign.mp4",
    "size_bytes": 482971200,
    "duration_ms": 120000,
    "sha256": null,
    "status": "ready",
    "modified_at": "2026-08-06T09:30:00.000Z"
  }]
}
```

`local:` keys are SHA-256 hashes of normalized relative paths. Managed CMS
downloads use `managed:<asset-id>`. Absolute PC paths are never transmitted.
The snapshot is authoritative for one Player: reported records are upserted,
while previously known records omitted from the snapshot become `missing`.
The CMS retains missing records for schedule history and diagnostics.

CMS-managed download endpoints support authenticated single byte ranges.
Players persist the response `ETag`, send `Range: bytes=<partial-size>-` and
`If-Range: <etag>` after interruption, and append only when the CMS returns
`206` with a matching `Content-Range` start and total size. Invalid or stale
partial state is discarded before one full retry.

After connecting to the `/player` namespace, the player emits:

```json
{
  "deviceId": "dev-001",
  "revision": 41,
  "appVersion": "1.1.0"
}
```

## Schedule snapshot

Before realtime delivery is enabled, the Player retrieves the authoritative
snapshot with its device token:

```text
GET /api/player/schedules
Authorization: Bearer <device-token>
```

The HTTP response is `{ "data": { "revision": ..., "schedules": [...] } }`.
Manual refresh synchronizes this snapshot independently from long-running media
downloads. The future Socket.IO events use the same schedule envelope.

The server sends the same envelope with `sync:initial`,
`schedule:replaceAll`, or `schedule:set`. `schedule:set` merges schedules by
ID; the other two events replace the schedule collection.

```json
{
  "revision": 42,
  "schedules": [
    {
      "id": "sch-001",
      "revision": 3,
      "title": "Morning promotion",
      "priority": 10,
      "startAt": "2026-08-01T08:00:00+07:00",
      "endAt": "2026-08-01T09:00:00+07:00",
      "recurrence": {
        "freq": "weekly",
        "daysOfWeek": [1, 2, 3, 4, 5]
      },
      "loop": true,
      "playlist": [
        {
          "assetId": "asset-001",
          "mediaKey": "managed:asset-001",
          "order": 0
        },
        {
          "mediaKey": "local:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "order": 1
        }
      ]
    }
  ],
  "assets": [
    {
      "id": "asset-001",
      "revision": 1,
      "filename": "morning-promo.mp4",
      "downloadUrl": "https://cdn.example.com/assets/asset-001",
      "size": 482971200,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "mimeType": "video/mp4",
      "durationMs": 120000
    }
  ]
}
```

Rules:

- Times must be ISO 8601 and include `Z` or an explicit UTC offset.
- `endAt` must be later than `startAt`.
- `priority` defaults to `0`; a larger value wins schedule overlaps.
- When priorities match, the occurrence with the latest start time wins.
- Weekly days use `1` for Monday through `7` for Sunday.
- Assets require an HTTP(S) URL, byte size, and SHA-256 digest.
- Local playlist entries use a `mediaKey` and are resolved to an absolute path
  only inside the Player. The CMS never receives or returns that path.
- Legacy `files[].path` schedules remain accepted for local Test Mode.

## Removal

```json
{
  "revision": 43,
  "ids": ["sch-001"]
}
```

## Applied acknowledgement

After validation, download preparation, cache persistence, and scheduler
update, the player emits:

```json
{
  "deviceId": "dev-001",
  "revision": 43,
  "appliedAt": "2026-08-01T07:55:00.000Z"
}
```

The optional Socket.IO acknowledgement callback receives `{ "ok": true }`.
Invalid payloads receive `{ "ok": false, "error": "...", "details": [] }`.
