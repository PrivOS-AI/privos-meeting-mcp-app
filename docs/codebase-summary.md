# Codebase Summary

```
meeting-agent/
  privos-app.json          # reviewed manifest (4 tools, permissions, csp in _meta.ui, env)
  package.json tsconfig{,.server}.json vite.config.ts vitest.config.ts
  scripts/                 # pair, generate-manifest, lint-manifest, preflight, package-source, deploy-hodao
    spikes/                # 11 foundational spikes + ab-vietnamese-quality (gated on live creds)
  src/shared/              # cross-boundary pure code
    app-error.ts           # AppError (user-facing)
    app-db-schema.ts       # SCHEMAS: 7 collections — single source of truth
    cosine.ts              # cosineSimilarity + encode/decodeEmbedding
    meeting-slug.ts        # slugify, folderName, partFileName (meetingId8 collision guard)
  src/server/
    index.ts               # entry: serveApp + boot checks + dev relay loop
    manifest.ts app-icon.ts mcp-handler.ts ui-resource.ts relay-transport.ts dev-server.ts paths.ts env.ts
    hub/                   # installation-bot Hub access
      resolve-hub-origin.ts resolve-own-mcp-app-id.ts bot-tool-call.ts
      agent-bot-credential-check.ts app-db-bot-client.ts app-settings.ts ensure-bot-in-room.ts
    stt/                   # provider abstraction (interface + registry + 4 shells)
      stt-provider.ts stt-provider-registry.ts
      soniox-realtime-token.ts soniox-async-provider.ts
      elevenlabs-realtime-token.ts elevenlabs-batch-provider.ts
    tools/                 # registry + index + bot-credential-check, bootstrap, stt-status
  src/ui/                  # React 18 + Vite shell (rail 64 / topbar 60 / body), i18n vi/en, theme, 5 screens
```

## Tools (Phase 1)

| Tool | Auth | Purpose |
|---|---|---|
| `meeting_agent` | member | UI resource (`_meta.ui`: microphone + screen-wake-lock, csp) |
| `meeting_agent_bot_credential_check` | member | bot credential status (no secret) |
| `meeting_bootstrap {roomId}` | member | register schema, knownRooms, join bot to room |
| `meeting_stt_status` | member | status of both STT vendors (no key input) |

Feature tools fail closed unless caller is a verified actor (dev: `ALLOW_UNVERIFIED_ACTOR=1`).

## Verification (offline gates, all green)

`npm run typecheck` (ui + server), `npm run test` (19 tests), `npm run manifest:lint`,
`npm run preflight`, `npm run build`. Live spikes + pair + hodao deploy require real
credentials and are not run in this environment.
