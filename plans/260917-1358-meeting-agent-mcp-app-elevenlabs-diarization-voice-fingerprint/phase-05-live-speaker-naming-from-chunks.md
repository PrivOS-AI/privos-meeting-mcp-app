---
phase: 5
title: "Phase 5: Live speaker naming from chunks"
status: pending
priority: P1
effort: "3.5d"
dependencies: [3, 4]
---

# Phase 5: Live speaker naming from chunks

## Overview

Biến nhãn `Người nói N` (do realtime provider gán, chỉ có nghĩa trong một phiên WS) thành **tên thật** ngay trong lúc họp, trễ ~70-90s kể từ lúc nói. Không thêm luồng audio nào: chunk = **part file 60s mà P2 đã upload**.

**Điều kiện kích hoạt (QĐ-18):** phase này chỉ chạy khi realtime provider của cuộc họp có `capabilities.speakerLabels` (hiện tại: Soniox). Với `elevenlabs-realtime`, iframe **không** gọi `meeting_chunk_ready` và **không** poll — cuộc họp đó chạy ở **degraded mode**, nhãn người nói đến hoàn toàn từ pass async (P3) + matching (P4). Backend vẫn phải chịu được lời gọi lạc: `meeting_chunk_ready` cho meeting có provider không hỗ trợ → trả `{accepted:false, reason:'labels_not_supported'}` và bỏ qua, không lỗi.

Sau mỗi part, iframe gọi `meeting_chunk_ready {roomId, meetingId, seq, durationMs, segments[]}` mang **mọi** turn Soniox bắt đầu trong cửa sổ part — **kể cả turn chưa final** — trên đồng hồ họp (QĐ-17). Chunk worker ở backend (hàng đợi **tuần tự theo `meetingId`**, không dùng `RenderQueue`) dùng lại nguyên xi hạ tầng có sẵn: `concat-parts.ts` + `decode-audio.ts` (P3), `embedding-extractor.ts` + `speaker-matcher.ts` + `profile-store.ts` + `voiceprint-crypto.ts` (P4), `caption-aligner.ts` (P3). Với mỗi turn: cắt PCM → embedding → gom vào **session registry** theo nhãn Soniox → khi một người đã nói đủ `LIVE_MIN_SPEECH_SEC` thì so khớp với `speaker_profiles` của workspace → ghi `meeting_speakers`. Iframe poll `meeting_live_speakers` mỗi 3-5s và **sửa lùi** nhãn của các dòng caption đã hiện.

**Không có model diarization trên server** (QĐ-16): phân đoạn người nói đã do Soniox cung cấp, ta chỉ làm embedding + cosine. **Pass async của P3 vẫn là nguồn sự thật**; span nhãn live được backend nối vào `live-turns.json` (Files) để reconcile chạy được **sau cả khi tiến trình đã restart**.

Ba nguyên tắc an toàn chi phối toàn phase: (1) **nhãn Soniox là gợi ý, không phải danh tính** — mọi quan sát đều kiểm lại bằng embedding; (2) **span do client gửi phải được xác thực lại ở server**; (3) **lỗi chunk không được làm lệch đồng hồ** của các chunk sau.

## Requirements

**Functional**
- Tool `meeting_chunk_ready {roomId, meetingId, seq, durationMs, segments[{speaker, startMs, endMs, final}]}` (P2 tạo vỏ): authz owner + `meetings.status ∈ {'recording','uploading'}`; **xác thực span phía server** rồi enqueue và trả ngay `{accepted:true}`:
  - `startMs` phải nằm trong cửa sổ part `[partStart, partStart + durationMs]`; span nằm ngoài → bỏ + log sự kiện bảo mật;
  - các span cùng `speaker` **không được chồng lấn**; tổng thời lượng ≤ `durationMs`; số turn ≤ 200/part;
  - mỗi span phải có **năng lượng thật** (RMS trên ngưỡng im lặng; nâng lên `sherpa_onnx.Vad` nếu số đo cho thấy cần) — span trỏ vào khoảng lặng bị loại;
  - idempotent theo `(seq, speakerKey, startMs)`.
