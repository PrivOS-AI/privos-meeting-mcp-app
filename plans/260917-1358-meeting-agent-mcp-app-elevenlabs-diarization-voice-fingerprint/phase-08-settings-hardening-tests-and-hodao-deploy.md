---
phase: 8
title: "Phase 8: Settings, hardening, tests and hodao deploy"
status: pending
priority: P1
effort: "4.5d"
dependencies: [1, 2, 3, 4, 5, 6, 7]
---

# Phase 8: Settings, hardening, tests and hodao deploy

## Overview

Hoàn thiện màn Settings (1e, có điều chỉnh theo QĐ-08), rà soát bảo mật (secret, CSP, xác minh actor, quyền truy cập file), bổ sung test còn thiếu + checklist e2e thủ công, chốt tài liệu, và đưa app lên node **hodao** dưới pm2 với runbook + health check + kế hoạch rollback.

## Requirements

**Functional — Settings (7 mục theo nav 1e)**
1. **Language & translation**: ngôn ngữ giao diện (vi/en), ngôn ngữ chính của cuộc họp, **ngôn ngữ đích của bản dịch**, bật/tắt dịch — điều khiển `translation: two_way` của phiên realtime (live, QĐ-12) và bước dịch batch Hub AI (P6); `showTranslation` không còn là cờ chết. Segment đã ở ngôn ngữ đích (theo `language` của token) **không** bị dịch lại.
2. **Speech recognition (hai nhà cung cấp)**: **không có ô nhập API key** (QĐ-08). Hai select **chỉ admin** — *Realtime*: `soniox` (có nhãn người nói live) | `elevenlabs` (không nhãn, có cảnh báo "Nhãn người nói sẽ có sau khi xử lý"); *Hậu họp*: `soniox` | `elevenlabs`. Ghi qua `meeting_settings_set` vào `app_settings.sttRealtimeProvider`/`sttAsyncProvider`; đổi chỉ ảnh hưởng **cuộc họp bắt đầu sau đó**. Bảng trạng thái từ `meeting_stt_status` cho **cả hai** nhà cung cấp: khoá có/không, model, usage, số phiên realtime đang chạy / `LIVE_MAX_CONCURRENT_RECORDINGS`. Ghi chú "Khoá API do quản trị viên cấu hình trong env" + ước tính chi phí mỗi bên, và kết quả A/B tiếng Việt nếu đã chạy (P1).
3. **Microphone (browser)**: trạng thái quyền, chọn thiết bị (`enumerateDevices`), nút "Kiểm tra mic" + thanh sóng 3s.
4. **Speaker identification**: panel P4 (profile, threshold slider) + ngưỡng trong-phiên P5 (`speakerSessionMatchThreshold`, `speakerSessionMergeThreshold`), cảnh báo "chỉ ảnh hưởng cuộc họp bắt đầu sau khi đổi".
5. **AI summary**: nhà cung cấp = Hub AI (read-only), `SUMMARY_MODEL` (read-only), độ dài tóm tắt (ngắn/vừa/chi tiết → ảnh hưởng prompt), ngôn ngữ tóm tắt.
6. **Privacy & storage**: "Giữ audio gốc" (mặc định **off**), "Tự xoá audio sau N ngày" (`app_settings.autoDeleteAudioDays`, mặc định **90**, chỉ áp dụng cho audio được giữ), **"Dọn part của cuộc họp bị gián đoạn sau N ngày"** (`interruptedPartsRetentionDays`, mặc định 7), nút "Xoá toàn bộ voiceprint", hiển thị `dataPolicy` (nêu rõ audio stream sang **Soniox** realtime — zero-retention mặc định — và upload sang Soniox async, app **chủ động xoá** file + transcription sau mỗi job thay vì chờ auto-xoá 30 ngày; transcript xử lý bởi Hub AI).
7. **Caption display**: cỡ chữ Stage (small/medium/large), bật/tắt bản dịch, độ trễ hiển thị token chưa `is_final`, bật/tắt hiện nhãn người nói live.

Cài đặt lưu ở `app_settings` (global, `key`/`valueJson`). Iframe đọc qua `src/ui/data/settings-store.ts`; ghi qua tool `meeting_settings_set` — **chỉ workspace admin** (QĐ-14), vì các khoá này (`speakerMatchThreshold`, `autoDeleteAudioDays`, `summaryLength`) ảnh hưởng toàn workspace. Cài đặt riêng của người dùng (cỡ chữ Stage, mic ưu tiên) vẫn ở `app.storage` cục bộ.

