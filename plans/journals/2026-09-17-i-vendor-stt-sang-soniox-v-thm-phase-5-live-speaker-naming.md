---
title: Đổi vendor STT sang Soniox và thêm Phase 5 live speaker naming
date: 2026-09-17
summary: "Khảo sát live diarization ngoài ElevenLabs → chọn Soniox (realtime + async, 1 vendor); thêm Phase 5 gắn tên người nói gần-realtime từ part 60s; red-team session 2 16 findings đều áp dụng; plan 8 phase / 26d"
---

# Đổi vendor STT sang Soniox và thêm Phase 5 live speaker naming

## What happened
- User yêu cầu research giải pháp live speaker diarization ngoài ElevenLabs và phương án cắt recording thành mảnh nhỏ để resolve speaker trong khi caption vẫn realtime.
- Reports: `plans/reports/researcher-260917-1550-live-diarization-market-survey.md`, `researcher-260917-1550-incremental-chunk-diarization-design.md`, `synthesis-260917-1555-live-speaker-diarization-options.md`, `researcher-260917-1608-soniox-vietnamese-and-async-deep-dive.md`.
- Kết quả: ElevenLabs realtime không có diarization; Soniox realtime `stt-rt-v5` có nhãn người nói mọi ngôn ngữ (kể cả VN), $0.12/h; Soniox async `stt-async-v5` $0.10/h thay được ElevenLabs batch → 1 vendor. Speechmatics là vendor duy nhất có enrollment native (bị khoá theo model version) → chỉ pilot. Self-host live diarization (diart/NeMo) không hợp node CPU-only không torch.
- Plan sửa: Soniox single vendor (ElevenLabs = fallback có cổng A/B VN ≥30 phút), Phase 5 mới "Live speaker naming from chunks" (Soniox turns + sherpa-onnx embedding trên part 60s, không cần model diarization server), dịch live bằng `translation: two_way` của Soniox.
- Red-team session 2 (2 reviewer): 16 findings, 8 Critical → tất cả Accept. Đáng nhớ: SDK Soniox web tự bắt mic (bỏ AudioWorklet/PCM tự chế); AudioWorklet không load được trong iframe srcdoc; Hub Files upload là upsert theo path → folder/part phải chứa `meetingId`; registry phải verify mọi observation trước khi bind nhãn; RenderQueue của gia phả không cancel được → keyed-serial-queue riêng.

## Decision
- Soniox làm STT duy nhất; mọi con số WER tiếng Việt của Soniox là tự công bố → cổng A/B P1 là bắt buộc trước P2.
- Chi phí họp 2h ≈ $0.44 (Soniox) so với ~$0.84–1.04 khi ghép ElevenLabs.

## Next steps
- Chạy `/ak:cook <plan>/plan.md`; P1 có 11 spike, spike SDK (P1-10) quyết định mọi call site P2.
- Cần: ngày chạy A/B + tài khoản ElevenLabs cho nhánh so sánh; xác nhận `translation: two_way` chạy cùng diarization; hạn mức 10 WS/tài khoản có nâng được không.
- AgentWiki publish skipped.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
