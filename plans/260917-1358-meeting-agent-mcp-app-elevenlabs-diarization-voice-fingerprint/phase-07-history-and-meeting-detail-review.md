---
phase: 7
title: "Phase 7: History and meeting detail review"
status: code-complete-deterministic
priority: P1
effort: "3d"
dependencies: [3, 4, 5, 6]
---

# Phase 7: History and meeting detail review

## Overview

Hai màn hình xem lại của design: **1d History** (stats, filter chips, sort, search, bảng cuộc họp) và **1c Meeting detail** (player audio có scrubber + bookmark ticks + tốc độ, transcript màu theo người nói, search highlight, filter theo người nói, panel AI summary / action items / bookmarks, export SRT/DOCX, sửa tiêu đề, sửa nhãn người nói).

Nguồn dữ liệu: App DB cho metadata/action items/bookmarks/speaker map; `transcript.json` tải từ Files (fetch một lần, cache theo `meetingId`); audio phát qua presigned URL từ `GET file-management.files/:fileId`. **Cả hai đường này chỉ chạy nếu `ui.csp.connect-src` (fetch JSON) và `media-src` (thẻ `<audio>`) có origin lưu trữ `PRIVOS_FILES_ORIGIN`** — đã chốt ở spike P1-3.

"Ask AI" trong ô search: v1 = **keyword search trên summary + transcript**, không gọi LLM. Toggle sparkle vẫn hiển thị theo design nhưng đổi nhãn thành "Tìm trong tóm tắt" và ghi chú trong docs rằng RAG thực thụ là v2.

## Requirements

**Functional — History (1d)**
- Nút vàng "Bắt đầu ghi" → màn new-meeting.
- 4 thẻ thống kê: tuần này (số cuộc), tổng thời lượng ghi, action item chưa xong, số bookmark — tính bằng `mcpapp.db.count`/`aggregate`, không tải hết record.
- Filter chips: Tất cả / Có action item / Đã bookmark / Chia sẻ với tôi (v1: "Của tôi" nếu chưa có cơ chế share → đổi nhãn, ghi chú).
- Sort: Mới nhất / Cũ nhất / Dài nhất.
- Search từ khoá: khớp `title` + `summaryText` (`where` op `!=` không đủ → tải trang hiện tại rồi lọc client-side; ghi rõ giới hạn, phân trang `limit 50 / offset`).
- Bảng: tiêu đề + ngày, avatar người nói (từ `meeting_speakers`), thời lượng (mono), số action, badge trạng thái (Summarized xanh / Processing cam / Failed đỏ / Private xám), menu ⋯ (Mở, Đổi tên, Xuất SRT, Xuất DOCX, Xoá).

**Functional — Detail (1c)**
- Breadcrumb History / tiêu đề (click sửa, lưu vào `meetings.title`).
- Meta: ngày, thời lượng, số người nói, badge "Transcript lưu trên PrivOS".
- Player: play/pause, scrubber có tick bookmark, hiển thị `mm:ss / mm:ss`, tốc độ 1x/1.25x/1.5x/2x; click 1 dòng transcript → seek; click `at` của action item → seek.
- Transcript: mỗi dòng avatar + tên (màu theo `colorKey`) + mm:ss + text; dòng đang phát được highlight và auto-scroll (tắt được).
- Search trong transcript: highlight vàng mọi kết quả, nút ‹ › nhảy giữa các kết quả, đếm "3/17".
- Filter theo người nói (multi-select); toggle hiện/ẩn bản dịch (`segment.translation` từ P6, ẩn khi không có).
- Bookmark: thêm tại thời điểm đang phát, xoá, click để seek.
- Sửa nhãn người nói ngay trên dòng transcript (`speaker-label-editor.tsx` của P4 → tool `meeting_relabel_speaker`) → back-propagate vào voiceprint. Tên người nói **escape markdown** khi render. Nhãn hiển thị ở đây lấy từ **pass async đã reconcile** (P3/P5), không phải nhãn live; tên người dùng gán giữa họp được giữ nguyên.
- Export: SRT (tải file đã có trên Files), DOCX (sinh tại trình duyệt bằng `docx` + `Packer.toBlob`, tải xuống; kèm tuỳ chọn "lưu vào Files").
- Nút "Send to Chat room" và "Share" (Share v1 = copy link file).

**Non-functional**
- Transcript 3h (~2000 segment) render mượt → virtualize list (tự viết windowing đơn giản, không thêm thư viện).
- `transcript.json` chỉ tải 1 lần/meeting/phiên.
- Audio stream, không tải hết vào memory.
- Presigned URL hết hạn → tự xin lại khi `<audio>` báo lỗi. Nếu console báo CSP chặn `connect-src`/`media-src` → coi là lỗi manifest, không phải lỗi runtime.

## Architecture

### Tải transcript + audio