**Functional — job dọn dẹp**
- Nguồn cấu hình **duy nhất**: `app_settings.autoDeleteAudioDays` (mặc định 90; `0` = tắt). Không còn env `MEETING_AUDIO_RETENTION_DAYS`.
- Chạy **lúc boot** và mỗi 6h, lặp qua `app_settings.knownRooms` (danh sách phòng do `meeting_bootstrap` duy trì) — không phụ thuộc việc có ai mở app hay không; `meeting_bootstrap {roomId}` quét thêm cho phòng đang mở.
- Điều kiện xoá: `meetings.status='summarized'` && `keepAudio === true` && `endedAt < now - autoDeleteAudioDays` && `audioDeletedAt` rỗng → `DELETE file-management.files/:fileId` (chỉ id trong `partFileIds`/`audioFileId`, **không** quét thư mục) → set `audioDeletedAt`. Thêm nhánh: `status='interrupted'` quá `interruptedPartsRetentionDays` → xoá part mồ côi. Audio của cuộc họp `keepAudio === false` đã bị xoá ngay sau khi summary thành công (P3/P6).
- `speaker_profile_delete` xoá cả `pendingEmbedding` và liên kết `meeting_speakers.profileId` trong mọi phòng của `knownRooms` — đúng như UI hứa "xoá hẳn".

**Non-functional / hardening**
- Không secret nào lọt sang iframe: rà `src/ui/**` không đọc `SONIOX_API_KEY`, `ELEVENLABS_API_KEY`, `VOICEPRINT_ENC_KEY`, bot credential (Anthropic đã gỡ hoàn toàn). Token ngắn hạn của **cả hai** nhà cung cấp chỉ tồn tại trong RAM của tab, **không** vào `localStorage`/`app.storage`.
- Mọi tool backend xác minh `context.actor` (userId/roomId) trước khi tác động dữ liệu phòng và fail-closed khi `actor.roomId !== args.roomId` — **bắt buộc** vì bot credential bỏ qua ranh giới thành viên của người dùng.
- `speaker_profiles` là dữ liệu sinh trắc: không tool nào được trả vector ra ngoài backend.
- CSP của tool UI mở đúng `wss://stt-rt.soniox.com` + `wss://api.elevenlabs.io` (`connect-src`) và `PRIVOS_FILES_ORIGIN` (`connect-src` + `media-src`) — **không hơn**; `permissions`/`csp` phải nằm **trong cùng object `_meta.ui`**. Khai sẵn cả hai origin WS là **có chủ đích**: đổi provider bằng Settings không được đòi republish manifest. CSP là kiểm soát tải tài nguyên của iframe, không phải kiểm soát egress của backend; ranh giới dữ liệu ra ngoài được mô tả trong `dataPolicy` của manifest.
- Log không chứa token, khoá, embedding plaintext, transcript.
- `npm run package` từ chối khi có file giống credential.

## Architecture

### Settings store

```ts
// src/ui/data/settings-store.ts
export interface AppSettings {
  uiLanguage: 'vi' | 'en'; meetingLanguage: 'vi' | 'en'; showTranslation: boolean;
  stageCaptionSize: 'small' | 'medium' | 'large';
  sttRealtimeProvider: 'soniox' | 'elevenlabs'; sttAsyncProvider: 'soniox' | 'elevenlabs';
  speakerMatchThreshold: number;                 // ghi đè env
  speakerSessionMatchThreshold: number; speakerSessionMergeThreshold: number;   // P5
  showLiveSpeakerLabels: boolean;
  summaryLength: 'short' | 'normal' | 'detailed'; summaryLanguage: 'vi' | 'en';
  keepOriginalAudio: boolean; autoDeleteAudioDays: number;
  preferredMicDeviceId?: string;
}
export const DEFAULTS: AppSettings = { /* … */ };      // src/shared/app-settings.ts — dùng chung server + ui
export async function loadSettings(db): Promise<AppSettings>;          // merge DEFAULTS + app_settings
export async function saveSetting<K extends keyof AppSettings>(app, key: K, value: AppSettings[K]): Promise<void>;  // → tool meeting_settings_set
```

### Tool trạng thái STT

