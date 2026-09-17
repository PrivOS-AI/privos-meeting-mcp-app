# Meeting Agent — Project Overview / PDR

## Outcome

MCP app PrivOS (`ai.privos.meeting-agent`) cho họp offline: bấm ghi trong phòng →
mic trình duyệt thu toàn bộ cuộc họp + live caption song ngữ **kèm nhãn người nói
ngay lập tức** → sau ~70-90s nhãn được thay bằng **tên thật** nhờ voiceprint →
"End & summarize" → pass async authoritative → tóm tắt bằng Hub AI → lưu transcript
+ summary vào PrivOS Files → xem lại (history, detail, player, search, export).

## Users & context

Thành viên phòng PrivOS họp trực tiếp trong một phòng. Không có bot join họp online,
không upload audio có sẵn (v1). Chạy production trên node **hodao** (pm2, port 3012).

## Key decisions (tóm tắt)

- **Hai nhà cung cấp STT hạng nhất** sau `stt-provider.ts` (Soniox / ElevenLabs),
  chọn theo workspace qua Settings (QĐ-15). Mặc định realtime = Soniox (provider duy
  nhất có nhãn người nói live, QĐ-18). Pass async là nguồn sự thật cho transcript.
- SDK nhà cung cấp tự thu audio từ một `MediaStream` ta cấp (QĐ-01) — app không tự
  chuyển PCM, không dựng wire protocol.
- Voiceprint bằng `sherpa-onnx-node`, **mã hoá AES-256-GCM + HMAC** trong App DB
  (QĐ-06); match ở backend, iframe không bao giờ thấy vector.
- Độ bền audio dựa trên **part file trên Files**, không dựa IndexedDB (QĐ-13).
- Tóm tắt + dịch batch bằng **Hub AI** (QĐ-07), không gửi transcript ra bên thứ ba.
- App DB = metadata + speaker map + action items; Files = transcript đầy đủ (QĐ-04).

## Non-goals (v1)

Upload audio có sẵn; video/bot join họp online; vector search trong App DB; RAG
"Ask AI" thực thụ; multi-tenant billing; tự tách một session speaker thành hai người.

## Acceptance criteria

Xem plan `plans/260917-1358-…/plan.md` § Acceptance criteria (nguồn sự thật). Gồm:
ghi 60 phút liên tục + khôi phục sau crash; chịu mạng hỏng ≤ retry window; live
caption < 1s + nhãn tên thật ≤ 90s (Soniox); 4 file đầy đủ sau End; cô lập dữ liệu
giữa phòng; history/detail/player/search/export; `verify:fast-pr` xanh; chạy pm2.

## Status

Phase 1 (scaffold + foundational spikes) — xem `project-roadmap.md`. Spike sống chưa
chạy (cần credential + Hub thật); code deterministic đã dựng và xanh offline.