- Chunk worker cho mỗi `(meetingId, seq)`: tải part `seq` + **overlap** = `LIVE_CHUNK_OVERLAP_SEC` giây PCM cuối của chunk trước (ring buffer trong RAM) → decode wav 16k mono → với mỗi turn: cắt PCM theo `[startMs, endMs]` quy về offset trong chunk (có bù `clockSkewMs`), bỏ turn ngắn hơn `SPEAKER_MIN_SEGMENT_SEC` → `computeEmbedding`.
- **Turn vắt biên part được HOÃN, không bị bỏ**: turn có `endMs` vượt quá audio đã decode được của chunk hiện tại → ghi vào `deferred` của meeting và xử lý ở chunk `seq+1` trên cửa sổ `(đuôi 10 s của part trước + part hiện tại)`. Turn chưa final ở chunk `N` sẽ được gửi lại ở `N+1` dưới dạng đã final; dedupe theo `speakerKey+startMs` nên mỗi turn chỉ embed **đúng một lần**, bản final thắng bản nháp. Fixture `[58s, 63s]` phải qua.
- **Session registry** (`src/server/speaker/session-speaker-registry.ts`, in-memory theo `meetingId`): `sonioxSpeaker → sessionSpeakerId`, mỗi `sessionSpeakerId` giữ centroid động, `speechSec`, `turnCount`, `embeddings` gần nhất (cap 10).
  - **Xác minh mọi quan sát**: embedding mới luôn được so với centroid của session speaker đang gắn với nhãn đó. Dưới `SPEAKER_SESSION_MATCH_THRESHOLD` → **không** trộn vào; thử khớp với các session speaker khác, không khớp nữa thì mở **instance nhãn mới** `label@n` (ví dụ `s0:1@2`) gắn vào session speaker mới. Nhãn Soniox bị dùng lại cho người khác vì thế không bao giờ làm bẩn centroid.
  - **Gắn dính có điều kiện**: liên kết `nhãn → sessionSpeakerId` chỉ trở thành "dính" sau **≥2 lượt độc lập** và **≥ `LIVE_MIN_SPEECH_SEC`** giây nói; trước đó mỗi lượt đều được đánh giá lại từ đầu.
  - **Gộp (merge)**: sau mỗi lần cập nhật centroid, so với các session speaker khác; vượt `SPEAKER_SESSION_MERGE_THRESHOLD` → gộp (bên `speechSec` lớn hơn thắng), `sonioxLabels` hợp nhất → lần poll sau UI tự sửa lùi mọi dòng của cả hai nhãn. **Tách (split)** không tự động ở v1 — người dùng sửa tay bằng quick-assign.
- **Khớp profile:** khi một `sessionSpeakerId` đạt `speechSec ≥ LIVE_MIN_SPEECH_SEC` và chưa có `profileId`, chạy `matchSpeaker(centroid, profiles, SPEAKER_MATCH_THRESHOLD)` trên danh sách profile **đã giải mã một lần lúc bắt đầu meeting và cache trong RAM**. Khớp → `{profileId, displayName, liveConfidence, nameSource:'live'}`; không khớp → giữ `Người nói N` và thử lại mỗi khi `speechSec` tăng thêm ≥ 8s (tối đa 5 lần).
- **KHÔNG enrol lúc live**: embedding live chỉ để nhận diện. Enrol chỉ xảy ra qua `speaker_resolve` (P4) và chỉ khi cụm qua **cổng đồng nhất nội cụm** — cụm lưỡng đỉnh chỉ được đặt tên, không được ghi vào `speaker_profiles`.
- Ghi `meeting_speakers` (bot credential, merge theo trường): `sessionSpeakerId`, `sonioxLabels[]`, `profileId?`, `displayName`, `nameSource`, `liveConfidence`, `liveSpeechSec`, `liveUpdatedAt`, `colorKey`, `snapshotHash`, và `pendingEmbedding` = centroid **đã seal**. **Chỉ ghi khi `snapshotHash` đổi và tối đa một lần cho mỗi part** (chặn ghi thừa App DB).
- **Persist span live ra Files**: sau mỗi chunk, nối các `{sessionSpeakerId, startMs, endMs}` đã chốt vào `live-turns.json` trong thư mục cuộc họp (`live-turns-store.ts` của P3). Reconcile đọc file này, **không** đọc bộ nhớ tiến trình.
- Tool `meeting_live_speakers {roomId, meetingId}` → `{ sessionSpeakers[{sessionSpeakerId, sonioxLabels[], displayName, profileId?, liveConfidence?, liveSpeechSec, colorKey, resolved, mergedInto?}], degraded?, labelsSupported, updatedAt }`. Authz: thành viên phòng của meeting. **Không** trả vector, không trả `pendingEmbedding`. `degraded:true` khi có chunk bị bỏ; `labelsSupported:false` khi provider của cuộc họp không gán nhãn (UI dừng poll).
- Quick-assign "Ai đang nói?" trong màn live: chip cho mỗi session speaker đang hoạt động → chọn thành viên phòng / gõ tên / "cùng người với …" → gọi **`speaker_resolve`** (P4, `speakerId = sessionSpeakerId`); cụm chưa chín → đặt tên ngay, enrol để pass async lo.
- **Reconcile ở pass cuối:** `reconcileWithLiveSpeakers()` (hook rỗng của P3) đọc `live-turns.json`, dùng `alignByMaxOverlap` (±1.5 s, bù `clockSkewMs`) map `speakerId` async ↔ `sessionSpeakerId` live → **gộp về một hàng `meeting_speakers` cho mỗi người**, điền `liveSessionSpeakerId`, xoá hàng live không map được. Segmentation async luôn thắng; **tên** theo `nameSource`: `user` > `async` > `live`.
- **Vòng đời registry**: TTL nhàn rỗi 30 phút (không có chunk mới) → evict; chạm trần đồng thời → **evict LRU**, không từ chối meeting mới. Restart pm2 → `loadRegistry(meetingId)` dựng lại từ `meeting_speakers` (centroid từ `pendingEmbedding`, `sonioxLabels`, `liveSpeechSec`) ở chunk kế tiếp.