```ts
// src/server/tools/stt-status-tool.ts  → meeting_stt_status   (P1 tạo vỏ → hoàn thiện ở đây)
// probe rẻ cho từng nhà cung cấp có khoá: Soniox = mint temp key TTL 10s rồi bỏ;
//   ElevenLabs = GET /v1/user/subscription (xi-api-key) → tier/characterCount/characterLimit
// → admin: { ok, active:{realtime, async},
//            providers:{ soniox:{configured, ok, models, activeSessions}, elevenlabs:{configured, ok, models, usage} },
//            checkedAt }
// → người khác: { ok }.  KHÔNG trả key; 401 → { ok:false, reason:'invalid_key' }
// Nhà cung cấp không có khoá → { configured:false } (không phải lỗi — chỉ là chưa cấu hình)
```

### Retention job

```ts
// src/server/jobs/audio-retention-job.ts
export async function purgeExpiredAudio(roomId: string): Promise<{ deleted: number }>;   // meeting_bootstrap gọi
export function startAudioRetention(): () => void;   // chạy ngay lúc boot + setInterval 6h, lặp app_settings.knownRooms
// days = app_settings.autoDeleteAudioDays (0 → no-op)
// query meetings where status=='summarized' && audioDeletedAt == null → lọc keepAudio && endedAt < now - days
// → DELETE file-management.files/:fileId → update meetings.audioDeletedAt
```

### pm2 entry (thêm vào `/opt/privos/apps/ecosystem.config.cjs`)

```js
{
  name: 'meeting-agent',
  cwd: '/opt/privos/apps/meeting-agent',
  script: 'npm', args: 'run start:standalone',
  env: { NODE_ENV: 'production', PORT: '3012' },
  max_memory_restart: '2G',
  autorestart: true, kill_timeout: 15000,
  out_file: '/var/log/privos/meeting-agent.out.log',
  error_file: '/var/log/privos/meeting-agent.err.log',
}
```

`kill_timeout: 15000` để job đang chạy kịp dừng (`serveApp` tự xử lý SIGTERM; `job-queue` thêm cờ `draining` từ chối job mới).

### Ma trận test

