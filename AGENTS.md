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

## Releases and versioning

Releases are automated with [release-please](https://github.com/googleapis/release-please), so the
commit history must follow [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, ...). The type drives the version bump, so a
non-conventional subject silently produces no release.

Flow: merges to `main` let release-please open or update a release PR; merging that PR bumps the
version, updates `CHANGELOG.md`, and pushes a `vX.Y.Z` tag; the tag triggers
[`release.yml`](.github/workflows/release.yml), which packs and publishes the `.streamDeckPlugin`.

Version sources:

- `package.json` and `native/Cargo.toml` are the source of truth and are bumped together by
  release-please. `release.yml` asserts the tag matches both before packing. release-please does
  **not** update `native/Cargo.lock`, so the helper build must stay non-`--locked`: adding
  `--locked` or `--frozen` would make every release-please PR fail until the lockfile is synced.
- `manifest.json` `Version` is the 4-part Stream Deck format (`X.Y.Z.0`) and is **not** managed by
  release-please (Stream Deck rejects 3-part versions). It is derived from the tag at pack time
  (`streamdeck pack --version X.Y.Z.0`), so the committed value is only a dev default; do not rely on
  it for the shipped version.

Pre-1.0, `feat:` bumps the minor by default and `bump-minor-pre-major` keeps a breaking change on
the minor too (instead of jumping to 1.0.0), so cutting `1.0.0` needs a `Release-As: 1.0.0` footer
on a commit.
