# Codebase Summary

```
meeting-agent/
  privos-app.json          # reviewed manifest (18 tools, permissions, csp in _meta.ui, env)
  package.json tsconfig{,.server}.json vite.config.ts vitest.config.ts
  scripts/                 # pair, generate-manifest, lint-manifest, preflight, package-source, deploy-hodao, calibrate-speaker-threshold
    spikes/                # 11 foundational spikes + ab-vietnamese-quality (gated on live creds)
  src/shared/               # cross-boundary pure code
    app-error.ts            # AppError (user-facing)
    app-db-schema.ts         # SCHEMAS: 7 collections — single source of truth
    app-settings.ts           # P8: WorkspaceAppSettings shape/defaults/validators — shared by settings-set-tool.ts + ui/data/settings-store.ts
    cosine.ts                # cosineSimilarity + encode/decodeEmbedding
    meeting-slug.ts            # slugify, folderName, partFileName (meetingId8 collision guard)
    sanitize-display-name.ts
  src/server/
    index.ts                 # entry: serveApp + boot checks + retention job start/stop + SIGTERM drain + dev relay loop
    manifest.ts app-icon.ts mcp-handler.ts ui-resource.ts relay-transport.ts dev-server.ts paths.ts env.ts
    hub/                      # installation-bot Hub access
      resolve-hub-origin.ts resolve-own-mcp-app-id.ts bot-tool-call.ts
      agent-bot-credential-check.ts app-db-bot-client.ts app-settings.ts ensure-bot-in-room.ts
    stt/                      # provider abstraction (interface + registry + 4 real providers)
      stt-provider.ts stt-provider-registry.ts provider-health-probe.ts (P8: cheap real vendor probes)
      soniox-realtime-token.ts soniox-async-provider.ts
      elevenlabs-realtime-token.ts elevenlabs-batch-provider.ts
    media/                    # concat-parts, decode-audio, hub-file-download, live-turns-store
    speaker/                  # voiceprint-crypto, embedding-extractor, profile-store, speaker-matcher, session-speaker-registry, resolve-speakers, segment-picker
    live-speakers/            # chunk-worker, live-speaker-repository, part-window
    transcript/                # segment-builder, caption-aligner, markdown/srt/json writers
    summary/                  # summarizer, translator, chunker, sanitize, prompts, summary-markdown
    jobs/                      # meeting-queue (draining flag), meeting-job, meeting-repository, job-repository,
                                # keyed-serial-queue, startup-sweep, audio-retention-job (P8: retention + pendingEmbedding TTL)
    tools/                     # 18 tools + registry/index + authz.ts + is-workspace-admin.ts (P8) + rate-limiter + test-support/fake-hub.ts
  src/ui/                      # React 18 + Vite shell (rail 64 / topbar 60 / body), i18n vi/en (274 keys, parity enforced), theme, 8 screens
    screens/settings/           # P8: 7 panels (language, speech-recognition, microphone, speaker-identification[P4], ai-summary, privacy, caption-display) + use-workspace-admin.ts
    data/settings-store.ts       # P8: workspace app_settings read + meeting_settings_set write
    data/local-preferences.ts     # P8: per-user local prefs (localStorage) — never app_settings
    components/mic-test-wave.tsx  # P8: 3s mic test wave (AnalyserNode)
```

## Tools (18, all in `privos-app.json` + registered in `tools/index.ts`)

| Tool | Auth | Purpose |
|---|---|---|
| `meeting_agent` | member | UI resource (`_meta.ui`: microphone + screen-wake-lock, csp) |
| `meeting_agent_bot_credential_check` | member | bot credential status (no secret) |
| `meeting_bootstrap {roomId}` | member | register schema, knownRooms, join bot to room, sweep jobs/retention |
| `meeting_stt_status` | member (detail: admin only) | status of both STT vendors — `{ok}` for non-admin, full detail + usage + liveConcurrency for admin |
| `meeting_realtime_token` | owner | mint realtime STT token for the active provider |
| `meeting_chunk_ready` | owner | ingest one part's turns for live speaker naming |
| `meeting_live_speakers` | room member | live speaker roster (no vector) |
| `meeting_translate` | room member | Hub-AI live translation fallback |
| `meeting_process` / `meeting_status` / `meeting_summarize` | owner / member / owner | run + poll + re-run the post-meeting job |
| `meeting_send_to_chat` | owner | post the saved summary to the room |
| `meeting_settings_set` | workspace admin | write one `app_settings` key (allowlist + validators in `src/shared/app-settings.ts`) |
| `speaker_resolve` | owner | confirm/name/merge a meeting's speakers |
| `speaker_profile_list` / `_update` / `_delete` | member / creator-or-admin / creator-or-admin | workspace speaker-identity registry |
| `meeting_relabel_speaker` | owner | fix a speaker label post-hoc, back-propagate voiceprint |

Every feature tool fails closed unless the caller is a verified actor (dev: `ALLOW_UNVERIFIED_ACTOR=1`), and every meeting-scoped tool asserts `actor.roomId === args.roomId === meeting.roomId` (`tools/authz.ts`) — a bot credential has no per-user room boundary of its own, this app's own checks are the only thing enforcing it (`jobs/cross-room-authz.test.ts`).

## Verification (offline gates, all green)

`npm run typecheck` (ui + server), `npm run test` (**325 tests / 62 files**),
`npm run manifest:lint`, `npm run preflight`, `npm run build`, and
`npm run verify:fast-pr` end to end. Live spikes + `npm run pair` + hodao
deploy + the manual e2e checklist (`docs/manual-e2e-checklist.md`) require real
Hub/credentials/node access and are **not** run in this environment — see
`docs/deployment-guide.md` for the runbook.