| Loại | Đối tượng | File |
|---|---|---|
| Unit | segment-builder (đổi speaker, pause, audio_event, rỗng) | `segment-builder.test.ts` |
| Unit | srt-writer (format timestamp, chẻ cue dài) | `srt-writer.test.ts` |
| Unit | markdown-writer + summary-markdown (snapshot vi/en); chunker (1 chunk / 15 chunk / segment vượt window) | `*.test.ts`, `chunker.test.ts` |
| Unit | speaker-matcher (khớp, dưới ngưỡng, rỗng, lệch dim); voiceprint-crypto (round-trip, HMAC sai → null + log) | `speaker-matcher`, `voiceprint-crypto` |
| Unit | sanitize + prompt injection (tiêu đề/tên chứa chỉ dẫn) | `sanitize.test.ts` |
| Unit | concat-parts (đủ/thiếu part, sai thứ tự, sai dấu `meetingId8`); authz (thiếu actor, chưa verified, khác phòng, khác owner) | `concat-parts`, `authz` |
| Contract | schema khai báo ↔ TS record types khớp nhau | `schema-contract.test.ts` |
| Unit | segment-picker (thiếu dữ liệu, nhiều segment ngắn); cosine + base64 round-trip; keyword-search (bỏ dấu tiếng Việt) | `segment-picker`, `cosine`, `keyword-search` |
| Unit | meeting-part-upload (đặt tên có `meetingId8`, thứ tự, `keep_both`); job-repository (claim idempotent, sweepStale) | `meeting-part-upload`, `job-repository` |
| Unit | bot-tool-call (body, unwrap `content[0].text`, không log credential); resolve-speakers (auto-label ≥ threshold, pendingEmbedding khi dưới ngưỡng) | `bot-tool-call`, `resolve-speakers` |
| Integration | meeting-queue + meeting-job với Soniox/Hub AI giả, ffmpeg thật trên wav mẫu 30s; timeout abort thật sự kill child; file+transcription trên Soniox được dọn kể cả khi lỗi | `meeting-job.integration.test.ts` |
| Unit | soniox-async-provider: `completed`/`error`/abort giữa poll/`mapToken` trên **JSON thật** của spike P1-9 | `soniox-async-provider.test.ts` |
| Unit | realtime client: draft bị thay bởi final; `speaker` namespace theo `sessionIndex`; roll session 280 phút; token `translation_status` không lọt vào `LiveTurn`; meeting-clock: hai phiên offset khác nhau, `clockSkewMs` resync mỗi part, skew > 1.5 s → `approxClock` | `soniox-realtime-client.test.ts`, `meeting-clock.test.ts` |
| Unit | part-upload-queue: mạng hỏng 10 phút → ghi âm tiếp, part lên đủ đúng thứ tự | `part-upload-queue.test.ts` |
| Unit | session registry: đổi nhãn → cùng người; **nhãn dùng lại cho giọng khác → `label@n`**; merge/không merge; `sticky`; dedupe; turn `[58s,63s]` hoãn rồi embed một lần | `session-speaker-registry.test.ts` |
| Unit | keyed-serial-queue: không chạy chồng cùng `meetingId`; song song khác `meetingId`; backlog > 3 bỏ chunk cũ; `abort()` đợi child thoát | `keyed-serial-queue.test.ts` |
| Security | span client gửi ngoài biên part / chồng lấn / trỏ vào khoảng lặng → bị loại + log; `speaker_resolve` với cụm lưỡng đỉnh → `enrolled:false`, `speaker_profiles` không đổi | `span-validation`, `speaker-resolve` |
| Integration | một chunk lỗi (ffmpeg fail) → các chunk sau vẫn gán đúng người (đồng hồ không lệch) | `chunk-worker.integration.test.ts` |
| Security (data loss) | hai cuộc họp **cùng phòng, cùng ngày, cùng tiêu đề**, ghi song song → hai thư mục riêng, không part nào bị ghi đè/xoá nhầm | `meeting-folder-collision.test.ts` |
| Unit | `meeting_realtime_token`: từ chối khi đủ `LIVE_MAX_CONCURRENT_RECORDINGS`; mint đúng loại token theo provider; trả `capabilities` đúng; provider thiếu khoá → lỗi nói rõ setting | `realtime-token-tool.test.ts` |
| Contract | **cùng** bộ test chạy cho hai realtime wrapper và hai async provider: cùng shape `CaptionEvent`/`SttToken`/`segments[]`, khác biệt duy nhất là `capabilities` | `stt-provider-contract.test.ts` |
| Unit | `stt-provider-registry`: `app_settings` ghi đè env; provider không có khoá → lỗi rõ; đổi setting → đổi cài đặt trả về | `stt-provider-registry.test.ts` |
| Unit | `elevenlabs-batch-provider.mapWordsToTokens` trên fixture `words[]` thật (đổi speaker, `spacing`, `audio_event`, thiếu `speaker_id`) | `elevenlabs-batch-provider.test.ts` |
| Unit | degraded mode: provider không nhãn → iframe không gọi `chunk_ready`/`live_speakers`; tool trả `labels_not_supported` khi bị gọi ép | `degraded-labels.test.ts` |
| Unit | caption-aligner `alignByMaxOverlap` (giao một phần, bao trọn, hoà, không giao) | `caption-aligner.test.ts` |
| Security | `meeting_live_speakers` không trả vector/`pendingEmbedding` | `live-speaker-repository.test.ts` |
| Security | phòng B gọi `meeting_process`/`meeting_status`/`speaker_profile_delete` trên dữ liệu phòng A → bị từ chối | `cross-room-authz.test.ts` |
| Integration | ensureAppDbSchema idempotent ("already registered" → updateSchema); smoke boot `serveApp` + manifest khớp `createManifest()` | `app-db-schema.test.ts`, `npm run preflight` |
| Manual e2e | checklist bên dưới | `docs/deployment-guide.md` |

