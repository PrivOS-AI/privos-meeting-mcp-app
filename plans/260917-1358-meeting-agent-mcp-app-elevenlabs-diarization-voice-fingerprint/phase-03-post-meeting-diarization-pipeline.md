---
phase: 3
title: "Phase 3: Post-meeting diarization pipeline"
status: code-complete-deterministic
priority: P1
effort: "4d"
dependencies: [2]
---

# Phase 3: Post-meeting diarization pipeline

## Overview

Job nền trong tiến trình app (pm2, không Redis) biến các **part file** đã upload thành transcript có nhãn người nói. Toàn bộ job chạy bằng **installation-bot credential** qua `src/server/hub/bot-tool-call.ts` (P1): tải `audio.part-NNNN-<meetingId8>.webm` theo thứ tự → byte-concat thành `audio.webm` → xoá part → **async provider đang chọn** → gom token thành segments → ghi `transcript.json/.md/.srt` lên Files → ghi kết quả vào App DB.

Hai cài đặt async sau **cùng** interface `SttProvider` (QĐ-03/QĐ-15):
- **`soniox-async`** (`stt-async-v5`): upload `audio.webm` **nguyên webm/opus, không transcode** → tạo transcription (`enable_speaker_diarization`, `enable_language_identification`, `language_hints`) → poll tới `completed` → `tokens[]` có `speaker`/`language`.
- **`elevenlabs-batch`** (`scribe_v2`): cần **wav 16k mono đã decode** → `speechToText.convert({ file, model_id, diarize:true, diarization_threshold: env.ELEVENLABS_DIARIZATION_THRESHOLD, timestamps_granularity:'word', tag_audio_events:true, language_code? })` → `words[]` `{text, type:'word'|'spacing'|'audio_event', start, end, speaker_id, logprob}` → `mapWordsToTokens()` đưa về cùng `SttToken`.

Decode wav 16k mono (`@ffmpeg-installer/ffmpeg`) **luôn** cần cho embedding (P4/P5), và là **đầu vào bắt buộc** của `elevenlabs-batch` → với provider đó bước `decode` chạy **trước** bước `transcribe`.

Hàng đợi **copy `~/projects/genealogy-privos-mcp-app/src/server/export/render-queue.ts`** (`RenderQueue`) thay vì tự viết, có thêm `AbortController` xuyên suốt (ffmpeg child `kill`, fetch `signal`) để timeout thật sự huỷ được công việc, và `Set<meetingId>` in-flight chặn chạy đôi.

**Không có file job state cục bộ.** Collection `processing_jobs` (App DB, room scope) là nguồn sự thật, idempotent theo `meetingId`, có `heartbeatAt` để phát hiện job chết. `MEETING_DATA_DIR` chỉ chứa file tạm khi decode.

Pass async này là **nguồn sự thật** cho transcript lưu (QĐ-03) bất kể nhà cung cấp nào; nhãn live của P5 chỉ phục vụ UI lúc họp và được **reconcile** vào đây bằng max time-overlap.

Phase này chưa làm voiceprint (P4), live naming (P5) và tóm tắt (P6); job để sẵn ba hook rỗng đúng vị trí. UI có màn "Đang xử lý" với tiến độ theo bước.

## Requirements

**Functional**
- Tool `meeting_process {roomId, meetingId}` — **không nhận fileId từ client**. Authz fail-closed: `context.actor` && `identityState === 'verified'`; `meetings.roomId === args.roomId === actor.roomId`; `ownerUserId === actor.userId`. Job đọc `partFileIds` từ `meetings` và kiểm `channel_id === roomId` trên metadata **từng file** trước khi tải.
- Tool `meeting_status` → `{ status, step, progress, heartbeatAt, stale, error?, result? }` (`stale = now - heartbeatAt > 2 × chu kỳ heartbeat`); tool `meeting_summarize` (P6 cài logic) chạy lại riêng bước tóm tắt từ `transcript.json`.
- **Idempotent:** `processing_jobs` unique `{meetingId:1}` + `Set<meetingId>` in-flight. Gọi lại cùng `meetingId`: đang chạy → trả job hiện tại; `completed` → kết quả cũ; `failed`/`stale` → reset và chạy lại.
- Job ghi `status`/`step`/`progress`/`heartbeatAt` sau mỗi bước; `result` vào `resultJson`. Timeout `MEETING_JOB_TIMEOUT_MS` (1h) → abort thật (kill ffmpeg, abort fetch) → `failed`, dọn file tạm.
- Xoá `audio.webm` khi `keepAudio === false` **chỉ sau khi tóm tắt thành công**. UI: màn processing 8 bước, poll `meeting_status` mỗi 3s; `stale` → "Job đã dừng" + nút "Xử lý lại".
- Khôi phục sau restart: boot sweep qua `knownRooms` + sweep trong `meeting_bootstrap` — job `queued` nạp lại hàng đợi; job `processing` quá hạn heartbeat → `failed(interrupted)`; **meeting kẹt `recording`** với `lastPartAt` cũ > 10 phút → `status='interrupted'` (giữ part, chủ sở hữu thấy banner "Khôi phục"/"Xử lý"); rác remote của job chết bị xoá.

