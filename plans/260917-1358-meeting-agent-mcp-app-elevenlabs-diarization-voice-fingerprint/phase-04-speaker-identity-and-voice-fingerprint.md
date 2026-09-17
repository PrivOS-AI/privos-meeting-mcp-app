---
phase: 4
title: "Phase 4: Speaker identity and voice fingerprint"
status: pending
priority: P1
effort: "3d"
dependencies: [3]
---

# Phase 4: Speaker identity and voice fingerprint

## Overview

Biến `speaker_0/1/2…` (chỉ có ý nghĩa trong một file) thành danh tính bền vững giữa các cuộc họp. **Toàn bộ vòng đời voiceprint nằm ở backend** (QĐ-06): job trích embedding bằng `sherpa-onnx-node` (Apache-2.0, pure Node, CPU), nạp `speaker_profiles` từ App DB qua bot credential, so khớp cosine, ghi speaker map kèm `confidence` vào `meeting_speakers`. Iframe chỉ hiển thị và gọi tool (`speaker_resolve`, `speaker_profile_*`, `meeting_relabel_speaker`) để xác nhận/sửa — backend thực thi cùng một code path.

P5 (live speaker naming) **dùng lại nguyên xi** ba khối của phase này: `embedding-extractor.ts`, `speaker-matcher.ts`/`profile-store.ts`, `voiceprint-crypto.ts` — vì vậy cả ba phải được export ở dạng thuần hàm, **không** gắn chặt vào vòng đời job của P3.

Vector KHÔNG bao giờ rời backend, và điều đó được **cưỡng chế bằng mật mã** chứ không bằng niềm tin: iframe có `db:read`/`db:write` trên cùng namespace nên vẫn đọc được record `speaker_profiles` — vì vậy mọi vector lưu dưới dạng AES-256-GCM ciphertext kèm HMAC-SHA256 (`VOICEPRINT_ENC_KEY`). Iframe chỉ thấy ciphertext; backend xác minh HMAC trước khi dùng, gặp bản ghi bị sửa/giả thì bỏ qua + log.

## Requirements