**Checklist e2e thủ công**
1. Ghi 10 phút, 3 người nói, có bookmark → caption hiện **kèm badge `Người nói N`**; sau ~70-90s người đã có voiceprint đổi thành tên thật, dòng cũ cũng đổi (text không đổi).
2. Refresh tab giữa chừng → recovery banner → upload lại được.
3. End & summarize → processing 8 bước (download → transcribe → segment → decode → embed → summarize → write → cleanup) → Files có 5 file (hoặc 4 nếu không giữ audio).
4. Modal xác nhận người nói → `speaker_resolve`: gán 1 PrivOS user, 1 tên tự do, 1 "cùng người với"; thử thêm **quick-assign giữa họp** (P5) và kiểm tên giữ nguyên sau khi pass async chạy xong.
5. Họp thứ hai cùng người → auto-label đúng, confidence hiển thị.
6. Sửa 1 nhãn sai trong detail → voiceprint cập nhật.
7. Push to Smart List 2 lần → không trùng item.
8. Export SRT + DOCX mở được.
9. Bật "Giữ audio gốc" + retention 1 ngày → mở lại app hôm sau (`meeting_bootstrap`) → audio biến mất, `audioDeletedAt` được set; bỏ dở một cuộc họp → sau 10 phút thành `interrupted`, part được dọn sau `interruptedPartsRetentionDays`.
10. Xoá 1 voiceprint (`speaker_profile_delete`) → họp sau không auto-label người đó nữa.
11. Xoá `PRIVOS_AGENT_BOT_CREDENTIAL` → banner cảnh báo, `meeting_process` từ chối sớm (không treo).
12. Dịch song ngữ: bật toggle → caption có bản dịch **từ chính luồng token Soniox** khi ghi (không lời gọi Hub AI nào lúc live), transcript sau xử lý có `translation` cho mọi segment cần dịch.
13. Ghi 60 phút có bóp mạng 10 phút: bộ nhớ tab phẳng, part liên tục, xử lý xong bình thường; **soak chunk worker**: RSS backend phẳng, mỗi chunk < 3s CPU, không chunk nào bị bỏ.
14. Đổi `VOICEPRINT_ENC_KEY` sang khoá khác → auto-label ngừng hoạt động nhưng app không crash; khôi phục khoá cũ → hoạt động lại.
15. Kill pm2 giữa cuộc họp rồi start lại → chunk kế tiếp dựng lại registry, nhãn live không reset về `Người nói 1`.
16. Rút `SONIOX_API_KEY` sai → `meeting_stt_status` trả `{ok:false, reason:'invalid_key'}`, `meeting_realtime_token` từ chối kèm thông báo rõ, ghi âm **vẫn chạy** (chỉ mất caption).
17. Mở đồng thời quá `LIVE_MAX_CONCURRENT_RECORDINGS` cuộc họp → cuộc vượt trần nhận thông báo tiếng Việt, **vẫn ghi âm**, tên người nói có sau khi xử lý.
19. **Đổi nhà cung cấp trong Settings** (realtime và async, từng cái một) → cuộc họp mới dùng đúng provider, cuộc đang chạy **không** bị ảnh hưởng; với `elevenlabs-realtime` caption không nhãn + cảnh báo đúng, nhãn vẫn đầy đủ sau khi xử lý.
20. Rút khoá của nhà cung cấp **đang chọn** → `meeting_stt_status` chỉ rõ bên nào hỏng, `meeting_realtime_token`/`meeting_process` báo lỗi nói rõ setting nào cần đổi; nhà cung cấp còn lại vẫn dùng được ngay sau khi đổi Settings.
21. **Màn hình không tắt khi ghi**: trên laptop đặt sleep 1 phút, ghi 5 phút không chạm → màn hình vẫn sáng (nếu Hub đã cấp `screen-wake-lock`); nếu chưa, dải `keep-awake-notice` hiện và bản ghi vẫn đủ part.
18. Job bị kill giữa lúc poll Soniox → `GET` file/transcription phía Soniox trả 404 sau boot sweep; retry không upload lại (tra theo `client_reference_id`).

## Related Code Files

**Create**
- `src/shared/app-settings.ts`, `src/ui/data/settings-store.ts`, `src/server/tools/settings-tool.ts` (`meeting_settings_set`, admin-only)
- `src/server/tools/is-workspace-admin.ts` (đọc `userRoles` của actor; dùng chung cho settings/stt-status/profile tools)
- `src/server/jobs/cross-room-authz.test.ts`, `schema-contract.test.ts`
- `src/ui/screens/settings/{language-panel.tsx,speech-recognition-panel.tsx,microphone-panel.tsx,ai-summary-panel.tsx,privacy-panel.tsx,caption-display-panel.tsx}`
- `src/ui/components/mic-test-wave.tsx`
- `src/server/tools/stt-status-tool.ts` (P1 tạo vỏ → hoàn thiện)
- `src/server/jobs/audio-retention-job.ts`
- `src/server/jobs/meeting-job.integration.test.ts`
- `docs/manual-e2e-checklist.md` (hoặc mục trong `deployment-guide.md` — chọn 1, không trùng lặp)