**Non-functional**
- 1h audio xử lý xong < 10 phút trên hodao — **thời gian quay vòng async chưa có tài liệu ở cả hai nhà cung cấp**, spike P1-9 đo trước; vượt thì nới ngưỡng và ghi lại, không rút ngắn bằng cách bỏ bước.
- File tạm trong `MEETING_DATA_DIR/tmp/<jobId>/`, luôn xoá ở `finally`. Ghép part + decode theo stream — **không bao giờ** giữ cả cuộc họp trong RAM; đưa file cho provider bằng `fs.createReadStream`.
- Giới hạn kích thước/thời lượng file async **chưa có tài liệu ở cả hai nhà cung cấp** — số đo từ spike P1-9 quyết định có phải chia audio dài rồi ghép theo offset; `splitForProvider(durationSec, provider)` trả 1 phần khi chưa cần.
- Mọi lỗi ghi log có `jobId`, `meetingId`, `step`, stack (không log id phía Soniox ra response MCP).

## Architecture

### Job state (App DB, không có file cục bộ)

```ts
// src/server/jobs/job-repository.ts — mọi truy cập qua AppDbBotClient (P1)
export type JobStep = 'download'|'decode'|'transcribe'|'segment'|'embed'|'summarize'|'write'|'cleanup';
export interface JobRecord {
  _id: string; jobId: string; meetingId: string; roomId: string;
  partFileIds: string[]; audioFileId?: string;      // file đã ghép, có sau bước concat
  sttProvider: 'soniox-async' | 'elevenlabs-batch';  // chốt lúc enqueue, không đổi giữa job
  providerFileId?: string; providerTranscriptionId?: string;   // Soniox: ghi NGAY khi tạo (dọn rác + nối lại)
  language: string; title: string; keepAudio: boolean;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  step: JobStep | null; progress: number;            // 0..1
  error?: string; startedAt: string; heartbeatAt: string; finishedAt?: string;
  result?: JobResult;                                 // lưu ở cột resultJson
}
export interface JobResult {
  durationSec: number; languageCode: string; sttProvider: string;
  speakers: Array<{ speakerId: string; totalSpeakSec: number; sampleSec?: number; displayName?: string;
    profileId?: string; confidence?: number; resolved?: boolean; liveSessionSpeakerId?: string;
    sampleRange?: { startSec: number; endSec: number } }>;   // KHÔNG chứa vector
  fileIds: { transcriptJson: string; transcriptMd: string; srt: string; summary?: string };
  summary?: SummaryPayload;          // P6
}
// findByMeeting · claim · patch · finish · fail · sweepStale(olderThanMs) · listQueued(roomId)
```

Một vitest so khớp `src/shared/app-db-schema.ts` với `JobRecord`/`MeetingRecord` (mọi field TS phải có trong schema và ngược lại) — chặn tái diễn lỗi "ghi/lọc trường chưa đăng ký".

### Queue (copy `render-queue.ts` của gia-pha)

`src/server/jobs/meeting-queue.ts` = `RenderQueue` copy từ `~/projects/genealogy-privos-mcp-app/src/server/export/render-queue.ts`, thêm:
- `AbortController` per job → `signal` vào mọi `fetch` (download / STT provider / Hub AI) + giữ ffmpeg child để `kill('SIGKILL')` khi abort: timeout **thực sự dừng công việc**, không chỉ reject promise.
- `inFlight = new Set<string>()` theo `meetingId` — `enqueue` trả job hiện tại thay vì xếp thêm; heartbeat interval `patch(heartbeatAt)` best-effort.

