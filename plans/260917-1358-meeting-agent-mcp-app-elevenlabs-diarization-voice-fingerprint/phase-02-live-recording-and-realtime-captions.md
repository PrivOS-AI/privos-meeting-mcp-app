---
phase: 2
title: "Phase 2: Live recording and realtime captions"
status: pending
priority: P1
effort: "4d"
dependencies: [1]
---

# Phase 2: Live recording and realtime captions

## Overview

Ghi âm cuộc họp offline bằng mic trình duyệt và hiện live caption **có nhãn người nói** + bản dịch. **Một** `getUserMedia` duy nhất, `MediaStream` đó được chia cho hai bên tiêu thụ: SDK Soniox (tự thu, tự gửi) và `MediaRecorder` (part file). Đồng hồ họp là **đồng hồ của recorder** (QĐ-17).
- **Nhánh lưu trữ (authoritative, QĐ-13):** `MediaRecorder(audio/webm;codecs=opus)` timeslice ~60s (hoặc ngưỡng dung lượng theo spike P1) → mỗi Blob upload **ngay** thành `audio.part-NNNN.webm` vào folder cuộc họp qua `app.uploadFile` → `meetings.partCount++`. Part đầu mang header WebM; ghép byte các blob timeslice liên tiếp tái tạo đúng stream. **Không** dùng IndexedDB làm nguồn bền (storage của opaque origin không đảm bảo); nếu spike P1 cho thấy IndexedDB chạy được thì dùng như buffer best-effort, lưu kèm `roomId`.
- **Nhánh caption (disposable, QĐ-01):** SDK của **realtime provider đang chọn** tự thu từ chính `MediaStream` đó và tự gửi — Soniox (`new SonioxClient({apiKey}).start({…, stream})` → `.stop()`) hoặc ElevenLabs (`Scribe.connect({ token, microphone:false, stream })`). App **không** chuyển PCM, **không** dựng config message, **không** quản `bufferedAmount` — backpressure là của SDK, ta chỉ hiển thị lỗi từ `onError`. Soniox trả token có `speaker` → badge **`Người nói N`** + màu; ElevenLabs **không có nhãn** → badge trung tính "Đang nói" + dải thông báo "Nhãn người nói sẽ có sau khi xử lý" (QĐ-18).
- **Nhánh live naming (QĐ-16, chỉ khi provider có nhãn):** sau mỗi part upload xong, gom các **turn** bắt đầu trong cửa sổ part (gộp token liên tiếp cùng `speaker`) → `meeting_chunk_ready {roomId, meetingId, seq, durationMs, segments}` — gửi **cả turn chưa final**, chunk kế tiếp gửi lại bản đã final; poll `meeting_live_speakers` mỗi 3-5 s để **sửa lùi** nhãn thành tên thật (P5 cài backend). `capabilities.speakerLabels === false` → **không** gọi `meeting_chunk_ready`, **không** poll, UI vào chế độ degraded.
- **Nhánh dịch (QĐ-12), hai đường theo `capabilities.translation`:** (a) **native** — thêm `translation: {type:'two_way', language_a:'vi', language_b:'en'}` vào cùng `.start()` của Soniox; token dịch có `translation_status`, **không có timestamp** → chỉ để render, **loại khỏi** turn và mọi phép gióng. (b) **Hub AI** — `translate-buffer.ts` gom dòng đã final mỗi 3-5 s → tool `meeting_translate`, dùng khi provider không dịch native (ElevenLabs) hoặc khi spike P1-8 cho thấy native xung đột với diarization. Một cờ `capabilities.translation` quyết định, UI không đổi.

Phase kết thúc khi bấm "End & summarize": part cuối đã upload, `meetings` có `partCount`/`endedAt`/`durationSec`/`sttSessionMeta`, `status='uploading'`, và `meeting_process {roomId, meetingId}` đã được gọi (P3 nối tiếp). **Không** có `audioFileId` ở phase này — file ghép do backend tạo.

## Requirements