**Functional**
- Job P3 bổ sung bước `embed`: mỗi `speakerId` → chọn segment sạch (mỗi segment ≥ `SPEAKER_MIN_SEGMENT_SEC`, tổng ~`SPEAKER_ENROL_TARGET_SEC`, ưu tiên segment dài + `avgLogprob` cao) → nối PCM → 1 embedding.
- Backend match ngay trong job: cosine(embedding, mọi embedding của mọi profile), lấy max. `max ≥ threshold` → auto-label, ghi `meeting_speakers {profileId, displayName, confidence, resolved:true}` và **enrol luôn** embedding vào profile khớp. Ngược lại `displayName = "Người nói N"`, `resolved:false`, embedding giữ tạm trong `meeting_speakers.pendingEmbedding` (base64) cho tới khi user xác nhận.
- Tool `speaker_resolve {roomId, meetingId, assignments[]}` (owner only): với mỗi speaker chưa resolved, `mode` ∈ `user` / `name` / `merge` / `skip`. Backend giải mã `pendingEmbedding` (kiểm HMAC) → **kiểm đồng nhất nội cụm** → tạo/tìm profile → `enrolEmbedding` → cập nhật `meeting_speakers` (`nameSource:'user'`).
- **Cổng enrol (chống nhiễm bẩn voiceprint):** chỉ enrol khi cụm đạt `minPairwiseCosine ≥ SPEAKER_MATCH_THRESHOLD` giữa các embedding thành phần (≥2 lượt độc lập). Cụm **lưỡng đỉnh** (một turn lẫn hai giọng — lỗi thường gặp của diarization realtime) → **chỉ đặt `displayName`, KHÔNG enrol**, trả `{enrolled:false, reason:'cluster_not_coherent'}` và UI nói rõ "đã đặt tên cho cuộc họp này, giọng chưa được ghi nhận". Modal có sẵn lựa chọn "Không phải một người" cho cùng tình huống.
- **`pendingEmbedding` giữ tới khi job async xong** rồi mới xoá (P3 reconcile cần nó để dựng lại registry sau restart và để gán tên theo cụm của pass authoritative) — không xoá ngay lúc `speaker_resolve`.
- Gán `privosUserId` là liên kết sinh trắc tới **một người cụ thể**: chỉ cho phép khi cụm qua được cổng trên; ghi `createdByUserId` để truy vết ai đã gán.
- Authz cho tool profile: `speaker_profile_list` (mọi user đã verify — chỉ trả tên/liên kết/đếm, **không** vector; hiển thị toàn workspace là đánh đổi đã được ghi nhận và chấp nhận); `speaker_profile_update`/`_delete` chỉ cho `createdByUserId` hoặc workspace admin. `speaker_profiles` thêm `createdByUserId`, `createdInRoomId`.
- `displayName` được sanitize: bỏ ký tự điều khiển/xuống dòng, `maxLength 80`, escape markdown khi render — tên người nói là dữ liệu do người dùng nhập và sẽ đi vào prompt + file (chống prompt injection, xem P6).
- Modal "Xác nhận người nói" (iframe): mỗi speaker chưa resolved hiển thị thời lượng nói, đoạn text mẫu, nút phát mẫu (seek audio tới `sampleRange`), 3 lựa chọn tương ứng 3 mode; danh sách thành viên từ `channels.members` (`rooms:read`), danh sách profile từ `speaker_profile_list`.
- `enrolEmbedding(profileId, embedding)` (backend): mã hoá + HMAC → push vào `embeddings[]`, cap 20 phần tử mới nhất, tính lại `centroid` (cũng mã hoá), `sampleCount++`, `lastSeenAt`. Ghi `speaker_profiles` **tuần tự hoá bằng mutex trong tiến trình + đọc lại ngay trước khi ghi** để hai job không ghi đè `embeddings[]` của nhau.
- Tool `meeting_relabel_speaker` (P7 dùng lại): sửa nhãn → back-propagate — gỡ embedding của cuộc họp đó khỏi profile sai, enrol vào profile đúng, cập nhật `meeting_speakers`. `transcript.md`/`.srt` không ghi lại (tên hiển thị lấy từ DB lúc render).
- Settings › Speaker identification: bảng profile từ `speaker_profile_list`, thao tác qua `speaker_profile_update` (gồm `action:'reenrol'` — **thay cho tool re-embed riêng**) / `speaker_profile_delete`; chỉnh `matchThreshold` (slider 0.3–0.8) lưu qua `meeting_settings_set` (admin) vào `app_settings`.
- `speaker_profile_delete` xoá cả `pendingEmbedding` và liên kết `meeting_speakers.profileId` trong **mọi** phòng thuộc `app_settings.knownRooms`, không chỉ phòng hiện tại.
- `meeting_speakers` mở rộng cho registry live của P5 (khai schema ở phase này để P5 không phải đổi schema giữa chừng): `sessionSpeakerId`, `sonioxLabels` (array string), `liveConfidence`, `liveSpeechSec`, `liveUpdatedAt`. Phase này **không** ghi các trường đó; chỉ đảm bảo `upsertMeetingSpeakers` không xoá mất chúng khi job P3 ghi đè (merge theo trường, không `replace` cả record).
- **Đường quick-assign giữa họp**: `speaker_resolve` nhận `speakerId` là `sessionSpeakerId` khi meeting còn `status:'recording'` — cùng code path, **cùng cổng enrol**. Giữa họp cụm thường chưa đủ chín → kết quả phổ biến là "đặt tên ngay, enrol sau khi pass async xong"; đó là hành vi đúng, không phải lỗi. Không có tool riêng cho quick-assign (DRY).
- **Ranh giới tin cậy (ghi lại cho rõ):** chủ cuộc họp được tin với **bản ghi của chính họ** — họ vốn đã kiểm soát mic và nội dung. Cái **không** được tin là span do client gửi lên (P5 xác thực lại phía server) và nhãn diarization realtime (phải qua cổng enrol). Mọi `speaker_profiles` đều mang `createdByUserId` để truy vết.
- `scripts/calibrate-speaker-threshold.ts`: nhận thư mục mẫu đã gán nhãn (`samples/<person>/<file>.wav`) → trích embedding → quét threshold 0.30→0.80 bước 0.01 → in FAR/FRR/EER + threshold đề xuất.

