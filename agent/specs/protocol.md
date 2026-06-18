# Teams Third-Party App API — empirically verified protocol contract

This is the authoritative protocol contract for teamdeck, derived from live captures against
Microsoft Teams (new Teams, protocol-version 2.0.0) on 2026-06-18. Every claim here was
observed directly; redacted fixtures are in `agent/progress/`. Where this contradicts the
reference repos, this document wins (it is evidence, they are leads).

## Connection

- Endpoint: `ws://127.0.0.1:8124`
- Query params (all required except token):
  `protocol-version=2.0.0&manufacturer=<m>&device=<d>&app=<a>&app-version=<v>`
  with `&token=<token>` appended **only when a token is held**.
- Identity tuple (`manufacturer/device/app/app-version`) is defined once in
  `shared/identity.json` and MUST be identical for the probe and the plugin: Teams binds the
  pairing token to this tuple.
- Unpaired connection: **omit the `token` param entirely** (empty `token=` is reported broken
  elsewhere; omission works and was verified).
- On every successful connect Teams immediately sends `{ "requestId": 0, "response": "Success" }`.

## Pairing

1. Connect with no token.
2. Wait for `meetingUpdate.meetingPermissions.canPair === true` — this only becomes true while
   the user is **in a meeting/call**.
3. Send `{ "action": "pair", "parameters": {}, "requestId": <n> }` (no `apiVersion` field).
4. **The user must approve an Allow/approve prompt in Teams** on first pairing (verified with
   the user). Teams then sends `{ "tokenRefresh": "<uuid, 36 chars>" }` followed by
   `{ "requestId": <n>, "response": "Success" }`.
5. Persist the token; reconnect with `&token=`.

Notes:
- The `pair` action (not svrooij's reaction-trigger) is the correct mechanism — H1 verified.
- Once the identity is in the Teams "Allowed apps and devices" list, reconnecting with a valid
  token needs no further approval. Re-pairing after a revocation prompts again.

## Token lifecycle and recovery

- Store the latest `tokenRefresh`. Teams may send a new `tokenRefresh` at any time; persist it
  and keep using the connection (no need to close/reconnect on rotation).
- **Invalid-token signal**: if connected **with** a token you receive `canPair === true` and no
  `meetingState` while in a meeting, the token is invalid → drop it, reconnect without a token,
  and re-pair.
- **Do not** connect speculatively with a known-bad token: connecting with a wrong/bogus token
  for the identity was observed to **revoke the existing valid pairing**. Only ever present a
  token returned by `tokenRefresh`.

## Inbound messages

Shapes observed:
- `{ "requestId": <n>, "response": "Success" }` — ack / command success.
- `{ "requestId": <n>, "errorMsg": "<text>" }` — command failure (shape per references).
- `{ "tokenRefresh": "<uuid>" }` — pairing/rotation token.
- `{ "meetingUpdate": { "meetingState": {...}, "meetingPermissions": {...} } }` — either or
  both sub-objects may be present.

### meetingState (8 fields)
`isMuted, isVideoOn, isHandRaised, isInMeeting, isRecordingOn, isBackgroundBlurred, isSharing,
hasUnreadMessages` (all boolean).

- On connect while paired and in a meeting, Teams sends a **full snapshot** (all 8 fields).
- On change, Teams sends a **partial delta containing only the changed field(s)**.
- Out of a meeting, Teams sends **no meetingState** (only permissions). `isInMeeting` is the
  authoritative in/out-of-meeting signal.
- **Blur is not echoed**: toggling background blur (from the Teams UI or via the API) returns
  `Success` but emits **no** `isBackgroundBlurred` delta. The current value IS included in the
  connect snapshot. → Track blur optimistically mid-session; trust the snapshot on (re)connect;
  reset optimistic blur on meeting transitions.
- Mute, camera and hand echo reliably for both user-initiated and API-initiated toggles.

### meetingPermissions (10 fields)
`canToggleMute, canToggleVideo, canToggleHand, canToggleBlur, canLeave, canReact,
canToggleShareTray, canToggleChat, canStopSharing, canPair` (all boolean).

- Out of meeting: all false (including `canPair`).
- In a meeting (validly paired): self-controls true; `canStopSharing` false unless sharing;
  `canPair` false.
- `meetingPermissions` can arrive on its own (no `meetingState`). Merge it independently.

## Merge rules (for the client state machine)

- Treat the first in-meeting message as a full snapshot; subsequent `meetingState` messages as
  partial deltas — apply only the present fields onto cached state, never reset omitted fields.
- `meetingPermissions`-only message → update permissions only; do not touch meeting state.
- `isInMeeting: false` → render all toggles as unavailable/greyed and reset optimistic blur.
- `isInMeeting` false → true → reset optimistic blur to the snapshot value (or unknown).
- Per-key enablement: a key is actionable only when `isInMeeting` and the matching `can*`
  permission are true.

## Outbound commands (verified verbs)

Envelope: `{ "action": <verb>, "parameters": {…}, "requestId": <monotonic int> }`. No
`apiVersion`. Responses echo the `requestId`.

| Verb | Params | Verified |
|---|---|---|
| `pair` | `{}` | yes (tokenRefresh) |
| `toggle-mute` | `{}` | yes (Success + isMuted echo) |
| `toggle-video` | `{}` | yes (isVideoOn echo) |
| `toggle-hand` | `{}` | yes (isHandRaised echo) |
| `toggle-background-blur` | `{}` | yes (Success, no echo) |
| `send-reaction` | `{ "type": "like"\|"love"\|"applause"\|"laugh"\|"wow" }` | yes (all 5 Success) |
| `leave-call` | `{}` | not exercised live (avoided dropping the user); gate on `canLeave` |

The original plugin's "Surprised" reaction maps to wire `wow`. The UI label lives only in the
manifest action `Name`.

## One-client constraint (inconclusive — treat defensively)

Documentation and reference repos claim Teams accepts only one client at a time. In testing,
two same-identity connections coexisted for ~6s without either being dropped, but this
coincided with the token going invalid. Conclusion: do not rely on either behaviour. Keep a
single long-lived connection, never run the probe and the plugin at once, and treat any
unexpected close as a reconnect trigger.

## Open items deferred to later phases

- Exact `errorMsg` payloads for command failures and dead-token closes (none surfaced cleanly;
  the invalid-token signal above is the practical trigger).
- `leave-call` live behaviour (Phase 2, in a disposable solo meeting).
- Screen-share / chat wire strings (Phase 4 only; not exercised).