**Functional**
- Màn `new-meeting`: nhập title, chọn ngôn ngữ chính (vi/en), hiện phòng hiện tại + **tên nhà cung cấp STT đang dùng** (chỉ đọc), nút "Bắt đầu ghi" → xin quyền mic → sang màn 1a.
- Màn 1a (Transcript, light) và 1b (Stage, dark) theo design: toggle Transcript↔Stage, chấm REC + timer mm:ss, footer mic mute / cỡ chữ / bookmark / pause / End & summarize. Bookmark tại thời điểm hiện tại → ghi `bookmarks` (App DB) ngay lúc ghi âm.
- Pause/Resume + Mute: `MediaRecorder.pause()` nhưng **SDK vẫn chạy và vẫn nhận im lặng** (thay track bằng nguồn im lặng hoặc `gain = 0`, **không** đóng track) — dừng cấp audio cho SDK làm `start_ms` lệch vĩnh viễn so với đồng hồ recorder.
- **Giữ màn hình sáng khi đang ghi** (yêu cầu người dùng 2026-09-17): khi vào trạng thái `recording` gọi `navigator.wakeLock.request('screen')` ngay trong gesture "Bắt đầu ghi"; giữ sentinel trong `recording-store`; `visibilitychange` → `visible` thì xin lại (sentinel bị thu hồi khi tab ẩn); thả ở pause/End/lỗi. **Phụ thuộc Hub**: iframe là `srcdoc` opaque-origin nên Wake Lock chỉ chạy khi thẻ iframe có `allow="screen-wake-lock"`; Hub hiện chỉ map `camera`/`microphone` (`use-mcp-bridge-host.ts:193-198`) → khai `_meta.ui.permissions: ["microphone","screen-wake-lock"]` và mở ticket Hub. Fallback khi `NotAllowedError`/không hỗ trợ: dải cảnh báo cố định "Tắt tự động tắt màn hình/sleep trong lúc ghi" ở 1a/1b + hướng dẫn theo OS; ghi âm **không** phụ thuộc wake lock (tab ẩn vẫn ghi; chỉ màn hình tắt mới có nguy cơ OS ngắt mic trên mobile).
- Mất WS → reconnect tối đa 5 lần backoff với token mới; "Caption tạm ngắt", bản ghi KHÔNG gián đoạn; mỗi lần connect ghi `{index, wsSessionOffsetMs, startedAt, clockSkewMs}` vào `sttSessionMeta`. **Mọi close/error của SDK = kết thúc phiên** (không đoán mã lỗi; không có "413"). Tự reconnect tối đa 5 lần backoff với temporary key **mới**; hiện "Caption tạm ngắt", bản ghi KHÔNG gián đoạn. Mỗi lần connect ghi thêm `{index, wsSessionOffsetMs, startedAt, clockSkewMs}` vào `meetings.sttSessionMeta`.
- **Cap phiên 300 phút** (Soniox): đếm thời lượng phiên hiện tại, tới ~280 phút thì **chủ động** mở phiên mới rồi đóng phiên cũ; khoá mint kèm `max_session_duration_seconds`. ElevenLabs realtime chưa có số cap công bố → dùng chung đường roll-over, ghi mã đóng quan sát được.
- **Degraded mode (QĐ-18)** khi `capabilities.speakerLabels === false`: caption không nhãn, không gọi `meeting_chunk_ready`, không poll `meeting_live_speakers`, ẩn chip "Ai đang nói?", hiện dải "Nhãn người nói sẽ có sau khi xử lý". Mọi thứ khác (ghi âm, part, dịch, bookmark, End & summarize) **không đổi**.
- **Trần đồng thời**: `meeting_realtime_token` từ chối khi workspace đã có `LIVE_MAX_CONCURRENT_RECORDINGS` phiên đang chạy → UI báo "Hệ thống đang ghi tối đa N cuộc họp, phụ đề trực tiếp tạm không khả dụng — bản ghi vẫn chạy và tên người nói sẽ có sau khi xử lý".
- Nhãn người nói (Soniox): `speaker` là **số thứ tự trong phiên**, reset khi roll session → namespace `s{sessionIndex}:{speaker}` trước khi gửi backend.
- `is_final`: token `is_final:false` là bản nháp, **luôn** bị thay thế bởi lần cập nhật sau. Caption render cả hai; `meeting_chunk_ready` gửi **cả turn chưa final** kèm cờ `final` (turn cuối part gần như luôn chưa final vì Soniox chỉ chốt khi người nói dừng). Nhãn `speaker` trên token đã final **giả định khoá** — spike P1-8 xác nhận; bị sửa thì đã có sẵn đường relabel lùi.
- Toggle dịch song ngữ: `capabilities.translation === true` → `.start()` kèm `translation: two_way` (đổi toggle giữa chừng = restart phiên SDK, ghi offset mới); ngược lại → bật `translate-buffer` gọi `meeting_translate`. Spike P1-8 thấy native xung đột với diarization → **giữ diarization**, chuyển sang đường Hub AI (QĐ-18), không mất tính năng dịch.
- Mở lại app thấy `status ∈ {'recording','interrupted'}` và không có `endedAt` → banner "Khôi phục?" → hoàn tất từ part đã upload (mất ≤ 1 timeslice) hoặc huỷ (xoá đúng `partFileIds` + `failed`).
- Upload part: `app.uploadFile` (base64) với `duplicateAction:'keep_both'` (**không bao giờ** `replace` — upload Files là upsert theo path). Thất bại → **không dừng ghi**: part vào hàng đợi RAM, retry backoff cap 30 s trong `LIVE_UPLOAD_RETRY_WINDOW_MIN` (15 phút), UI "Mạng yếu — đang giữ N phút chưa tải lên"; quá cửa sổ hoặc chạm trần 20 part → thử lại tay lúc End. **Không** có nhánh chunked REST.
- Thư mục `Meetings/<yyyy-mm-dd>-<slug>-<meetingId8>/`, part `audio.part-NNNN-<meetingId8>.webm` — hai cuộc họp cùng ngày cùng tiêu đề **không** đụng vào file của nhau.

**Non-functional**
- Ghi liên tục 60 phút với bộ nhớ phẳng: **không bao giờ giữ cả cuộc họp trong RAM** — blob được upload rồi thả ngay.
- Ghi liên tục 60 phút với bộ nhớ phẳng: blob upload xong là thả; chỉ hàng đợi part lỗi giữ lại, trần 20 part. Backpressure do SDK lo, app chỉ hiện lỗi từ `onError` và **không** tự bỏ frame audio (frame mất = sai số vĩnh viễn cho đồng hồ provider).
- Độ trễ caption < 1s. Sau mỗi part, `|elapsed_recorder − (offset + end_ms cuối)|` ≤ 1.5 s; vượt → ghi `clockSkewMs` + `approxClock`. Token realtime không bao giờ log ra console/telemetry; mọi chuỗi UI qua i18n.
## Architecture

### Luồng

