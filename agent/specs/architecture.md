# Architecture

How teamdeck is structured. Pairs with `agent/specs/protocol.md` (the wire contract).

## Process shape

A Stream Deck plugin is a single Node process the Stream Deck app launches. teamdeck holds one
shared connection to Teams and fans state out to every visible key.

```
Stream Deck app ──launch──> bin/plugin.js (Node)
                               │  registers actions, streamDeck.connect()
                               ▼
                         TeamsClient (singleton)  ──ws──> ws://127.0.0.1:8124  ──> Microsoft Teams
                               │  snapshot broadcast            ▲
                               ▼                                └─ meetingUpdate (state + permissions)
                         actions (Mute, …) render keys
```

## Modules

- `shared/identity.json` — the `manufacturer/device/app/app-version` tuple Teams binds the token
  to. Imported by the plugin (bundled via `@rollup/plugin-json`) and read by the probe, so both
  present the same identity.
- `src/teams/types.ts` — `MeetingState`, `MeetingPermissions`, `ReactionType`, `TeamsSnapshot`.
- `src/teams/client.ts` — the singleton `teams` client: connect, pair, persist token in SD
  global settings, reconnect with backoff, merge partial deltas, invalid-token re-pair, and
  broadcast snapshots. The only module that talks to the Teams socket.
- `src/actions/*.ts` — one `SingletonAction` per action. They subscribe to `teams` and render.
- `src/plugin.ts` — entry point: set log level (never `trace`), register actions, connect to
  Stream Deck, then `teams.start()`.

## Startup ordering

`streamDeck.connect()` (registration) must complete promptly and must not be blocked by the
Teams socket. `teams.start()` runs after, awaits `getGlobalSettings()` for the token, then
connects. The Teams socket lifecycle is independent and surfaces status via snapshots.

## Key state machine

Each toggle key derives its visual from the latest snapshot:

- `unavailable` (greyed): not `isInMeeting`, or the matching `can*` permission is false. The key
  ignores presses in this state.
- `on` / `off`: when actionable, `setState(0|1)` from the relevant `meetingState` field.
- Connection loss falls back to `unavailable` until reconnected.

Gating uses `isInMeeting && can<Action>`; because Teams reports all permissions false out of a
meeting, the greyed state is correct even if a stale state field lingers.

## Merge rules (from protocol.md)

- `meetingState` is a full snapshot on connect, then partial single-field deltas: merge present
  fields, never reset omitted ones.
- `meetingPermissions` can arrive alone: merge independently of state.
- Background blur is not echoed: track it optimistically mid-session and trust the connect
  snapshot; reset on meeting transitions (Phase 2).

## Pairing and recovery

- No token + `canPair: true` -> send `pair`; on `tokenRefresh`, persist and reconnect with the
  token (first pairing requires the user to approve in Teams).
- Holding a token + `canPair: true` -> token invalid -> drop it and re-pair.

## Adding an action (Phase 1+)

1. Generate its icons in `tools/gen-icons.mjs` (states + disabled).
2. Add the action entry to `manifest.json` (UUID `io.github.teh-hippo.teamdeck.<name>`, States).
3. Add `src/actions/<name>.ts` subscribing to `teams`, gating on the right permission.
4. Register it in `src/plugin.ts`. Build + validate.
