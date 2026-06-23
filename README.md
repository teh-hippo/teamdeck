# TeamDeck

Control Microsoft Teams meetings from an Elgato Stream Deck. TeamDeck mirrors your live meeting
state on the keys and drives Teams from the deck.

> Not affiliated with, or endorsed by, Microsoft or Elgato. "Microsoft Teams" and "Stream Deck"
> are trademarks of their respective owners. TeamDeck is also unrelated to the resource management
> product at teamdeck.io.

## How it reads and controls Teams

The Teams third-party app API that earlier versions of TeamDeck used is being retired by Microsoft
on 30 June 2026 (message centre MC1266901), with no replacement. TeamDeck now reads and controls
Teams through Windows UI Automation, the accessibility layer that assistive tools use, so it keeps
working after that date.

A small native helper (`teamdeck-helper.exe`, built from [`native/`](native/)) inspects the new
Teams meeting window to report live state, and actuates the meeting controls on a key press.

## Actions

| Live-state toggles | One-press |
| --- | --- |
| Mute, Camera, Raise Hand | Leave, Applause, Laugh, Like, Love, Surprised |

Read-only status tiles: In Meeting and Screen Sharing. The toggles grey out when you are not in a
meeting.

## What works, and the trade-offs

- Mute, camera, raise hand, leave, the five reactions, in-meeting and screen-sharing detection are
  supported.
- Reading state never disturbs you: it inspects the meeting window in the background, even while
  minimised. **Pressing a control briefly brings Teams to the foreground, then restores focus** to
  the window you were using. It is a short flash, only on an explicit key press, and never moves the
  mouse or types into other windows.
- **Mute and camera state are read from the English Teams labels.** Other display languages may not
  report state correctly until their labels are added (control still works).
- **Raise-hand state is not shown.** Teams only exposes it behind the reactions flyout, so the key
  raises and lowers your hand but does not light up.
- TeamDeck depends on the structure of the Teams desktop window, which Microsoft can change in any
  update. If a Teams update moves a control, a key may stop working until TeamDeck is updated.

## Requirements

- The new Microsoft Teams (work or school) on Windows 10 or later.
- The Elgato Stream Deck app 7.1 or later, and a Stream Deck device.

## Install

Download the latest `.streamDeckPlugin` from the
[Releases](https://github.com/teh-hippo/teamdeck/releases) page and double-click it. The Stream Deck
app installs and runs it; no Node, build tools, or terminal are required.

The bundled helper is an unsigned executable, so Windows SmartScreen or your antivirus may warn the
first time it runs. Each release publishes SHA256 checksums you can verify.

## Setup

1. Install TeamDeck and drag the actions onto your keys.
2. Join a Teams meeting. The toggles light up and mirror your state; one-press actions fire while a
   meeting allows them.

No pairing or Teams settings change is required.

## Building from source

Building needs [Node.js](https://nodejs.org) and the [Rust toolchain](https://rustup.rs), on
Windows (the Stream Deck CLI talks to the Windows Stream Deck app).

```powershell
npm install
npm run build         # the plugin bundle
npm run build:helper  # the native helper -> sdPlugin/bin
npm run proof         # typecheck, build, validate, icon check, unit tests
streamdeck link io.github.teh-hippo.teamdeck.sdPlugin
streamdeck restart io.github.teh-hippo.teamdeck
```

`npm run pack` builds the helper and produces a distributable `.streamDeckPlugin`. A pre-commit hook
runs `npm run secret-scan`; run `npm run hooks` to reinstall it.

## How it works

The plugin is a single Node process that spawns the native helper
([`native/`](native/), Rust + Windows UI Automation) and streams its meeting snapshots to every
visible key, sending control commands back on a key press. The snapshot and command contract is in
[`agent/specs/helper.md`](agent/specs/helper.md), and the architecture in
[`agent/specs/architecture.md`](agent/specs/architecture.md).

## Licence

[MIT](LICENSE).