```
new-meeting → folderId = ensureMeetingFolder(roomId, date, slug, meetingId8)
  → db.create('meetings', { roomId, folderId, status:'recording', startedAt, language,
                            translationEnabled, translationLang, keepAudio, partCount:0, ownerUserId })
  → stream = getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true, channelCount:1 } })
  → recorderEpochMs = performance.now(); MediaRecorder(stream,{mimeType:'audio/webm;codecs=opus'}).start(PART_MS)
       ondataavailable(blob) → enqueueUpload(seq++, blob)        // hàng đợi retry, KHÔNG chặn ghi
                             → db.update('meetings', id, { partCount: seq, lastPartAt: now })
                             → nếu capabilities.speakerLabels: callTool('meeting_chunk_ready',
                                   { roomId, meetingId, seq, durationMs, segments: turnsInPart(seq) })
  → tool meeting_realtime_token {roomId, meetingId}     // authz + budget + trần đồng thời
       → { provider, token, wsUrl?, expiresAt, capabilities:{ speakerLabels, translation } }
  → createRealtimeClient(provider)   // soniox: SonioxClient.start({..., stream, translation?})
                                     // elevenlabs: Scribe.connect({ token, microphone:false, stream })
       onStarted → wsSessionOffsetMs[i] = performance.now() - recorderEpochMs        // QĐ-17
  → nếu !capabilities.speakerLabels → bỏ qua chunk_ready + poll (degraded, QĐ-18)
  → nếu !capabilities.translation && showTranslation → translate-buffer → tool meeting_translate
  → poll meeting_live_speakers mỗi 3-5s → relabel lùi dòng đã hiện theo speakerKey
End & summarize:
  → recorder.stop() (flush part cuối + chunk_ready cuối) → soniox.stop()   // SDK tự flush audio đệm
  → db.update('meetings', id, { endedAt, durationSec, partCount, sttSessionMeta, status:'uploading' })
  → callTool('meeting_process', { roomId, meetingId })   // P3 ghép part -> audio.webm
```

### Tool mint token realtime (backend, P1 đã tạo vỏ cho cả hai provider)

```ts
// soniox-realtime-token.ts — POST api.soniox.com/v1/auth/temporary-api-key (Bearer SONIOX_API_KEY)
//   { usage_type:'transcribe_websocket', expires_in_seconds: min(TTL,3600), single_use:true,
//     max_session_duration_seconds:16800, client_reference_id: meetingId } → { api_key, expires_at }
//   capabilities { speakerLabels: true, translation: true }
// elevenlabs-realtime-token.ts — POST api.elevenlabs.io/v1/single-use-token/realtime_scribe
//   (header xi-api-key) → { token }; ~15 phút, tiêu thụ ở lần connect đầu
//   capabilities { speakerLabels: false, translation: false }   // Scribe realtime KHÔNG diarization
export interface RealtimeTokenProvider { mint(meetingId: string): Promise<RealtimeToken>; }

// realtime-token-tool.ts — meeting_realtime_token { roomId, meetingId }
// 1. requireVerifiedActor  2. meeting.roomId === args.roomId === actor.roomId
// 3. ownerUserId === actor.userId && status === 'recording'
// 4. budget ≤ 30 lần/giờ/(user,meeting)   5. TRẦN ĐỒNG THỜI: đếm meetings 'recording' còn tươi
//    (lastPartAt) trên mọi knownRooms ≥ LIVE_MAX_CONCURRENT_RECORDINGS → AppError tiếng Việt,
//    ghi âm VẪN chạy; áp chung cả hai provider (QĐ-19)
// 6. provider = sttRegistry.realtime()  // app_settings.sttRealtimeProvider ?? env.STT_REALTIME_PROVIDER
//    thiếu khoá provider đó → AppError nói rõ setting nào đang trỏ tới đâu
// 7. log { userId, roomId, meetingId, provider } (KHÔNG log token) → provider.mint(meetingId)
// → { provider, token, wsUrl?, expiresAt, model?, capabilities }
```

Cả hai loại token đều dùng một lần → **mỗi lần connect/reconnect/roll-session mint token mới**; token chỉ sống trong RAM của tab, không vào `localStorage`/`app.storage`. SDK nhận token qua hàm async và **đệm audio cho tới khi token về** — đó là lý do `wsSessionOffsetMs` phải lấy ở callback "đã bắt đầu stream" (QĐ-17).


### Hàng đợi upload part (chịu được mạng hỏng)

`src/ui/data/part-upload-queue.ts`: FIFO trong RAM `{seq, blob, attempts}`; `enqueueUpload` trả ngay (ghi âm không chờ). Worker đơn: `uploadPart` → thành công thì thả blob + `partCount++` + gọi `meeting_chunk_ready` (nếu provider có nhãn); lỗi → backoff luỹ thừa **cap 30 s** tới `LIVE_UPLOAD_RETRY_WINDOW_MIN`. Trần 20 part (~5 MB opus); chạm trần hoặc hết cửa sổ → dừng ghi có báo trước, giữ blob để thử lại tay lúc End. Mất `meeting_chunk_ready` chỉ làm **chậm** nhãn, không sai dữ liệu — backend suy ra phần việc thiếu từ `partCount`.

### Upload part

`src/ui/data/meeting-part-upload.ts`: `PART_MS = 60_000` (chốt theo spike P1-2); `partName(seq, meetingId8)` = `audio.part-NNNN-<meetingId8>.webm`; `uploadPart(...)` = base64(blob) → `app.uploadFile({channelId: roomId, folderId, fileName, mimeType:'audio/webm', duplicateAction:'keep_both'})` → `fileId`; `listParts(app, roomId, folderId)`. Retry do `part-upload-queue.ts` lo. Không có nhánh chunked REST (`upload-chunked-*` không gọi được qua bridge).