**Non-functional**
- Độ trễ mục tiêu speech → tên trên màn hình **≈ 70-90s** (60s chờ part đóng + ≤10s xử lý + ≤5s poll). Đo bằng log `chunkReadyAt → persistedAt`.
- CPU cho mỗi chunk 60s < 3s trên hodao; ≤ 5 CPU-phút cho mỗi giờ họp (không đáng kể trên 72 core).
- Ring buffer ≤ `LIVE_CHUNK_OVERLAP_SEC` × 16000 × 4 B ≈ 640 KB/meeting; trần đồng thời **khớp với `LIVE_MAX_CONCURRENT_RECORDINGS`** (không phải 20 — Soniox chỉ cho 10 WS/tài khoản), vượt thì **evict LRU**, không từ chối.
- Chunk worker **không bao giờ** làm hỏng nhánh ghi âm: mọi lỗi chỉ log + bỏ chunk đó; part file không bị xoá (P3 mới được xoá part). **Nhưng bỏ chunk KHÔNG được làm lệch đồng hồ**: dù lỗi ở khâu nào, worker vẫn tiến `decodedSecBefore` bằng `durationMs` do iframe đo, xoá ring buffer và đánh dấu **đứt quãng** (chunk sau không dùng overlap cũ).
- Không log audio, embedding, hay `pendingEmbedding`.

## Architecture

### Hàng đợi (KHÔNG dùng `RenderQueue`)

`src/server/jobs/keyed-serial-queue.ts` — nhỏ, viết riêng: khoá theo `meetingId`, **tuần tự trong cùng khoá, song song giữa các khoá**, backlog giữ **mới nhất + 2** cho mỗi khoá (chunk cũ hơn bị bỏ + log + bật cờ `degraded`), `AbortController` mà worker **quan sát giữa các khâu** và `abort()` **đợi child process thoát** trước khi trả về. `render-queue.ts` của gia-pha không dùng được ở đây: nó là FIFO toàn cục cho render Chromium (`render-queue.ts:25-41`), không có khoá theo key và timeout của nó chỉ reject promise chứ không dừng công việc — hai chunk của cùng meeting có thể chồng lên nhau và làm hỏng registry.

### Chunk worker