**Non-functional**
- Extractor load model **một lần** cho cả tiến trình (lazy singleton).
- `VOICEPRINT_ENC_KEY` không bao giờ vào log/response; vector plaintext chỉ tồn tại trong RAM của backend.
- Trích embedding cho 1 cuộc họp 1h (≤ 10 speaker) < 60s trên CPU hodao.
- Không có audio hay embedding nào ghi ra log.
- Xoá profile phải xoá hẳn embeddings (yêu cầu dữ liệu sinh trắc).

## Architecture

### Backend — extractor (export để P5 dùng lại)

`src/server/speaker/embedding-extractor.ts`: lazy singleton `sherpa.createSpeakerEmbeddingExtractor({ model: env.SPEAKER_MODEL_PATH, numThreads: 2, provider: 'cpu' })`; export `computeEmbedding(samples: Float32Array, sampleRate = 16000): Float32Array` (→ `createStream()` → `acceptWaveform` → `computeEmbedding(stream)`) và `getEmbeddingDim(): number`. `dim` đọc từ `result.length` lúc runtime — KHÔNG hardcode. **Một singleton cho cả tiến trình**: chunk worker của P5 và job của P3 dùng chung, không load model hai lần.

### Backend — chọn segment enrol

`src/server/speaker/segment-picker.ts`: `planEnrolment(segments, { minSegSec, targetSec })` → `EnrolPlan[] { speakerId, ranges[{startSec,endSec}], totalSec }`. Quy tắc: lọc segment `endSec - startSec ≥ minSegSec` và `wordCount ≥ 4`; sắp giảm dần theo `(duration, avgLogprob)`; lấy cho tới khi `totalSec ≥ targetSec` (tối đa 8 range); nếu tổng < `minSegSec*2` thì bỏ qua speaker (trả `ranges: []`, iframe hiển thị "quá ít dữ liệu, không thể ghi nhận giọng").

### Backend — match + ghi speaker map (bước `embed` của `meeting-job.ts`)

```ts
// src/server/speaker/resolve-speakers.ts
export async function resolveSpeakers(db: AppDbBotClient, wavPath: string, segments: Segment[], meetingId: string) {
  const threshold = await readThreshold(db);           // app_settings.speakerMatchThreshold ?? env.SPEAKER_MATCH_THRESHOLD
  const profiles = await profileStore.listProfiles(db); // đã decode base64 → Float32Array
  const plans = planEnrolment(segments, { minSegSec: env.SPEAKER_MIN_SEGMENT_SEC, targetSec: env.SPEAKER_ENROL_TARGET_SEC });
  const out: JobResult['speakers'] = [];
  for (const plan of plans) {
    if (!plan.ranges.length) { out.push({ speakerId: plan.speakerId, totalSpeakSec: plan.totalSpeakSec, sampleSec: 0, resolved: false }); continue; }
    const pcm = concatPcm(await Promise.all(plan.ranges.map((r) => readWavPcm(wavPath, r.startSec, r.endSec))));
    const emb = computeEmbedding(pcm);
    const match = matchSpeaker(emb, profiles, threshold);
    if (match.profileId) await profileStore.enrolEmbedding(db, match.profileId, { vector: emb, meetingId, durationSec: plan.totalSec });
    out.push({ speakerId: plan.speakerId, totalSpeakSec: plan.totalSpeakSec, sampleSec: plan.totalSec,
               sampleRange: plan.ranges[0], profileId: match.profileId ?? undefined,
               displayName: match.displayName ?? undefined, confidence: match.confidence, resolved: Boolean(match.profileId) });
    // chưa khớp → lưu emb vào meeting_speakers.pendingEmbedding (base64) chờ speaker_resolve
  }
  return out;      // KHÔNG chứa vector
}

// src/server/speaker/speaker-matcher.ts (dùng chung src/shared/cosine.ts)
export function matchSpeaker(embedding: Float32Array, profiles: SpeakerProfile[], threshold: number): MatchResult;
```