### Realtime client (factory theo provider — app KHÔNG chạm wire protocol)

```ts
// src/ui/data/realtime-client.ts — factory: createRealtimeClient(token.provider) -> RealtimeConnection
// src/ui/data/soniox-realtime-client.ts — bọc SDK đã ghim ở spike P1-10
// src/ui/data/elevenlabs-realtime-client.ts — bọc @elevenlabs/client Scribe.connect({token, microphone:false, stream})
//   map PARTIAL_TRANSCRIPT/COMMITTED_TRANSCRIPT -> CaptionEvent; KHÔNG có speaker, KHÔNG có translation
export interface CaptionEvent { kind: 'draft' | 'final'; id: string; text: string;
  atSec: number; endSec: number; speakerKey?: string; lang?: string;   // theo ĐỒNG HỒ HỌP
  translationOf?: string }                                             // token dịch: KHÔNG có timestamp
export function createSonioxConnection(opts: {
  getKey: () => Promise<{ apiKey: string; model: string }>;   // mint mới mỗi connect/reconnect/roll
  stream: MediaStream; recorderEpochMs: number; translate: boolean;
  onCaption: (e: CaptionEvent) => void;
  onTurns: (turns: LiveTurn[]) => void;      // gộp token liên tiếp cùng speaker (BỎ token dịch)
  onStarted: (sessionIndex: number, offsetMs: number) => void;
  onStatus: (s: 'connecting'|'live'|'reconnecting'|'off', info?: { sessionIndex: number; error?: string }) => void;
}): { stop(): Promise<void> };
```

Cả hai wrapper cài **cùng** interface `RealtimeConnection` và chỉ làm bốn việc: (1) gọi API start của SDK với option đúng tài liệu + `stream` của ta, (2) ghi `wsSessionOffsetMs` ở callback "đã bắt đầu stream", (3) dựng `CaptionEvent`/`LiveTurn` từ token — **loại token có `translation_status` khỏi turn** (không timestamp), wrapper ElevenLabs **không bao giờ** phát `LiveTurn`, (4) reconnect backoff 1s/2s/4s/8s/16s với token mới, roll phiên ~280 phút. Không `sendPcm`, không `bufferedAmount`, không config tự chế — kết thúc bằng `stop()`/`close()` của SDK.

**Không** gọi `finalize` chủ động: docs cảnh báo ép finalize sớm **làm giảm độ chính xác diarization** — đánh đổi không đáng cho caption vốn đã < 1s.

### Đồng hồ họp (QĐ-17)

`src/ui/data/meeting-clock.ts` — đồng hồ họp **là đồng hồ của recorder**:
- `recorderEpochMs = performance.now()` ngay trước `mediaRecorder.start()`.
- `wsSessionOffsetMs[i]` lấy ở callback **"đã bắt đầu stream"** của SDK (không phải lúc gọi mint, không phải lúc mở socket — SDK đệm audio trong lúc chờ khoá).
- `tokenToMeetingMs(t) = wsSessionOffsetMs[t.sessionIndex] + t.start_ms + clockSkewMs[t.sessionIndex]`.
- **Resync mỗi part**: khi part đóng, `skew = elapsedRecorderMs − (offset + end_ms của token final cuối)`; lưu vào `clockSkewMs`. `|skew| > 1500 ms` → đánh dấu part `approxClock` và báo cho backend biết qua `meeting_chunk_ready`.
- `measuredPartMs(seq)` = thời lượng **đo được** của blob part (không dùng `PART_MS` danh nghĩa) — backend dùng nó để tiến đồng hồ ngay cả khi chunk xử lý lỗi.

Lưu `{ recorderEpochMs, sessions: [{index, wsSessionOffsetMs, startedAt, clockSkewMs}] }` vào `meetings.sttSessionMeta` — P3 dùng để reconcile pass async với nhãn live.

### Dịch live (QĐ-12 — hai đường, chọn bằng `capabilities.translation`)

**(a) Native (Soniox, ưu tiên):** truyền `translation: { type:'two_way', language_a:'vi', language_b:'en' }` vào chính `.start()`; token dịch mang `translation_status` và **không có `start_ms`/`end_ms`** → chỉ gắn vào dòng gốc để render, **tuyệt đối không** đưa vào `turnsInPart()` hay phép gióng nào.

**(b) Hub AI (ElevenLabs, hoặc khi native xung đột diarization):** `src/ui/data/translate-buffer.ts` gom `CaptionEvent kind==='final'`, **bỏ dòng đã ở ngôn ngữ đích**, flush mỗi 3-5 s hoặc khi đủ N dòng → `meeting_translate {roomId, meetingId, target, segments:[{id,text,lang}]}` → gán `translations` theo `id` vào dòng đã render; lỗi/timeout → bỏ lô đó, **không** chặn caption. Backend `translate-tool.ts`: `requireVerifiedActor` + thành viên phòng, rate-limit theo meeting, gọi `hub-ai-client.generate`. Dịch batch sau họp vẫn là Hub AI (P6, QĐ-07).

### Live speaker labels ở iframe

`src/ui/data/live-speaker-poll.ts`: poll `meeting_live_speakers {roomId, meetingId}` mỗi 3-5s khi đang ghi → `Map<speakerKey, {displayName?, colorKey, liveConfidence?, resolved}>` → recording-store áp map lên **mọi** dòng caption đã render (kể cả dòng cũ): relabel lùi, **không** viết lại text, chỉ đổi badge; dừng poll khi rời `recording`.