Boot: `startupSweep()` đọc `app_settings.knownRooms` → mỗi phòng `listQueued` (nạp lại hàng đợi) + `sweepStale` (job `processing` quá hạn → `failed(interrupted)`). `meeting_bootstrap` lặp lại sweep cho phòng đang mở.

### Ghép part

`concat-parts.ts` — `concatParts(hub, parts, destPath, signal)`: sort theo `seq` → assert dãy liên tục 1..n (thiếu → `AppError "Bản ghi thiếu phần N"`) → **kiểm từng part** (`fileId` ∈ `processing_jobs.partFileIds` và tên mang đúng dấu `<meetingId8>`) → download stream, append vào `destPath` → upload `audio.webm` → **chỉ xoá `fileId` đã ghi trong `partFileIds`**, không quét thư mục. P5 dùng lại ở chế độ **cửa sổ**.

### Download qua bot credential

`hub-file-download.ts`: `downloadRoomFile(hub, fileId, destPath, signal)` → `authorizedFetch('/api/v1/file-management.files/<id>/download', {signal})` → `pipeline(...)`. Trước khi tải: `assertFileInRoom(fileId, roomId)`. "not member" → thông báo tiếng Việt kèm gợi ý thêm bot.

### Decode

`decode-audio.ts`: `decodeToWav16k(input, output, signal)` spawn `ffmpeg -hide_banner -i in.webm -vn -ac 1 -ar 16000 -c:a pcm_s16le out.wav` (giữ handle child để `kill` khi abort) → `{ durationSec }`; `readWavPcm(path, from, to) → Float32Array`. Parse `Duration:` từ stderr, không được thì tính từ kích thước wav. Dùng cho embedding (mọi job) **và** làm đầu vào của `elevenlabs-batch`.

### STT provider interface (P1 đã dựng vỏ) + hai cài đặt async

```ts
// src/server/stt/stt-provider.ts — MỘT interface, HAI cài đặt async (QĐ-15)
export interface SttToken { text: string; startMs: number; endMs: number;
  speaker?: string; language?: string; confidence?: number }
export interface SttResult { tokens: SttToken[]; languageCode?: string; durationSec?: number; providerJobId?: string }
export interface SttProvider {
  readonly name: 'soniox-async' | 'elevenlabs-batch';
  readonly wants: 'webm' | 'wav16k';        // job biết phải đưa file nào cho provider
  transcribeFile(input: { filePath: string; mimeType: string; languageHints: string[];
                          signal: AbortSignal; onProgress?: (p: number) => void }): Promise<SttResult>;
}
// src/server/stt/stt-provider-registry.ts — asyncProvider() đọc app_settings.sttAsyncProvider ?? env
```

```ts
// src/server/stt/soniox-async-provider.ts   (wants: 'webm')
// 1. POST /v1/files (multipart, createReadStream) → { id }   2. POST /v1/transcriptions
//    { file_id, model: env.SONIOX_ASYNC_MODEL, language_hints:['vi','en'],
//      enable_speaker_diarization: true, enable_language_identification: true } → { id, status }
//    → ghi providerFileId/providerTranscriptionId vào processing_jobs NGAY (trước lần poll đầu)
// 3. poll GET /v1/transcriptions/{id} (backoff 2s→10s, tôn trọng signal) tới 'completed' | 'error'
// 4. GET .../transcript → tokens[] → mapToken() (tên trường thật từ spike P1-9, câu hỏi mở #2)
// 5. cleanup DELETE file + transcription bằng **AbortSignal MỚI** (timeout riêng ~15s) — KHÔNG kế
//    thừa signal của job.  6. retry: tra theo client_reference_id TRƯỚC khi upload lại (không
//    tải lại 40MB, không bị tính tiền lần hai)
```

```ts
// src/server/stt/elevenlabs-batch-provider.ts   (wants: 'wav16k')
// new ElevenLabsClient({ apiKey: env.ELEVENLABS_API_KEY }).speechToText.convert({
//   file: createReadStream(wavPath), model_id: env.ELEVENLABS_BATCH_MODEL,      // scribe_v2
//   diarize: true, diarization_threshold: env.ELEVENLABS_DIARIZATION_THRESHOLD,
//   timestamps_granularity: 'word', tag_audio_events: true, ...(languageCode && { language_code }) })
// → { text, language_code, audio_duration_secs, words[] };  mapWordsToTokens(): bỏ type==='spacing'
//   khi tính biên, giữ audio_event dạng "[laughter]", speaker_id→speaker, logprob→confidence, s→ms
// Một lời gọi đồng bộ có stream file — KHÔNG upload/poll/cleanup remote
```