So với **từng embedding** (max), không so với centroid — bắt được biến thiên mic/thiết bị tốt hơn. `centroid` chỉ để hiển thị/độ đo chất lượng. Embedding khác `dim` bị bỏ qua (không ném lỗi).

### Voiceprint crypto (mới)

```ts
// src/server/speaker/voiceprint-crypto.ts
const key = Buffer.from(env.VOICEPRINT_ENC_KEY, 'base64');          // 32 byte
const macKey = hkdfSync('sha256', key, Buffer.alloc(0), 'meeting-agent/voiceprint-hmac', 32);

export function sealEmbedding(vec: Float32Array, meta: { profileId: string; createdAt: string }): SealedEmbedding {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(vec.buffer)), c.final()]);
  const tag = c.getAuthTag();
  const hmac = createHmac('sha256', macKey)
    .update(meta.profileId).update(ct).update(meta.createdAt).digest('base64');
  return { ct: ct.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64'), hmac, ...meta };
}
export function openEmbedding(sealed: SealedEmbedding): Float32Array | null;
// so HMAC bằng timingSafeEqual TRƯỚC khi giải mã; sai → trả null + log { profileId, reason:'hmac_mismatch' }
```

Áp cho cả `embeddings[]`, `centroid` và `meeting_speakers.pendingEmbedding`. Khoá sinh lúc deploy, `.env` chmod 600, **bắt buộc backup** (P8) — mất khoá là mất toàn bộ voiceprint.

### Backend — profile store (App DB global, bot credential, KHÔNG truyền roomId)

```ts
// src/server/speaker/profile-store.ts
export interface StoredEmbedding { vector: Float32Array; meetingId: string; durationSec: number; createdAt: string }
export interface SpeakerProfile { id: string; displayName: string; privosUserId?: string; privosUsername?: string;
  colorKey: string; embeddings: StoredEmbedding[]; centroid: Float32Array | null; dim: number; sampleCount: number; lastSeenAt?: string }

export const EMBEDDING_CAP = 20;
export async function listProfiles(db: AppDbBotClient): Promise<SpeakerProfile[]>;          // openEmbedding() + bỏ bản ghi sai HMAC
export async function createProfile(db, input): Promise<SpeakerProfile>;
export async function enrolEmbedding(db, profileId, emb): Promise<void>;                    // push, cap 20 mới nhất, recompute centroid
export async function removeEmbeddingsOfMeeting(db, profileId, meetingId): Promise<void>;   // back-propagate khi sửa nhãn
export async function renameProfile(db, profileId, displayName): Promise<void>;
export async function linkPrivosUser(db, profileId, userId, username): Promise<void>;
export async function deleteProfile(db, profileId, knownRooms: string[]): Promise<void>;    // xoá profile + pendingEmbedding + liên kết mọi phòng
export async function withProfileLock<T>(profileId: string, fn: () => Promise<T>): Promise<T>;  // mutex + re-read trước khi ghi
```

`mergeProfiles()` bị cắt — chế độ `merge` của `speaker_resolve` chỉ cần enrol embedding mới vào profile đích, không cần gộp hai profile. Lưu: `embeddings` là mảng JSON string (App DB không có kiểu object), mỗi phần tử `{ct, iv, tag, hmac, meetingId, durationSec, createdAt}` ≈ 1.5 KB → 20 embedding ≈ 30 KB/profile.

### Tools (xem bảng § MCP tools trong plan.md)

