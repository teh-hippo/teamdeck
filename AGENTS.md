# AGENTS.md

Guidance for coding agents in this repository. See [`README.md`](README.md) for the product
overview and [`CONTRIBUTING.md`](CONTRIBUTING.md) for building and testing.

## Build, compile and test

Build and test on Windows. The plugin is TypeScript bundled by rollup; the native helper in
[`native/`](native/) is Rust, built with `cargo` (install via <https://rustup.rs>). The Stream Deck
CLI (`validate`, `link`, `pack`) only talks to the Windows Stream Deck app, and the installed
`node_modules` native binaries are host-specific.

Use targeted Node test files or Rust test filters while implementing.  `npm run proof` is the
canonical Windows release-candidate gate: plugin typecheck, lint, build, validation, icon checks and
tests, followed by Rustfmt, Clippy, native tests, cargo-machete, helper bundling and a schema smoke
test.  Run it once the release candidate is ready and again after device-driven code changes.  The
pre-commit hook runs a secret scan with Node, so commits need Node on the PATH.

On-device proof uses at least 30 confirmed commands per control with zero failures, duplicates, or
final state disagreements.  P95 limits are 500 ms for mute/camera, one second for hand, 1.5 seconds
for reactions, and two seconds for helper recovery.  Hand commands retry at most twice, at 600 ms
intervals, only when Teams' `FullDescription` proves the preceding action did not change state.

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