Retry 3 lần backoff cho 5xx/timeout (truyền `signal`) ở **cả hai** provider; 4xx fail ngay kèm message của nhà cung cấp. Bước dọn rác remote (`providerFileId`/`providerTranscriptionId`) chỉ áp dụng cho `soniox-async`. `startupSweep` liệt kê file/transcription phía Soniox của các job `failed`/`interrupted` (tra theo `client_reference_id`) và **xoá rác** — audio cuộc họp không được nằm lại ở vendor vì job chết giữa chừng. Webhook (`webhook_url`) **không dùng ở v1** — app chạy sau Hub, không chắc có URL public; poll là đường duy nhất, ghi rõ trong docs.

### Segment builder

`src/server/transcript/segment-builder.ts`: `Segment { id, speakerId, startSec, endSec, text, translation?, lang, tokenCount, avgConfidence }`; `buildSegments(tokens: SttToken[], { pauseSplitSec: 1.5 })` — **một** builder cho cả hai provider vì cả hai đã quy về `SttToken`. Quy tắc: cắt segment mới khi (a) `speaker` đổi, (b) `language` đổi, hoặc (c) khoảng lặng giữa 2 token cùng speaker > `pauseSplitSec`. `lang` của segment = `language` chiếm đa số token (QĐ-12 dùng để bỏ qua dịch); ElevenLabs không trả `language` theo token → `lang` lấy từ `language_code` của cả file. Ghép segment < 0.3s vào segment liền trước cùng speaker; token thiếu `speaker` → gán vào speaker của token liền trước.

### Writers

`transcript-json.ts` → `{ version: 2, meetingId, title, startedAt, durationSec, languageCode, translationLang?, provider: 'soniox-async'|'elevenlabs-batch', speakers: [{ speakerId, totalSpeakSec, displayName: null }], segments: Segment[], tokens: SttToken[] }` (`displayName` điền ở P4, `translation` ở P6). `markdown-writer.ts`: `# <title>` + meta + `## [HH:MM:SS] <displayName ?? speakerId>` + đoạn text. `srt-writer.ts`: một cue/segment, cue > 7s chẻ theo ranh giới token, format `HH:MM:SS,mmm`.

### Tools

`meeting_process` / `meeting_status` / `meeting_summarize` cùng một shape: `inputSchema: { type:'object', required:['roomId','meetingId'], properties: { roomId:{type:'string'}, meetingId:{type:'string'} } }`.

`src/server/tools/authz.ts` (dùng cho MỌI tool backend): `requireVerifiedActor(context)` — thiếu `actor` hoặc `identityState !== 'verified'` → `AppError('Không xác thực được người gọi.')`, chỉ bỏ qua khi `NODE_ENV !== 'production' && ALLOW_UNVERIFIED_ACTOR === '1'`. `requireMeetingOwner(db, actor, roomId, meetingId)` — `meeting.roomId === roomId === actor.roomId && ownerUserId === actor.userId`. `assertFileInRoom(fileId, roomId)` — đọc metadata, so `channel_id`.

Bot credential bỏ qua ranh giới thành viên của người dùng → kiểm actor là **bắt buộc**, và mọi fileId phải được suy ra từ dữ liệu đã lưu rồi kiểm `channel_id === roomId`, không bao giờ nhận từ client.

### Hook cho P4/P5/P6

```ts
// src/server/jobs/meeting-job.ts
const p        = sttRegistry.asyncProvider();               // app_settings ?? env
const stt      = await p.transcribeFile({ filePath: p.wants === 'wav16k' ? wavPath : webmPath, ... });
const segments = buildSegments(stt.tokens);
const speakers = await resolveSpeakers(db, wavPath, segments);        // P4 — embed + cosine ở backend; nay trả [] + totalSpeakSec
await reconcileWithLiveSpeakers(db, meetingId, segments, speakers);   // P5 — nay no-op
const summary  = await summarizeTranscript(segments, language);       // P6 — nay trả undefined
```

