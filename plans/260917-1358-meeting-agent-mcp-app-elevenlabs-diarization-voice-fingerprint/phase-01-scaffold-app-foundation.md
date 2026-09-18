---
phase: 1
title: "Phase 1: Scaffold app foundation"
status: code-complete-deterministic
priority: P1
effort: "3d"
dependencies: []
---

# Phase 1: Scaffold app foundation

## Overview

Dựng bộ khung app `ai.privos.meeting-agent` copy cấu trúc từ `~/projects/genealogy-privos-mcp-app` **và chạy 11 spike nền tảng** — mọi giả định mà red team bác bỏ đều phải được quan sát trực tiếp ở phase này trước khi xây tiếp. Script A/B tiếng Việt cũng nằm ở đây nhưng **không chặn** phase sau (U1). Gồm: server `serveApp` + mcp-handler + tool registry + ui-resource, transport installation-bot credential (`hub/bot-tool-call.ts`), UI React/Vite với PrivOS DS tokens, app shell (rail 64px / topbar 60px / body), i18n vi-default, schema App DB một chỗ, interface `stt-provider.ts` + tool `meeting_stt_status`, git init, docs skeleton, script deploy hodao (stub). Cuối phase: iframe mở trong Hub, mic xin quyền được, WS Soniox nối được từ trong tab phòng, App DB đủ collection (global không dính roomId), credential check `valid`. Không có logic ghi âm/AI ở phase này.

## Requirements

**Functional**
- Tool `meeting_agent` trả UI resource; iframe render app shell với 5 route rỗng: `new`, `live`, `detail`, `history`, `settings`.
- Rail trái + topbar dựng đúng token design; icon inline từ `resources/Caption application design/assets/icons/*.svg`.
- i18n: `vi` mặc định, `en` fallback; toàn bộ chuỗi UI qua `t()`.
- Transport bot credential (`src/server/hub/bot-tool-call.ts`, tham số `roomId?` **tuỳ chọn**) + tool `meeting_agent_bot_credential_check` + `meeting_bootstrap {roomId}`: đăng ký idempotent 7 collection (global đăng ký **room-lessly**), cập nhật `app_settings.knownRooms`, đảm bảo bot là thành viên phòng (`bot:room:join`).
- Tool UI khai `_meta.ui.permissions: ["microphone"]` → `getUserMedia` hoạt động trong tab phòng thật.
- Interface `src/server/stt/stt-provider.ts` + **registry chọn provider** (`stt-provider-registry.ts`: đọc `app_settings.sttRealtimeProvider`/`sttAsyncProvider`, fallback env `STT_REALTIME_PROVIDER`/`STT_ASYNC_PROVIDER`) + **bốn vỏ cài đặt**: `soniox-realtime-token.ts`, `soniox-async-provider.ts`, `elevenlabs-realtime-token.ts`, `elevenlabs-batch-provider.ts` (logic thật ở P2/P3). Tool `meeting_stt_status` trả trạng thái **cả hai** nhà cung cấp (QĐ-15).
- `npm run build` sinh manifest, `manifest:lint` + `preflight` xanh; `dist/manifest.json` tools == registry.

