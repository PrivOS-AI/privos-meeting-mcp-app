# Phase 8 Implementation Report — Settings, hardening, tests, hodao deploy

## Executed Phase
- Phase: phase-08-settings-hardening-tests-and-hodao-deploy
- Plan: `plans/260917-1358-meeting-agent-mcp-app-elevenlabs-diarization-voice-fingerprint/`
- Status: DONE_WITH_CONCERNS (code/tests/docs/scripts complete; live hodao deploy/pairing/manual-e2e explicitly out of scope per user directive)

## Files Created
- `src/shared/app-settings.ts` — central `WorkspaceAppSettings` (10 admin-gated keys) + defaults + validators
- `src/server/tools/is-workspace-admin.ts` — extracted admin heuristic (authz.ts re-exports)
- `src/server/stt/provider-health-probe.ts` — real cheap vendor probes (Soniox temp-key mint TTL10s; ElevenLabs `GET /v1/user/subscription`)
- `src/server/jobs/audio-retention-job.ts` — `purgeExpiredAudio(hub,roomId)` + `startAudioRetention(hub)` (3 branches: kept-audio TTL, orphaned interrupted parts, 30d pendingEmbedding sweep)
- `src/ui/data/settings-store.ts` — workspace settings read (App DB) + write (`meeting_settings_set`)
- `src/ui/data/local-preferences.ts` — per-user local prefs (localStorage, never `app_settings`)
- `src/ui/components/mic-test-wave.tsx` — 3s AnalyserNode mic test
- `src/ui/screens/settings/{language,speech-recognition,microphone,ai-summary,privacy,caption-display}-panel.tsx` + `use-workspace-admin.ts`
- `src/ui/theme/settings.css` — 240px nav + panel primitives
- Tests: `src/server/jobs/cross-room-authz.test.ts`, `audio-retention-job.test.ts`, `meeting-queue.test.ts`, `meeting-job.integration.test.ts` (+ `__fixtures__/sample-30s.wav`, real committed 30s two-tone wav), `src/server/media/meeting-folder-collision.test.ts`, `src/server/tools/stt-status-tool.test.ts`
- `docs/manual-e2e-checklist.md`

## Files Modified
- `src/server/tools/{authz,bootstrap-tool,realtime-token-tool,settings-set-tool,stt-status-tool}.ts`
- `src/server/stt/{stt-provider,soniox-realtime-token,soniox-async-provider,elevenlabs-realtime-token,elevenlabs-batch-provider}.ts` — `ProviderStatus` gained `reason`/`usage`/`activeSessions`; all 4 `status()` use the real probe
- `src/server/jobs/meeting-queue.ts` — `draining` flag (`startDraining()`)
- `src/server/index.ts` — SIGTERM/SIGINT drain hook + `startAudioRetention` lifecycle
- `src/ui/{main.tsx,screens/settings-screen.tsx}`, `src/ui/i18n/{vi,en}.json` (+91 keys, parity verified 274/274)
- `scripts/deploy-hodao.sh` — port precheck, ecosystem-aware pm2 reload/start, `pm2 save`, health-check loop, VOICEPRINT_ENC_KEY backup reminder
- `docs/{deployment-guide,codebase-summary,system-architecture,project-roadmap,design-guidelines}.md`, `PRIVOS.md`

## Deps
None added — reused `@ffmpeg-installer/ffmpeg` (already a dependency) to synthesize the committed integration-test wav fixture.

