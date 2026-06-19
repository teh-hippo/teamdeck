# AGENTS.md

Guidance for coding agents in this repository. See [`README.md`](README.md) for the product
overview and [`agent/specs/`](agent/specs/) for the verified protocol and architecture.

## Build, compile and test

Build and test on Windows. The Stream Deck CLI (`validate`, `link`, `pack`) only talks to the
Windows Stream Deck app, and the installed `node_modules` native binaries are host-specific.

`npm run proof` is the canonical gate (build, validate, icon check, unit tests); run it before
considering a change complete. The pre-commit hook runs a secret scan with Node, so commits need
Node on the PATH.
