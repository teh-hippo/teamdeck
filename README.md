<div align="center">

# TeamDeck

[![Licence: MIT](https://img.shields.io/badge/Licence-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/teh-hippo/teamdeck)](https://github.com/teh-hippo/teamdeck/releases)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6)
![Elgato Stream Deck](https://img.shields.io/badge/Elgato-Stream%20Deck-101820?logo=elgato&logoColor=white)

### Drive a Microsoft Teams meeting straight from your Elgato Stream Deck.

<p>
  <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/mute/on@2x.png" width="58" alt="Mute" />
  <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/camera/off@2x.png" width="58" alt="Camera" />
  <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/hand/lowered@2x.png" width="58" alt="Raise hand" />
  <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/react/love@2x.png" width="58" alt="React" />
  <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/sharing/on@2x.png" width="58" alt="Screen sharing" />
  <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/leave/enabled@2x.png" width="58" alt="Leave" />
</p>

</div>

Not affiliated with or endorsed by Microsoft or Elgato; "Microsoft Teams" and "Stream Deck" are trademarks of their respective owners.

## Features

|  |  |  |  |  |  |
| :-: | :-: | :-: | :-: | :-: | :-: |
| <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/mute/on@2x.png" width="44" alt="" /> | <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/camera/on@2x.png" width="44" alt="" /> | <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/hand/lowered@2x.png" width="44" alt="" /> | <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/leave/enabled@2x.png" width="44" alt="" /> | <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/inmeeting/on@2x.png" width="44" alt="" /> | <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/sharing/on@2x.png" width="44" alt="" /> |
| **Mute** | **Camera** | **Raise hand** | **Leave** | **In meeting** | **Screen sharing** |
| <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/react/applause@2x.png" width="44" alt="" /> | <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/react/laugh@2x.png" width="44" alt="" /> | <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/react/like@2x.png" width="44" alt="" /> | <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/react/love@2x.png" width="44" alt="" /> | <img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/react/wow@2x.png" width="44" alt="" /> |  |
| Applause | Laugh | Like | Love | Surprised |  |

### Availability (opt-in)

<img src="io.github.teh-hippo.teamdeck.sdPlugin/imgs/actions/availability/available@2x.png" width="44" alt="Availability" />

A read-only tile mirrors your Microsoft Teams presence — Available, Busy, Do Not Disturb, Be Right
Back, Away, Offline, and In a meeting. Presence is read from your local New Teams log, so it stays
off until you tick **Allow reading status via Teams logs** in the tile's property inspector. Only the
availability word is read (no messages, contacts, or meeting titles), and nothing leaves your machine.

Teams' finer activities roll up to these states, using the same colours Teams does: *In a call* shows
as Busy and *Presenting* as Do Not Disturb, while *In a meeting* is detected directly. (Distinguishing
those activities would require signing in to Microsoft Graph, which this tile deliberately avoids.)

## Install

Download the latest from the [Releases page](https://github.com/teh-hippo/teamdeck/releases) — the Stream Deck app installs it for you. No Node, terminal, or build tools required.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

This project is licensed under the MIT Licence - see the [LICENSE](LICENSE) file for details.
