# Project Roadmap

Nguồn kế hoạch đầy đủ: `plans/260917-1358-meeting-agent-mcp-app-elevenlabs-diarization-voice-fingerprint/`.

| # | Phase | Trạng thái | Ghi chú |
|---|---|---|---|
| 1 | Scaffold app foundation | **Deterministic done** | Code/test/build/manifest:lint/preflight xanh offline |
| 2 | Live recording & realtime captions | **Deterministic done** | Soniox/ElevenLabs realtime SDK wiring; spike sống chưa chạy |
| 3 | Post-meeting diarization pipeline | **Deterministic done** | `meeting-job.ts` pipeline; Soniox async/ElevenLabs batch chưa gọi thật |
| 4 | Speaker identity & voice fingerprint | **Deterministic done** | Voiceprint mã hoá, `speaker_resolve`; model ONNX + `VOICEPRINT_ENC_KEY` cần deploy thật |
| 5 | Live speaker naming from chunks | **Deterministic done** | `session-speaker-registry` + chunk worker |
| 6 | AI summary, translation, save to Files | **Deterministic done** | Hub AI wiring; `agents.sandbox.generate-async` chưa gọi thật |
| 7 | History & meeting detail review | **Deterministic done** | History/detail/player/search/export |
| 8 | Settings, hardening, tests, hodao deploy | **Deterministic done** | 18 tool, 325 test/62 file, Settings 7 mục, retention, cross-room authz + folder-collision tests, docs, `deploy-hodao.sh` finalized. **Deploy thật lên hodao + pairing + manual e2e checklist chưa chạy** (cần node/Hub thật) |

"Deterministic done" = `npm run verify:fast-pr` (typecheck + test + build +
preflight) xanh offline trên máy phát triển. Không có nghĩa là đã chạy trên Hub
thật, đã pairing, hay đã xác nhận hành vi runtime với khoá vendor thật.

## Còn lại trước khi go-live (cần môi trường thật)

- 11 spike nền tảng trong `scripts/spikes/` + `ab-vietnamese-quality.ts` — cần
  Hub thật + credential bot + khoá Soniox/ElevenLabs + audio thật. Điền kết quả
  vào `docs/system-architecture.md` § Spike results.
- Deploy hodao theo `docs/deployment-guide.md` runbook: rsync, model ONNX,
  `.env`, `npm run pair` (2 lần), admin cấp bot credential, thêm bot vào phòng,
  `ecosystem.config.cjs` entry, `pm2 save`, health check.
- **Backup `VOICEPRINT_ENC_KEY`** ngay sau khi sinh khoá lần đầu (không có
  đường khôi phục nếu mất).
- Chạy `docs/manual-e2e-checklist.md` (21 mục) trên node thật, ghi kết quả vào
  chính file đó.
- Model/ngưỡng nhận diện người nói chưa benchmark (`npm run calibrate:speaker`)
  trên dữ liệu thật (plan.md câu hỏi mở #5).

**Quy tắc**: mục nào fail khi chạy thật → dừng, ghi lỗi nguyên văn vào plan.md
§ Câu hỏi chưa giải quyết hoặc vào chính checklist, **không** tự dựng đường
thay thế chưa được duyệt.
