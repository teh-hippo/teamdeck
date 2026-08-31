# Contributing

Thanks for your interest in TeamDeck.

## Prerequisites

Build and test on **Windows** — the Stream Deck CLI talks to the Windows Stream Deck app. You will
need:

- [mise](https://mise.jdx.dev), which installs the pinned Node.js, Rust, Rustfmt, Clippy, and cargo-machete versions from `mise.toml`
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/) with the **Desktop development with C++** workload
- The Elgato Stream Deck app

Run `mise install` after cloning.  Contributors who do not use mise need Node.js 24, Rust 1.98 with
Rustfmt and Clippy, cargo-machete 0.9.2, and the x64 MSVC toolchain.

## Build and run

```powershell
npm install
npm run build         # bundle the plugin
npm run build:helper  # build the native helper into the plugin's bin/
npm run proof         # complete Windows release-candidate proof
streamdeck link io.github.teh-hippo.teamdeck.sdPlugin
streamdeck restart io.github.teh-hippo.teamdeck
```

Use targeted Node or Rust tests while implementing.  Run `npm run proof` for the release candidate;
it typechecks, lints, builds, validates, tests, audits, bundles, and smoke-tests the plugin and native
helper.  `npm run pack` produces a distributable `.streamDeckPlugin`.

Device proof requires at least 30 confirmed commands per control with zero failures, duplicates, or
final state disagreements.  Mute and camera must remain at or below 500 ms p95, hand at or below
one second p95 with up to two state-driven retries when Teams silently ignores a hand action, reactions
at or below 1.5 seconds p95, and helper recovery at or below two seconds.

A pre-commit hook runs a secret scan with Node, so keep Node on your PATH when committing.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`,
`docs:`, `chore:`, ...); the type drives the automated release. See [AGENTS.md](AGENTS.md) for the
release and versioning detail.