```ts
// src/server/live-speakers/chunk-worker.ts — queue keyed by meetingId, concurrency 1/meeting
export async function onChunkReady(ctx: JobCtx, req: ChunkReadyRequest): Promise<void> {
  const reg = await registry.ensure(req.meetingId);      // rebuild từ meeting_speakers nếu trống
  const spans = validateSpans(req, reg);                 // §Requirements: biên, chồng lấn, RMS, cap
  const tmp = tmpDir(req.meetingId, req.seq);
  try {
    const partPath = await downloadPartBySeq(ctx.hub, req.meetingId, req.seq, tmp, ctx.signal);
    const { wavPath, durationSec } = await decodeToWav16k(partPath, `${tmp}/chunk.wav`, ctx.signal);
    const overlap = reg.ring.take();                     // rỗng nếu chunk trước đứt quãng
    const pcm = concatPcm([overlap, readWavPcm(wavPath, 0, durationSec)]);
    const chunkStartSec = reg.decodedSecBefore(req.seq) - overlap.length / 16000;
    for (const seg of [...reg.takeDeferred(), ...spans]) {
      if (reg.alreadyProcessed(seg)) continue;                          // dedupe speakerKey+startMs
      const from = seg.startMs/1000 - chunkStartSec + reg.skewSec(seg);
      const to   = seg.endMs/1000   - chunkStartSec + reg.skewSec(seg);
      if (to > pcm.length/16000) { reg.defer(seg); continue; }          // HOÃN, không bỏ (S2-03)
      if (from < 0 || to - from < env.SPEAKER_MIN_SEGMENT_SEC) continue;
      const slice = pcm.subarray(from*16000, to*16000);
      if (rmsLevel(slice) < SILENCE_RMS) continue;
      reg.observe(seg.speaker, computeEmbedding(slice), to - from, seg); // §registry: xác minh mọi lần
    }
    reg.ring.set(pcm.subarray(pcm.length - env.LIVE_CHUNK_OVERLAP_SEC*16000));
    await matchPendingAgainstProfiles(ctx.db, reg);
    await liveTurnsStore.append(ctx.hub, req.meetingId, reg.settledTurns());   // -> live-turns.json
    if (reg.snapshotChanged()) await liveSpeakerRepository.upsertAll(ctx.db, req.roomId, req.meetingId, reg.snapshot());
  } catch (e) {
    logChunkError(req, e); reg.ring.clear(); reg.markDiscontinuity(req.seq);   // KHÔNG ném
  } finally {
    reg.noteDecoded(req.seq, req.durationMs / 1000);     // LUÔN chạy -> đồng hồ không lệch (S2-08)
    await rm(tmp, { recursive: true, force: true });
  }
}
```

`reg.decodedSecBefore(seq)` cộng dồn `durationMs` **đo được** của các part (iframe gửi kèm), không phải `seq × 60`. `noteDecoded` nằm trong `finally` — đây là điểm mấu chốt: một chunk lỗi chỉ mất nhãn của chính nó, không đẩy lệch mọi chunk sau.

### Session registry — nhãn là gợi ý, embedding mới là danh tính

```ts
// src/server/speaker/session-speaker-registry.ts
interface SessionSpeaker { sessionSpeakerId: string; sonioxLabels: string[]; centroid: Float32Array;
  embeddings: Float32Array[];        // cap 10 gần nhất
  speechSec: number; turnCount: number; sticky: boolean;
  profileId?: string; displayName?: string; nameSource?: 'user'|'async'|'live';
  liveConfidence?: number; profileAttempts: number; colorKey: string; mergedInto?: string }

observe(label, emb, durSec, seg) {
  let s = this.byLabel.get(label);
  if (s && s.sticky && cosine(emb, s.centroid) < env.SPEAKER_SESSION_MATCH_THRESHOLD) {
    s = undefined;                                     // nhãn bị Soniox dùng lại cho người khác
    this.byLabel.delete(label); label = nextInstance(label);   // -> "s0:1@2"
  }
  if (!s) {
    const hit = matchSpeaker(emb, this.asProfiles(), env.SPEAKER_SESSION_MATCH_THRESHOLD);
    s = hit ? this.byId.get(hit.id)! : this.createSessionSpeaker();
    s.sonioxLabels.push(label); this.byLabel.set(label, s);
  }
  s.embeddings.push(emb); capTo(s.embeddings, 10);
  s.centroid = meanNormalize(s.embeddings);
  s.speechSec += durSec; s.turnCount += 1;
  s.sticky = s.turnCount >= 2 && s.speechSec >= env.LIVE_MIN_SPEECH_SEC;   // gắn dính có điều kiện
  this.markProcessed(seg); this.maybeMerge(s);
}
```

`maybeMerge`: bên `speechSec` lớn hơn thắng; bên thua chuyển `sonioxLabels` + `speechSec` + `embeddings` sang, `byLabel` trỏ lại, id bên thua vào `mergedInto` để `meeting_live_speakers` trả cả hai (UI sửa lùi rồi mới xoá). `matchPendingAgainstProfiles` chỉ chạy cho session speaker `sticky`, chưa có `profileId`, `profileAttempts < 5`; danh sách profile **đọc + giải mã một lần** lúc `ensure(meetingId)`.

