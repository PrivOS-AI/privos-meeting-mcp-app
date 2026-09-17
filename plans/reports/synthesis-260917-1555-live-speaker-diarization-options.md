# Tổng hợp: Live speaker diarization — lựa chọn ngoài ElevenLabs realtime

Nguồn: `researcher-260917-1550-live-diarization-market-survey.md`, `researcher-260917-1550-incremental-chunk-diarization-design.md`, xác minh trực tiếp docs Soniox (2026-09-17).

## Bối cảnh
Plan hiện tại (QĐ-01): ElevenLabs Scribe realtime chỉ cho caption ($0.39/h, KHÔNG diarization) → nhãn người nói chỉ có sau "End & summarize" (batch diarize $0.22/h + voiceprint sherpa-onnx). User muốn nhãn người nói gần-realtime.

## Kết quả khảo sát thị trường (rút gọn)
| Option | Nhãn live | VN | $/h | Enrollment liên phiên | Ghi chú |
|---|---|---|---|---|---|
| **Soniox realtime `stt-rt-v5`** | Có, mọi ngôn ngữ, ≤15 người, field `speaker` trên token | WER 5.4% (tự công bố) + language-ID token-level cho code-switch VI/EN | **0.12** | Không | Token tạm `POST /v1/auth/temporary-api-key` (`usage_type: transcribe_websocket`) cho browser; nhãn realtime "có thể chuyển tạm rồi ổn định"; async chính xác hơn |
| **Speechmatics realtime + Speaker ID** | Có | WER 8.9% (bench của Soniox) | ~0.24+ | **Có** (enroll 5-30s → identifier, ≤50/phiên) | Identifier khoá theo model version → phải re-enroll khi vendor nâng model |
| Deepgram Nova-3 | Có | có hỗ trợ, không số liệu VN | ~0.29-0.46 + 0.12 | Không | SDK chín |
| AssemblyAI Universal-3.5 Pro | Có (nhãn có thể đổi sau 0.5s) | VN chỉ tier Pro | ~0.45 + 0.12 | Không | cap 3h/phiên |
| Google STT v2 / AWS / Azure | Có | chưa xác nhận VN (AWS mâu thuẫn tài liệu) | 0.96 / free add-on / ? | Không | tích hợp nặng hơn |
| Gladia, Rev AI | **Không** | — | — | — | loại |
| Self-host: diart/pyannote, NeMo Sortformer | Có | độc lập ngôn ngữ (chưa test VN) | 0 | Không | cần Python/torch/GPU, NeMo cap 4 người → không hợp node hodao |
| **Self-host: sherpa-onnx OfflineSpeakerDiarization trên chunk 60s** | Gần-realtime (~70-80s) | độc lập ngôn ngữ | 0 | (dùng voiceprint sẵn có) | Node API xác nhận từ source addon; CPU ≈ 2-5 phút CPU/giờ họp |

Không vendor nào (trừ Speechmatics) cho identity liên phiên → pipeline voiceprint sherpa-onnx (P4) vẫn cần.

## Ba phương án khả thi
**A. Soniox realtime thay ElevenLabs realtime + voiceprint match theo chunk (KHUYẾN NGHỊ)**
- Live: caption + nhãn `Người nói N` ngay (~1s) từ Soniox; chunk worker (P2 part files 60s) chỉ cần *embedding + cosine match* theo segment mà Soniox đã gán → điền TÊN (profile) sau ~60-90s, sửa lùi các dòng đã hiện.
- Không cần model diarization trên server (bỏ pyannote-segmentation), ít code hơn phương án B.
- Chi phí live giảm 0.39 → 0.12 $/h. Batch cuối vẫn ElevenLabs (authoritative) hoặc thử Soniox async sau (chưa research).
- Rủi ro: vendor nhỏ hơn; WER VN tự công bố; nhãn realtime chuyển tạm → cần spike P1 với audio VN thật; CSP connect-src thêm origin Soniox.
- Effort ≈ +3-4d (P2 đổi client WS, P4b chunk-match worker + tool `meeting_chunk_ready`/`meeting_live_speakers`, UI relabel lùi).

**B. Giữ ElevenLabs realtime + self-host sherpa-onnx diarization theo chunk 60s**
- Nhãn sau ~70-80s (30s chunk → ~40s nhưng kém chính xác). Không đổi vendor. $0.39/h giữ nguyên. Effort +5-6d (Phase 4b). Cần tải thêm model pyannote-segmentation-3.0 ONNX; ngưỡng clustering phải calibrate trên hodao.

**C. Speechmatics realtime + Speaker ID native**
- Tên người nói live không cần voiceprint tự dựng → có thể bỏ P4 phần lớn. Nhưng: re-enroll mỗi khi vendor đổi model, WER VN kém hơn, giá tier ID chưa công bố, ≤50 identifier/phiên. Phù hợp làm pilot song song, không nên là v1.

## Kiến trúc chung cho A/B (từ design report)
- Chunk = part file 60s đã upload (không thêm luồng), overlap 5-10s ring buffer; push `meeting_chunk_ready {roomId, meetingId, seq}` sau mỗi part.
- Một đồng hồ họp `recordingEpochMs` (AudioWorklet và MediaRecorder cùng MediaStream) → gắn nhãn vào caption bằng max time-overlap.
- Registry 2 tầng: session-local clusters (centroid) + profile voiceprint (P4); merge lùi khi có bằng chứng; nhãn chỉ hiện sau ≥ N giây nói.
- Final pass sau End vẫn ElevenLabs batch (authoritative), reconcile với nhãn live bằng overlap; nhãn live chỉ phục vụ UI.
- UI: dòng caption chưa nhãn → nhãn `Người nói N` → tên + confidence; nút "Ai đang nói?" gán nhanh trong họp.

## Khuyến nghị
Chọn **A**. Spike P1 bổ sung: Soniox token tạm + WS từ iframe (CSP), chất lượng VN/EN trên 1 file họp thật, độ ổn định nhãn. Nếu spike A fail → B (đã có design chi tiết).

## Câu hỏi chưa giải quyết
1. Soniox: WER VN độc lập, hành vi đổi nhãn realtime, giới hạn phiên, retention/zero-retention.
2. Soniox async có thay được ElevenLabs batch không (giá, chất lượng diarization VN) — chưa research.
3. Ngưỡng cosine session/merge và RTF trên hodao — cần đo thực tế.
4. Speechmatics: retention identifier, giá tier ID — chỉ cần nếu pilot C.