Trước khi có tên: badge `Người nói N` (N = thứ tự xuất hiện của `speakerKey` trong phiên) + màu từ palette 6 màu. Sau khi P5 khớp profile: badge đổi thành tên + chấm confidence; chấm "?" → mở quick-assign gọi `speaker_resolve` ngay trong họp (P5).

### Store recording

```ts
// src/ui/stores/recording-store.ts — useSyncExternalStore hoặc context + reducer
interface RecordingState {
  meetingId: string | null; status: 'idle'|'recording'|'paused'|'ending'|'uploading'|'error';
  provider: 'soniox'|'elevenlabs'; capabilities: { speakerLabels: boolean; translation: boolean };
  recorderEpochMs: number; startedAt: number; elapsedSec: number; muted: boolean;
  captionStatus: 'connecting'|'live'|'reconnecting'|'off'|'capacity'; sessionIndex: number;
  pendingParts: number; clockSkewMs: number;      // "đang chờ mạng" / cảnh báo lệch đồng hồ
  lines: CaptionLine[];            // {id, text, translation?, atSec, endSec, isFinal, speakerKey?, lang?}
  speakerMap: Record<string, LiveSpeaker>; stageCaptionSize: 'small'|'medium'|'large';
  showTranslation: boolean; error?: string;
}
```

## Related Code Files

**Create**
- `src/server/tools/realtime-token-tool.ts`
- `src/server/tools/chunk-ready-tool.ts` (vỏ nhận + validate; hàng đợi ở P5), `src/server/tools/translate-tool.ts` (`meeting_translate`, rate-limit theo meeting)
- `src/ui/data/{media-recorder-service,realtime-client,soniox-realtime-client,elevenlabs-realtime-client,meeting-clock,part-upload-queue,translate-buffer,live-speaker-poll}.ts`
- `src/ui/data/meeting-part-upload.ts`
- `src/ui/data/screen-wake-lock.ts` (request/re-acquire/release, feature-detect, trả `{ supported, active, error }`) + `src/ui/components/keep-awake-notice.tsx` (dải cảnh báo fallback)
- `src/ui/data/meeting-folder.ts` (`Meetings/<yyyy-mm-dd>-<slug>-<meetingId8>/`); `indexeddb-chunk-store.ts` (chỉ khi spike P1-7 xác nhận); `meeting-draft-repository.ts` (iframe tạo/cập nhật `meetings` lúc ghi âm + `bookmarks`)
- `src/ui/stores/recording-store.ts`
- `src/ui/components/{rec-indicator,caption-line,stage-caption,recording-footer,mic-level-meter,capacity-notice,degraded-labels-notice}.tsx`; `src/ui/screens/recovery-banner.tsx`
- Tests: `meeting-part-upload`, `part-upload-queue`, `soniox-realtime-client`, `elevenlabs-realtime-client`, `meeting-clock`, `translate-buffer`

**Modify**
- `privos-app.json` + `src/server/manifest.ts` — thêm `meeting_realtime_token`, `meeting_chunk_ready`, `meeting_translate`
- `src/server/tools/index.ts` (3 tool); `src/server/hub/hub-ai-client.ts` (tạo ở đây, P6 dùng lại); `src/server/stt/{soniox,elevenlabs}-realtime-token.ts` (P1 vỏ → cài đặt thật)
- `src/ui/screens/new-meeting-screen.tsx`, `live-screen.tsx` (biến placeholder thành màn 1a/1b thật)
- `src/ui/app.tsx` (route `new` → `live`, gắn recovery banner)
- `src/ui/i18n/vi.json`, `en.json`
- `package.json` (SDK Soniox đã ghim ở spike P1-10 + `@elevenlabs/client`)
- `src/server/stt/soniox-realtime-token.ts` (P1 tạo vỏ → cài đặt thật ở đây)
- `src/shared/app-db-schema.ts` (`meetings.sttSessionMeta`, `lastPartAt`, `status:'interrupted'`)

**Delete** — không có.

## Implementation Steps

