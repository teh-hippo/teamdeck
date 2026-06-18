# teamdeck Ralph loop — operating spec

This is the prompt/spec an autonomous agent reads each iteration to advance teamdeck. It is a
real, versioned project artifact (not transient notes). The human-readable phase plan lives in
the session plan; this file plus the SQL backlog drive execution.

## Mission

Faithfully recreate the discontinued Microsoft "Microsoft Teams" Stream Deck plugin as an OSS
plugin (`@elgato/streamdeck`, TypeScript), targeting new Teams (work/school) on Windows, tested
on a Stream Deck Neo. Original feature set = 10 actions: Mute, Camera, Background Blur, Raise
Hand (live-state toggles) + Leave + 5 reactions (Applause, Laugh, Like, Love, Surprised=`wow`).

## Principles

- Evidence over assumption. Reference repos are leads, not truth: verify against
  `agent/specs/protocol.md` (empirically captured) and live testing.
- De-risk core unknowns early; do not front-load every research task.
- Phase-gated autonomy: work autonomously within a phase, then stop at the phase boundary for
  human + expert-panel review.
- Granular commits (one logical change each) with the Co-authored-by trailer. Australian
  English in docs and commit messages; no emdash; minimal code comments.
- The Teams pairing token is a secret: never log it (keep the SD log level off `trace`), never
  commit it. `agent/progress/probe-token.json` and `**/*.secret.json` are gitignored.

## Each iteration

1. Pick the next ready todo from the SQL backlog: `status='pending'` with all `todo_deps`
   satisfied, within the current phase. Set it `in_progress`.
2. Implement the smallest correct change. Consult `agent/specs/protocol.md` and
   `agent/specs/architecture.md`.
3. Prove it with the tiered proof gate (below). Never commit unproven work.
4. Commit granularly. Update the todo to `done` (or `blocked` with a reason).
5. If the next ready todo is a phase `*-gate`, STOP and request human + expert review.

## Tiered proof gate

- Tier A (blocking, every iteration, fully autonomous): `node tools/proof-gate.mjs` runs
  `npm run build`, `streamdeck validate`, and `npm test` (deterministic unit/fixture-replay
  tests against a mock Teams server and the captured fixtures). Fail closed.
- Tier B (opportunistic, non-blocking): if a paired token and a live meeting are available, run
  a live probe (`tools/probe/probe.mjs`) to confirm behaviour; if unavailable, defer to the gate.
- Tier C (human-attended, at the phase gate): full live matrix on the Neo in a solo "Meet now".
  Destructive or visible commands (`leave-call`, reactions) run ONLY here.

## Single-socket discipline

Teams binds the token to the identity tuple in `shared/identity.json`; the probe and the plugin
share it. Never run the probe and the plugin against Teams at the same time — stop/unlink the
plugin first. Treat any unexpected socket close as a reconnect trigger.

## Guardrails

- Stuck detection: if a todo fails its proof gate repeatedly, set it `blocked` with a note and
  escalate to the human rather than thrashing.
- Keep `agent/backlog.md` in sync with the SQL backlog so state is portable.
- Record gate evidence (redacted) under `agent/progress/`.

## Environment notes (verified)

- Run `streamdeck` CLI commands (link/restart/validate/pack) from Windows PowerShell, not WSL.
- Dev box is Windows ARM64; the plugin is pure-JS and runs under the x64 Stream Deck app via
  Prism. Node is supplied to the plugin by the Stream Deck app (manifest `Nodejs.Version: 24`).
- Enable developer mode once with `streamdeck dev` (already done) to allow link/restart.
