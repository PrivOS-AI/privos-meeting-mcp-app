---
name: meeting-agent-soniox-switch
description: Meeting Agent plan switched from ElevenLabs to single-vendor Soniox STT (rt + async) with live speaker naming; ElevenLabs kept as documented-only fallback behind an A/B gate
metadata:
  type: project
---

Ngày 2026-09-17 người dùng duyệt đổi kiến trúc STT của Meeting Agent: **Soniox là nhà cung cấp duy nhất** — realtime `stt-rt-v5` (caption + nhãn người nói live) và async `stt-async-v5` (pass authoritative). ElevenLabs bị gỡ khỏi mã, chỉ còn là **fallback có tài liệu, chưa cài** sau interface `src/server/stt/stt-provider.ts`. Thêm Phase 5 "Live speaker naming from chunks"; plan 7 phase/22d → 8 phase/25d.

**Why:** ElevenLabs realtime không có diarization nên nhãn người nói chỉ có sau khi họp xong; Soniox realtime có diarization ≤15 người, rẻ hơn ($0.12/h vs $0.39/h), và async ($0.10/h, nhận webm native) gộp được thành một vendor → ~$0.44 vs ~$0.84-1.04 cho họp 2h, một hợp đồng/retention/compliance.

**How to apply:**
- Đừng đề xuất quay lại ElevenLabs hay thêm provider thứ hai trừ khi **cổng A/B ở P1 trượt** (Soniox VN WER lệch > +2 điểm so với `scribe_v2`, hoặc DER kém rõ rệt, trên ≥30 phút audio họp VN+EN thật). Trượt → cài `elevenlabs-*` sau cùng interface, +2d.
- Rủi ro đã ghi nhận và **đã được người dùng chấp nhận**: mọi số WER tiếng Việt của Soniox đều do chính Soniox công bố, không có nguồn độc lập; vendor ~15 người.
- Không tự dựng model diarization trên server (pyannote/`OfflineSpeakerDiarization` đã bị loại có chủ đích) — Soniox đã cấp turn, ta chỉ làm embedding + cosine bằng sherpa-onnx.
- Đánh số quyết định trong plan: QĐ-01/QĐ-03 (Soniox rt/async), QĐ-15 (single vendor + cổng A/B), QĐ-16 (live naming không cần model server), QĐ-17 (đồng hồ họp `recordingEpochMs`). QĐ-12/QĐ-13 đã bị chiếm bởi quyết định cũ (dịch song ngữ / part-file durability) — không tái sử dụng số.

**Red team phiên 2 (2026-09-17)** — 16 findings, chấp nhận toàn bộ. Bốn thay đổi kiến trúc đáng nhớ nhất:
- **SDK Soniox tự thu audio** từ `MediaStream` ta cấp → bỏ hẳn AudioWorklet/PCM16/`sendPcm`/`bufferedAmount`/config snake_case. AudioWorklet vốn **không nạp được** trong iframe `srcdoc` opaque-origin (`import.meta.url` = `about:srcdoc`) — đừng đề xuất lại.
- **`permissions` và `csp` phải nằm trong cùng object `_meta.ui`**; khai `csp` ở key `ui` anh em thì Hub bỏ qua **im lặng** và manifest vẫn lint sạch.
- **Upload Files là upsert theo (channel, path)** → tên thư mục và tên part phải mang `meetingId8`, part dùng `keep_both`, không bao giờ `replace`. Đây là lỗi mất dữ liệu thật, không phải lo xa.
- **Soniox realtime có `translation: two_way` sẵn trên cùng socket** → bỏ `meeting_translate` + `translate-buffer` (18 → **17 tool**); dịch batch vẫn Hub AI.
Giới hạn tài khoản Soniox: **10 WS đồng thời, 100 req/phút** → `LIVE_MAX_CONCURRENT_RECORDINGS=8`. Mã lỗi "413" cho cap 300 phút là **bịa** — vendor không nêu mã nào.

Tổng effort sau phiên 2: 26d.

**Phiên 3 (2026-09-17) — người dùng đảo quyết định vendor.** Không còn "một nhà cung cấp": **ElevenLabs trở thành provider hạng nhất song song Soniox**, bốn cài đặt sau `stt-provider.ts` (`soniox-realtime`/`elevenlabs-realtime`/`soniox-async`/`elevenlabs-batch`), chọn theo workspace qua `app_settings.sttRealtimeProvider`/`sttAsyncProvider` (admin) với env mặc định. Hệ quả cần nhớ:
- **Cổng A/B tiếng Việt không còn chặn phase nào** — chỉ là script chọn giá trị mặc định. Đừng mô tả nó như blocker nữa.
- **Nhãn người nói > dịch native (QĐ-18)**: chỉ Soniox realtime có diarization live → mặc định realtime = Soniox; chọn ElevenLabs realtime ⇒ **P5 tắt cho cuộc họp đó** (degraded có tài liệu), nhãn đến từ pass async.
- **`meeting_translate` (Hub AI) quay lại** làm đường dịch live chung khi provider không dịch native → **18 tool**.
- CSP khai sẵn **cả hai** origin WS để đổi provider không phải republish manifest; trần `LIVE_MAX_CONCURRENT_RECORDINGS=8` áp chung (QĐ-19, giới hạn ElevenLabs chưa xác minh).
- Effort **28d** (P2 4d, P3 4d, P8 4.5d).

Xem [[meeting-agent-plan-file-conventions]].
