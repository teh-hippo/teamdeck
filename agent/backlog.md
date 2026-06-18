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
- [ ] p1-gate — expert + human review

## Phase 2 — Reach original 10-action parity

- [ ] p2-blur — background blur (optimistic, meeting-transition reset)
- [ ] p2-leave — leave-call (gate canLeave; live only in Tier C)
- [ ] p2-reactions — 5 reactions (send-reaction; wow = "Surprised"; gate canReact)
- [ ] p2-tests — extend deterministic tests
- [ ] p2-gate — expert + human review

## Phase 3 — Faithful UX, packaging, OSS release

- [ ] p3-branding — finalise name/UUID/disclaimer + icon provenance
- [ ] p3-property-inspector — single root PI (pairing status, re-pair, host/token override)
- [ ] p3-neo-profile — 2-page Neo profile (10 actions over 8 keys)
- [ ] p3-package-release — pack .streamDeckPlugin + README + LICENSE
- [ ] p3-gate — expert + human review

## Phase 4 — Optional stretch (beyond original), isolated

- [ ] p4-stretch — screen-share, chat toggle, status tiles, Smart Profile auto-switch