`settledTurns()` trả các turn đã chốt kèm `sessionSpeakerId` để nối vào `live-turns.json`; `snapshotChanged()` so `snapshotHash` để chỉ ghi App DB khi thực sự đổi (tối đa 1 lần/part).

### Giao thức relabel (backend ↔ iframe)

1. iframe giữ mỗi dòng caption kèm `speakerKey` = nhãn Soniox đã namespace theo `sessionIndex` (P2).
2. `meeting_live_speakers` trả **danh sách session speaker kèm `sonioxLabels[]`** → iframe dựng `Map<speakerKey, sessionSpeaker>`.
3. Mỗi lần poll, iframe áp map lên **mọi** dòng đã render: chỉ đổi badge (tên, màu, chấm confidence), **không** viết lại `text`, không đổi thứ tự dòng, không mất vị trí cuộn.
4. Khi hai nhãn Soniox được gộp, cả hai cùng trỏ về một `sessionSpeakerId` → các dòng cũ tự đổi sang tên đúng ở đúng lần poll đó.
5. Sau "End & summarize", ngừng poll; màn detail (P7) hiển thị nhãn của pass async (đã reconcile).

### Tools

```ts
// meeting_chunk_ready { roomId, meetingId, seq, durationMs,
//                       segments[{speaker, startMs, endMs, final}] } -> { accepted: true }
// meeting_live_speakers { roomId, meetingId } -> { sessionSpeakers[...], degraded?, updatedAt }
```

Cả hai `requireVerifiedActor`; `meeting_chunk_ready` thêm `requireMeetingOwner`, `meeting_live_speakers` chỉ cần thành viên phòng của meeting.

## Related Code Files

**Create**
- `src/server/jobs/keyed-serial-queue.ts` (khoá theo `meetingId`, backlog mới nhất + 2, abort đợi child thoát)
- `src/server/live-speakers/chunk-worker.ts`, `live-speaker-repository.ts`, `part-window.ts` (tải part theo `seq`, dùng lại `hub-file-download.ts`)
- `src/server/speaker/session-speaker-registry.ts`
- `src/server/tools/live-speakers-tool.ts`
- `src/ui/components/{live-speaker-chips.tsx,quick-assign-popover.tsx}`
- Tests: `session-speaker-registry.test.ts`, `chunk-worker.test.ts`, `keyed-serial-queue.test.ts`, `live-speaker-repository.test.ts`, `span-validation.test.ts`, `live-speaker-poll.test.ts` (UI)

**Modify**
- `src/server/tools/chunk-ready-tool.ts` (P2 tạo vỏ → xác thực span + enqueue thật)
- `src/server/media/live-turns-store.ts` (P3 tạo → P5 ghi `live-turns.json`)
- `src/server/tools/speaker-resolve-tool.ts` (P4) — nhận `sessionSpeakerId`, dùng chung cổng enrol
- `src/server/jobs/meeting-job.ts` (`reconcileWithLiveSpeakers` no-op → cài đặt thật bằng `caption-aligner.ts`)
- `src/server/jobs/meeting-repository.ts` (`upsertMeetingSpeakers` merge trường live, không ghi đè)
- `src/server/speaker/{embedding-extractor,speaker-matcher,profile-store,voiceprint-crypto,pcm-utils}.ts` — chỉ **dùng lại**, không sửa logic
- `src/server/env.ts` (`SPEAKER_SESSION_MATCH_THRESHOLD`, `SPEAKER_SESSION_MERGE_THRESHOLD`, `LIVE_MIN_SPEECH_SEC`, `LIVE_CHUNK_OVERLAP_SEC`; đọc `LIVE_MAX_CONCURRENT_RECORDINGS` cho trần registry)
- `privos-app.json` + `src/server/manifest.ts` — thêm `meeting_live_speakers` (tổng **18 tool**)
- `src/server/tools/index.ts`
- `src/ui/screens/live-screen.tsx` (chip người nói + quick-assign), `src/ui/data/live-speaker-poll.ts` (P2 tạo → nối dữ liệu thật), `src/ui/stores/recording-store.ts` (`speakerMap`)
- `src/ui/i18n/vi.json`, `en.json`
- `scripts/calibrate-speaker-threshold.ts` (quét thêm ngưỡng session/merge)
- `docs/system-architecture.md`

**Delete** — không có.

## Implementation Steps

