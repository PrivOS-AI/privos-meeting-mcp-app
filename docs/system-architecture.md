# System Architecture

Nguồn sự thật chi tiết: `plans/260917-1358-…/plan.md`. Tài liệu này tóm tắt kiến trúc
đã hiện thực ở Phase 1 và giữ chỗ cho **kết quả spike** phải điền khi chạy với Hub thật.

## Boot & runtime mode

App boot qua `serveApp` (`@privos_ai/app-server`) trong `src/server/index.ts`. Mode tự
phát hiện, không đặt bằng env:

| Mode | Resolved khi | Transport/trust |
|---|---|---|
| `managed` | có workload socket (`PRIVOS_WORKLOAD_SOCKET`) | serveApp, Hub-signed |
| `standalone-production` | có identity file (`npm run pair`) | serveApp, dispatch trust |
| `development` | không có cả hai và `NODE_ENV`≠production | dev Relay loop, unverified actor |

Boot chạy `assertProviderKeysAtBoot()` (fatal ở production nếu provider đang chọn thiếu
khoá hoặc thiếu `VOICEPRINT_ENC_KEY`) và self-check credential bot.

## Backend Hub access (installation bot)

Mọi ghi App DB/job/settings đi qua `POST /api/v1/mcp-apps.tool-call` với credential bot
(`src/server/hub/bot-tool-call.ts` → `callAppPlatformTool`). `roomId` **tuỳ chọn** —
collection `scope:'global'` (speaker_profiles, app_settings) gọi room-lessly (QĐ-05).
`resolveOwnMcpAppId()` cấp `mcpAppId` cho body. Iframe chỉ **đọc** App DB để hiển thị.

## Data flow (record → live naming → process → review)

```mermaid
flowchart LR
  subgraph B["Iframe UI (React 18 + Vite)"]
    GUM["getUserMedia: MỘT MediaStream"] --> MR["MediaRecorder ~60s"] --> UP["uploadFile part"]
    GUM --> WSC["SDK realtime (Soniox/ElevenLabs)"]
    POLL["poll meeting_live_speakers"] --> SCR["Screens"]
  end
  subgraph A["meeting-agent (pm2 :3012)"]
    MCPH["mcp-handler + tools (authz)"] --> CHW["chunk worker"] --> EMB["sherpa-onnx + voiceprint-crypto"]
    MCPH --> CAT["ghép parts -> audio.webm"] --> STT["stt-provider: async"] --> SUM["summarizer (Hub AI)"]
  end
  WSC <--> V["wss Soniox | wss ElevenLabs"]
  SCR -->|callServerTool| MCPH
  UP --> FM[("Files")]
```

## App DB collections

Nguồn sự thật: `src/shared/app-db-schema.ts` (7 collection). Global: `speaker_profiles`,
`app_settings`. Room: `meetings`, `meeting_speakers`, `action_items`, `bookmarks`,
`processing_jobs`. Field chỉ có `string|number|boolean|date|array|reference`.

## STT provider layer

`src/server/stt/stt-provider.ts` (interface) + `stt-provider-registry.ts` (chọn theo
`app_settings` → env) + bốn vỏ (soniox/elevenlabs × realtime/async). Phase 1 là vỏ; logic
thật ở P2 (realtime token mint) / P3 (async transcribe).

## Spike results — CHƯA CHẠY (cần Hub + credential + khoá vendor thật)

Điền quan sát thực tế vào các mục dưới khi chạy `scripts/spikes/*` với môi trường thật.

1. **Mic** (spike-01): getUserMedia trong tab phòng dưới `_meta.ui.permissions`. → _TBD_
2. **uploadFile ceiling** (spike-02): base64 tối đa → độ dài timeslice. → _TBD_
3. **CSP/presign** (spike-03): `PRIVOS_FILES_ORIGIN`, fetch transcript.json + audio. → _TBD_
4. **Global collection room-less** (spike-04): getSchema trả scope:'global' không roomId. → _TBD_
5. **Hub AI** (spike-05): generate-async + attempt-status bằng bot credential. → _TBD_
6. **Bot getMe** (spike-06): nguồn botToken cho Send to Chat. → _TBD_
7. **IndexedDB** (spike-07): có dùng làm buffer best-effort không. → _TBD_
8. **Soniox realtime SDK** (spike-08): JSON token thô; `translation:two_way` có sống chung
   `enable_speaker_diarization` không; `speaker` trên token `is_final`; mã đóng thật; độ trễ;
   origin SDK chạm. → _TBD_
9. **Soniox async** (spike-09): JSON output thô + tên trường thật + thời gian quay vòng; giới
   hạn kích thước/thời lượng file. → _TBD_
10. **SDK wrapper + ghim version** (spike-10): gói nào (`@soniox/speech-to-text-web@1.4.0` vs
    `@soniox/client@2.3.0`) nhận custom stream + diarization. **Chốt trước khi viết P2.** → _TBD_
11. **Cả hai SDK boot dưới CSP** (spike-11): directive CSP thật, origin hai SDK, giới hạn đồng
    thời ElevenLabs realtime. → _TBD_

**A/B tiếng Việt** (`ab-vietnamese-quality.ts`): WER (vi+en) + gán người nói (50 lượt) + độ trễ
nhãn của `soniox-async` vs `elevenlabs-batch` trên ≥30 phút audio thật. **KHÔNG chặn P2+**; chỉ
chọn mặc định `STT_*_PROVIDER`. Kết quả + giá trị mặc định đã chọn → điền tại đây. → _TBD_