### Reconciliation hook cho P5

`src/server/transcript/caption-aligner.ts` (tạo ở phase này, P5 dùng lại): `alignByMaxOverlap(a, b, { toleranceMs: 1500, skewMs })` — với mỗi span của `a`, chọn span của `b` có **tổng thời gian giao nhau lớn nhất** sau khi bù `clockSkewMs`, cho phép lệch biên ±1.5 s; hoà → span dài hơn thắng.

Nguồn span live là **`live-turns.json`** trong thư mục cuộc họp (P5 nối thêm sau mỗi part) — **không** phải bộ nhớ tiến trình, để reconcile vẫn chạy sau restart. Reconcile: pass async tạo hàng `meeting_speakers` theo `speakerId` của nó, rồi **gộp** vào hàng live tương ứng (một người = một hàng), điền `liveSessionSpeakerId`. **Segmentation của pass async luôn thắng** cho transcript lưu; riêng **tên** theo thứ tự ưu tiên `nameSource`: **người xác nhận (`user`) > async > live**. Mâu thuẫn được log, không im lặng bỏ.

## Related Code Files

**Create**
- `src/server/jobs/{job-repository,meeting-queue (copy `render-queue.ts`),meeting-job,startup-sweep,meeting-repository}.ts`; `tools/authz.ts`
- `src/server/media/{hub-file-download,concat-parts,decode-audio}.ts`; `src/server/transcript/{segment-builder,transcript-json,markdown-writer,srt-writer,caption-aligner}.ts`
- `src/server/files/hub-file-upload.ts` (upload text artifact bằng bot credential; copy pattern gia-pha)
- `src/server/tools/{process,status,summarize}-tool.ts` (summarize là vỏ, logic ở P6); `src/ui/screens/processing-screen.tsx`; `src/server/media/live-turns-store.ts` (P5 ghi — P3 đọc)
- Tests: `segment-builder`, `srt-writer`, `markdown-writer`, `job-repository`, `concat-parts`, `authz`, `schema-contract`, `caption-aligner`, `soniox-async-provider`, `elevenlabs-batch-provider`, `stt-provider-registry`

**Modify**
- `privos-app.json` + `src/server/manifest.ts` + `tools/index.ts` — thêm `meeting_process`, `meeting_status`, `meeting_summarize`; `src/server/index.ts` (gọi `startupSweep()` sau boot)
- `src/server/tools/bootstrap-tool.ts` (`sweepStale` + `listQueued` + sweep meeting bỏ rơi)
- `src/shared/app-db-schema.ts` (`processing_jobs.partFileIds/roomId/language/title/keepAudio/providerFileId/providerTranscriptionId`; `meetings.status:'interrupted'`)
- `src/server/env.ts` (biến job; `SONIOX_ASYNC_MODEL`, `ELEVENLABS_BATCH_MODEL`, `ELEVENLABS_DIARIZATION_THRESHOLD`, `STT_ASYNC_PROVIDER`); `src/server/stt/{soniox-async-provider,elevenlabs-batch-provider,stt-provider-registry}.ts` (P1 vỏ → cài thật)
- `src/ui/screens/live-screen.tsx` (End & summarize → `meeting_process` thật); `src/ui/app.tsx` (route `processing`); `src/ui/data/meeting-read-model.ts` (chỉ đọc)
- `package.json` (`@ffmpeg-installer/ffmpeg`, `@elevenlabs/elevenlabs-js`; Soniox async gọi bằng `fetch` thuần)

**Delete** — không có.

## Implementation Steps