1. `env.ts`: 4 biến ngưỡng + đọc `LIVE_MAX_CONCURRENT_RECORDINGS`; `session-speaker-registry.ts` thuần in-memory (không I/O): `observe` (xác minh + `label@n` + `sticky`), `maybeMerge`, `snapshot`/`snapshotChanged`, `alreadyProcessed`, `defer`/`takeDeferred`, `ring`, `noteDecoded`/`decodedSecBefore`/`markDiscontinuity`, `settledTurns`, `loadFrom(records)`, TTL + LRU.
2. Unit test registry **trước khi nối I/O**: (a) nhãn ổn định → một session speaker; (b) Soniox đổi nhãn, embedding giống → gắn vào **cùng** session speaker; (c) **nhãn bị dùng lại cho giọng khác** → mở `label@2`, centroid cũ **không** đổi; (d) hai session speaker centroid hội tụ → merge, `sonioxLabels` hợp nhất, bên `speechSec` lớn thắng; (e) hai giọng khác nhau → **không** merge; (f) `sticky` chỉ bật sau ≥2 lượt và ≥ `LIVE_MIN_SPEECH_SEC`; (g) `alreadyProcessed` chặn turn lặp trong vùng overlap; (h) turn `[58s,63s]` bị `defer` rồi xử lý ở chunk sau **đúng một lần**.
3. `keyed-serial-queue.ts` + test: hai chunk cùng `meetingId` **không** chạy chồng; chunk của hai meeting chạy song song; backlog > 3 → chunk cũ nhất bị bỏ và bật `degraded`; `abort()` **đợi child thoát** rồi mới resolve.
4. `span-validation.ts` (trong `chunk-ready-tool.ts`) + test: span ngoài cửa sổ part, span chồng lấn cùng speaker, tổng vượt `durationMs`, > 200 turn, span trỏ vào khoảng lặng (RMS thấp) — tất cả bị loại và ghi log sự kiện bảo mật.
5. `part-window.ts`: tìm `fileId` của `audio.part-NNNN-<meetingId8>.webm` theo `seq` (dùng `listParts` + `assertFileInRoom` + kiểm dấu `meetingId8`), tải về tmp.
6. `chunk-worker.ts` theo pseudocode; `noteDecoded` trong `finally`; lỗi → xoá ring + `markDiscontinuity`; timeout 60 s/chunk.
7. `live-speaker-repository.ts`: `upsertAll` qua `AppDbBotClient` (merge theo trường, seal centroid vào `pendingEmbedding`, **chỉ ghi khi `snapshotHash` đổi**), `loadForMeeting` (dựng lại registry sau restart). `live-turns-store.append` nối span vào `live-turns.json`.
8. `chunk-ready-tool.ts`: authz + `validateSpans` + enqueue + trả `{accepted:true}` ngay. Test: caller không phải owner bị từ chối; `segments` sai bị loại; gọi 2 lần cùng `seq` → xử lý một lần.
9. `live-speakers-tool.ts`: đọc `meeting_speakers` → map ra `sessionSpeakers` (DTO allowlist, **lược** `pendingEmbedding`), kèm `degraded`. Test khẳng định response không chứa trường vector nào.
10. Khai `meeting_live_speakers` vào `privos-app.json` + `manifest.ts` + `tools/index.ts`; kiểm `dist/manifest.json` đủ **18 tool**.
11. UI: `live-speaker-chips.tsx` (chip màu + số giây nói, cờ `degraded` hiện "một số đoạn chưa nhận diện được"), `quick-assign-popover.tsx` (member picker P4 + ô gõ tên + "cùng người với …") → `speaker_resolve`; nối `live-speaker-poll.ts` với dữ liệu thật, áp `speakerMap` lên `lines` (kể cả `mergedInto`).
12. `meeting-job.ts`: cài `reconcileWithLiveSpeakers` — đọc `live-turns.json` → `alignByMaxOverlap(asyncSpans, liveSpans, {toleranceMs:1500, skewMs})` → **gộp về một hàng/người**, điền `liveSessionSpeakerId`, áp ưu tiên tên `user > async > live`, xoá hàng live không map được, log mâu thuẫn.
13. `calibrate-speaker-threshold.ts`: thêm chế độ quét `SPEAKER_SESSION_MATCH_THRESHOLD` (0.25→0.60) và `SPEAKER_SESSION_MERGE_THRESHOLD` (0.45→0.80) trên mẫu cùng-phiên, in bảng nhầm-gộp / nhầm-tách.
14. i18n vi/en ("Ai đang nói?", "Đang nhận diện…", "Đã nhận ra: {name}", "một số đoạn chưa nhận diện được").
15. `npm run typecheck && npm test`; **soak 60 phút** trên hodao với cuộc họp thật ≥3 người: đo độ trễ từng chunk, RSS, số chunk bị bỏ, `clockSkewMs` cuối.