```ts
// speaker_resolve (owner only)
inputSchema: { type:'object', required:['roomId','meetingId','assignments'], properties: {
  roomId:{type:'string'}, meetingId:{type:'string'},
  assignments:{ type:'array', items:{ type:'object', required:['speakerId','mode'], properties:{
    speakerId:{type:'string'}, mode:{type:'string', enum:['user','name','merge','skip']},
    privosUserId:{type:'string'}, displayName:{type:'string', maxLength:80}, profileId:{type:'string'} } } } } }
// speaker_profile_list {}  → không roomId, không vector
// speaker_profile_update { profileId, displayName?, privosUserId?, action?:'reenrol' }  ← gồm cả re-embed
// speaker_profile_delete { profileId } · meeting_relabel_speaker { roomId, meetingId, speakerId, ... }
```

Mọi tool bắt đầu bằng `requireVerifiedActor(context)` (P3). Tool gắn với meeting kiểm thêm `requireMeetingOwner`. Tool profile kiểm `createdByUserId === actor.userId || isWorkspaceAdmin(actor)`. `action:'reenrol'` chỉ chạy khi `audio.webm` còn tồn tại; UI disable khi `meetings.audioDeletedAt` có giá trị.

### UI

- `resolve-speakers-modal.tsx`: list speaker chưa resolved; mỗi hàng: avatar màu, "Người nói N", thời lượng, trích 2 câu đầu, nút ▶ phát mẫu (dùng presigned URL + `currentTime`), 3 lựa chọn ở trên; nút "Bỏ qua" giữ nguyên nhãn tạm.
- `member-picker.tsx`: gõ để lọc `channels.members` (debounce 250ms, timeout 8s như gia-pha `room-members.ts`), degrade sang nhập tay khi thiếu `rooms:read`.
- `settings/speaker-identification-panel.tsx`: bảng + hành động + slider threshold + cảnh báo "Thay đổi ngưỡng chỉ ảnh hưởng cuộc họp xử lý sau".
- `speaker-avatar.tsx`: initials + `colorKey` từ palette design (6 màu).

## Related Code Files

**Create**
- `src/server/speaker/embedding-extractor.ts`, `segment-picker.ts`, `pcm-utils.ts`, `speaker-matcher.ts`, `profile-store.ts`, `resolve-speakers.ts`, `voiceprint-crypto.ts`
- `src/server/tools/speaker-resolve-tool.ts`, `speaker-profile-tools.ts`, `relabel-speaker-tool.ts`
- `src/ui/data/room-members.ts`, `speaker-api.ts` (wrapper `callServerTool` cho 5 tool speaker)
- `src/ui/components/{resolve-speakers-modal.tsx,member-picker.tsx,speaker-avatar.tsx,speaker-label-editor.tsx}`
- `src/ui/screens/settings/speaker-identification-panel.tsx`
- `scripts/calibrate-speaker-threshold.ts`
- Tests: `segment-picker.test.ts`, `speaker-matcher.test.ts`, `profile-store.test.ts`, `resolve-speakers.test.ts`, `voiceprint-crypto.test.ts`

**Modify**
- `src/server/jobs/meeting-job.ts` (thay hook `resolveSpeakers` rỗng bằng cài đặt thật)
- `src/server/jobs/meeting-repository.ts` (`upsertMeetingSpeakers` nhận `confidence`/`pendingEmbedding`)
- `src/server/env.ts` (`SPEAKER_MODEL_PATH`, `SPEAKER_MATCH_THRESHOLD`, `SPEAKER_MIN_SEGMENT_SEC`, `SPEAKER_ENROL_TARGET_SEC`)
- `src/server/media/decode-audio.ts` (`readWavPcm` dùng thật)
- `src/server/tools/index.ts`
- `privos-app.json` + `src/server/manifest.ts` — thêm `speaker_resolve`, `speaker_profile_list/_update/_delete`, `meeting_relabel_speaker`
- `src/shared/app-db-schema.ts` (`meeting_speakers.pendingEmbedding` + trường registry live `sessionSpeakerId`/`sonioxLabels`/`liveConfidence`/`liveSpeechSec`/`liveUpdatedAt`; `speaker_profiles.createdByUserId`, `createdInRoomId`)
- `src/server/env.ts` (`VOICEPRINT_ENC_KEY`, fail-fast khi thiếu ở production)
- `src/ui/screens/processing-screen.tsx` (job `completed` mà còn speaker `resolved:false` → mở modal)
- `src/ui/screens/settings-screen.tsx` (gắn panel)
- `package.json` (`sherpa-onnx-node`)
- `scripts/deploy-hodao.sh` (tải model ONNX vào `models/` nếu chưa có)
- `docs/system-architecture.md`, `docs/deployment-guide.md` (mục model + threshold)

