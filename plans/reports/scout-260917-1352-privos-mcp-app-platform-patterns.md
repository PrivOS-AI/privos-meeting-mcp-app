# Scout report: PrivOS MCP app platform patterns (from privos-mcp-app-demo + privos-dev-docs)

## Source files
- `~/projects/privos-mcp-app-demo/privos-app.json` — schemaVersion 3 manifest: permissions[], tools[], license.tiers, env[]
- `~/projects/privos-mcp-app-demo/SCOPES.md` — scope justification + degradedBehavior table
- `~/projects/privos-mcp-app-demo/src/server.ts` — `serveApp()` from `@privos_ai/app-server`
- `~/projects/privos-mcp-app-demo/src/mcp-message-handlers.ts` — `tools/list` (L112-161), `tools/call` (L163-213), `handleWhoami(actor)` (L226-244)
- `~/projects/privos-mcp-app-demo/src/ui/file-upload-panel.tsx` — `app.uploadFile()` (L118), REST list files (L81)
- `~/projects/privos-mcp-app-demo/src/ui/privos-rest.ts` — `app.rest()` wrapper
- `~/projects/privos-mcp-app-demo/scripts/` — generate-manifest.ts, preflight.ts, pair.ts, package-source.sh; `PUBLISHING.md`
- `~/projects/privos-dev-docs/file-management/file-management-api.md` — upload (direct ≤100MB default `FileUpload_MaxDirectFileSize`, chunked init/upload/complete), folders, list by channel, presigned download, duplicateAction
- `~/projects/privos-dev-docs/mcp-app-platform/security-and-data-model.md` — App Database (`db:read/write/schema:*`, workspace or room scoped), scope enforcement
- `~/projects/privos-dev-docs/mcp-app-platform/react-sdk-reference.md` — `usePrivosContext()` (userId, username, roomId, theme, effectiveScopes, userToken), `usePrivosApp()` (rest, uploadFile, callTool, storage)
- `~/projects/privos-dev-docs/mcp-app-platform/developer-guide.md` — scaffold + tool definition
- `~/projects/mcp-app-clan-business-hub/privos-app.json` — real app using `db:*` (L50-80) for app-owned records + `files:*`
- `~/projects/privos-hub-voice-smooth/plans/260713-1453-speech-conversation-ai-agent-thread/` — Hub STT (Groq/OpenAI) + TTS (ElevenLabs) services; endpoint `POST /v1/voice.transcribe` validates room access before transcribing. No diarization anywhere in PrivOS repos.

## Manifest shape (schema v3)
```json
{ "schemaVersion": 3, "kind": "mcp-app", "name": "ai.privos.example", "version": "1.0.0",
  "permissions": [{ "scope": "files:write", "requirement": "optional|required", "context": "room|workspace",
    "executionContext": "user|app", "feature": "core.files", "reason": "...", "degradedBehavior": "..." }],
  "tools": [{ "name": "tool_name", "title": "...", "inputSchema": {...},
    "ui": { "resourceUri": "ui://app-id/form.html", "csp": { "frame-src": [...] } } }],
  "license": { "tiers": [{ "id": "free", "features": [], "limits": {} }] },
  "env": [{ "key": "VAR", "required": true, "secret": true, "example": "..." }] }
```

## Tool registration
```ts
case 'tools/list': return { tools: [
  { name: 'hr_management_dashboard', title: '...', inputSchema: { type:'object', properties:{ roomId:{type:'string'} } },
    _meta: { ui: { resourceUri: 'ui://privos-mcp-app-demo/form.html', csp: {...} } } },
  { name: 'hr_whoami', title: 'Who am I (verified)', inputSchema: { type:'object', properties:{} } } ] };
case 'tools/call':
  if (params?.name === 'hr_management_dashboard') return { content: [{ type:'resource', resource: { uri: UI_RESOURCE_URI, mimeType: 'text/html;profile=mcp-app', text: getInlineUiHtml() } }] };
  if (params?.name === 'hr_whoami') return handleWhoami(actor); // actor: VerifiedActor { userId, username, roomId, provenance }
```

## File upload (iframe, runs as current user, needs files:write)
```ts
const app = usePrivosApp();
await app.uploadFile({ channelId: roomId, fileName, base64Data: dataUri, mimeType });
// Hub: POST /file-management.files.upload (multipart)
await app.rest({ method:'GET', path:'file-management.files.channel/'+roomId, query:{ count:50 } });
await app.rest({ method:'POST', path:'file-management.folders.create', body:{ channelId: roomId, name:'Meetings' } });
```

## Identity
- Backend: `VerifiedActor` from dispatch assertion (managed/standalone) — trustworthy userId/username/roomId.
- Frontend: `usePrivosContext()` → userId, username, roomId, theme, effectiveScopes; `userToken` (verify vs Hub JWKS if backend must authenticate iframe→backend calls).

## Storage options for app data
| Option | Scope | Use for |
|---|---|---|
| Hub App Database (`db:*`, tool calls `mcpapp.db.create/query/...`) | workspace or room | meetings metadata, speakers, voiceprints (embeddings as arrays), action items |
| File Management (`files:*`) | room channel | transcript .md/.json/.srt, summary .md, optional original audio |
| `app.storage` | per-app per-browser | UI prefs only (not synced) |
| Own DB (Postgres/SQLite) | app container | allowed, app manages lifecycle/backups; needed if vector search or large blobs |

## Runtime modes (from README)
managed (workload socket) / standalone-production (paired identity file) / development (relay WS, `npm run dev`, Vite UI :5179). Prod `/ready` requires manifest digest match; Docker label `io.privos.manifestDigest`.

## Risks
1. Unknown scope in Portal catalog → publish fails (`PROPOSAL_PERMISSION_UNKNOWN`).
2. Manifest digest pinned to image; rerun `manifest:lint` after any manifest change.
3. Direct upload ≤100MB default; hour-long audio (wav) exceeds → chunked upload or compress (opus/m4a) first.
4. `app.rest`/`uploadFile` run as user → app cannot exceed user's room membership.
5. `app.storage` is device-local; never store voiceprints there.
6. App Database quota per workspace unknown — verify before storing many embeddings (192-256 floats × N per person is small).

## Unresolved
- App Database quota + query capabilities (filter by field? vector? probably not → cosine matching done in app process after loading person embeddings).
- Whether App Database supports app-execution-context (`executionContext: app`) writes from a background job without a user session.

Status: DONE