**Modify**
- `src/ui/screens/settings-screen.tsx` (nav 240px + 7 panel)
- `src/server/index.ts` (khởi động + dừng `audio-retention-job`, cờ `draining` cho queue)
- `src/server/jobs/meeting-queue.ts` (graceful drain: cờ `draining` từ chối job mới, chờ job đang chạy)
- `src/server/tools/index.ts`
- `privos-app.json` + `src/server/manifest.ts` (thêm `meeting_settings_set`; version bump 0.1.0 → 1.0.0; rà reason/degradedBehavior; đối chiếu **18 tool** với registry lần cuối)
- `scripts/deploy-hodao.sh` (hoàn thiện: rsync, chown/chmod, npm install, model, pm2 restart, health check)
- `PRIVOS.md`, `docs/deployment-guide.md`, `docs/codebase-summary.md`, `docs/system-architecture.md`, `docs/project-roadmap.md`, `docs/design-guidelines.md`
- `src/ui/i18n/vi.json`, `en.json`

**Delete** — không có.

## Implementation Steps

1. `src/shared/app-settings.ts` (`AppSettings` + `DEFAULTS`) + `settings-store.ts` (iframe đọc) + tool `meeting_settings_set` (backend ghi); thay mọi chỗ đọc cấu hình rải rác ở P2/P4/P5/P6 bằng một nguồn này (DRY).
2. 6 panel settings + gắn panel Speaker identification của P4 vào nav 240px theo layout 1e.
3. `is-workspace-admin.ts` + hoàn thiện `stt-status-tool.ts` (probe **từng** nhà cung cấp có khoá, admin thấy bảng hai bên, người khác chỉ `{ok}`) + nút "Kiểm tra kết nối" + hai select provider (chỉ admin, ghi qua `meeting_settings_set`).
4. `microphone-panel.tsx`: `enumerateDevices` + lưu `preferredMicDeviceId` + `mic-test-wave.tsx` (AnalyserNode, 3s).
5. `privacy-panel.tsx`: toggle giữ audio (mặc định off), số ngày tự xoá, nút "Xoá toàn bộ voiceprint" (hộp xác nhận gõ lại tên), hiển thị `dataPolicy`.
6. `audio-retention-job.ts` (`purgeExpiredAudio(roomId)` gọi từ `meeting_bootstrap` + `startAudioRetention()` lặp `knownRooms` mỗi 6h; thêm nhánh dọn part của meeting `interrupted` và rác phía Soniox) + khởi động/dừng trong `index.ts`; thêm cờ `draining` cho `job-queue` để SIGTERM không cắt job giữa chừng.
7. Rà bảo mật: grep `SONIOX_API_KEY|ELEVENLABS_API_KEY|VOICEPRINT_ENC_KEY|CREDENTIAL|ANTHROPIC` trong `src/ui/**` phải trống; **mọi tool** gọi `requireVerifiedActor` và kiểm quyền theo bảng tool của plan.md; không response nào chứa vector plaintext (gồm cả `meeting_live_speakers`); CSP đúng 3 origin (`wss://stt-rt.soniox.com`, `wss://api.elevenlabs.io`, `PRIVOS_FILES_ORIGIN`) và nằm trong `_meta.ui`; log sạch, không có temporary API key. Viết `cross-room-authz.test.ts` cho kịch bản phòng B ↔ phòng A.
8. Bổ sung test còn thiếu theo ma trận; thêm `meeting-job.integration.test.ts` với wav mẫu 30s commit vào `src/server/jobs/__fixtures__/`.
9. Chạy `npm run verify:fast-pr` (`typecheck && test && build && preflight`).
10. Viết `docs/deployment-guide.md` đầy đủ: runtime modes, env, tải model ONNX (URL + sha256), **sinh và BACKUP `VOICEPRINT_ENC_KEY`** (mục riêng: `openssl rand -base64 32`, chmod 600, cất vào kho bí mật của tổ chức, cảnh báo mất khoá = mất toàn bộ voiceprint, quy trình xoay khoá = re-enrol), pm2 entry, health check, rollback; cập nhật `codebase-summary.md`, `system-architecture.md`, `project-roadmap.md`, `design-guidelines.md` (5 màn bổ sung ngoài design, QĐ-08, "Ask AI" v1 chỉ là tìm từ khoá). Thêm mục **"Nhà cung cấp STT"**: bốn cài đặt sau `stt-provider.ts`, cách đổi bằng Settings, khoá nào cần cho bên nào, hệ quả khi chọn `elevenlabs-realtime` (P5 tắt), và kết quả A/B tiếng Việt nếu đã chạy.
11. Hoàn thiện `scripts/deploy-hodao.sh`:
    ```bash
    ssh -i ~/.ssh/thanh-dev -p 22087 root@hub002.roxane.one 'ss -ltnp | grep :3012 || true'   # cổng trống?
    rsync -az -e "ssh -i ~/.ssh/thanh-dev -p 22087" \
      --exclude node_modules/ --exclude .git/ --exclude data/ --exclude models/ --exclude '*.tsbuildinfo' \
      ./ root@hub002.roxane.one:/opt/privos/apps/meeting-agent/
    ssh … 'cd /opt/privos/apps/meeting-agent && chown -R root:root . && chmod 600 privos-standalone-identity.json .env \
            && npm install --no-audit --no-fund && npm run build && bash scripts/fetch-speaker-model.sh && pm2 restart meeting-agent'
    ```