## Todo

- [ ] `session-speaker-registry.ts` (xác minh mọi quan sát, `label@n`, `sticky`, merge, defer, ring, TTL/LRU, `snapshotChanged`)
- [ ] Test registry: nhãn ổn định · đổi nhãn · **nhãn dùng lại cho giọng khác** · merge đúng · không merge nhầm · `sticky` · dedupe overlap · fixture `[58s,63s]`
- [ ] `keyed-serial-queue.ts` (khoá theo `meetingId`, backlog mới nhất + 2, abort đợi child thoát) + test
- [ ] `span-validation` trong `chunk-ready-tool.ts` (biên part, chồng lấn, RMS, cap) + test + log sự kiện bảo mật
- [ ] `part-window.ts` tải part theo `seq` (kiểm `channel_id` + dấu `meetingId8`)
- [ ] `chunk-worker.ts` (`noteDecoded` trong `finally`, lỗi → xoá ring + đánh dấu đứt quãng)
- [ ] `live-speaker-repository.ts` (`upsertAll` chỉ khi `snapshotHash` đổi, seal centroid, `loadForMeeting`) + `live-turns.json`
- [ ] `live-speakers-tool.ts` + khai manifest (đủ **18 tool**) + test "không rò vector"
- [ ] UI chip người nói + `degraded` + quick-assign (`speaker_resolve`) + nối `live-speaker-poll.ts`
- [ ] `reconcileWithLiveSpeakers` (đọc `live-turns.json`, gộp một hàng/người, ưu tiên `user > async > live`)
- [ ] `calibrate-speaker-threshold.ts` quét ngưỡng session/merge
- [ ] i18n vi/en
- [ ] typecheck + test + **soak 60 phút trên hodao**

## Success Criteria

- [ ] `npm run typecheck` / `npm test` xanh (≥ 14 test mới); `dist/manifest.json` có đủ **17** tool
- [ ] **Dedupe + hoãn turn biên:** fixture turn `[58s, 63s]` được **hoãn** sang chunk kế và embed đúng **một** lần; `liveSpeechSec` không cộng đôi; turn chưa final ở chunk N, bản final ở N+1 → vẫn chỉ một lần
- [ ] **Đổi/gộp nhãn Soniox:** nhãn `1` đổi thành `3` cho cùng giọng → một `sessionSpeakerId`, `sonioxLabels=['s0:1','s0:3']`; nhãn `1` bị dùng lại cho **giọng khác** → mở `s0:1@2`, centroid người cũ không đổi; hai giọng khác nhau → **không** gộp
- [ ] **Relabel lùi:** dòng đã hiện `Người nói 2` đổi thành tên thật sau lần poll kế; **text không đổi**, vị trí cuộn không nhảy
- [ ] Người đã có voiceprint: tên xuất hiện **≤ 90s** kể từ câu nói đầu tiên (đo log `chunkReadyAt → persistedAt` + chu kỳ poll)
- [ ] Quick-assign giữa họp: gán tên → mọi dòng của người đó (cũ lẫn mới) mang tên đó; cụm chín → profile được tạo và cuộc họp kế tiếp tự nhận ra; cụm lưỡng đỉnh → **chỉ đặt tên**, `speaker_profiles` không đổi
- [ ] Không enrol tự động lúc live: sau một cuộc họp không bấm quick-assign, `speaker_profiles.sampleCount` **không đổi**
- [ ] **Span độc hại bị chặn:** span nằm ngoài cửa sổ part / chồng lấn / trỏ vào khoảng lặng → bị loại, có log, `pendingEmbedding` không bị dựng từ nó
- [ ] **Một chunk lỗi không làm lệch chunk sau:** giả lập ffmpeg fail ở chunk 5 → chunk 6-10 vẫn gán đúng người (đo bằng fixture có nhãn tham chiếu); ghi âm và caption không gián đoạn
- [ ] Kill pm2 giữa cuộc họp → chunk kế tiếp dựng lại registry từ `meeting_speakers`, nhãn không reset về `Người nói 1`
- [ ] **Degraded mode**: cuộc họp dùng `elevenlabs-realtime` → không lời gọi `meeting_chunk_ready`/`meeting_live_speakers` nào; nếu gọi ép thì trả `labels_not_supported`; sau khi xử lý xong nhãn vẫn đầy đủ từ pass async + P4
- [ ] `meeting_live_speakers` không chứa vector/`pendingEmbedding`; grep log không thấy embedding
- [ ] Ghi App DB **≤ 1 lần/part** cho mỗi meeting (đếm lời gọi `upsertAll` trong soak)
- [ ] **Soak 60 phút** trên hodao: RSS phẳng, mỗi chunk < 3s CPU, không chunk nào bị bỏ vì quá tải, `data/tmp/` rỗng sau khi xong
- [ ] Reconcile: `live-turns.json` tồn tại và đọc được **sau khi restart**; mỗi người đúng **một** hàng `meeting_speakers`; tên do người dùng gán giữa họp **không** bị pass async ghi đè