1. Backend: `soniox-realtime-token.ts` + `elevenlabs-realtime-token.ts` (cùng interface `RealtimeTokenProvider`, trả `capabilities`) + tool `meeting_realtime_token` đủ 7 bước authz/budget/**trần đồng thời**/chọn provider; tool `meeting_chunk_ready` (vỏ); `hub/hub-ai-client.ts` + tool `meeting_translate` (rate-limit theo meeting). Đăng ký 3 tool vào `tools/index.ts` **và** `privos-app.json`. Test: mock `fetch` — Soniox `authorization: Bearer` + `usage_type`/`single_use`/`max_session_duration_seconds`; ElevenLabs header `xi-api-key` + endpoint `single-use-token/realtime_scribe`; **không log token**; chặn caller không phải owner; chặn khi đủ `LIVE_MAX_CONCURRENT_RECORDINGS`; **provider thiếu khoá → lỗi nói rõ setting nào**.
2. `media-recorder-service.ts`: `start(stream, onPart)`, `pause/resume/stop`, mimeType qua `isTypeSupported('audio/webm;codecs=opus')` fallback `audio/webm`; blob trao cho callback rồi thả ngay.
3. `part-upload-queue.ts`: FIFO + worker + backoff cap 30 s + trần 20 part + cửa sổ `LIVE_UPLOAD_RETRY_WINDOW_MIN`; test: mạng hỏng 10 phút → ghi âm tiếp tục, part lên đủ khi mạng về, thứ tự `seq` giữ nguyên.
3b. `meeting-clock.ts`: `recorderEpochMs`, `wsSessionOffsetMs` theo `sessionIndex` (lấy ở `onStarted`), `clockSkewMs` resync mỗi part, `tokenToMeetingMs`, `measuredPartMs`, `turnsInPart(seq)` — gộp token liên tiếp cùng `speaker` thành turn, **giữ cả turn chưa final** kèm cờ, **loại token dịch**. Unit test: hai phiên offset khác nhau vẫn map đúng; skew > 1.5 s → part bị đánh dấu `approxClock`; turn vắt biên part vẫn được gửi (không cắt cụt).
3c. `screen-wake-lock.ts`: `acquire()` trong handler click "Bắt đầu ghi" (cần user gesture), lưu sentinel vào `recording-store`; lắng nghe `visibilitychange` + `sentinel.onrelease` để xin lại khi tab hiện lại; `release()` ở pause/End/lỗi; `NotAllowedError`/`undefined navigator.wakeLock` → bật `keep-awake-notice.tsx`. Test: mock `navigator.wakeLock` (acquire/release/re-acquire sau `visibilitychange`), và nhánh không hỗ trợ hiện notice.
4. `realtime-client.ts` (factory) + `soniox-realtime-client.ts` (option camelCase + `stream`, map token → `CaptionEvent` + `LiveTurn[]`) + `elevenlabs-realtime-client.ts` (`Scribe.connect({token, microphone:false, stream})`, map `PARTIAL_TRANSCRIPT`/`COMMITTED_TRANSCRIPT` → `CaptionEvent`, **không phát `LiveTurn`**). Cả hai: `onStarted` → offset, backoff reconnect với token mới, roll phiên ~280 phút, mọi close/error = kết thúc phiên. Test: draft bị thay bởi final cùng id; `speaker` namespace theo `sessionIndex`; token `translation_status` không lọt vào `LiveTurn`; wrapper ElevenLabs **luôn** trả `capabilities.speakerLabels=false`.
4b. `translate-buffer.ts`: gom dòng final, bỏ dòng đã ở ngôn ngữ đích, flush 3-5 s, gọi `meeting_translate`, gán theo `id`; chỉ bật khi `!capabilities.translation`. Test thuần cho gom/flush/bỏ qua/lỗi.
5. `live-speaker-poll.ts`: poll `meeting_live_speakers` 3-5s trong lúc ghi, áp `speakerMap` lên toàn bộ `lines` đã render (relabel lùi, không đổi text); dừng poll khi rời `recording`. Test: map tới sau khi dòng đã render → badge đổi, `text` không đổi.
6. `meeting-folder.ts`: tìm/ tạo `Meetings` rồi folder con **`<yyyy-mm-dd>-<slug>-<meetingId8>`** — idempotent theo tên, và tên đã mang `meetingId8` nên hai cuộc họp trùng ngày/tiêu đề không dùng chung thư mục.
7. `meeting-part-upload.ts`: `partName(seq, meetingId8)` = `audio.part-NNNN-<meetingId8>.webm`, `uploadPart` (base64 + **`duplicateAction:'keep_both'`**), `listParts`; upload xong → `meeting_chunk_ready {roomId, meetingId, seq, durationMs, segments}` (retry cùng chính sách, lỗi chỉ log — **không** làm hỏng nhánh lưu trữ). Test: đặt tên có `meetingId8`, thứ tự, đường retry, "chunk_ready lỗi không chặn part sau", và **không** bao giờ gửi `duplicateAction:'replace'`.
8. `meeting-draft-repository.ts`: `createMeeting`, `updateRecordingMeeting` (gồm `lastPartAt` + provider đã chốt trong `sttSessionMeta`), `addBookmark`, `listActiveRecording`. 9. `recording-store.ts`: state machine idle→recording→paused→ending→uploading→done/error; timer 1s; ghép caption draft→final; theo dõi `pendingParts`, `clockSkewMs`, `capacity`, `capabilities`.
10. Màn `new-meeting-screen.tsx`: form title, select ngôn ngữ, tên phòng + tên provider (chỉ đọc), nút "Bắt đầu ghi"; `NotAllowedError` mic → hướng dẫn cấp quyền. 11b. `capacity-notice.tsx` khi `captionStatus==='capacity'`; `degraded-labels-notice.tsx` khi `!capabilities.speakerLabels`.
11. Màn 1a `live-screen.tsx` (light): topbar title editable + meta "17 Sep 2026 · From 09:30 · N speakers" (N = số `speakerKey`, "—" ở degraded mode), toggle Transcript/Stage, REC + timer, list caption (badge tên/`Người nói N`/"Đang nói" + màu, mm:ss, nút bookmark), side panel 340px 3 tab Summary/Action items/Bookmarks (empty-state "Có sau khi kết thúc"), footer controls.
12. Màn 1b Stage (dark): full-bleed navy, 3 lớp caption (history 32%/60% opacity + dòng hiện tại 30/38/46px theo `stageCaptionSize`), con trỏ nhấp nháy, nhãn ngôn ngữ (từ token `language`) + "Soniox · trạng thái", chip màu người nói, thanh điều khiển nổi blur, nút gradient vàng "End & summarize". Trạng thái `capacity` → hiện dải "Phụ đề trực tiếp tạm không khả dụng — bản ghi vẫn chạy".
13. "End & summarize": stop recorder (flush part cuối + `meeting_chunk_ready` cuối) → `soniox.stop()` (chờ SDK flush) → đợi hàng đợi upload cạn (có nút "thử lại" nếu còn part) → update `meetings` (`endedAt`, `durationSec`, `partCount`, `sttSessionMeta`, `status:'uploading'`) → gọi `meeting_process {roomId, meetingId}` (P3 chưa có ⇒ `try/catch` log; P3 nối tiếp).
14. `recovery-banner.tsx`: khi mount app, query `meetings` có `status ∈ {'recording','interrupted'}` && không `endedAt` → banner "Khôi phục bản ghi chưa hoàn tất (N part)" với 2 nút "Hoàn tất & xử lý" (đặt `endedAt` từ part cuối rồi gọi `meeting_process`) / "Huỷ" (xoá part + `status:'failed'`).
15. Thêm chuỗi i18n vi/en cho toàn bộ UI mới.
16. Chạy `npm run typecheck && npm test`; test tay: ghi 5 phút + refresh giữa chừng (recovery); **test dài 60 phút** với 10 phút mạng bị bóp: bộ nhớ tab phẳng, **ghi âm không dừng**, part lên đủ sau khi mạng về, caption tự nối lại, nhãn giữ đúng qua reconnect, `clockSkewMs` cuối ≤ 1.5 s.

