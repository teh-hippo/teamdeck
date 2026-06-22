# AGENTS.md

Guidance for coding agents in this repository. See [`README.md`](README.md) for the product
overview and [`agent/specs/`](agent/specs/) for the helper contract and architecture.

## Build, compile and test

Build and test on Windows. The plugin is TypeScript bundled by rollup; the native helper in
[`native/`](native/) is Rust, built with `cargo` (install via <https://rustup.rs>). The Stream Deck
CLI (`validate`, `link`, `pack`) only talks to the Windows Stream Deck app, and the installed
`node_modules` native binaries are host-specific.

`npm run proof` is the canonical gate (typecheck, build, validate, icon check, unit tests); run it
before considering a change complete. It does not build the helper -- run `npm run build:helper`, or
`npm run pack` which builds and bundles it, when the helper or its bundling changes. The pre-commit
hook runs a secret scan with Node, so commits need Node on the PATH.
