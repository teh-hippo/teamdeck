# teamdeck Ralph loop — operating spec

This is the prompt/spec an autonomous agent reads each iteration to advance teamdeck. It is a
real, versioned project artifact (not transient notes). The human-readable phase plan lives in
the session plan; this file plus the SQL backlog drive execution.

## Mission

Recreate the discontinued Microsoft "Microsoft Teams" Stream Deck plugin as an OSS plugin
(`@elgato/streamdeck`, TypeScript) for new Teams (work/school) on Windows, tested on a Stream Deck
Neo. State and control come from a native Windows UI Automation helper (`native/`), since the Teams
third-party app API it first used retires on 30 June 2026. Actions: Mute, Camera, Raise Hand
(live-state toggles) + Leave + 5 reactions (Applause, Laugh, Like, Love, Surprised=`wow`); read-only
In Meeting and Screen Sharing tiles.

## Principles

- Evidence over assumption. Reference repos are leads, not truth: verify against
  `agent/specs/helper.md` (the helper contract) and live testing.
- De-risk core unknowns early; do not front-load every research task.
- Phase-gated autonomy: work autonomously within a phase, then stop at the phase boundary for
  human + expert-panel review.
- Granular commits (one logical change each) with the Co-authored-by trailer. Australian
  English in docs and commit messages; no emdash; minimal code comments.
- Keep the Stream Deck log level off `trace` (it logs every Stream Deck message). Never commit
  secrets; `**/*.secret.json` is gitignored and a pre-commit secret scan runs.

## Each iteration

1. Pick the next ready todo from the SQL backlog: `status='pending'` with all `todo_deps`
   satisfied, within the current phase. Set it `in_progress`.
2. Implement the smallest correct change. Consult `agent/specs/helper.md` and
   `agent/specs/architecture.md`.
3. Prove it with the tiered proof gate (below). Never commit unproven work.
4. Commit granularly. Update the todo to `done` (or `blocked` with a reason).
5. If the next ready todo is a phase `*-gate`, STOP and request human + expert review.

## Tiered proof gate

- Tier A (blocking, every iteration, fully autonomous): `node tools/proof-gate.mjs` runs
  `npm run typecheck`, `npm run build`, `streamdeck validate`, the icon check, and `npm test`
  (deterministic unit tests). Fail closed. It does not spawn the helper.
- Tier B (opportunistic, non-blocking): if a live meeting is available, run the built helper
  (`teamdeck-helper.exe`, read mode) or drive a key to confirm behaviour; otherwise defer.
- Tier C (human-attended, at the phase gate): full live matrix on the Neo in a solo "Meet now".
  Destructive or visible commands (`leave`, reactions) run ONLY here.

## Guardrails

- Stuck detection: if a todo fails its proof gate repeatedly, set it `blocked` with a note and
  escalate to the human rather than thrashing.
- Keep `agent/backlog.md` in sync with the SQL backlog so state is portable.
- Record gate evidence (redacted) under `agent/progress/`.

## Environment notes (verified)

- Run `streamdeck` CLI commands (link/restart/validate/pack) from Windows PowerShell, not WSL.
- Dev box is Windows ARM64; the Stream Deck app is x64, so it runs the plugin under x64 Node
  (manifest `Nodejs.Version: 24`) and the bundled x64 helper runs fine under emulation.
- Enable developer mode once with `streamdeck dev` (already done) to allow link/restart.