```ts
// src/ui/data/transcript-loader.ts
const cache = new Map<string, TranscriptDoc>();
export async function loadTranscript(app, fileId: string): Promise<TranscriptDoc> {
  if (cache.has(fileId)) return cache.get(fileId)!;
  const meta = await app.rest({ method: 'GET', path: `file-management.files/${fileId}` });
  const url = (meta?.body ?? meta)?.file?.downloadUrl;            // presigned
  const doc = await (await fetch(url)).json() as TranscriptDoc;
  cache.set(fileId, doc); return doc;
}
export async function resolveAudioUrl(app, fileId: string): Promise<string>;   // cùng cách, trả downloadUrl
```

Nếu `downloadUrl` vắng mặt → fallback `GET file-management.files/:fileId/download` qua `app.rest` (binary → blob URL); ghi rõ trong code comment.

### Keyword search

```ts
// src/ui/data/keyword-search.ts
export interface Hit { segmentId: string; startSec: number; pre: string; hit: string; post: string }
export function searchTranscript(segments: Segment[], query: string): Hit[];    // bỏ dấu tiếng Việt, case-insensitive
export function searchMeetings(rows: MeetingRow[], query: string): MeetingRow[]; // title + summaryText
```

Dùng `String.prototype.normalize('NFD').replace(/\p{Diacritic}/gu,'')` để "hop" khớp "họp".

### Player

```ts
// src/ui/components/audio-player.tsx
// <audio preload="metadata"> + rAF cập nhật currentTime; expose { seek(sec), play, pause, rate }
// bookmark ticks: absolute positioned theo (atSec / duration)
// onError (403/hết hạn) → resolveAudioUrl() lại 1 lần rồi giữ currentTime
```

### Virtualized transcript

```ts
// src/ui/components/transcript-view.tsx
// đo chiều cao trung bình dòng, chỉ render [start-10, end+10] theo scrollTop; dòng đang phát tính từ currentTime
```

### DOCX export

```ts
// src/ui/data/docx-export.ts
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
export async function buildMeetingDocx(input: { meeting, speakers, segments, summary }): Promise<Blob>;
// Heading1 tiêu đề → meta → Heading2 "Tóm tắt"/"Quyết định"/"Việc cần làm" → Heading2 "Biên bản" → mỗi segment 1 paragraph
```

### Stats

```ts
// src/ui/data/meeting-stats.ts
// count meetings where startedAt >= đầu tuần
// aggregate sum durationSec
// count action_items where done == false
// count bookmarks
```

## Related Code Files

**Create**
- `src/ui/data/transcript-loader.ts`, `keyword-search.ts`, `docx-export.ts`, `meeting-stats.ts`, `file-download.ts`
- `src/ui/components/{audio-player.tsx,transcript-view.tsx,transcript-line.tsx,search-box.tsx,bookmarks-panel.tsx,meeting-row-menu.tsx,status-badge.tsx,stat-card.tsx,filter-chips.tsx}`
- `src/ui/screens/history-screen.css`, `meeting-detail-screen.css`
- Tests: `keyword-search.test.ts`, `meeting-stats.test.ts`, `docx-export.test.ts`

**Modify**
- `privos-app.json` + `src/server/manifest.ts` — **không thêm tool mới**; xác nhận `connect-src`/`media-src` đã có `PRIVOS_FILES_ORIGIN`
- `src/ui/screens/history-screen.tsx` (placeholder → màn 1d thật)
- `src/ui/screens/meeting-detail-screen.tsx` (placeholder → màn 1c thật)
- `src/ui/data/meeting-read-model.ts` (P3) — thêm `listMeetings` phân trang, `renameMeeting`, `deleteMeeting`
- `src/ui/data/action-item-read-model.ts` (P6) — `toggleDone` gọi từ detail
- `src/ui/app.tsx` (route `detail/:meetingId`, quay lại History)
- `src/ui/i18n/vi.json`, `en.json`
- `package.json` (`docx`)

**Delete** — không có.

## Implementation Steps

1. `meeting-read-model.ts`: `listMeetings({ limit, offset, orderBy })`, `renameMeeting`, `deleteMeeting` (xoá record + xoá file trên Files khi user xác nhận), `getMeeting`.
2. `meeting-stats.ts` dùng `mcpapp.db.count` + `aggregate` (`op:'sum'`, `field:'durationSec'`); test bằng client giả.
3. `stat-card.tsx`, `filter-chips.tsx`, `status-badge.tsx` theo token design (success/warning/danger/info).
4. `history-screen.tsx`: header + nút "Bắt đầu ghi" gradient vàng, search box (⌘K focus), 4 stat card, chips, sort select, bảng + `meeting-row-menu.tsx`, phân trang "Tải thêm".
5. `keyword-search.ts` + test (bỏ dấu, nhiều kết quả trong 1 segment, query rỗng).
6. `transcript-loader.ts` + `file-download.ts` (presigned + fallback binary), cache theo fileId.
7. `audio-player.tsx`: scrubber, bookmark ticks, tốc độ, seek API, tự xin lại URL khi hết hạn.
8. `transcript-view.tsx` + `transcript-line.tsx`: virtualize, màu theo `colorKey`, highlight dòng đang phát, auto-scroll có toggle, highlight kết quả search, dropdown sửa nhãn (P4).
9. `bookmarks-panel.tsx`: list + thêm/xoá + seek.
10. `meeting-detail-screen.tsx`: layout `rail / topbar / 1fr + 380px`, breadcrumb, tiêu đề sửa được, meta + badge, player, search + filter người nói, transcript, panel phải (summary card, action items card, bookmarks).
11. `docx-export.ts` + nút Export DOCX (tải xuống + tuỳ chọn lưu vào Files qua `app.uploadFile` vào folder cuộc họp).
12. Export SRT: tải file `srtFileId` đã có (không sinh lại).
13. Nối "Send to Chat room" (P6) và "Share" (copy presigned link `summary.md`).
14. i18n vi/en cho mọi chuỗi mới; ghi chú đổi nhãn "Ask AI" → "Tìm trong tóm tắt" vào `docs/design-guidelines.md`.
15. `npm run typecheck && npm test`; kiểm tay trên cuộc họp 1h thật (scroll, search, seek, export).

