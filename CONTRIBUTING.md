# Contributing

Thanks for your interest in TeamDeck.

## Prerequisites

Build and test on **Windows** — the Stream Deck CLI talks to the Windows Stream Deck app. You will
need:

- [Node.js](https://nodejs.org)
- The [Rust toolchain](https://rustup.rs), for the native helper
- The Elgato Stream Deck app

## Build and run

```powershell
npm install
npm run build         # bundle the plugin
npm run build:helper  # build the native helper into the plugin's bin/
npm run proof         # typecheck, lint, build, validate, icon check, unit tests
streamdeck link io.github.teh-hippo.teamdeck.sdPlugin
streamdeck restart io.github.teh-hippo.teamdeck
```

`npm run proof` is the gate to run before opening a pull request. `npm run pack` builds the helper
and produces a distributable `.streamDeckPlugin`.

A pre-commit hook runs a secret scan with Node, so keep Node on your PATH when committing.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`,
`docs:`, `chore:`, ...); the type drives the automated release. See [AGENTS.md](AGENTS.md) for the
release and versioning detail.
