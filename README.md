# TeamDeck

[![Licence: MIT](https://img.shields.io/badge/Licence-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/teh-hippo/teamdeck)](https://github.com/teh-hippo/teamdeck/releases)

TeamDeck is a Stream Deck plugin for controlling a Microsoft Teams meeting from an Elgato Stream Deck. The keys mirror your live meeting state and drive Teams from the deck. It is Windows-only and works with the new Microsoft Teams (work or school).

TeamDeck is not affiliated with or endorsed by Microsoft or Elgato. "Microsoft Teams" and "Stream Deck" are trademarks of their respective owners.

> Earlier versions of TeamDeck used a Microsoft Teams third-party device and app integration. Microsoft is retiring that integration on 30 June 2026 (see [Connect to third-party devices in Microsoft Teams](https://support.microsoft.com/en-us/teams/calls-devices/connect-to-third-party-devices-in-microsoft-teams)). TeamDeck now reads and controls Teams through Windows UI Automation, so it keeps working after that date.

## Features

Live-state toggles mirror your real meeting state and grey out when you are not in a meeting:

- Mute
- Camera
- Raise Hand

One-press actions:

- Leave
- Reactions: Applause, Laugh, Like, Love, Surprised

Read-only status tiles:

- In Meeting
- Screen Sharing

Reading state is non-intrusive. The helper inspects the meeting window in the background, even while Teams is minimised, and never steals focus or moves the mouse. Pressing a control briefly brings Teams to the foreground and then restores focus to the window you were using, so you see a short flash only on an explicit key press.

### Limitations

- Mute and camera state are read from the English Teams labels. With other display languages the control still works, but the on or off state may not show until those labels are added.
- Raise-hand state is not shown. Teams only exposes it behind the reactions flyout, so the key raises and lowers your hand without lighting up.
- TeamDeck depends on the structure of the Teams desktop window, which Microsoft can change in any update. A Teams update could move a control until TeamDeck is updated.

## Requirements

- The new Microsoft Teams (work or school) on Windows 10 or later.
- The Elgato Stream Deck app 7.1 or later, with a Stream Deck device.

## Installation

Download the latest `.streamDeckPlugin` from the [Releases page](https://github.com/teh-hippo/teamdeck/releases) and double-click it. The Stream Deck app installs and runs the plugin, so you do not need Node, build tools, or a terminal.

The bundled helper (`teamdeck-helper.exe`) is an unsigned executable, so Windows SmartScreen or your antivirus may warn the first time it runs. Each release publishes SHA256 checksums so you can verify the download.

## Configuration

There is little to configure.

1. Drag the TeamDeck actions onto your keys.
2. Join a Teams meeting.

The toggles light up and mirror your state, and the one-press actions fire while the meeting allows them. No pairing and no change to Teams settings is required.

The plugin's Property Inspector shows a status line (helper running, Teams running, in a meeting) to help confirm everything is wired up.

## Building from source

Build and test on Windows, because the Stream Deck CLI talks to the Windows Stream Deck app. You need [Node.js](https://nodejs.org) and the [Rust toolchain](https://rustup.rs).

```powershell
npm install
npm run build         # build the plugin bundle
npm run build:helper  # build the native helper into the plugin bin/
npm run proof         # typecheck, lint, build, validate, icon check, unit tests
streamdeck link io.github.teh-hippo.teamdeck.sdPlugin
streamdeck restart io.github.teh-hippo.teamdeck
```

`npm run pack` builds the helper and produces a distributable `.streamDeckPlugin`. A pre-commit hook runs a secret scan, so keep Node on your PATH when committing.

## How it works

TeamDeck has two parts: a Stream Deck plugin written in Node and TypeScript, and a small native helper (`teamdeck-helper.exe`) written in Rust. The helper reads and controls Teams through Windows UI Automation, the Windows accessibility layer. It reports live meeting state to the keys and actuates the meeting controls on a key press.

For the design detail, see [`agent/specs/architecture.md`](agent/specs/architecture.md) and [`agent/specs/helper.md`](agent/specs/helper.md).

## Licence

TeamDeck is released under the MIT Licence. See [LICENSE](LICENSE).
