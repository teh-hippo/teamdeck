# Helper contract

The native helper (`native/`, built to `teamdeck-helper.exe`) is the plugin's only source of Teams
meeting state and control. It reads the new Teams meeting window through Windows UI Automation and
actuates the meeting toolbar. This is the contract between the helper and the Node plugin
(`src/teams/helper.ts`, `src/teams/helper-map.ts`).

## Process modes

- `teamdeck-helper.exe` -- emit one snapshot as JSON on stdout, then exit. Used as a smoke test.
- `teamdeck-helper.exe --loop` -- emit a snapshot every 500 ms.
- `teamdeck-helper.exe serve` -- the mode the plugin uses. Read newline-delimited command objects on
  stdin, stream snapshot objects on stdout, and emit a result object after each command. Exits when
  stdin closes (the parent has gone) so it never outlives the plugin.
- `teamdeck-helper.exe do <verb> [arg]` -- run one control verb and exit. Used for manual testing.

## Snapshot (helper -> plugin)

One JSON object per line on stdout. In `serve` mode each carries `"type": "snapshot"`.

```json
{
  "schema": 1,
  "ts": 1750000000000,
  "teamsRunning": true,
  "inMeeting": true,
  "window": { "pid": 1234, "name": "Meeting with ... | Microsoft Teams" },
  "signals": {
    "mute":      { "value": true,  "available": true,  "source": "uia-label" },
    "camera":    { "value": true,  "available": true,  "source": "uia-label" },
    "hand":      { "value": null,  "available": false, "source": "flyout-only" },
    "sharing":   { "value": false, "available": true,  "source": "uia-window" }
  }
}
```

- `teamsRunning` -- a Teams window exists.
- `inMeeting` -- an active meeting window (the microphone and hangup controls are present).
- Each signal is `{ value, available, source }`. `available: false` means the value is unknown; the
  plugin renders such a field as "unavailable", never a definite on/off. A `true` `value` means
  muted, camera-on, hand-raised or sharing respectively.
- Signals the helper cannot read are always `available: false`: `hand` (only readable behind the
  reactions flyout).
- Mute and camera `value` are derived from the English Teams control labels, so they read correctly
  only while Teams is in English; the label lexicon lives in the helper and can be extended.

## Commands (plugin -> helper, stdin in `serve` mode)

One JSON object per line: `{ "cmd": <verb>, "arg": <string?> }`.

| Verb | Arg | Effect |
| --- | --- | --- |
| `toggle-mute` | -- | Toggle the microphone |
| `toggle-camera` | -- | Toggle the camera |
| `leave` | -- | Leave the call |
| `raise-hand` | -- | Toggle raise hand (via the reactions flyout) |
| `react` | `like`, `love`, `laugh`, `surprised`, `applause` | Send a reaction (via the flyout) |

The plugin's wire reaction `wow` maps to the helper's `surprised`. After each command the helper
emits `{ "type": "result", "cmd": <verb>, "arg": <arg>, "ok": <bool> }`.

## Control and focus

Controls are actuated with UI Automation's Invoke pattern (and ExpandCollapse for the reactions
flyout). Invoke routes through the Teams window's accessibility tree and briefly brings Teams to the
foreground; the helper captures the previous foreground window first and restores it afterwards, so
control causes a short flash to Teams and back, only on an explicit key press, without moving the
mouse or injecting keystrokes. Reading never changes focus and works while the window is minimised.

## Historical: the retired third-party app API

Before this approach, TeamDeck used the Microsoft Teams third-party app API: a local WebSocket at
`ws://127.0.0.1:8124` that pushed `meetingUpdate` messages (full `meetingState` and
`meetingPermissions`) and accepted control verbs, gated by a pairing token the user approved once in
Teams. Microsoft retires that API on 30 June 2026 (MC1266901) with no replacement, which is why
TeamDeck moved to UI Automation. That API also reported recording, unread and background-blur state,
which UI Automation does not currently expose.