1. Cài `@ffmpeg-installer/ffmpeg` + `@elevenlabs/elevenlabs-js`. Kiểm tra binary: `node -e "console.log(require('@ffmpeg-installer/ffmpeg').path)"`.
2. `authz.ts`: `requireVerifiedActor` (fail closed, dev bypass có điều kiện), `requireMeetingOwner`, `assertFileInRoom`. Test: thiếu actor / chưa verified / khác phòng / khác owner đều bị từ chối.
3. `job-repository.ts`: `claim/patch/finish/fail/findByMeeting/sweepStale/listQueued`. Test: claim 2 lần cùng `meetingId` → job cũ; `sweepStale` chỉ đụng `processing` quá hạn.
4. `meeting-queue.ts`: copy `render-queue.ts` + `AbortController` + `inFlight` + heartbeat; `startup-sweep.ts` nạp lại `queued`, dọn `stale`. Test: timeout abort thật, 2 lần enqueue cùng meeting → 1 lần chạy. 4b. `meeting-repository.ts`: `upsertMeeting`/`upsertMeetingSpeakers`/`replaceActionItems`, idempotent.
5. `hub-file-download.ts` (stream + `signal`) + `concat-parts.ts` (sort theo seq, kiểm dãy liên tục + dấu `meetingId8`, append stream, upload `audio.webm`, xoá đúng `partFileIds`). Test: thiếu part → lỗi rõ, đủ part → byte output khớp.
6. `decode-audio.ts`: spawn ffmpeg (giữ handle để abort) → wav pcm_s16le 1 kênh 16k, trả `durationSec`; `readWavPcm(path, from, to)` → `Float32Array`. Chạy cho **mọi** job (embedding) và là đầu vào của `elevenlabs-batch`.
7. `soniox-async-provider.ts` (`wants:'webm'`): upload file → create transcription (**ghi `providerFileId`/`providerTranscriptionId` vào `processing_jobs` ngay**) → poll → tokens → `mapToken()` (tên trường thật từ spike P1-9) → dọn file/transcription bằng **signal mới có timeout riêng**; retry tra theo `client_reference_id` trước khi upload lại. Test `fetch` giả: `completed`, `error`, **abort giữa lúc poll → cả hai DELETE vẫn gửi và trả 2xx**, retry không upload lại.
7a. `elevenlabs-batch-provider.ts` (`wants:'wav16k'`): `speechToText.convert` với `diarize`/`diarization_threshold`/`timestamps_granularity:'word'` + retry backoff + `signal`; `mapWordsToTokens()` (bỏ `spacing`, giữ `audio_event` dạng `[laughter]`, `speaker_id`→`speaker`, `logprob`→`confidence`, giây→ms). Test `mapWordsToTokens` trên fixture `words[]` thật: đổi speaker, `audio_event`, mảng rỗng, từ không có `speaker_id`.
7b. `stt-provider-registry.ts`: `asyncProvider()` đọc `app_settings.sttAsyncProvider` → env → throw nếu provider đó thiếu khoá (message nói rõ setting nào). Test: đổi setting → đổi cài đặt trả về; thiếu khoá → lỗi rõ ràng.
7b. `caption-aligner.ts` `alignByMaxOverlap` + unit test: giao nhau một phần, bao trọn, hoà (span dài hơn thắng), không giao nhau → không map.
8. `segment-builder.ts` + unit test: đổi speaker, đổi `language`, pause > 1.5s, token thiếu `speaker`, segment siêu ngắn, mảng rỗng — chạy trên fixture của **cả hai** provider.
9. `transcript-json.ts` / `markdown-writer.ts` / `srt-writer.ts` + unit test (snapshot nhỏ, format timestamp `00:01:02,500`). 10. `files/hub-file-upload.ts`: upload buffer text (`text/markdown`, `application/json`, `application/x-subrip`) vào `folderId` bằng `authorizedFetch` multipart; xử lý `DUPLICATE_FILE` → `duplicateAction:'replace'` (chạy lại job phải ghi đè, không nhân bản).
11. `meeting-job.ts`: orchestrate (concat → decode wav16k → transcribe **bằng provider đang chọn**, `wants` quyết định đưa webm hay wav → segment → embed(P4) → reconcile(P5) → summarize(P6) → write → cleanup), `patch(step, progress, heartbeatAt)` sau mỗi bước, kết thúc ghi `meetings` + `finish(result)`; `finally` xoá `tmp/<jobId>`; xoá `audio.webm` khi `keepAudio === false` **và** bước summarize đã thành công.
12. `process-tool.ts`: `requireVerifiedActor` + `requireMeetingOwner` + `assertFileInRoom` từng part → `findByMeeting` (idempotent) → chốt `sttProvider` vào job record → enqueue → `{ jobId }`.
13. `status-tool.ts`: authz thành viên phòng; trả `heartbeatAt` + `stale` + tên provider; lược trường nội bộ (không path tạm, không vector, **không** id job phía nhà cung cấp). `summarize-tool.ts` để vỏ tới P6.
14. `processing-screen.tsx`: 8 bước có icon trạng thái + progress + thời gian chạy; `stale` → "Job đã dừng, bấm Xử lý lại"; nút "Về History"; hiện **tên provider** đang xử lý.
15. `bootstrap-tool.ts` + `startupSweep()`: `sweepStale(10 * 60_000)` + `listQueued`; meeting kẹt `recording` (`lastPartAt` > 10 phút) → `interrupted`; xoá rác remote của job `failed`/`interrupted` theo `client_reference_id`.
16. `meeting-read-model.ts` (iframe chỉ đọc) + nối `live-screen.tsx` → `meeting_process` → route `processing` + poll.
17. `npm run typecheck && npm test`; e2e bản ghi 5 phút thật (nhiều part) cho **cả hai** async provider.