**Delete** — không có.

## Implementation Steps

1. Cài `sherpa-onnx-node`; tải 3 ứng viên model vào `models/` và ghi lại kích thước: `3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`, `wespeaker_en_voxceleb_CAM++_LM.onnx`, `nemo_en_titanet_small.onnx`. Smoke test: load + `computeEmbedding` trên 3s nhiễu trắng, in `dim` + thời gian.
2. `pcm-utils.ts`: `concatPcm(parts: Float32Array[])`, `rmsLevel(pcm)` (lọc range gần như im lặng trước khi enrol).
3. `embedding-extractor.ts` singleton + `computeEmbedding`; fail-fast với thông báo rõ khi `SPEAKER_MODEL_PATH` không tồn tại.
4. `segment-picker.ts` `planEnrolment` + unit test (ít dữ liệu, nhiều segment ngắn, 1 speaker dài).
4b. `voiceprint-crypto.ts`: `sealEmbedding`/`openEmbedding` (AES-256-GCM + HMAC, `timingSafeEqual`), test round-trip + test bản ghi bị sửa 1 byte → `null` + log, không ném.
5. `profile-store.ts`: CRUD `speaker_profiles` qua `AppDbBotClient` **không truyền `roomId`** (đã xác nhận ở spike P1-4), `enrolEmbedding` (seal + cap 20 + recompute centroid), `withProfileLock` (mutex + re-read), `deleteProfile` xoá liên kết trong mọi `knownRooms`.
6. `speaker-matcher.ts` + unit test: khớp đúng, dưới ngưỡng, profile rỗng, dim lệch (bỏ qua — không ném lỗi).
7. `resolve-speakers.ts`: nối bước `embed` trong `meeting-job.ts` — đọc PCM theo range, ghép, trích embedding, match, enrol khi khớp, lưu `pendingEmbedding` khi chưa khớp, trả `JobResult.speakers[]` **không có vector**.
8. Tool `speaker_resolve` (4 mode, idempotent theo `speakerId`, owner only), `speaker_profile_list/_update/_delete` (`_update` gồm `action:'reenrol'`; `_update`/`_delete` kiểm `createdByUserId` hoặc admin), `meeting_relabel_speaker` (back-propagate). Tất cả qua `requireVerifiedActor`. Khai đủ vào `privos-app.json`.
9. `room-members.ts`: copy pattern gia-pha (`channels.members`, debounce, timeout 8s, degrade khi thiếu scope); `speaker-api.ts` wrapper `callServerTool` cho 5 tool trên.
10. `resolve-speakers-modal.tsx` + `member-picker.tsx` + `speaker-avatar.tsx`; phát mẫu bằng `<audio>` với presigned URL và `currentTime = sampleRange.startSec`; submit → `speaker_resolve`.
11. `processing-screen.tsx`: job `completed` mà `result.speakers` còn `resolved:false` → mở modal ngay.
12. `speaker-label-editor.tsx`: dropdown sửa nhãn dùng lại ở meeting detail → gọi `meeting_relabel_speaker`.
13. `speaker-identification-panel.tsx`: bảng từ `speaker_profile_list` + đổi tên/liên kết/xoá/re-enrol qua tool + slider threshold lưu vào `app_settings.key='speakerMatchThreshold'` (backend đọc khi match).
14. Nút "Ghi nhận lại giọng" gọi `speaker_profile_update {action:'reenrol'}` (disable khi `meetings.audioDeletedAt` có giá trị).
15. `scripts/calibrate-speaker-threshold.ts`: đọc `samples/<person>/*.wav`, trích embedding, tính ma trận cosine, quét threshold, in bảng FAR/FRR/EER + gợi ý; `npm run calibrate:speaker -- ./samples`.
16. `deploy-hodao.sh`: nếu `models/<file>` chưa có trên node thì `curl -L` từ release sherpa-onnx (ghi URL trong deployment-guide), verify sha256.
17. `npm run typecheck && npm test`; test tay 2 cuộc họp liên tiếp cùng người nói.

