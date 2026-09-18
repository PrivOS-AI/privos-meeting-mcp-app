# Manual E2E Checklist (chạy trên node thật — hodao)

Nguồn: `plans/260917-1358-meeting-agent-mcp-app-elevenlabs-diarization-voice-fingerprint/phase-08-settings-hardening-tests-and-hodao-deploy.md`
§ "Checklist e2e thủ công". Mọi mục dưới đây **chưa chạy** trong môi trường này —
không có Hub thật, khoá vendor thật, hay node hodao trong phiên làm việc này
(chỉ static verification: typecheck/test/build/manifest:lint/preflight). Chạy
trên node thật sau khi `npm run pair` + cấp bot credential (xem
`deployment-guide.md`), rồi điền `PASS`/`FAIL` + ngày + người chạy vào cột
Kết quả. **Không** đánh dấu PASS mà chưa thực sự chạy trên node thật.

| # | Kịch bản | Kết quả |
|---|---|---|
| 1 | Ghi 10 phút, 3 người nói, có bookmark → caption hiện kèm badge `Người nói N`; sau ~70-90s người đã có voiceprint đổi thành tên thật, dòng cũ cũng đổi (text không đổi) | _chưa chạy_ |
| 2 | Refresh tab giữa chừng → recovery banner → upload lại được | _chưa chạy_ |
| 3 | End & summarize → processing 8 bước (download → transcribe → segment → decode → embed → summarize → write → cleanup) → Files có 5 file (hoặc 4 nếu không giữ audio) | _chưa chạy_ |
| 4 | Modal xác nhận người nói → `speaker_resolve`: gán 1 PrivOS user, 1 tên tự do, 1 "cùng người với"; quick-assign giữa họp; tên giữ nguyên sau khi pass async chạy xong | _chưa chạy_ |
| 5 | Họp thứ hai cùng người → auto-label đúng, confidence hiển thị | _chưa chạy_ |
| 6 | Sửa 1 nhãn sai trong detail → voiceprint cập nhật | _chưa chạy_ |
| 7 | Push to Smart List 2 lần → không trùng item | _chưa chạy_ |
| 8 | Export SRT + DOCX mở được | _chưa chạy_ |
| 9 | Bật "Giữ audio gốc" + retention 1 ngày → mở lại app hôm sau (`meeting_bootstrap`) → audio biến mất, `audioDeletedAt` được set; bỏ dở một cuộc họp → sau 10 phút thành `interrupted`, part được dọn sau `interruptedPartsRetentionDays` | _chưa chạy_ |
| 10 | Xoá 1 voiceprint (`speaker_profile_delete`) → họp sau không auto-label người đó nữa | _chưa chạy_ |
| 11 | Xoá `PRIVOS_AGENT_BOT_CREDENTIAL` → banner cảnh báo, `meeting_process` từ chối sớm (không treo) | _chưa chạy_ |
| 12 | Dịch song ngữ: bật toggle → caption có bản dịch từ chính luồng token Soniox khi ghi (không lời gọi Hub AI nào lúc live), transcript sau xử lý có `translation` cho mọi segment cần dịch | _chưa chạy_ |
| 13 | Ghi 60 phút có bóp mạng 10 phút: bộ nhớ tab phẳng, part liên tục, xử lý xong bình thường; soak chunk worker: RSS backend phẳng, mỗi chunk < 3s CPU, không chunk nào bị bỏ | _chưa chạy_ |
| 14 | Đổi `VOICEPRINT_ENC_KEY` sang khoá khác → auto-label ngừng hoạt động nhưng app không crash; khôi phục khoá cũ → hoạt động lại | _chưa chạy_ |
| 15 | Kill pm2 giữa cuộc họp rồi start lại → chunk kế tiếp dựng lại registry, nhãn live không reset về `Người nói 1` | _chưa chạy_ |
| 16 | Rút `SONIOX_API_KEY` sai → `meeting_stt_status` trả `{ok:false, reason:'invalid_key'}`, `meeting_realtime_token` từ chối kèm thông báo rõ, ghi âm vẫn chạy (chỉ mất caption) | _chưa chạy_ |
| 17 | Mở đồng thời quá `LIVE_MAX_CONCURRENT_RECORDINGS` cuộc họp → cuộc vượt trần nhận thông báo tiếng Việt, vẫn ghi âm, tên người nói có sau khi xử lý | _chưa chạy_ |
| 18 | Job bị kill giữa lúc poll Soniox → GET file/transcription phía Soniox trả 404 sau boot sweep; retry không upload lại (tra theo `client_reference_id`) | _chưa chạy_ |
| 19 | Đổi nhà cung cấp trong Settings (realtime và async, từng cái một) → cuộc họp mới dùng đúng provider, cuộc đang chạy không bị ảnh hưởng; với `elevenlabs-realtime` caption không nhãn + cảnh báo đúng, nhãn vẫn đầy đủ sau khi xử lý | _chưa chạy_ |
| 20 | Rút khoá của nhà cung cấp đang chọn → `meeting_stt_status` chỉ rõ bên nào hỏng, `meeting_realtime_token`/`meeting_process` báo lỗi nói rõ setting nào cần đổi; nhà cung cấp còn lại vẫn dùng được ngay sau khi đổi Settings | _chưa chạy_ |
| 21 | Màn hình không tắt khi ghi: trên laptop đặt sleep 1 phút, ghi 5 phút không chạm → màn hình vẫn sáng (nếu Hub đã cấp `screen-wake-lock`); nếu chưa, dải `keep-awake-notice` hiện và bản ghi vẫn đủ part | _chưa chạy_ |

## Trước khi chạy

1. `npm run verify:fast-pr` xanh cục bộ (đã xác nhận offline — xem `codebase-summary.md`).
2. Deploy hodao theo `deployment-guide.md` (rsync + model + `.env` + pm2 + ecosystem entry).
3. `npm run pair` (2 lần theo quy trình gia phả) rồi admin cấp `PRIVOS_AGENT_BOT_USER_ID`/`PRIVOS_AGENT_BOT_CREDENTIAL` + thêm bot vào phòng thử.
4. `/health` + `/ready` trả 200, `pm2 logs meeting-agent` không lỗi lặp.

Ghi kết quả từng mục vào cột "Kết quả" (PASS/FAIL + ngày + ghi chú) khi chạy thật;
FAIL nào cũng ghi nguyên văn lỗi quan sát được, không tự chế cách vá.
