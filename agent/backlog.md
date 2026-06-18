# Backlog (seed)

Portable mirror of the execution backlog. Phases are gated: work proceeds autonomously within a
phase, then stops at the `*-gate` for human + expert review. Status here is a snapshot; the live
tracker is the session SQL backlog.

Legend: [x] done · [~] in progress · [ ] pending

## Phase 0 — Foundation and base-integration proof

- [x] p0a-cli-and-smoke — install @elgato/cli, confirm native ARM64
- [x] p0a-identity-tuple — shared/identity.json (manufacturer/device/app/app-version)
- [x] p0a-protocol-probe — standalone probe; protocol captured in agent/specs/protocol.md
- [x] p0b-scaffold-manifest — scaffold; manifest SDKVersion 3 / Node 24 / min 7.1; validates
- [x] p0b-ws-client — shared Teams WebSocket singleton (src/teams/client.ts)
- [x] p0b-mute-e2e — verified live on the Neo: red/green and toggles Teams mute
- [x] p0c-ralph-harness — loop spec, proof gate, secret scan, backlog seed
- [x] p0-gate — expert panel reviewed and findings addressed; human E2E confirmed

## Phase 1 — Core actions (Mute, Camera, Raise Hand)

- [x] p1-base-action — ToggleAction base; setImage-driven live state; replay-on-appear
- [x] p1-mute-camera-hand — Mute, Camera, Raise Hand echoed live-state toggles
- [x] p1-deterministic-tests — protocol unit + fixture-replay suite (10 tests) in the Tier A gate
- [x] p1-gate — expert + human review (Mute/Camera/Hand verified live)

## Phase 2 — Reach original 10-action parity

- [x] p2-blur — background blur toggle with optimistic state
- [x] p2-leave — leave-call FireAction (gate canLeave; live test in Tier C)
- [x] p2-reactions — 5 reactions (send-reaction; wow = "Surprised"; gate canReact)
- [x] p2-tests — selectImage covers Blur; isActionable gate test (16 tests total)
- [x] p2-gate — both Opus reviewers (no blockers); findings addressed (18 tests)

## Phase 3 — Faithful UX, packaging, OSS release

- [x] p3-branding — name/UUID/disclaimer set; trademark checked; placeholder icons (final art deferred)
- [x] p3-property-inspector — root PI (live pairing status + re-pair); verified runtime-clean
- [ ] p3-neo-profile — 2-page Neo profile (10 actions over 8 keys)
- [~] p3-package-release — README + LICENSE + pack verified; final icons/profile + publish pending
- [ ] p3-gate — expert + human review (folded in around the holistic review)

## Phase 4 — Optional stretch (beyond original), isolated

- [ ] p4-stretch — screen-share, chat toggle, status tiles, Smart Profile auto-switch [Stream B]

## Polished icons (parallel worktree, Stream A)

- [ ] icons-fluent — polished Fluent-style icons for all 10 actions x on/off/unavailable

## Holistic review (after Streams A + B merge)

- [ ] hr-reduce — reduce code without breaking functionality; re-run full proof gate
- [ ] hr-tests — audit/extend deterministic unit tests for quality coverage
- [ ] hr-ci — GitHub Actions CI (build, validate, test, secret-scan, lint)
- [ ] hr-lint — ESLint/Prettier + JS/TS best practices, wired into CI and the gate