12. Deploy lần đầu trên hodao (port 3012 **đã xác minh còn trống** — `ss -ltnp` chỉ thấy 3011 gia-pha và 3000 business-hub): tạo thư mục, copy `.env` (chmod 600: `STT_REALTIME_PROVIDER`, `STT_ASYNC_PROVIDER`, `SONIOX_API_KEY`, `SONIOX_RT_MODEL`, `SONIOX_ASYNC_MODEL`, `SONIOX_TEMP_KEY_TTL_SEC`, `ELEVENLABS_API_KEY`, `ELEVENLABS_REALTIME_MODEL`, `ELEVENLABS_BATCH_MODEL`, `ELEVENLABS_DIARIZATION_THRESHOLD`, `LIVE_*`, `SPEAKER_*`, `VOICEPRINT_ENC_KEY`, `PRIVOS_FILES_ORIGIN`, bot credential — **ít nhất một** khoá STT, và nhà cung cấp đang chọn bắt buộc phải có khoá), tải model vào `models/`, `npm run pair` (chạy 2 lần theo quy trình gia-pha), **nhờ admin cấp `PRIVOS_AGENT_BOT_USER_ID`/`PRIVOS_AGENT_BOT_CREDENTIAL` ở Admin → Apps → Meeting Agent → Settings và thêm bot vào phòng thử**, thêm entry vào `/opt/privos/apps/ecosystem.config.cjs`, `pm2 start` + `pm2 save`.
13. Health check: `curl -s localhost:3012/health` → `{ok:true}`; `curl -s -o /dev/null -w '%{http_code}' localhost:3012/ready` → 200; `pm2 logs meeting-agent --lines 50` thấy kết nối thành công; gọi `meeting_agent_bot_credential_check` → `valid`.
14. Chạy checklist e2e thủ công trên node thật; ghi kết quả vào `docs/deployment-guide.md`.
15. Rollback plan (ghi vào deployment-guide): `pm2 stop meeting-agent` → app biến mất khỏi Hub, dữ liệu App DB/Files giữ nguyên; quay về commit trước bằng rsync lại từ tag git; **không** drop collection (dữ liệu voiceprint không tái tạo được từ audio đã xoá).
16. Commit + tag `v1.0.0`.

## Todo

- [ ] `src/shared/app-settings.ts` + `settings-store.ts` + tool `meeting_settings_set`; refactor các nơi đọc cấu hình rời rạc
- [ ] 6 panel settings + nav 240px (1e) + gắn panel Speaker identification
- [ ] Hoàn thiện `meeting_stt_status` (probe cả hai nhà cung cấp) + hai select provider (admin) + nút kiểm tra kết nối (không có ô nhập key)
- [ ] `is-workspace-admin.ts` + `meeting_stt_status` phân quyền + `microphone-panel.tsx` + `mic-test-wave.tsx`
- [ ] `privacy-panel.tsx` (giữ audio, auto-delete N ngày, xoá voiceprint)
- [ ] `audio-retention-job.ts` (`purgeExpiredAudio` theo phòng + interval `knownRooms`) + graceful drain cho job queue
- [ ] Rà bảo mật (secret/CSP/actor/log) + `cross-room-authz.test.ts` + ghi kết quả
- [ ] Bổ sung test theo ma trận + integration test có ffmpeg thật
- [ ] `npm run verify:fast-pr` xanh
- [ ] Hoàn thiện 7 file `docs/` + checklist e2e + mục backup `VOICEPRINT_ENC_KEY`
- [ ] `scripts/deploy-hodao.sh` + `scripts/fetch-speaker-model.sh`
- [ ] Deploy hodao: pair, cấp bot credential (Admin → Apps → Settings), ecosystem entry, pm2 save, health check + `meeting_agent_bot_credential_check`
- [ ] Chạy checklist e2e trên node thật
- [ ] Rollback plan ghi trong deployment-guide
- [ ] Commit + tag `v1.0.0`

