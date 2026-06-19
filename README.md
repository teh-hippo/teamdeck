# TeamDeck

Control Microsoft Teams meetings from an Elgato Stream Deck. TeamDeck recreates the
discontinued first-party Microsoft Teams Stream Deck plugin using the Teams third-party app API,
the local control interface that the new Teams client still exposes.

Because it talks to a real API rather than simulating key presses, the controls work even when
Teams is not the focused window, and the keys mirror your live meeting state.

> Not affiliated with, or endorsed by, Microsoft or Elgato. "Microsoft Teams" and "Stream Deck"
> are trademarks of their respective owners. TeamDeck is also unrelated to the resource
> management product at teamdeck.io.

> [!IMPORTANT]
> Microsoft is retiring the Teams third-party app API that TeamDeck relies on on 30 June 2026
> (Microsoft message centre MC1266901). After that date these controls stop working and there is
> no replacement API, so TeamDeck is useful only until then.

## Actions

Ten keys, matching the original plugin. The first four mirror live state and grey out when you
are not in a meeting; the rest fire while a meeting allows them.

| Live-state toggles | One-press |
| --- | --- |
| Mute, Camera, Raise Hand, Background Blur | Leave, Applause, Laugh, Like, Love, Surprised |

## Requirements

- The new Microsoft Teams (work or school). The classic client does not expose this API.
- Windows 10 or later.
- The Elgato Stream Deck app 7.1 or later, and a Stream Deck device.

## Install

Download the latest `.streamDeckPlugin` from the [Releases](https://github.com/teh-hippo/teamdeck/releases)
page and double-click it. The Stream Deck app installs and runs it; no Node, build tools, or
terminal are required. To build it yourself instead, see [Building from source](#building-from-source).

## Setup

1. In Teams, open Settings then Privacy, scroll to Third-party app API, choose Manage API, and
   turn on Enable API. If Manage API is missing or greyed out, your IT administrator has
   disabled third-party device pairing and TeamDeck will not be able to connect.
2. Install TeamDeck (see [Install](#install) above, or build from source below).
3. Drag the TeamDeck actions onto your Stream Deck keys.
4. Join a Teams meeting, then press a TeamDeck key. Teams shows a prompt asking whether to allow
   TeamDeck to connect. Choose Allow. Pairing happens once and the token is reused afterwards.

The keys are greyed out whenever you are not in a meeting, because the Teams API only permits
control during a call. Background blur is updated optimistically, since Teams does not report
blur changes back to connected apps.

## Building from source

The Stream Deck CLI talks to the Windows Stream Deck app, so run its commands from Windows
PowerShell rather than WSL.

```powershell
npm install
npm run build
npm run validate
npm test
streamdeck link io.github.teh-hippo.teamdeck.sdPlugin
streamdeck restart io.github.teh-hippo.teamdeck
```

`npm run watch` rebuilds and restarts on change. `npm run pack` produces a distributable
`.streamDeckPlugin`. A pre-commit hook runs `npm run secret-scan` so a pairing token can never
be committed; run `npm run hooks` if you need to reinstall it.

## How it works

A single Node process holds one WebSocket connection to `ws://127.0.0.1:8124` and fans live
meeting state out to every visible key. The verified wire protocol is documented in
[`agent/specs/protocol.md`](agent/specs/protocol.md), and the architecture in
[`agent/specs/architecture.md`](agent/specs/architecture.md).

## Licence

[MIT](LICENSE).