## Risk Assessment

| Risk | Signal | Response |
|---|---|---|
| Soniox đổi/dùng lại nhãn `speaker` → registry sinh quá nhiều người hoặc trộn hai giọng | Số session speaker ≫ số người thật; centroid lưỡng đỉnh | Mọi quan sát đều kiểm với centroid đang gắn; nhãn dùng lại → `label@n`; merge theo centroid; `sticky` chỉ sau ≥2 lượt |
| Ngưỡng session (0.40/0.60) chưa calibrate → gộp nhầm hai người | Hai người cùng một tên trên UI | Quick-assign sửa ngay; ngưỡng là env + `app_settings`; pass async cuối vẫn tách đúng vì độc lập với registry |
| Đồng hồ lệch → cắt PCM sai đoạn → embedding lẫn giọng | `clockSkewMs` > 1.5 s; `liveConfidence` thấp đều | `decodedSecBefore` cộng `durationMs` **đo được**; bù `skewSec`; vượt dung sai → chunk bị đánh dấu `approxClock` và **bỏ embedding** thay vì embed nhầm |
| Một chunk lỗi làm lệch mọi chunk sau | Nhãn sai hệ thống từ một mốc trở đi | `noteDecoded` nằm trong `finally`; lỗi → xoá ring + `markDiscontinuity`; test fixture "ffmpeg fail ở chunk 5" |
| Chunk worker tụt hậu (mạng chậm/CPU bận) | Backlog dài dần | Backlog giữ tối đa 3 chunk mới nhất/meeting; chunk cũ bị bỏ + log + `degraded:true` để UI nói thật; độ trễ tệ nhất vẫn bounded |
| Client gửi span độc hại/sai để trỏ vào giọng người khác | Span ngoài biên part, chồng lấn, hoặc trỏ vào khoảng lặng | `validateSpans` ở server + log sự kiện bảo mật; enrol còn phải qua cổng đồng nhất nội cụm của P4 |
| Registry mất khi pm2 restart giữa họp | Nhãn quay về `Người nói 1` | `loadForMeeting` dựng lại từ `meeting_speakers` (centroid từ `pendingEmbedding`); test kịch bản restart |
| Rò vector qua tool live | `meeting_live_speakers` trả trường lạ | Repository trả DTO allowlist, có test khẳng định; `pendingEmbedding` luôn là ciphertext |
| Nhiều cuộc họp song song ăn RAM | RSS tăng theo số meeting | Trần khớp `LIVE_MAX_CONCURRENT_RECORDINGS`, ring ≤ 640 KB, TTL nhàn rỗi 30 phút + **evict LRU** (không từ chối meeting mới), profile cache dùng chung + TTL 10 phút |
| Ghi thừa App DB mỗi chunk | Số lời gọi `upsertAll` ≈ số chunk | `snapshotHash` + tối đa 1 lần/part; đếm trong soak |
| Người dùng gán sai giữa họp rồi pass async gán khác | Tên nhảy sau khi xử lý xong | Ưu tiên `user > async > live` nên tên người dùng thắng; mâu thuẫn được log; P7 có `meeting_relabel_speaker` để sửa lần cuối |
| Cuộc họp dùng provider không có nhãn live nhưng client vẫn gọi `chunk_ready` | Log thấy lời gọi lạc | Tool trả `{accepted:false, reason:'labels_not_supported'}`, không enqueue, không lỗi; UI đã tự tắt ở P2 |