## Todo

- [ ] `meeting-read-model.ts` list/rename/delete phân trang
- [ ] `meeting-stats.ts` bằng count/aggregate + test
- [ ] `stat-card.tsx` / `filter-chips.tsx` / `status-badge.tsx`
- [ ] `history-screen.tsx` (1d) đầy đủ: stats, chips, sort, search, bảng, ⋯ menu
- [ ] `keyword-search.ts` (bỏ dấu tiếng Việt) + test
- [ ] `transcript-loader.ts` + `file-download.ts` (presigned + fallback)
- [ ] `audio-player.tsx` (scrubber, ticks, tốc độ, refresh URL hết hạn)
- [ ] `transcript-view.tsx` virtualize + highlight + sửa nhãn
- [ ] `bookmarks-panel.tsx`
- [ ] `meeting-detail-screen.tsx` (1c) đầy đủ
- [ ] `docx-export.ts` + nút Export DOCX/SRT
- [ ] Nối Send to Chat + Share
- [ ] i18n vi/en + ghi chú "Ask AI" v1
- [ ] typecheck + test + kiểm tay cuộc họp 1h

## Success Criteria

- [ ] `npm run typecheck` / `npm test` xanh (≥ 6 test cho search/stats/docx)
- [ ] History hiện đúng 4 số liệu, đối chiếu thủ công với App DB
- [ ] Filter + sort + search hoạt động; phân trang 50 record/lần, cuộn "Tải thêm" không trùng dòng
- [ ] Detail cuộc họp 1h: transcript ~2000 dòng cuộn mượt (không giật rõ rệt), bộ nhớ tab < 400MB
- [ ] Click dòng transcript → audio seek đúng (±0.5s); click `at` action item → seek đúng
- [ ] Search "họp" khớp cả "hop"; đếm kết quả và ‹ › nhảy đúng
- [ ] Export SRT tải đúng file trên Files; Export DOCX mở được bằng Word/LibreOffice với đủ heading; transcript song ngữ hiển thị đúng khi bật toggle
- [ ] Không có lỗi CSP trong console khi fetch `transcript.json` và phát `audio.webm`
- [ ] Sửa nhãn người nói trong detail → History + voiceprint cập nhật theo

## Risk Assessment

| Risk | Signal | Response |
|---|---|---|
| Presigned URL hết hạn giữa lúc phát | `<audio>` error, phát dừng | `onError` → xin URL mới 1 lần, khôi phục `currentTime`; quá 1 lần → "Tải lại trang" |
| CSP thiếu origin lưu trữ | Console `Refused to connect/load media` | `PRIVOS_FILES_ORIGIN` phải nằm trong `connect-src` **và** `media-src`; kiểm lại sau mỗi lần sửa manifest |
| `transcript.json` > 10MB làm treo tab | Thời gian parse lâu | Tải 1 lần + cache; UI có skeleton; nếu > 20MB thì chỉ đọc `segments` (bỏ `tokens`) bằng cách yêu cầu P3 ghi thêm `transcript-segments.json` nhẹ |
| Virtualize tự viết gây lỗi nhảy scroll | Scroll giật khi search | Ưu tiên đơn giản: đo chiều cao cố định theo số dòng text ước lượng; test tay ở 2000 dòng trước khi chốt |
| Audio đã bị xoá theo chính sách lưu trữ | Player 404 | Ẩn player + hiện "Audio gốc đã xoá theo cài đặt lưu trữ" |
| `db.query` limit 1000 làm thiếu dữ liệu | History thiếu cuộc họp cũ | Luôn phân trang `limit/offset`, không bao giờ query không giới hạn |
| Nhãn "Ask AI" gây kỳ vọng sai | Người dùng phàn nàn không thông minh | Đổi nhãn + tooltip "v1 tìm theo từ khoá trong tóm tắt", ghi vào roadmap |
| Xoá cuộc họp làm mất file người khác cần | Khiếu nại dữ liệu | Hộp xác nhận nêu rõ file sẽ xoá; chỉ chủ cuộc họp (`ownerUserId`) mới thấy nút Xoá |
