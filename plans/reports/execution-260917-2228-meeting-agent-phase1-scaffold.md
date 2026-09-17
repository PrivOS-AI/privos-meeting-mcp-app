# Execution Report — Phase 1 Scaffold (deterministic slice)

Date: 2026-09-17 · Plan: `260917-1358-meeting-agent-mcp-app-elevenlabs-diarization-voice-fingerprint` · Phase 1

## Scope decision

User chose "full scaffold P1" after being told the 11 foundational spikes, `npm run pair`,
the A/B default-picker, and the hodao deploy **cannot run in this session** (no live Hub, no
bot credential, no Soniox/ElevenLabs keys, no audio) and that the plan forbids writing P2
before spike-10 resolves. Delivered: every deterministic artifact of Phase 1, verified green
offline. Spikes/live/deploy left as runnable-but-gated stubs + documented TODOs.

## Delivered

- **Config/build**: `package.json`, `tsconfig{,.server}.json`, `vite.config.ts`, `vitest.config.ts`,
  `.gitignore`, `.env.example` (all env vars), `privos-app.json` (4 tools, one `_meta.ui` with
  permissions+csp, dataPolicy externalProcessing, full env table), `PRIVOS.md`, `public/icon.svg`.
- **Server**: `serveApp` wiring (`index.ts` + boot checks), `manifest.ts`, `mcp-handler.ts`
  (fail-closed actor gate), `env.ts` (typed, fail-fast), `ui-resource.ts`, `relay-transport.ts`
  (dev pairing + MCP_APP_ID cache), `dev-server.ts`, `paths.ts`, `app-icon.ts`.
- **Hub (installation bot)**: `resolve-hub-origin`, `resolve-own-mcp-app-id`, `bot-tool-call`
  (optional roomId), `agent-bot-credential-check`, `app-db-bot-client` (+ `ensureAppDbSchema`),
  `app-settings`, `ensure-bot-in-room`.
- **STT**: `stt-provider` (interface), `stt-provider-registry` (workspace→env selection),
  4 shells (soniox/elevenlabs × realtime/async).
- **Tools**: registry + index + `meeting_agent_bot_credential_check`, `meeting_bootstrap`,
  `meeting_stt_status`.
- **Shared**: `app-db-schema` (7 collections, single source of truth), `cosine`, `meeting-slug`,
  `app-error`.
- **UI**: React 18 + Vite shell — rail 64 / topbar 60 / body, i18n vi/en, theme (light/dark),
  inline-SVG icons (45), read-only app-db-client, bot-credential banner, 5 placeholder screens.
- **Scripts**: pair, generate-manifest, lint-manifest, preflight, package-source, deploy-hodao,
  11 spike stubs + `ab-vietnamese-quality` (prereq-checking, gated).
- **Docs**: 7 skeleton files incl. `system-architecture.md` with a "Spike results — TBD" section.

## Verification (offline gates — all green)

| Gate | Result |
|---|---|
| `tsc` (ui + server + scripts) | pass |
| `vitest` | 21 tests pass (cosine, slug, schema, bot-tool-call, manifest-parity) |
| `vite build` | single inlined bundle (index.js+css), no Google-Fonts string |
| `manifest:lint` | valid (schemaVersion 3) |
| `preflight` | pass (serveApp boots, serves authoritative manifest) |

## Code review + fixes applied

`code-reviewer` (DONE_WITH_CONCERNS) → fixed in-session:
- **H1** fail-closed/boot guard re-keyed from `NODE_ENV` to `resolveRuntimeMode().mode` (managed
  production now provably fail-closed; unresolvable mode → treated as production).
- **M1/L4** UI + feature tool `title`/`description` now sourced from / aligned to the manifest;
  added `manifest-parity.test.ts` to lock registry↔manifest so it can't drift in CI.
- **M2** `setSetting` tolerates a concurrent unique-key create (retry as update); `knownRooms`
  race documented for the Phase-3 sweeper.
- **L2/L3** `cosine`: dropped dead loop in `encodeEmbedding`; `decodeEmbedding` copies out of the
  Node pooled buffer (no alias / alignment assumption). **L5** test name corrected.
- Not changed (documented): **L1** index reconciliation on `updateSchema` — deferred until schema
  evolves.

## Still gated on a live environment (NOT done here)

- 11 foundational spikes + A/B (need Hub + bot credential + Soniox/ElevenLabs keys + audio).
- `npm run pair` + open-in-Hub verification (mic prompt, WS Soniox, App DB, credential valid).
- pm2 deploy on hodao.
- **Do not write Phase 2 until spike-10 (SDK API surface) is resolved** (plan constraint).

## Known placeholders to resolve before live

- `privos-app.json` CSP `connect-src`/`media-src` hold literal `<PRIVOS_FILES_ORIGIN>` → spike-03.
- `ensure-bot-in-room.ts` tool name `mcpapp.bot.joinRoom` → confirm via spike-06.
- `meeting_stt_status` admin-only gating deferred to Phase 8.

## Unresolved questions

1. Does the managed runtime set `NODE_ENV=production`? H1 fix no longer depends on it, but worth
   confirming against the hodao/pm2 deploy.
2. Does the Hub render tool descriptions from `tools/list` or from `privos-app.json`? (Parity now
   enforced either way.)
3. All plan-level open questions (#1–#12) remain — they are answered by the live spikes.
