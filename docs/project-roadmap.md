# Project Roadmap

Nguồn kế hoạch đầy đủ: `plans/260917-1358-meeting-agent-mcp-app-elevenlabs-diarization-voice-fingerprint/`.

| # | Phase | Trạng thái | Ghi chú |
|---|---|---|---|
| 1 | Scaffold app foundation | **Deterministic done** (spike sống + pair Hub + A/B + deploy chưa chạy) | Code/test/build/manifest:lint/preflight xanh offline |
| 2 | Live recording & realtime captions | pending | **Chờ spike SDK (spike-10) chốt trước khi viết** |
| 3 | Post-meeting diarization pipeline | pending | Chờ spike Soniox async (spike-09) |
| 4 | Speaker identity & voice fingerprint | pending | Cần model ONNX + `VOICEPRINT_ENC_KEY` |
| 5 | Live speaker naming from chunks | pending | Phụ thuộc P3, P4 |
| 6 | AI summary, translation, save to Files | pending | Hub AI (spike-05) |
| 7 | History & meeting detail review | pending | Phụ thuộc P3–P6 |
| 8 | Settings, hardening, tests, hodao deploy | pending | negative tests, retention, CSP, deploy |

## Cổng chặn còn lại của Phase 1 (cần môi trường thật)

- 11 spike nền tảng trong `scripts/spikes/` — cần Hub thật + credential bot + khoá
  Soniox/ElevenLabs + audio thật. Điền kết quả vào `docs/system-architecture.md`.
- `npm run pair` + mở tool trong phòng Hub (mic prompt, WS Soniox, App DB, credential valid).
- A/B tiếng Việt (không chặn P2) — chọn mặc định `STT_*_PROVIDER`.
- Deploy pm2 trên hodao.

**Quy tắc**: spike nền tảng nào fail → dừng, ghi lỗi nguyên văn vào plan.md § Câu hỏi
chưa giải quyết, **không** dựng sẵn đường thay thế. Đặc biệt: **không viết P2 trước khi
spike-10 (bề mặt API SDK) chốt.**