## Todo

- [ ] Cài `sherpa-onnx-node` + tải/benchmark 3 model ứng viên, chốt default
- [ ] `pcm-utils.ts` (concat, rms)
- [ ] `embedding-extractor.ts` singleton (export `computeEmbedding`/`getEmbeddingDim` cho P5) + fail-fast thiếu model
- [ ] Khai trường registry live vào `meeting_speakers` (P5 ghi) + `upsertMeetingSpeakers` merge theo trường, không ghi đè cả record
- [ ] `segment-picker.ts` `planEnrolment` + test
- [ ] `voiceprint-crypto.ts` (seal/open + HMAC) + test round-trip và test bản ghi bị sửa
- [ ] `profile-store.ts` (App DB global **không roomId**; enrol cap 20, centroid, `withProfileLock`, delete xuyên `knownRooms`)
- [ ] `speaker-matcher.ts` (backend) + test
- [ ] `resolve-speakers.ts` + nối bước `embed` trong `meeting-job.ts` (match + enrol, không trả vector)
- [ ] Tools `speaker_resolve` (**có cổng đồng nhất nội cụm**, `nameSource:'user'`, giữ `pendingEmbedding` tới khi job async xong), `speaker_profile_list/_update(+reenrol)/_delete`, `meeting_relabel_speaker` + khai manifest + authz theo `createdByUserId`/admin
- [ ] `room-members.ts` + `speaker-api.ts` (wrapper tool phía iframe)
- [ ] `resolve-speakers-modal.tsx` + `member-picker.tsx` + `speaker-avatar.tsx`
- [ ] `processing-screen.tsx` mở modal khi còn speaker chưa resolved
- [ ] `speaker-label-editor.tsx` + back-propagate khi sửa nhãn
- [ ] `settings/speaker-identification-panel.tsx` + slider threshold
- [ ] `scripts/calibrate-speaker-threshold.ts` + npm script
- [ ] `deploy-hodao.sh` tải model + verify sha256
- [ ] typecheck + test + thử 2 cuộc họp liên tiếp

## Success Criteria