## Success Criteria

- [ ] `npm run verify:fast-pr` xanh (typecheck + test + build + preflight)
- [ ] `grep -rn "SONIOX_API_KEY\|ELEVENLABS_API_KEY\|VOICEPRINT_ENC_KEY\|BOT_CREDENTIAL\|ANTHROPIC" src/ui/` không có kết quả
- [ ] `cross-room-authz.test.ts` xanh: phòng B không process/status/xoá được dữ liệu phòng A
- [ ] `dist/manifest.json` liệt kê **đúng** bộ tool trong registry (16 tool), không thừa không thiếu
- [ ] Settings đủ 7 mục, không có ô nhập API key; đổi threshold/ngôn ngữ lưu và đọc lại đúng sau reload
- [ ] "Kiểm tra kết nối" trả trạng thái thật; key sai → báo lỗi, không lộ key
- [ ] Retention: bật giữ audio + 1 ngày → `meeting_bootstrap` xoá đúng file và set `audioDeletedAt`, không đụng meeting `keepAudio` ở cài đặt khác
- [ ] `pm2 restart meeting-agent` khi có job đang chạy → job kết thúc hoặc `failed(interrupted)`, không hỏng file trên Files
- [ ] Trên hodao: `/health` 200, `/ready` 200, `pm2 logs` không có lỗi lặp; app mở được trong phòng Hub
- [ ] 14/14 mục checklist e2e thủ công PASS trên node thật
- [ ] Không response MCP nào chứa vector/embedding (kiểm `meeting_status`, `speaker_profile_list`)
- [ ] `docs/` cập nhật đủ 7 file; deployment-guide có runbook + rollback + URL/sha256 model + quy trình backup/xoay `VOICEPRINT_ENC_KEY`
- [ ] `npm run package` chạy được và từ chối khi có file credential

## Risk Assessment

| Risk | Signal | Response |
|---|---|---|
| Bot credential chưa được admin cấp khi deploy | `meeting_agent_bot_credential_check` = `not-configured`, mọi job fail | Thêm bước cấp credential vào runbook; app vẫn boot và phục vụ UI, chỉ chặn ghi/xử lý với thông báo rõ |
| Chạy app cả local lẫn hodao cùng lúc | Relay báo trùng identity, app rớt | PRIVOS.md cảnh báo rõ; dừng `npm run dev` trước khi deploy |
| rsync đổi owner/quyền file identity | App từ chối nạp identity | `chown -R root:root` + `chmod 600` ngay sau rsync (đã nằm trong script) |
| Thiếu model ONNX trên node | Boot lỗi `SPEAKER_MODEL_PATH` không tồn tại | `fetch-speaker-model.sh` chạy trong deploy, verify sha256; `models/` không rsync |
| `VOICEPRINT_ENC_KEY` không được backup trước khi hỏng ổ | Không giải mã được voiceprint sau khôi phục | Runbook bắt buộc backup ngay sau khi sinh khoá; checklist deploy có ô xác nhận |
| pm2 restart giữa job dài → mất kết quả | Job `failed(interrupted)` | `kill_timeout 15s` + `draining`; job idempotent chạy lại được từ `audioFileId` |
| Manifest digest lệch sau khi sửa `privos-app.json` | `/ready` 503, install lỗi | Chạy `npm run manifest:lint` + `preflight` trước deploy; pair lại nếu permission đổi |
| Xoá nhầm dữ liệu khi rollback | Mất voiceprint | Rollback chỉ đổi code + pm2; cấm `dropCollection` trong quy trình rollback |
| Thiếu ffmpeg quyền exec sau rsync | `EACCES` lúc spawn | `npm install` trên node tái tạo quyền; health check sau deploy chạy thử decode 3s wav |