## Todo

- [ ] Cài + verify `@ffmpeg-installer/ffmpeg` + `@elevenlabs/elevenlabs-js`
- [ ] `authz.ts` (fail-closed, `requireMeetingOwner`, `assertFileInRoom`) + `job-repository.ts` (claim/patch/finish/fail/sweepStale/listQueued) + test
- [ ] `meeting-repository.ts` upsert meetings/speakers/action items qua bot credential
- [ ] `meeting-queue.ts` (copy `render-queue.ts` + AbortController + inFlight + heartbeat) + `startup-sweep.ts` + test
- [ ] `hub-file-download.ts` + `concat-parts.ts` (dãy part liên tục + kiểm dấu `meetingId8`) + `decode-audio.ts` (webm→wav16k, `readWavPcm`) + test
- [ ] `soniox-async-provider.ts` (upload → transcription → poll → map token → cleanup signal mới, lưu `provider*Id`, retry theo `client_reference_id`) + test
- [ ] `elevenlabs-batch-provider.ts` (`scribe_v2`, `diarize`, `diarization_threshold`, `words[]` → `mapWordsToTokens`) + test fixture words thật
- [ ] `stt-provider-registry.ts` `asyncProvider()` (app_settings → env → lỗi rõ khi thiếu khoá) + test
- [ ] `live-turns-store.ts` đọc `live-turns.json` cho reconcile; sweep meeting kẹt `recording` → `interrupted`; xoá rác Soniox của job chết
- [ ] `caption-aligner.ts` `alignByMaxOverlap` (±1.5 s + `skewMs`, dùng lại ở P5) + `segment-builder.ts` + test edge case cho **cả hai** provider
- [ ] `transcript-json.ts` / `markdown-writer.ts` / `srt-writer.ts` + test; `files/hub-file-upload.ts` (text artifact, replace on duplicate — **chỉ** cho artifact text, không cho part)
- [ ] `meeting-job.ts` orchestrate (`wants` quyết định webm/wav) + cleanup + xoá audio theo `keepAudio`; tool `meeting_process` (idempotent, chốt `sttProvider`) + `meeting_status` + `meeting_summarize` (vỏ) + khai manifest
- [ ] Vitest so khớp schema ↔ TS record types; `processing-screen.tsx` 8 bước + `stale` + retry; `bootstrap-tool.ts` thêm `sweepStale` + `listQueued`
- [ ] `meeting-read-model.ts` (iframe chỉ đọc) + nối `live-screen.tsx` → `meeting_process`
- [ ] typecheck + test + e2e 5 phút **cho cả hai async provider**

## Success Criteria

- [ ] `npm run typecheck` / `npm test` xanh (≥ 16 test: segment/srt/md/job-repository/job-queue/hai provider/registry/aligner)
- [ ] E2E 5 phút **cho mỗi async provider**: Files có `transcript.json/.md/.srt`; `.json` có `tokens[]` với `speaker` và `segments[]` khớp số speaker nghe được; `meetings` + `processing_jobs` do **backend** ghi (iframe không ghi)
- [ ] `soniox-async`: `audio.webm` gửi thẳng **không transcode**, file + transcription bị xoá sau job (kiểm `GET` trả 404) kể cả khi abort giữa lúc poll. `elevenlabs-batch`: nhận đúng wav 16k mono đã decode, `diarization_threshold` từ env có hiệu lực
- [ ] Đổi `app_settings.sttAsyncProvider` rồi chạy lại job → dùng đúng provider mới, `transcript.json` ghi `provider` tương ứng; hai provider cho cùng shape `segments[]`/`speakers[]` (test hợp đồng)
- [ ] Hai cuộc họp cùng phòng/ngày/tiêu đề: `concatParts` chỉ lấy part có đúng dấu `meetingId8` + đúng `partFileIds`, và **không** xoá file của cuộc họp kia (negative test)
- [ ] Gọi `meeting_process` 2 lần cùng `meetingId` → cùng một `jobId`, không chạy trùng
- [ ] Kill pm2 giữa lúc xử lý rồi start lại → `meeting_bootstrap` đưa job về `failed(interrupted)`, "Xử lý lại" chạy sạch, file không nhân bản
- [ ] Không có `data/jobs/`; `data/tmp/` rỗng sau mọi lần chạy (kể cả khi lỗi)
- [ ] `keepAudio=false` → `audio.webm` biến mất sau khi job xong; `keepAudio=true` → còn nguyên
- [ ] 1h audio xử lý < 10 phút trên hodao ở **cả hai** provider (đo bằng log `step` timestamps)

