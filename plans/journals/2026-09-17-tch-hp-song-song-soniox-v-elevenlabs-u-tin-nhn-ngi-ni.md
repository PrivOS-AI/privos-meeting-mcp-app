---
title: "Tích hợp song song Soniox và ElevenLabs, ưu tiên nhãn người nói"
date: 2026-09-17
summary: "User chốt: cả 2 STT provider first-class sau SttProvider, mặc định Soniox vì có nhãn live; ElevenLabs realtime = chế độ giảm cấp không nhãn live; meeting_translate quay lại làm đường dịch live chung; cap 8 phiên giữ nguyên; plan 8 phase / 28d"
---

# Tích hợp song song Soniox và ElevenLabs, ưu tiên nhãn người nói

## What happened
- User quyết định: tích hợp cả Soniox và ElevenLabs (realtime + async mỗi bên) sau `src/server/stt/stt-provider.ts`, chọn theo workspace trong Settings (`app_settings.sttRealtimeProvider/sttAsyncProvider`, env mặc định `soniox`). Ưu tiên nhãn người nói: nếu `translation: two_way` xung đột với diarization thì giữ diarization, dịch live đi qua Hub AI `meeting_translate`. Hạn mức socket giữ 8, chưa nâng.
- Hệ quả đã mã hoá: ElevenLabs realtime không có nhãn → Phase 5 live naming tắt cho cuộc họp đó (UI báo "nhãn có sau khi xử lý"); cổng A/B tiếng Việt không còn chặn P2, chỉ dùng để chọn mặc định; provider được ghim theo cuộc họp (`sttSessionMeta`, `processing_jobs.sttProvider`); cả 2 origin WS khai sẵn trong CSP để đổi provider không cần republish manifest.
- Plan: 18 tool, 28d (P2 4d, P3 4d, P8 4.5d), `ak plan validate` OK, sweep phiên 3 sạch.

## Decision
- Hai vendor = hai key phải xoay vòng; quota theo từng provider; ElevenLabs realtime concurrency chưa đo, tạm dùng chung cap 8.

## Next steps
- `/ak:cook <plan>/plan.md`; spike P1-10 (SDK Soniox), P1-8 (translation + diarization cùng lúc), P1-11 (cả 2 SDK boot trong room tab dưới CSP).
- AgentWiki publish skipped.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