## Todo

- [ ] Tool `meeting_realtime_token` (chọn provider, mint token đúng loại, trả `capabilities`; authz owner + budget 30/h + trần đồng thời) + test cả hai nhánh
- [ ] `elevenlabs-realtime-token.ts` (single-use `realtime_scribe`) + `soniox-realtime-token.ts` + tool `meeting_chunk_ready` (vỏ nhận + validate; hàng đợi ở P5) + khai manifest
- [ ] `hub/hub-ai-client.ts` (P6 dùng lại) + tool `meeting_translate` (rate-limit theo meeting) + khai manifest
- [ ] `part-upload-queue.ts` (backoff cap 30s, cửa sổ 15 phút, trần 20 part) + test mạng hỏng 10 phút; `meeting-clock.ts` (`recorderEpochMs`, offset ở `onStarted`, `clockSkewMs` resync mỗi part, `measuredPartMs`, `turnsInPart` giữ turn chưa final + loại token dịch) + test
- [ ] `realtime-client.ts` factory + hai wrapper (Soniox / ElevenLabs không nhãn-không dịch) + reconnect/roll-session + `translate-buffer.ts` (chỉ khi `!capabilities.translation`) + test
- [ ] Degraded QĐ-18 (`!capabilities.speakerLabels` → không `chunk_ready`, không poll, dải thông báo ở 1a/1b) + `live-speaker-poll.ts` relabel lùi badge + test
- [ ] `screen-wake-lock.ts` + `keep-awake-notice.tsx` (acquire trong gesture, re-acquire sau `visibilitychange`, release ở pause/End; fallback notice) + test mock `navigator.wakeLock`
- [ ] `media-recorder-service.ts` (start/pause/resume/stop, thả blob ngay) + `meeting-folder.ts` find-or-create idempotent
- [ ] `meeting-part-upload.ts` (`partName` có `meetingId8`, `keep_both`, `listParts`) + gọi `meeting_chunk_ready` sau mỗi part (khi provider có nhãn) + test
- [ ] `meeting-draft-repository.ts` + `recording-store.ts` (state machine, timer, `capabilities`)
- [ ] Màn `new-meeting-screen.tsx` (hiện provider) · 1a `live-screen.tsx` (light) · 1b stage dark + `stageCaptionSize`
- [ ] Flow "End & summarize" (stop → flush part cuối → update DB → `meeting_process`) + `recovery-banner.tsx` cho `status ∈ {'recording','interrupted'}`
- [ ] i18n vi/en ("đang chờ mạng", "phụ đề tạm không khả dụng", "Nhãn người nói sẽ có sau khi xử lý")
- [ ] typecheck + test + thử tay 5 phút có refresh + test dài 60 phút có bóp mạng, **chạy một lần cho mỗi provider**

## Success Criteria

- [ ] `npm run typecheck` và `npm test` xanh; `dist/manifest.json` có `meeting_realtime_token` + `meeting_chunk_ready` + `meeting_translate`
- [ ] **Provider = soniox**: ghi 5 phút → caption < 1s **kèm badge `Người nói N`** đổi đúng khi đổi người; bật song ngữ → bản dịch về cùng luồng token (không gọi Hub AI lúc live)
- [ ] **Provider = elevenlabs**: caption < 1s **không nhãn**, dải "Nhãn người nói sẽ có sau khi xử lý"; **không** lời gọi `meeting_chunk_ready`/`meeting_live_speakers` nào; bật song ngữ → bản dịch điền sau 3-5s qua `meeting_translate`
- [ ] Đổi `app_settings.sttRealtimeProvider` rồi bắt đầu cuộc họp mới → dùng đúng provider mới **không cần republish manifest, không cần restart app**
- [ ] Provider có nhãn: mỗi part upload xong → `meeting_chunk_ready` gọi đúng 1 lần với `durationMs` đo được và `segments` phủ đúng cửa sổ part, **gồm cả turn chưa final** ở cuối part
- [ ] Ngắt WS rồi nối lại → `sttSessionMeta.sessions` có mục mới kèm `clockSkewMs`, nhãn **không** trộn giữa hai phiên; không có `AudioWorklet`/`sendPcm`/`bufferedAmount`/config tự chế trong `src/` (grep)
- [ ] Hai cuộc họp cùng phòng, **cùng ngày, cùng tiêu đề**, ghi song song → hai thư mục riêng, part không đụng nhau, không part nào bị `replace`
- [ ] Ngắt mạng **10 phút** → badge "Caption tạm ngắt" + "đang chờ mạng N phút", **ghi âm không dừng**, mạng về → part lên đủ đúng thứ tự; test 60 phút: bộ nhớ tab phẳng, `clockSkewMs` cuối ≤ 1.5 s
- [ ] Refresh tab giữa lúc ghi → banner khôi phục, mất ≤ 1 timeslice; sau "End & summarize" folder đủ part, `partCount` và `durationSec` khớp (±2s)
- [ ] Người dùng KHÔNG phải owner gọi `meeting_realtime_token` / `meeting_chunk_ready` → bị từ chối; quá 30 lần/giờ → bị từ chối; đã đủ `LIVE_MAX_CONCURRENT_RECORDINGS` phiên → **từ chối có thông báo tiếng Việt và ghi âm vẫn chạy**
- [ ] Bookmark hiện đúng mm:ss; **không** token nào xuất hiện trong log hay `localStorage`
- [ ] **Màn hình không tắt khi đang ghi**: trên Hub đã cấp `allow="screen-wake-lock"` → ghi 20 phút không chạm chuột, màn hình vẫn sáng, `wakeLock` sentinel `released === false`; chuyển tab rồi quay lại → sentinel được xin lại. Hub chưa cấp → `keep-awake-notice` hiện ngay khi bắt đầu ghi và ghi âm vẫn chạy bình thường.