## Open-question defaults applied (plan default + code comment, per USER DIRECTIVE)
- `speaker_profile_update(action:'reenrol')` left as the existing "not supported" `AppError` — phase didn't require closing it.
- Bulk "Xoá toàn bộ voiceprint" confirm-by-typing: plan asks for a name-retype gate but a workspace-wide bulk action has no single name to retype — resolved with a fixed literal confirmation phrase (`XOA VOICEPRINT`), documented inline in `privacy-panel.tsx`.
- `pendingEmbedding` TTL fixed at 30 days (phase-04's risk table value), not made configurable — matches plan wording exactly ("cũ hơn 30 ngày").
- `audio-retention-job.ts` built as its OWN boot+6h-interval module (`purgeExpiredAudio`/`startAudioRetention`) per plan.md's Architecture code sketch, rather than folding into `startup-sweep.ts` — the orchestrator prompt's paraphrase said "extend startup-sweep.ts"; the authoritative phase spec's own sketch specifies a dedicated module, which is what was built (still wired into `bootstrap-tool.ts` and boot, satisfying "extend the sweeps" in effect).
- **Manifest/package version**: phase step 16 says bump `privos-app.json` 0.1.0→1.0.0. `scripts/preflight.ts` (existing, unmodified) hard-asserts `manifest.version === package.json.version` — and the user directive explicitly forbids touching `package.json`'s version. Bumping only one side would fail `npm run preflight` (a required gate). Resolved by leaving BOTH at `0.1.0` and not tagging `v1.0.0` this session — flagging for the user rather than silently picking a side.

## Gate Status (all run via `NODE_ENV=development`, this shell's `NODE_ENV=production` default)
- `tsc -p tsconfig.json --noEmit` (ui): PASS
- `tsc -p tsconfig.server.json --noEmit` (server): PASS
- `npm run test` (vitest): PASS — **325 tests / 62 files** (was 322/61 pre-phase)
- `npm run build`: PASS (vite build + generate-manifest + manifest:lint)
- `npm run manifest:lint`: PASS
- `NODE_ENV=development npm run preflight`: PASS
- `NODE_ENV=development npm run verify:fast-pr` (end-to-end): PASS
- `grep -rn "SONIOX_API_KEY|ELEVENLABS_API_KEY|VOICEPRINT_ENC_KEY|BOT_CREDENTIAL|ANTHROPIC" src/ui/`: CLEAN (no matches)
- i18n parity: vi.json/en.json both 274 keys, zero drift (verified programmatically)
- `npm run package`: NOT run this session (requires a clean/committed git tree or `--allow-dirty`; script itself unmodified, already had the credential-file rejection guard from an earlier phase)

## New test coverage highlights
- `cross-room-authz.test.ts`: `meeting_process`/`meeting_status`/`speaker_profile_delete` called as actual tools (not just `authz.ts` primitives) — room B cannot reach room A's meeting or another user's speaker profile
- `meeting-folder-collision.test.ts`: two meetings same room/date/title get distinct `folderName`/`partFileName`; `concatParts` rejects a part smuggled in with the OTHER meeting's digest even when its fileId is in `partFileIds`
- `meeting-job.integration.test.ts`: REAL `@ffmpeg-installer/ffmpeg` decode against a committed 30s wav fixture (Soniox/ElevenLabs, embedding extractor, and Hub-AI summarizer all faked — no ONNX model is available in this dev sandbox, only downloaded at deploy time), a real abort-kills-the-ffmpeg-child assertion, a full-pipeline-completes-with-5-uploads assertion, and a transcribe-failure-does-not-upload-partial-results assertion
- `audio-retention-job.test.ts`: all 3 retention branches (kept-audio TTL incl. `0`=disabled, orphaned interrupted parts, 30d pendingEmbedding) plus the "already deleted, skip" case
- `stt-status-tool.test.ts`: non-admin gets `{ok}` only; admin gets full 4-provider detail with real probe outcomes (`configured`/`ok`/`invalid_key` on a mocked 401), never a key value
- `meeting-queue.test.ts`: `startDraining()` rejects new work, never affects an already-running (or re-enqueued-same-meetingId) job

## Not completed / deferred (explicit)
- Live hodao deploy, `npm run pair`, admin bot-credential provisioning, `ecosystem.config.cjs` entry (file lives outside this repo on the node), pm2 start/save on the real node — per USER DIRECTIVE, not executed
- `docs/manual-e2e-checklist.md`'s 21 manual scenarios — all marked "_chưa chạy_", none fabricated
- `scripts/spikes/*` + `ab-vietnamese-quality.ts` — not run (need live Hub/vendor keys), consistent with every prior phase's status
- Manifest/package version bump to 1.0.0 and the `v1.0.0` git tag — deferred (see version conflict above); no commit was made this session (none requested)
- `speaker_profile_update(action:'reenrol')` still unsupported (pre-existing, out of this phase's required scope)

## Unresolved Questions
1. Manifest/package version: bump both together (breaks the "never touch package.json" instruction) or accept staying at 0.1.0 through v1 release? Left at 0.1.0 pending your call.
2. `npm run package`'s dirty-tree guard means it cannot succeed until these changes are committed (or run with `--allow-dirty`) — not run this session; say if you want it run now with `--allow-dirty` as a smoke check.

Status: DONE_WITH_CONCERNS
Summary: All P8 code (central settings, 6 new settings panels + P4's speaker panel remounted, real STT status probes, audio/pendingEmbedding retention, queue draining, hardening tests incl. a real-ffmpeg integration test, docs, deploy script) is complete and every static gate (typecheck/test/build/manifest-lint/preflight/verify:fast-pr) is green at 325 tests/62 files; live hodao deploy, pairing, and the 21-item manual e2e checklist remain unexecuted per your explicit directive.
Concerns: version-sync conflict between preflight's manifest↔package.json check and the "never touch package.json" instruction (left both at 0.1.0, no tag cut); `npm run package` not smoke-tested this session.
