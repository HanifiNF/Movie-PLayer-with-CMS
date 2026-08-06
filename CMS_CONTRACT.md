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

After connecting to the `/player` namespace, the player emits:

```json
{
  "deviceId": "dev-001",
  "revision": 41,
  "appVersion": "1.1.0"
}
```

## Schedule snapshot

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
          "order": 0
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