- [ ] `npm run typecheck` / `npm test` xanh (≥ 11 test: picker/matcher/profile-store/resolve-speakers/voiceprint-crypto); `dist/manifest.json` tools == registry
- [ ] `computeEmbedding` gọi được từ ngoài vòng đời job (test gọi trực tiếp với `Float32Array`), model chỉ load **một** lần dù gọi 100 lần
- [ ] Cuộc họp 1: 3 người → modal hiện 3 speaker chưa biết → `speaker_resolve` xong, App DB có 3 `speaker_profiles` với `sampleCount = 1`
- [ ] Cụm lưỡng đỉnh (fixture: nối 4s giọng A + 4s giọng B thành một "turn") → `speaker_resolve` trả `{enrolled:false, reason:'cluster_not_coherent'}`, `speaker_profiles` **không** đổi, tên vẫn được đặt cho cuộc họp đó
- [ ] Cuộc họp 2 (cùng 3 người, cùng mic): ≥ 2/3 được auto-label **bởi backend** trước khi UI mở, confidence hiển thị trên UI
- [ ] Gán sai rồi sửa trong detail → `embeddings` của meeting đó chuyển sang profile đúng (kiểm bằng `mcpapp.db.get`)
- [ ] Xoá profile → không còn embedding, `pendingEmbedding`, hay `meeting_speakers.profileId` trỏ tới người đó ở **mọi** phòng trong `knownRooms`
- [ ] Đọc thô `speaker_profiles` bằng `mcpapp.db.query` từ iframe → chỉ thấy ciphertext, không suy ra được vector
- [ ] Sửa 1 byte trong `ct` của một embedding → backend bỏ qua bản ghi đó + ghi log `hmac_mismatch`, quá trình match vẫn chạy
- [ ] `speaker_profile_update/_delete` bởi user không phải `createdByUserId` và không phải admin → bị từ chối
- [ ] `npm run calibrate:speaker -- ./samples` in bảng FAR/FRR/EER và threshold gợi ý
- [ ] Trích embedding + match cho cuộc họp 1h ≤ 10 speaker < 60s (đo log bước `embed`)
- [ ] Không có vector/plaintext embedding trong bất kỳ response MCP nào (kiểm `meeting_status`, `speaker_profile_list`) và trong log; `VOICEPRINT_ENC_KEY` không xuất hiện ở đâu ngoài `.env`

## Risk Assessment

| Risk | Signal | Response |
|---|---|---|
| Model ONNX không load trên glibc của hodao | Exception lúc `createSpeakerEmbeddingExtractor` | Thử prebuilt `linux-x64`; nếu hỏng → fallback model khác hoặc Python sidecar SpeechBrain (ghi trong docs là fallback) |
| Ngưỡng 0.5 sai cho tiếng Việt → gán nhầm | Người dùng sửa nhãn liên tục | Chạy `calibrate-speaker-threshold.ts` trước khi bật auto-label; threshold chỉnh được trong Settings |
| Diarization gộp 2 người thành 1 speaker (realtime hay xảy ra hơn async) | 1 embedding lẫn 2 giọng, `minPairwiseCosine` thấp | **Cổng đồng nhất nội cụm** chặn enrol tự động; modal có "Không phải một người"; tên vẫn đặt được cho riêng cuộc họp |
| Người dùng gán nhầm giọng đồng nghiệp rồi liên kết `privosUserId` | Profile workspace mang giọng sai | Chỉ enrol khi cụm đạt cổng; `createdByUserId` truy vết; `speaker_profile_delete` xoá hẳn xuyên `knownRooms`; back-propagate khi sửa nhãn |
| Người dùng có nhiều mic/thiết bị → cosine tụt | Auto-label miss ở phòng họp khác | Lưu nhiều embedding/profile (cap 20) thay vì 1 centroid; mọi lần xác nhận đều enrol thêm |
| Embedding là dữ liệu sinh trắc | Yêu cầu tuân thủ | `dataPolicy` khai rõ; Settings có nút Xoá profile xoá hẳn; không bao giờ ghi ra Files |
| `dim` khác nhau khi đổi model giữa chừng | So khớp sai/ném lỗi | `matchSpeaker` bỏ qua embedding khác `dim` và UI cảnh báo "cần re-enrol sau khi đổi model" |
| Audio đã bị xoá → không re-enrol được | Nút re-enrol lỗi | Disable nút khi `audioDeletedAt` có giá trị; tooltip giải thích |
| Mất/đổi `VOICEPRINT_ENC_KEY` | `openEmbedding` trả `null` hàng loạt | Backup khoá bắt buộc (P8); app không crash, chỉ mất auto-label → người dùng enrol lại |
| Hai job cùng ghi một profile | `embeddings[]` mất phần tử | `withProfileLock` + re-read trước khi ghi; test đồng thời 2 lần enrol |
| `pendingEmbedding` tồn đọng khi user không bao giờ xác nhận | Record `meeting_speakers` phình | `meeting_bootstrap` xoá `pendingEmbedding` cũ hơn 30 ngày; speaker vẫn giữ nhãn "Người nói N" |