**Spikes (cổng của cả kế hoạch — làm trước khi viết feature)**
1. Mic: `getUserMedia` trong tab phòng Hub thật với `_meta.ui.permissions`.
2. `app.uploadFile` ceiling: đo kích thước base64 lớn nhất qua bridge → chốt độ dài timeslice (~4-6 MB).
3. CSP/presign: đọc URL presigned của một file để lấy origin → `PRIVOS_FILES_ORIGIN`; fetch `transcript.json` + `<audio src=presigned>` chạy được trong tab.
4. Collection global room-less: `registerCollection(scope:'global')` **không** truyền `roomId` → `getSchema` phải trả `scope:'global'` và KHÔNG có `roomId`; nếu bị đóng dấu room → drop + re-register khi còn rỗng.
5. Hub AI: `POST /api/v1/agents.sandbox.generate-async` bằng bot credential từ backend → poll `agents.sandbox.attempt-status`.
6. `mcpapp.bot.getMe` với `PRIVOS_AGENT_BOT_CREDENTIAL` (quyết định nút "Send to Chat room" ở P6).
7. IndexedDB trong iframe: chạy được hay không → chỉ quyết định có dùng làm buffer best-effort, **không** load-bearing.
8. **Soniox realtime qua SDK, chạy ~5 phút thật**: backend mint `POST https://api.soniox.com/v1/auth/temporary-api-key` `{usage_type:'transcribe_websocket', expires_in_seconds ≤ 3600, single_use:true, max_session_duration_seconds, client_reference_id}` → iframe `new SonioxClient({apiKey})` → `.start({ model:'stt-rt-v5', languageHints:['vi','en'], enableSpeakerDiarization:true, enableLanguageIdentification:true, enableEndpointDetection:true, translation:{type:'two_way', language_a:'vi', language_b:'en'}, stream: <MediaStream của ta>, onPartialResult, onError })` → `.stop()`. Ghi lại: (a) JSON token thô (`text/start_ms/end_ms/is_final/speaker/language/confidence/translation_status`), (b) **`translation` có sống chung với diarization không** — `speaker` còn được điền không, token gốc còn timestamp không (token dịch **không** có timestamp), (c) **token đã `is_final` có bị đổi `speaker` không**, (d) **mã đóng + reason thật** khi chạm cap/huỷ (KHÔNG giả định 413), (e) độ trễ từ lúc nói tới token đầu tiên, (f) SDK có gọi origin nào ngoài `wss://stt-rt.soniox.com` không (quyết định CSP).
9. **Soniox async round-trip trên 1 file webm 60s**: `POST /v1/files` → `POST /v1/transcriptions {file_id, model:'stt-async-v5', language_hints, enable_speaker_diarization, enable_language_identification}` → poll tới `completed` → **lưu nguyên văn JSON output** vào `docs/system-architecture.md`: tên trường thật của token, thời gian quay vòng, và thử tiếp 1 file ~2h để đo giới hạn kích thước/thời lượng (câu hỏi mở #2).
10. **Chốt SDK Soniox bằng cách DỰNG HẲN WRAPPER** (không chỉ "connect thử"): `@soniox/speech-to-text-web@1.4.0` (`new SonioxClient({apiKey})` → `.start({…, stream})` → `.stop()`) và `@soniox/client@2.3.0` (`client.realtime.*`) là **hai thế hệ API khác nhau** — đổi gói là đổi mọi call site của P2. Spike phải chứng minh với gói được chọn: (a) nhận `MediaStream` do ta cấp, (b) trả token có `speaker`, (c) `stop()` đóng sạch và flush hết audio đệm, (d) reconnect được bằng key mới, (e) lộ lỗi/backpressure ra callback. Rồi **ghim version** trong `package.json`. Nếu **không** SDK nào nhận custom stream hoặc thiếu option diarization → dùng phương án dự phòng duy nhất đã ghi ở QĐ-01 (WebSocket thô ở main thread, nguồn audio `ScriptProcessorNode`, không worklet, không blob URL) và **báo lại người dùng trước khi viết P2**.
11. **Cả hai SDK boot được trong tab phòng thật dưới CSP đã khai**: mở tool trong phòng Hub, chạy wrapper Soniox (spike 10) **và** `@elevenlabs/client` `Scribe.connect({ microphone:false, token })` với single-use token từ `POST /v1/single-use-token/realtime_scribe`; xác nhận không `Refused to connect`/`Refused to load`, ghi lại mọi directive CSP Hub thực sự áp, mọi origin hai SDK chạm tới (quyết định có phải thêm origin HTTPS không), và **giới hạn đồng thời quan sát được của ElevenLabs realtime** (câu hỏi mở #8).

**Script A/B tiếng Việt (QĐ-15) — chọn mặc định, KHÔNG chặn P2+**
- **Chủ sở hữu: chủ dự án.** Cung cấp ≥30 phút audio họp nội bộ VN+EN code-switch, 3-6 người, có cả giọng Bắc và Nam, **đã xin phép người tham dự**; dự phòng: một bản ghi họp tiếng Việt công khai. Transcript tham chiếu = bản máy do **đội sửa lại** (không chép tay từ đầu).
- `scripts/spikes/ab-vietnamese-quality.ts` chạy cùng audio qua `soniox-async` và `elevenlabs-batch` **bằng chính hai provider đã cài** (không phải code riêng của script) và dùng `ELEVENLABS_API_KEY` của app — không còn biến `AB_ELEVENLABS_API_KEY`.
- Đo: WER (vi+en); độ chính xác gán người nói trên 50 lượt lấy mẫu chấm tay; độ trễ tới nhãn đầu tiên; độ ổn định nhãn; dấu thanh/số/danh từ riêng (định tính).
- Kết quả **chỉ** quyết định giá trị mặc định của `STT_REALTIME_PROVIDER`/`STT_ASYNC_PROVIDER` và được ghi vào `docs/system-architecture.md`. Chạy được lúc nào thì chạy — **P2 trở đi không chờ**. Đổi lựa chọn sau này = đổi một ô trong Settings.

**Non-functional**
- Không commit `.env`, `privos-standalone-identity.json`, `models/`, `data/`; file > 200 LOC phải tách module; docs mỗi file ≤ 800 LOC. Iframe opaque origin (`srcdoc`) → mọi asset (css/js/svg) inline/bundle, **không** fetch URL anh em: `import.meta.url` là `about:srcdoc` nên asset rời do Vite phát ra sẽ không tải được.

## Architecture

### Cây thư mục mục tiêu

```
meeting-agent/  privos-app.json (schemaVersion 3, port 3012) · package.json · tsconfig{,.server}.json · vite/vitest.config.ts
  PRIVOS.md .gitignore .env.example · docs/ (7 file skeleton) · models/ + data/ (gitignore) · public/icon.png
  scripts/{pair,generate-manifest,preflight}.ts lint-manifest.mjs package-source.sh deploy-hodao.sh spikes/*.ts
  src/shared/{app-error,cosine,meeting-slug,app-db-schema}.ts
  src/server/{index,manifest,mcp-handler,ui-resource,relay-transport,dev-server,paths,env}.ts
    hub/{resolve-hub-origin,resolve-own-mcp-app-id,bot-tool-call,app-db-bot-client,agent-bot-credential-check}.ts
    stt/{stt-provider,soniox-realtime-token,soniox-async-provider}.ts
    tools/{index,registry,bot-credential-check-tool,bootstrap-tool,stt-status-tool}.ts
  src/ui/{index.html,main.tsx,app.tsx} theme/{tokens.css,app-shell.css,theme-provider.tsx}
    i18n/{vi,en}.json {i18n-provider,resolve-language}.{tsx,ts} · assets/icons/*.svg · data/{app-db-client,app-config}.ts
    components/{icon,app-rail,top-bar,empty-state,bot-credential-banner}.tsx
    screens/{new-meeting,live,meeting-detail,history,settings}-screen.tsx (placeholder)
```

`src/ui/data/app-db-client.ts` chỉ dùng cho **đọc để hiển thị** trong ngữ cảnh người dùng. Mọi ghi liên quan job/voiceprint đi qua tool backend (bot credential).

### Manifest (trích)

```json
{
  "schemaVersion": 3, "kind": "mcp-app", "name": "ai.privos.meeting-agent", "version": "0.1.0",
  "title": "Meeting Agent", "port": 3012,
  "agentBot": { "name": "Trợ lý Cuộc họp", "slug": "tro-ly-cuoc-hop" },
  "permissions": [ /* bảng § Manifest permissions của plan.md */ ],
  "tools": [{ "name": "meeting_agent", "title": "Meeting Agent",
    "inputSchema": { "type": "object", "properties": { "roomId": { "type": "string" } } },
    "_meta": { "ui": { "resourceUri": "ui://meeting-agent/app.html", "hideAiChat": true,
                       "permissions": ["microphone", "screen-wake-lock"],   // screen-wake-lock: Hub chưa map (use-mcp-bridge-host.ts:193-198) — khai trước, chờ Hub hỗ trợ
                       "csp": { "connect-src": ["wss://stt-rt.soniox.com", "wss://api.elevenlabs.io", "<PRIVOS_FILES_ORIGIN>"],
                                "media-src":   ["<PRIVOS_FILES_ORIGIN>"] } } } },
    { "name": "meeting_agent_bot_credential_check", "title": "Kiểm tra credential bot",
      "inputSchema": { "type": "object", "properties": {} } },
    { "name": "meeting_bootstrap", "title": "Khởi tạo dữ liệu phòng",
      "inputSchema": { "type": "object", "required": ["roomId"], "properties": { "roomId": { "type": "string" } } } },
    { "name": "meeting_stt_status", "title": "Trạng thái nhận dạng giọng nói",
      "inputSchema": { "type": "object", "properties": {} } }],
  "resources": { "memoryMb": 2048, "cpus": 2, "tmpSizeMb": 2048 },
  "stateless": false,
  "dataPolicy": { "version": "2026-09-17", "externalProcessing": true,
    "retention": "Transcript và tóm tắt lưu trong Files của phòng; audio gốc xoá sau xử lý nếu không bật Keep original audio." },
  "capabilities": { "verifiedActor": true },
  "env": [ /* bảng § Env vars của plan.md */ ]
}
```

`externalProcessing: true` là bắt buộc và `dataPolicy` phải nói rõ: **audio của người tham dự được stream và upload sang nhà cung cấp STT đang chọn** — Soniox (realtime zero-retention, async tự xoá sau 30 ngày, app chủ động xoá sớm) hoặc ElevenLabs — và **tên nhà cung cấp hiện trong Settings**; transcript được xử lý bởi Hub AI trong workspace. `resourceUri`, `hideAiChat`, `permissions` và `csp` nằm **cùng trong một object `_meta.ui`** (`developer-guide.md:44-50`) — đặt `csp` ở key `ui` anh em thì Hub **bỏ qua im lặng**, `manifest:lint` vẫn xanh và lỗi chỉ lộ ra dưới dạng `Refused to connect` lúc chạy (spike P1-11 là chốt chặn cho đúng chuyện này). `_meta.ui.permissions` là cách duy nhất Hub cấp mic cho iframe (`use-mcp-bridge-host.ts:196`, `McpAppTab.tsx:303`, `security-and-data-model.md:18`). Origin HTTPS của cả hai nhà cung cấp **không** vào CSP (backend mint token, iframe chỉ mở WS) — trừ khi spike P1-10/P1-11 cho thấy SDK tự gọi; khai sẵn **cả hai** origin `wss://` để đổi provider bằng Settings không phải republish manifest. CSP là kiểm soát tải tài nguyên của iframe, **không** phải kiểm soát egress của backend.

### Icon inline (DRY, không fetch sibling asset)

`src/ui/components/icon.tsx`: `import.meta.glob('../assets/icons/*.svg', { query:'?raw', import:'default', eager:true })` → `<Icon name size>` render `dangerouslySetInnerHTML` từ chuỗi SVG đã bundle; `IconName` là union sinh từ danh sách file.

### Transport bot credential (nền tảng của mọi truy cập Hub từ job nền)

```ts
// src/server/hub/bot-tool-call.ts — copy pattern demo src/app-platform-tool-call.ts
import { createAgentBotHubClient } from '@privos_ai/app-server';
const TOOL_CALL_PATH = '/api/v1/mcp-apps.tool-call';

export async function callAppPlatformTool(
  toolName: string, args: Record<string, unknown>, requiredScope: string, roomId?: string,
): Promise<unknown> {   // roomId CHỈ bắt buộc cho collection scope:'room' (mcp-apps.ts:2495 `roomId?: string`)
  const mcpAppId = await resolveOwnMcpAppId();          // dev: MCP_APP_ID trong .env; prod: identity file / workload broker
  if (!mcpAppId) throw new AppError('Chưa phân giải được mcpAppId — chạy lại `npm run pair`.');
  const res = await createAgentBotHubClient({ resolveHubOrigin }).authorizedFetch(TOOL_CALL_PATH, {
    method: 'POST', requiredScope, retryMode: 'never', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mcpAppId, toolName, arguments: args, ...(roomId ? { roomId } : {}) }),
  });
  // { success, content:[{type:'text',text}] } → JSON.parse(text); !ok || success===false → ném lỗi kèm message của Hub
}
```

`src/server/hub/app-db-bot-client.ts`: class `AppDbBotClient(roomId?)` bọc `mcpapp.db.*` (bỏ `roomId` cho `speaker_profiles`/`app_settings`) — `registerCollection`/`updateSchema` (`db:schema:write`), `getSchema`/`listCollections` (`db:schema:read`), `create`/`update`/`delete` (`db:write`), `query`/`get`/`count` (`db:read`), mỗi hàm gọi `callAppPlatformTool` với đúng `requiredScope`.

`src/server/hub/agent-bot-credential-check.ts` copy demo `agent-bot-credential-check.ts`: gọi `GET /api/v1/me` với `x-user-id`/`x-auth-token`, trả `not-configured | hub-unreachable | invalid | valid{botId,username}`, **không bao giờ** trả/ghi log credential. Tool `meeting_agent_bot_credential_check` phơi kết quả này; `index.ts` gọi một lần lúc boot và log cảnh báo nếu chưa cấu hình.

### App DB schema module

```ts
// src/shared/app-db-schema.ts — nguồn sự thật duy nhất cho MỌI collection (mọi phase)
const SCHEMAS: readonly CollectionSchema[] = [
  { collection: 'speaker_profiles', scope: 'global', fields: [
      { name: 'displayName', type: 'string', required: true, maxLength: 200 },
      { name: 'displayNameNormalized', type: 'string', required: true, maxLength: 200 },
      { name: 'privosUserId', type: 'string' }, { name: 'privosUsername', type: 'string' },
      { name: 'colorKey', type: 'string' },
      { name: 'embeddings', type: 'array' },       // phần tử = JSON string {v,meetingId,durationSec,createdAt}
      { name: 'centroid', type: 'string' },        // base64 Float32
      { name: 'dim', type: 'number' }, { name: 'sampleCount', type: 'number' },
      { name: 'lastSeenAt', type: 'date' } ],
    indexes: [{ fields: { privosUserId: 1 } }, { fields: { displayNameNormalized: 1 } }] },
  // app_settings (global) + meetings, meeting_speakers, action_items, bookmarks, processing_jobs (room)
  // — khai đúng theo bảng § Data model của plan.md
];

// src/server/hub/app-db-bot-client.ts
export async function ensureAppDbSchema(db: AppDbBotClient): Promise<void> {
  for (const schema of SCHEMAS) {
    try { await db.registerCollection(schema); }
    catch (e) { if (!/already\s+(registered|exists)/i.test(String(e)) ) throw e;
                await db.updateSchema(schema.collection, schema.fields); }   // reconcile drift, validationLevel moderate
  }
}
```

`registerCollection` KHÔNG idempotent phía Hub (demo `app-db-demo-tool.ts`) → bắt lỗi "already registered" coi như thành công rồi `updateSchema`. `ensureAppDbSchema` chạy trong `meeting_bootstrap {roomId}`; collection `scope:'global'` đăng ký **không truyền `roomId`**, sau đó `getSchema` phải trả `scope:'global'` và không có `roomId` — nếu sai thì drop + re-register khi collection còn rỗng, và ghi lại quan sát.

### Theme tokens

Copy `resources/Caption application design/_ds/privos-design-system-*/colors_and_type.css` → `src/ui/theme/tokens.css` + bổ sung token scout liệt kê (`--ma-bg-canvas:#F4F6F8`, `--ma-surface:#fff`, `--ma-border-1:#ECEEF1`, `--ma-fg-1:#001930`, `--ma-fg-2:#38475B`, `--ma-fg-3:#6A7584`, dark `#06223A`/`#0C2A45`, status success/warning/danger/info, `--ma-shadow-lg:0 12px 28px rgba(0,25,48,.14)`, radii 6/10/16/999). Palette speaker: `#1F9E6F #E5A800 #38475B #3C82E6 #2563C9 #6A7584`.

## Related Code Files

**Create**
- `package.json`, `tsconfig{,.server}.json`, `vite.config.ts`, `vitest.config.ts`, `.gitignore`, `.env.example`, `PRIVOS.md`, `privos-app.json`
- `src/server/{index,manifest,mcp-handler,ui-resource,relay-transport,dev-server,paths,env}.ts`; `tools/{registry,index,bot-credential-check-tool,bootstrap-tool}.ts`; `hub/{resolve-hub-origin,resolve-own-mcp-app-id,bot-tool-call,app-db-bot-client,agent-bot-credential-check}.ts`
- `src/shared/{app-error,cosine,meeting-slug,app-db-schema}.ts`
- `src/ui/{index.html,main.tsx,app.tsx}`; `theme/*`; `i18n/*`; `components/{icon,app-rail,top-bar,empty-state,bot-credential-banner}.tsx`; `data/{app-db-client (chỉ đọc),app-config}.ts`; `screens/{new-meeting,live,meeting-detail,history,settings}-screen.tsx` (placeholder); `assets/icons/*.svg` (copy 45 file từ resources)
- `src/server/stt/{stt-provider,stt-provider-registry,soniox-realtime-token,soniox-async-provider,elevenlabs-realtime-token,elevenlabs-batch-provider}.ts` (bốn provider là vỏ, logic ở P2/P3), `src/server/tools/stt-status-tool.ts`
- `scripts/pair.ts`, `generate-manifest.ts`, `lint-manifest.mjs`, `preflight.ts`, `package-source.sh`, `deploy-hodao.sh`, `spikes/*.ts` (11 spike + `ab-vietnamese-quality.ts`, giữ lại làm bằng chứng)
- `docs/{project-overview-pdr,system-architecture,codebase-summary,code-standards,design-guidelines,deployment-guide,project-roadmap}.md`; tests `src/shared/{app-db-schema,cosine}.test.ts`, `src/server/hub/bot-tool-call.test.ts`

**Modify** — không có (repo mới).
**Delete** — không có.

## Implementation Steps

1. `git init` + `.gitignore` (`node_modules/`, `dist/`, `.env`, `.env.*` trừ `.env.example`, `privos-standalone-identity.json*`, `models/`, `data/`, `*.tsbuildinfo`, `.recyclebin/`); `npm init` + deps `@privos_ai/app-server`, `express`, `dotenv`, `tsx`, `ws`; dev `@privos_ai/app-react`, `react@18`, `react-dom@18`, `vite@6`, `@vitejs/plugin-react`, `typescript@5.7`, `vitest@2`, `@types/*`.
2. Copy nguyên xi từ gia-pha (đổi tên app/port/title): `src/server/{index,relay-transport,dev-server,paths,ui-resource}.ts`, `scripts/{pair,generate-manifest,preflight}.ts`, `lint-manifest.mjs`, `package-source.sh`.
3. Viết `src/server/manifest.ts` đọc `privos-app.json`, export `manifest`, `createManifest()`, `buildRelayAppDescriptor()`, `UI_RESOURCE_URI = 'ui://meeting-agent/app.html'`.
4. Viết `src/server/env.ts`: đọc + validate env theo bảng plan.md, export object typed (KHÔNG rải `process.env` khắp code). `SONIOX_API_KEY` và `ELEVENLABS_API_KEY` **đều optional**, nhưng **fail-fast ở production khi nhà cung cấp đang chọn thiếu khoá** — thông báo phải nói rõ setting nào đang trỏ tới provider nào.
5. Viết `src/server/tools/registry.ts` (copy pattern gia-pha: `AppTool`, `ToolRuntime { agentBotHub }`) + `tools/index.ts` rỗng (`registerAllTools()` no-op, các phase sau append import).
6. Viết `src/server/mcp-handler.ts`: `tools/list` = tool UI + `listToolDefinitions()`; `tools/call` trả UI resource cho `meeting_agent`, còn lại resolve từ registry.
7. Viết `privos-app.json` đầy đủ permissions/env + **4 tool**: `meeting_agent` (một object `_meta.ui` gồm `resourceUri`, `hideAiChat`, `permissions:["microphone"]`, `csp.connect-src` = `wss://stt-rt.soniox.com` + `wss://api.elevenlabs.io` + `PRIVOS_FILES_ORIGIN`, `csp.media-src` = `PRIVOS_FILES_ORIGIN`), `meeting_agent_bot_credential_check`, `meeting_bootstrap`, `meeting_stt_status`; `dataPolicy` nêu rõ audio stream sang **nhà cung cấp STT đang chọn (Soniox hoặc ElevenLabs)** và transcript xử lý bởi Hub AI; chạy `npm run manifest:lint`.
8. Viết `src/server/hub/`: `resolve-hub-origin.ts` + `resolve-own-mcp-app-id.ts` (copy demo, mode-aware managed/standalone/dev-`MCP_APP_ID`), `bot-tool-call.ts` (`callAppPlatformTool`), `agent-bot-credential-check.ts` (`GET /api/v1/me`), `app-db-bot-client.ts` (`AppDbBotClient` + `ensureAppDbSchema`). Test `bot-tool-call.test.ts` với `fetch` giả: kiểm body `{mcpAppId,toolName,arguments,roomId}`, unwrap `content[0].text`, và **không** log credential.
8b. Tool `meeting_agent_bot_credential_check` + `meeting_bootstrap {roomId}`: `ensureAppDbSchema` (global room-less) → thêm `roomId` vào `app_settings.knownRooms` → đảm bảo bot là thành viên phòng (`mcpapp.bot.*` / `bot:room:join`, idempotent) → chỗ dành sẵn cho sweep job treo (P3) + audio hết hạn (P8). `index.ts` chạy credential check một lần lúc boot, log cảnh báo khi `not-configured`.
8b2. Viết `src/server/stt/`: `stt-provider.ts` (interface `SttProvider { transcribeFile(input): Promise<SttResult> }`, `RealtimeTokenProvider { mint(meetingId): Promise<RealtimeToken> }` với `capabilities:{speakerLabels, translation}`, `SttToken {text, startMs, endMs, speaker?, language?, confidence?, isFinal?}`), `stt-provider-registry.ts` (chọn theo `app_settings` → env), và **bốn vỏ**: `soniox-realtime-token.ts`, `soniox-async-provider.ts`, `elevenlabs-realtime-token.ts`, `elevenlabs-batch-provider.ts`. Tool `meeting_stt_status` trả trạng thái cả hai provider (admin thấy model + usage + số phiên đang chạy, người khác chỉ `{ok}` — **không** có ô nhập API key, QĐ-08).
8c. **Chạy 11 spike** (`scripts/spikes/`), ghi kết quả quan sát được (kèm JSON thô của cả hai nhà cung cấp) vào `docs/system-architecture.md`; spike nền tảng nào fail thì dừng và đưa lỗi nguyên văn vào § Câu hỏi chưa giải quyết của plan.md. Script A/B chạy khi có audio, kết quả chỉ chỉnh giá trị mặc định của `STT_*_PROVIDER`.
9. Copy 45 icon SVG `resources/Caption application design/assets/icons/*.svg` → `src/ui/assets/icons/`; viết `icon.tsx` (glob `?raw`) + type `IconName` sinh từ danh sách file.
10. Copy `colors_and_type.css` → `tokens.css` + token thiếu; `app-shell.css` (grid `64px / 60px / 1fr / auto`, font nạp bằng `@font-face` base64 hoặc fallback stack — KHÔNG link Google Fonts vì opaque origin); `theme-provider.tsx` (light/dark từ `usePrivosContext().theme`).
11. Viết i18n: `i18n-provider.tsx` (context + `t(key, vars)`), `resolve-language.ts` (ưu tiên `app_settings.language`, rồi `navigator.language`, mặc định `vi`), `vi.json`/`en.json` với key cho rail/topbar/5 screen.
12. Viết `app.tsx`: state route đơn giản (`useState<Route>`), render rail + topbar + screen placeholder; `app-rail.tsx` dùng icon `record/history/bookmark/search/settings` + avatar từ `usePrivosContext().username`.
13. Viết `src/ui/data/app-db-client.ts` (copy `AppDbClient` của gia-pha, chỉ giữ `query/get/count` cho hiển thị; qua `app.callServerTool` + `parseToolResult`) + `bot-credential-banner.tsx` hiện cảnh báo khi `meeting_agent_bot_credential_check` ≠ `valid`.
14. Viết `src/shared/app-db-schema.ts` với đủ 7 collection; iframe gọi `meeting_bootstrap {roomId}` một lần lúc mount (guard bằng ref) — iframe KHÔNG tự đăng ký schema. 15. Viết `src/shared/cosine.ts` (`cosineSimilarity(a: Float32Array, b: Float32Array)`, `encodeEmbedding/decodeEmbedding` base64↔Float32Array) + `meeting-slug.ts` (`slugify(title)`, bỏ dấu tiếng Việt, `<yyyy-mm-dd>-<slug>`); unit test cả hai.
16. Viết `scripts/deploy-hodao.sh` stub: rsync + chown/chmod 600 + `npm install` + `pm2 restart meeting-agent`, có `set -euo pipefail` và biến `REMOTE=/opt/privos/apps/meeting-agent`.
17. Viết `PRIVOS.md` mirror gia-pha (node ssh, remote path, pm2 name, cảnh báo không chạy local + node cùng lúc); symlink `CLAUDE.md`/`AGENTS.md` đã có sẵn trỏ về nó.
18. Viết 7 file docs skeleton: overview/PDR, system-architecture (mermaid + data flow + đường bot credential), codebase-summary, code-standards, design-guidelines (token + icon + không emoji), deployment-guide (điền ở P8), project-roadmap.
19. Chạy `npm run typecheck && npm test && npm run build && npm run manifest:lint && npm run preflight`; `npm run dev` → pair → mở tool trong phòng.
20. Commit đầu tiên: `chore: scaffold meeting agent mcp app`.

## Todo

> **Execution status (2026-09-17).** Phần deterministic đã dựng + xanh offline
> (typecheck ui+server, 19 test, build inline bundle, manifest:lint, preflight).
> Các mục cần **Hub thật + credential bot + khoá vendor + audio** vẫn để trống —
> không chạy được trong môi trường session này (đã báo và được người dùng chấp thuận
> làm "full scaffold P1"). **Không viết P2 tới khi spike-10 chốt.**

- [x] git init + `.gitignore` + `.env.example` + `package.json` + deps/scripts
- [x] Copy server skeleton từ gia-pha (index/relay/dev-server/paths/ui-resource)
- [x] `src/server/manifest.ts` + `privos-app.json` (port 3012, **một** object `_meta.ui`: resourceUri + permissions + csp + hideAiChat, dataPolicy, **4 tool**) — csp còn placeholder `<PRIVOS_FILES_ORIGIN>` chờ spike-03
- [ ] 11 spike (script đã tạo ở `scripts/spikes/`, **chưa chạy** — cần Hub/khoá thật): mic · uploadFile ceiling · CSP/presign origin · global collection room-less · Hub AI generate-async · `mcpapp.bot.getMe` · IndexedDB · **Soniox realtime SDK** · **Soniox async round-trip** · **wrapper + ghim SDK Soniox** · **cả hai SDK boot dưới CSP + giới hạn ElevenLabs**
- [ ] Script A/B tiếng Việt (stub tạo, **chưa chạy** — cần audio): WER + gán người nói + độ trễ → chốt mặc định `STT_*_PROVIDER`
- [x] `stt-provider.ts` + `stt-provider-registry.ts` + 4 vỏ provider + tool `meeting_stt_status` (cả hai provider)
- [x] `src/server/env.ts` typed config, fail-fast (production)
- [x] `tools/registry.ts` + `tools/index.ts`
- [x] `src/server/hub/` (resolve-hub-origin, resolve-own-mcp-app-id, bot-tool-call + test, app-db-bot-client, agent-bot-credential-check, app-settings, ensure-bot-in-room)
- [x] Tool `meeting_agent_bot_credential_check` + `meeting_bootstrap` (schema + knownRooms + bot vào phòng) + self-check lúc boot
- [x] `mcp-handler.ts` trả UI resource + fail-closed actor
- [x] Copy 45 icon SVG + `icon.tsx` inline glob
- [x] `theme/` (tokens, app-shell, theme-provider) + i18n vi/en + `resolve-language.ts`
- [x] `app.tsx` router + rail + topbar + 5 screen placeholder
- [x] `src/shared/app-db-schema.ts` (7 collection) + `app-db-client.ts` (chỉ đọc) + `bot-credential-banner.tsx`
- [x] `src/shared/cosine.ts` + `meeting-slug.ts` + test
- [x] `scripts/deploy-hodao.sh` stub + `PRIVOS.md` + 7 file `docs/`
- [x] typecheck/test/build/manifest:lint/preflight xanh — [ ] `npm run dev` mở trong Hub (cần pairing thật)
- [ ] Commit `chore: scaffold meeting agent mcp app` (chờ người dùng đồng ý)

## Success Criteria

- [ ] `npm run typecheck` xanh
- [ ] `npm test` xanh (≥4 test: cosine, slugify, app-db-schema, bot-tool-call body/unwrap)
- [ ] `npm run build && npm run manifest:lint && npm run preflight` xanh; `dist/manifest.json` tools == tool registry (**4 tool**), và `resourceUri`/`permissions`/`csp`/`hideAiChat` đều nằm trong **một** object `_meta.ui`
- [ ] `npm run dev` → mở tool `meeting_agent` trong phòng Hub thật → thấy rail + topbar, **hộp thoại xin quyền microphone hiện ra** khi bấm thử, không lỗi console
- [ ] Spike CSP: fetch `transcript.json` qua presigned URL và `<audio src=presigned>` phát được trong tab phòng; `PRIVOS_FILES_ORIGIN` được ghi vào `.env.example` + manifest
- [ ] Spike global: `getSchema('speaker_profiles')` trả `scope:'global'` **không** kèm `roomId`
- [ ] Spike Hub AI: `agents.sandbox.generate-async` + `attempt-status` trả kết quả bằng bot credential (hoặc lỗi được ghi thành câu hỏi mở)
- [ ] Spike Soniox realtime: wrapper SDK (đã ghim version) nhận `MediaStream` của ta, chạy **trong tab phòng Hub** không lỗi CSP, token có `speaker` + `language`; ghi lại bằng quan sát thực tế: `translation:two_way` có sống chung diarization không, hành vi `speaker` trên token `is_final`, và **mã đóng + reason** khi phiên kết thúc
- [ ] Spike SDK: `stop()` flush hết audio đệm; reconnect bằng key mới chạy được; lỗi/backpressure lộ ra callback (không cần ta tự quản `bufferedAmount`)
- [ ] Spike Soniox async: file webm 60s ra kết quả `completed`; **JSON output thô + tên trường thật + thời gian quay vòng** được chép vào `docs/system-architecture.md`; thử thêm file ~2h để biết giới hạn
- [ ] **A/B tiếng Việt**: bảng WER (vi+en) + gán người nói (50 lượt) + độ trễ nhãn của `soniox-async` vs `elevenlabs-batch` trên ≥30 phút audio thật, ghi vào docs kèm giá trị mặc định đã chọn; chạy bằng chính hai provider đã cài, không có biến env riêng cho script
- [ ] `app.uploadFile` đo được ngưỡng base64 → chốt độ dài timeslice cho P2
- [ ] `meeting_agent_bot_credential_check` trả `valid` với `botId`/`username` sau khi admin cấp credential; trả `not-configured` khi xoá env (banner hiện trong UI)
- [ ] Gọi `meeting_bootstrap {roomId}` 2 lần liên tiếp không sinh lỗi; `listCollections` (bot credential) trả đủ 7 collection đúng scope; `knownRooms` có roomId; bot là thành viên phòng
- [ ] `git status` sạch, không có `.env`, `models/`, `data/`, identity file trong index
- [ ] `docs/` có đủ 7 file, mỗi file ≤ 800 LOC

## Risk Assessment

| Risk | Signal | Response |
|---|---|---|
| Scope trong manifest không có trong catalog Hub | `manifest:lint` hoặc `pair` báo `PROPOSAL_PERMISSION_UNKNOWN` | Bỏ scope optional gây lỗi, ghi vào open questions, ship với degradedBehavior tương ứng |
| Font Montserrat/JetBrains Mono không tải được trong iframe opaque origin | Chữ render bằng font hệ thống | Nhúng woff2 base64 vào `tokens.css` hoặc chấp nhận fallback stack, ghi rõ trong design-guidelines |
| `registerCollection` gọi lần 2 ném lỗi (đã biết là KHÔNG idempotent) | Lỗi lúc bootstrap lần 2 | Bắt `/already (registered\|exists)/i` → coi là thành công rồi `updateSchema` |
| `resolveOwnMcpAppId()` trả `undefined` ở dev (`.env` cũ chưa có `MCP_APP_ID`) | `bot-tool-call` ném "chưa phân giải được mcpAppId" | Chạy lại `npm run pair`/`npm run dev` để pairing ghi `MCP_APP_ID`; thông báo lỗi nói thẳng cách khắc phục |
| `mcp-apps.tool-call` từ chối vì bot chưa là thành viên phòng | 403 khi có `roomId` | `meeting_bootstrap` tự thêm bot (`bot:room:join`) + banner khi credential check ≠ valid |
| Lời gọi bot **không kèm `roomId`** bị Hub từ chối vì không phân giải được grant | Spike 4 trả 403 thay vì schema | Ghi lỗi nguyên văn vào câu hỏi mở #4 của plan.md; cân nhắc room-scoped + phòng hồ sơ dùng chung — không tự ý đổi khi chưa hỏi |
| Mic bị chặn dù đã khai `_meta.ui.permissions` | Spike 1 không hiện prompt | Dừng kế hoạch, báo lại — không có đường vòng trong sandbox |
| CSP chặn `wss://stt-rt.soniox.com` (hoặc `csp` khai sai chỗ nên bị bỏ qua) | Spike 11 báo `Refused to connect` dù `manifest:lint` xanh | Kiểm `csp` nằm trong `_meta.ui` (không phải key `ui` anh em); vẫn chặn → ghi lỗi nguyên văn, dừng trước P2 |
| SDK không nhận `MediaStream` của ta hoặc thiếu option diarization | Spike 10 không dựng nổi wrapper | Dùng phương án dự phòng của QĐ-01 (WS thô + `ScriptProcessorNode`) và **báo người dùng trước khi viết P2** — không im lặng quay về tự chế wire protocol |
| A/B cho thấy provider mặc định kém hơn | WER VN lệch rõ giữa hai bên | Đổi `STT_*_PROVIDER` (env hoặc Settings) — không sửa code, không trễ phase |
| Chỉ có khoá của một nhà cung cấp lúc dev | Provider kia không test được | `meeting_stt_status` hiện `not-configured` cho bên thiếu khoá; test của provider đó chạy bằng `fetch` giả; ghi rõ trong docs cần khoá nào để e2e |
| Soniox async giới hạn file/thời lượng nhỏ hơn họp 3h | Spike 9 lỗi với file lớn | Ghi giới hạn thật vào docs; P3 chia audio theo giới hạn đó và ghép kết quả theo offset — quyết định sau khi có số đo |
| Copy code gia-pha kéo theo logic thừa | Build lỗi vì thiếu deps | Chỉ copy 5 file server skeleton đã liệt kê, không copy `src/ui/data/*` ngoài `app-db-client.ts` |
