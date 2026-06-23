<div align="center">

# TeamDeck

[![Licence: MIT](https://img.shields.io/badge/Licence-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/teh-hippo/teamdeck)](https://github.com/teh-hippo/teamdeck/releases)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6)
![Elgato Stream Deck](https://img.shields.io/badge/Elgato-Stream%20Deck-101820?logo=elgato&logoColor=white)

### Drive a Microsoft Teams meeting straight from your Elgato Stream Deck.

Your keys mirror live meeting state and control Teams — mute, camera, raise hand, react, and leave — without touching the window.

<p>
  <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/mute/on@2x.png" width="58" alt="Mute" />
  <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/camera/off@2x.png" width="58" alt="Camera" />
  <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/hand/lowered@2x.png" width="58" alt="Raise hand" />
  <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/react/love@2x.png" width="58" alt="React" />
  <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/sharing/on@2x.png" width="58" alt="Screen sharing" />
  <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/leave/enabled@2x.png" width="58" alt="Leave" />
</p>

</div>

> [!NOTE]
> Earlier versions relied on the Microsoft Teams third-party device integration, which Microsoft [retires on 30 June 2026](https://support.microsoft.com/en-us/teams/calls-devices/connect-to-third-party-devices-in-microsoft-teams). TeamDeck now reads and controls Teams through Windows UI Automation, so it keeps working after that date.

For the new Microsoft Teams (work or school) on Windows. Not affiliated with or endorsed by Microsoft or Elgato; "Microsoft Teams" and "Stream Deck" are trademarks of their respective owners.

## Features

**Live toggles** — mirror your real meeting state and grey out when you are not in a call.

|  |  |  |
| :-: | :-: | :-: |
| <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/mute/on@2x.png" width="44" alt="" /> | <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/camera/on@2x.png" width="44" alt="" /> | <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/hand/lowered@2x.png" width="44" alt="" /> |
| **Mute** | **Camera** | **Raise hand** |

**One-press**

|  |  |  |  |  |  |
| :-: | :-: | :-: | :-: | :-: | :-: |
| <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/leave/enabled@2x.png" width="44" alt="" /> | <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/react/applause@2x.png" width="44" alt="" /> | <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/react/laugh@2x.png" width="44" alt="" /> | <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/react/like@2x.png" width="44" alt="" /> | <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/react/love@2x.png" width="44" alt="" /> | <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/react/wow@2x.png" width="44" alt="" /> |
| **Leave** | Applause | Laugh | Like | Love | Surprised |

**Status tiles** — read-only, at a glance.

|  |  |
| :-: | :-: |
| <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/inmeeting/on@2x.png" width="44" alt="" /> | <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/sharing/on@2x.png" width="44" alt="" /> |
| **In meeting** | **Screen sharing** |

> Reading is non-intrusive. The helper inspects the meeting window in the background — even while Teams is minimised — and never steals focus or moves the mouse. A control press briefly brings Teams forward, then restores the window you were using, so you see only a short flash on an explicit press.

## Install

Download the latest **`.streamDeckPlugin`** from the [Releases page](https://github.com/teh-hippo/teamdeck/releases) — the Stream Deck app installs it for you. No Node, terminal, or build tools required.

Windows may flag the bundled helper the first time it runs, because it is unsigned. That is expected.

## Contributing

Want to build or hack on TeamDeck? See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT — see [LICENSE](LICENSE).