## Risk Assessment

| Risk | Signal | Response |
|---|---|---|
| ffmpeg binary thiếu quyền exec sau rsync | `EACCES` lúc spawn | `deploy-hodao.sh` chạy `chmod +x` đường dẫn binary; hoặc `npm install` trên node (tái tạo quyền) |
| Provider trả 429/5xx hoặc transcription `error` | Job `failed` với status code / message | Retry backoff 3 lần; quá thì `failed` + nút "Xử lý lại"; với Soniox luôn dọn file/transcription remote |
| Hai provider cho `segments[]` lệch shape (thiếu `language`, `speaker` khác kiểu) | P4/P5/P6 lỗi chỉ với một provider | `mapToken`/`mapWordsToTokens` quy hết về `SttToken`; **test hợp đồng chạy cho cả hai** trên cùng fixture audio |
| File vượt giới hạn async (chưa có tài liệu ở cả hai) | Lỗi upload với họp dài | Số đo từ spike P1-9 → `splitForProvider()` chia audio, ghép theo offset; chưa cần thì trả 1 phần |
| Tên trường token khác giả định | Parser trả mảng rỗng | Ánh xạ gói gọn trong `mapToken()`/`mapWordsToTokens()`; test dùng **JSON thật** từ spike làm fixture |
| Bot chưa vào phòng / credential sai | Lỗi "not member", tool-call 403 | `meeting_process` gọi `checkAgentBotCredential()` trước khi enqueue, fail sớm + nút "Thêm bot vào phòng" |
| Part bị xoá/đổi tên thủ công, hoặc lẫn part của cuộc họp khác | `concatParts` thấy dãy đứt hoặc dấu `meetingId8` sai | Fail rõ ràng, giữ nguyên part còn lại; chỉ xoá `fileId` đã ghi trong `partFileIds`; không quét thư mục, không đoán nội dung thiếu |
| Job chết giữa chừng → audio họp nằm lại ở Soniox và retry bị tính tiền hai lần | `GET` transcription cũ vẫn 200 sau khi job `failed` | `providerFileId`/`providerTranscriptionId` lưu ngay khi tạo; cleanup dùng signal riêng; boot sweep dọn rác; retry nối lại theo `client_reference_id` |
| Mất mạng tới Hub giữa job → `patch` heartbeat lỗi | Log lỗi tool-call, job vẫn chạy | `patch` best-effort; `sweepStale` dọn khi cần; `finish` retry 3 lần vì đó mới là ghi quan trọng |
| `tokens[]` 1h rất lớn (hàng chục nghìn phần tử) khiến `transcript.json` nặng | JSON > 10MB | Chấp nhận (Files chịu được); MCP response chỉ chứa fileId + speakers, không chứa transcript |
| Diarization gộp/tách sai người | Số speaker lệch thực tế | Soniox async **không** có tham số ngưỡng (chấp nhận kết quả vendor); `elevenlabs-batch` chỉnh được qua `ELEVENLABS_DIARIZATION_THRESHOLD`; P4 cho user gộp thủ công, P5 giữ nhãn đã gán giữa họp qua `caption-aligner` |
| Job chạy lại tạo file trùng tên | Files xuất hiện `transcript_1.json` | Artifact text (`transcript.*`, `summary.md`) dùng `duplicateAction:'replace'` — **chỉ** chúng; part audio luôn `keep_both` và có dấu `meetingId8` |