## Risk Assessment

| Risk | Signal | Response |
|---|---|---|
| SDK không nhận `MediaStream` của ta (phát hiện muộn) | Wrapper không dựng được | Đã chốt ở spike P1-10/P1-11 **trước** khi viết P2; nếu vẫn hỏng → phương án dự phòng QĐ-01 (WS thô + `ScriptProcessorNode`), báo người dùng |
| `translation:two_way` không sống chung với diarization | Spike P1-8 thấy `speaker` rỗng khi bật dịch | **Giữ diarization**, chuyển dịch live sang `meeting_translate` (QĐ-18) — đường này đã cài sẵn cho ElevenLabs nên không tốn thêm việc |
| Hai wrapper realtime lệch hành vi (timestamp, final, reconnect) | Nhãn/dịch chỉ sai ở một provider | Cùng interface `RealtimeConnection` + **cùng bộ test hợp đồng** chạy cho cả hai; khác biệt duy nhất được phép là `capabilities` |
| WS bị CSP chặn | Console `Refused to connect` | `_meta.ui.csp.connect-src` phải có `wss://stt-rt.soniox.com` (+ `PRIVOS_FILES_ORIGIN`); kiểm `csp` nằm **trong** `_meta.ui`; verify sau mỗi lần sửa manifest + `manifest:lint` |
| Hub chưa cấp `allow="screen-wake-lock"` cho iframe → màn hình tắt, OS mobile có thể ngắt mic | `wakeLock.request` ném `NotAllowedError` trong room tab | Ticket Hub (thêm `screen-wake-lock` vào `buildSandboxAttrs`/`allow`); tạm thời `keep-awake-notice` + hướng dẫn tắt sleep; test nhánh ghi khi tab ẩn trên desktop |
| Token hết hạn giữa họp dài | WS đóng sau TTL | Token chỉ dùng lúc connect; reconnect luôn mint mới — không cache |
| Cap phiên (300 phút với Soniox; ElevenLabs chưa rõ) | Socket đóng gần mốc | Roll chủ động ~280 phút + `max_session_duration_seconds`; **mọi** close/error đi chung một đường xử lý |
| Hết slot WS toàn workspace | `meeting_realtime_token` từ chối | Thông báo rõ, ghi âm vẫn chạy, nhãn đến từ pass async sau họp |
| Nhãn `speaker` nhảy trong 10-20s đầu mỗi lượt | Badge đổi liên tục | Chỉ hiện `Người nói N` khi live (không hiện tên đoán); tên thật đến từ P5 sau ~70-90s; pass async là nguồn sự thật |
| Token đã `is_final` bị đổi `speaker` (chưa được vendor xác nhận) | Spike P1-8 thấy `speaker` đổi | Đã có sẵn đường relabel lùi của `live-speaker-poll`; chỉ cần cho phép cập nhật `speakerKey` của dòng cũ, không viết lại text |
| Part vượt ngưỡng base64 của `uploadFile` | Upload part lỗi | `PART_MS` chốt từ spike P1-2; nếu blob vẫn quá lớn thì giảm timeslice động (đo kích thước part trước) |
| Upload part thất bại kéo dài | Hàng đợi chờ đầy dần | Retry backoff tới `LIVE_UPLOAD_RETRY_WINDOW_MIN`, UI báo sớm; chạm trần 20 part → dừng ghi có báo trước, giữ blob để thử lại tay; KHÔNG âm thầm ghi tiếp vào khoảng trống |
| Tab đóng khi đang upload part cuối | Meeting kẹt `recording` | Sweep server đánh dấu `interrupted` khi `lastPartAt` cũ > 10 phút (P3/P8); recovery banner hoàn tất từ part đã có |
| Đồng hồ lệch làm P5 cắt nhầm đoạn audio | `clockSkewMs` vượt 1.5 s | Resync mỗi part; vượt dung sai → `approxClock`, P5 bỏ embedding chunk đó thay vì embed nhầm |
| Người dùng đổi provider giữa lúc đang ghi | Caption đứt, `capabilities` lệch | Provider **chốt theo cuộc họp** lúc mint token đầu, lưu vào `sttSessionMeta`; đổi Settings chỉ ảnh hưởng cuộc họp sau |
