# Architecture

How TeamDeck is structured. Pairs with [`helper.md`](helper.md), the helper snapshot and command
contract.

## Process shape

A Stream Deck plugin is a single Node process the Stream Deck app launches. TeamDeck spawns the
native helper as a child process, reads its meeting snapshots, and fans state out to every visible
key. Control commands flow back to the helper on its stdin.

```
Stream Deck app --launch--> bin/plugin.js (Node)
                               |  registers actions, streamDeck.connect()
                               v
                         HelperClient --spawn--> teamdeck-helper.exe (Rust)
                               |  ^ snapshots (stdout, JSON lines)   | UI Automation
                               |  +---------- commands (stdin) ------+ (reads + Invoke)
                               v                                      v
                         actions render keys                   Microsoft Teams (new)
```

## Modules

- `native/` -- the Rust helper crate. Reads the Teams meeting window via Windows UI Automation and
  emits a snapshot per poll; executes control verbs (mute, camera, hand, leave, reactions) via the
  UIA Invoke pattern, restoring the user's foreground window afterwards. See [`helper.md`](helper.md).
- `src/teams/helper.ts` -- `HelperClient`: spawns the helper in `serve` mode, parses its snapshot
  stream, sends commands on stdin, and restarts it on crash. The only module that talks to the
  helper process.
- `src/teams/helper-map.ts` -- pure mapping from a helper snapshot to the plugin's `TeamsSnapshot`:
  synthesizes permissions and an availability map so unknown fields render "unavailable" instead of
  a fake on/off (the never-fake-state guarantee).
- `src/teams/helper-path.ts` -- resolves the helper binary (env override, bundled `bin/`, or a local
  cargo build). Kept free of the Stream Deck SDK so it is unit-testable.
- `src/teams/client.ts` -- exports the shared `teams` instance.
- `src/teams/types.ts` -- `MeetingState`, `MeetingPermissions`, `ReactionType`, `TeamsSnapshot`,
  `Listener`.
- `src/actions/*.ts` -- one `SingletonAction` per key. They subscribe to `teams` and render live
  state; meeting keys also send a control command on press.
- `src/ui.ts` + `sdPlugin/ui/inspector.html` -- the property inspector, an honest diagnostic
  (helper running, Teams running, in a meeting).
- `src/plugin.ts` -- entry point: set the log level, register actions, connect to Stream Deck, then
  `teams.start()`.

## Startup ordering

`streamDeck.connect()` (registration) must complete promptly and must not be blocked. `teams.start()`
runs after, spawning the helper. The helper lifecycle is independent and surfaces status via
snapshots; if it crashes it is restarted with backoff, and it exits on its own when the plugin's
stdin/stdout pipe closes so it never outlives the plugin.

## Key state machine

Each toggle key derives its visual from the latest snapshot:

- `unavailable` (greyed): not in a meeting, the matching permission is false, or the field's value
  is unknown (availability false). The key ignores presses in this state, except that pressing a
  greyed key asks the helper to recover.
- `on` / `off`: when actionable and the value is known, from the relevant `MeetingState` field.
- When the helper or Teams is not running, every key falls back to `unavailable`.

Gating uses in-meeting plus the matching permission; because permissions are synthesized false out
of a meeting, the greyed state is correct even if a stale state field lingers. A field whose value
the helper cannot read (recording, unread, raise-hand state) is marked unavailable so a key never
shows a confident-but-wrong state.

## Adding an action

1. Generate its icons in `tools/gen-icons.mjs` (states + disabled/unavailable).
2. Add the action entry to `manifest.json` (UUID `io.github.teh-hippo.teamdeck.<name>`, States).
3. Add `src/actions/<name>.ts` subscribing to `teams`, gating on the right permission.
4. If it needs a new control verb or signal, add it to the helper and `helper-map.ts`.
5. Register it in `src/plugin.ts`. Run `npm run proof`.
