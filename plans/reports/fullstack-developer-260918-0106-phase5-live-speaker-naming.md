# Phase 5 Implementation Report — Live speaker naming from chunks

## Executed Phase
- Phase: phase-05-live-speaker-naming-from-chunks
- Plan: plans/260917-1358-meeting-agent-mcp-app-elevenlabs-diarization-voice-fingerprint
- Status: completed (static verification only per user directive — no dev-server/pairing/soak run)

## Files Created
- `src/server/jobs/keyed-serial-queue.ts` (+test) — key-serialized queue, backlog cap 3, `abort()` awaits child exit
- `src/server/speaker/session-speaker-registry.ts` (+test, 14 cases a-h + clock/TTL/loadFrom) — in-memory per-meeting registry: verify-every-observation, `label@n` recycle, sticky (≥2 turns + `LIVE_MIN_SPEECH_SEC`), merge, defer/dedupe, ring, clock (`decodedSecBefore`/`noteDecoded`/`markDiscontinuity`/`markDropped`), `SessionRegistryStore` (TTL 30min + LRU)
- `src/server/live-speakers/part-window.ts` — download part by `seq`, `meetingId8` stamp check
- `src/server/live-speakers/chunk-worker.ts` (+test) — `processChunk` (download→decode→cut PCM→embed→observe→match→append live-turns→upsertAll), `noteDecoded` in `finally`, dropped-backlog handler
- `src/server/live-speakers/live-speaker-repository.ts` (+test) — `ensureRegistry`/`loadForMeeting`/`upsertAll`, seals centroid, `snapshotChanged` gate
- `src/server/tools/span-validation.ts` (+test) — structural checks (cap 200, overlap, total-duration bound) + `isWithinPartWindow` + RMS `hasRealEnergy` (documented default, plan open Q#9)
- `src/server/tools/live-speakers-tool.ts` (+test) — `meeting_live_speakers`, room-member authz, DTO allowlist, `degraded`/`labelsSupported`
- `src/server/jobs/meeting-repository.test.ts`, `src/server/tools/live-speakers-tool.test.ts`
- `src/ui/components/live-speaker-chips.tsx`, `src/ui/components/quick-assign-popover.tsx`
- `src/ui/theme/live-speakers.css` (new file — `speaker-identity.css` already >200 lines pre-P5)

## Files Modified
- `src/server/tools/chunk-ready-tool.ts` — real authz + structural span validation + `labels_not_supported` degraded-mode short-circuit + enqueue (was validate-only shell); test file updated to match (cross-boundary turns now accepted, not rejected)
- `src/server/media/live-turns-store.ts` — added `appendLiveTurns` (read-then-replace-upload)
- `src/server/jobs/meeting-repository.ts` — added `mergeLiveIntoAsyncSpeaker` (name priority user>async>live) + `deleteUnmappedLiveSpeakers`
- `src/server/jobs/meeting-job.ts` — real `reconcileWithLiveSpeakers` (was P3 no-op stub): reads `live-turns.json`, `alignByMaxOverlap`, merges into one row/person, returns `speakerId->sessionSpeakerId` map used to set `JobResultSpeaker.liveSessionSpeakerId`
- `src/server/tools/index.ts`, `privos-app.json` — registered `meeting_live_speakers` (16 tools total; phase doc's stale "17"/"18" figures count later phases too)
- `src/server/tools/speaker-resolve-tool.ts` — **verified only, no code change**: `findSpeakerRow` already falls back to `sessionSpeakerId`; added a regression test proving it
- `src/ui/data/live-speaker-poll.ts` (+test) — `LiveSpeaker.liveSpeechSec`/`mergedInto`, `onSpeakersUpdate` callback, skips merged-away entries when building the label map
- `src/ui/stores/recording-store.ts` — `liveSpeakers`/`liveSpeakersDegraded` state, `applyQuickAssignResult` optimistic update
- `src/ui/screens/live-screen.tsx`, `src/ui/main.tsx` (CSS import)
- `src/ui/i18n/vi.json`, `en.json` — key parity verified (120/120)
- `scripts/calibrate-speaker-threshold.ts` — `--session` mode sweeps `SPEAKER_SESSION_MATCH_THRESHOLD`/`_MERGE_THRESHOLD`, prints false-split/false-merge tables
- `docs/system-architecture.md` — new "Live speaker naming từ chunk (P5)" section

## Not modified (already correct from prior phases)
- `src/server/env.ts` — all 4 P5 env vars + `liveMaxConcurrentRecordings` already present
- `src/shared/app-db-schema.ts` — `meeting_speakers` already has every P5 field (`sessionSpeakerId`, `sonioxLabels`, `liveConfidence`, `liveSpeechSec`, `liveUpdatedAt`, `snapshotHash`, `pendingEmbedding`)
- `src/server/manifest.ts` — generic projector, no hardcoded tool list
- `embedding-extractor.ts`/`speaker-matcher.ts`/`profile-store.ts`/`voiceprint-crypto.ts`/`pcm-utils.ts` — reused as-is, per plan

## Deps added
None — reused `@ffmpeg-installer/ffmpeg`, `sherpa-onnx-node` already in package.json.

## Open-question defaults implemented (per user directive — coded, not run)
- **#9 (RMS vs Silero VAD)**: RMS via `pcm-utils.hasSpeechEnergy` (`span-validation.ts`'s `hasRealEnergy`) — documented in a code comment as the plan's default; `sherpa_onnx.Vad` upgrade deferred until CPU measurements justify it.
- **Session-registry thresholds** (`SPEAKER_SESSION_MATCH_THRESHOLD`=0.40, `_MERGE_THRESHOLD`=0.60): plan defaults, unverified against real audio — `calibrate-speaker-threshold.ts --session` now exists to close this but was not run (no real samples, no dev-server per directive).

## Design resolutions worth flagging
1. **Span-window validation split**: structural checks (shape/cap/overlap/total-duration) run synchronously in `chunk-ready-tool.ts` before enqueue; the audio-aware window check (`isWithinPartWindow` against the server-tracked `decodedSecBefore`) and RMS silence check run inside `chunk-worker.ts`, matching the phase's own Architecture pseudocode (`validateSpans` runs inside `onChunkReady`) rather than the Implementation Steps' looser phrasing that implied it all lives in the tool.
2. **Deferred-turn re-validation bug caught by testing**: a turn deferred from chunk N legitimately has a `startMs` that belongs to chunk N's window, not chunk N+1's — re-running the window check against chunk N+1 would wrongly reject the `[58s,63s]` fixture. Fixed by skipping the window check specifically for turns replayed from `takeDeferred()`.
3. **`mergedInto` is registry-only, never a DB field** (schema has none) — `meeting_live_speakers` surfaces it from the in-process registry when this pm2 instance is running that meeting's worker (true in production: single-instance deploy per PRIVOS.md). UI's `toSpeakerKeyMap` skips merged-away entries so a stale duplicate label mapping can't win a `Map.set` race.
4. **Reconcile name priority** implemented as an actual rank comparison (`user`>`async`>`live`) in `mergeLiveIntoAsyncSpeaker`, not just "async always wins" — an unresolved async speaker still adopts a live quick-assign/auto-match name instead of staying "Người nói N".
5. **Idempotent-by-seq**: not short-circuited at the tool layer (a duplicate `meeting_chunk_ready` for the same `seq` re-enqueues and re-downloads/decodes); correctness for repeated calls is guaranteed at the registry layer (`alreadyProcessed` dedupe by `speaker+startMs`), which is what the plan's acceptance criteria actually measure (no double-counted `liveSpeechSec`/embeddings). Flagging as a conscious scope trade-off, not an oversight.

## Gates
- `tsc -p tsconfig.json --noEmit` (UI): PASS
- `tsc -p tsconfig.server.json --noEmit` (server): PASS
- `vitest run`: PASS — 232 tests / 44 files (one flaky-by-design queue test fixed: the task must itself observe the abort signal, `abort()` cannot force it)
- `npm run build` (vite + generate-manifest + manifest:lint): PASS, 16 tools in `dist/manifest.json`
- `npm run preflight`: PASS
- `npm run verify:fast-pr`: PASS end-to-end

## Not done (explicitly out of scope per user directive)
- 60-minute soak on hodao, real multi-speaker meeting timing/CPU/RSS measurements, `calibrate-speaker-threshold.ts --session` actually run against samples — all require a live Hub/real audio and were explicitly excluded ("DO NOT run the app/dev-server/spikes/pairing").

Status: DONE_WITH_CONCERNS
Summary: Full phase coded and statically verified (typecheck/test/build/preflight all green, 16 tools, i18n parity); concerns are the untunable-without-real-audio session thresholds and the soak/live-timing acceptance criteria that need a real Hub + microphone, which the directive excludes from this pass.
Concerns/Blockers: (1) SPEAKER_SESSION_MATCH/MERGE_THRESHOLD defaults are still unverified — run `calibrate:speaker -- <samples> --session` once real same-session recordings exist. (2) Soak test, 70-90s end-to-end latency measurement, and the "kill pm2 mid-meeting" scenario are only unit-tested (registry rebuild), not exercised against a live pm2/Hub. (3) `meeting_agent` UI-tool title/description parity and any downstream P6/P7 hooks were not touched — out of this phase's ownership.
