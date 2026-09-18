# Deployment Guide

Chi tiết vận hành đầy đủ được hoàn thiện ở Phase 8. Bản này ghi những gì đã đúng ở Phase 1.

## Runtime mode (tự phát hiện)

| Mode | Resolved khi | Ghi chú |
|---|---|---|
| `managed` | có `PRIVOS_WORKLOAD_SOCKET` | platform cấp trust |
| `standalone-production` | có `privos-standalone-identity.json` (`npm run pair`) | self-host |
| `development` | không có cả hai, `NODE_ENV`≠production | `npm run dev`, unverified actor |

Có cả socket lẫn identity, hoặc `NODE_ENV=production` mà không có gì → lỗi khởi động.
Container production trần (chưa cài) phục vụ **manifest-only** (`/health` degraded, `/ready` 503).

## Development

```bash
NODE_ENV=development npm install --include=dev
npm run dev    # PRIVOS_TRANSPORT=relay + Vite dev UI; nhập pairing URL lần đầu
```

> Lưu ý: shell có `NODE_ENV=production` sẽ khiến `npm install` bỏ devDependencies
> (thiếu tsc/vite/vitest). Cài với `NODE_ENV=development ... --include=dev`.

## Verify trước khi ship

```bash
npm run verify:fast-pr   # typecheck + test + build + preflight
```

## Production trên hodao (pm2, port 3012)

Sửa code local → rsync → restart trên node. **Không** chạy local và node cùng lúc.

```bash
bash scripts/deploy-hodao.sh
```

- Node: `ssh -i ~/.ssh/thanh-dev -p 22087 root@hub002.roxane.one` (hodao)
- Remote: `/opt/privos/apps/meeting-agent` · pm2: `meeting-agent`
- Sau rsync: `chown -R root:root` + `chmod 600` identity/.env (pm2 chạy root).
- Provision trên node: `.env` (đủ khoá vendor + bot credential + `VOICEPRINT_ENC_KEY`
  + `PRIVOS_FILES_ORIGIN`).
- `VOICEPRINT_ENC_KEY` **phải backup** — mất khoá = mất toàn bộ voiceprint.

## Model nhận diện giọng nói (`SPEAKER_MODEL_PATH`, P4)

`scripts/deploy-hodao.sh` tự tải model ONNX vào `models/` trên node nếu chưa có
(idempotent — không tải lại mỗi lần deploy). Model **không** commit vào mã
nguồn (`models/` đã `.gitignore`); `sherpa-onnx-node` (Apache-2.0, native addon
`sherpa-onnx-linux-x64`) cài qua `npm install` như dependency thường.

- Mặc định script tải `3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`
  từ [sherpa-onnx speaker-recognition-models release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models),
  lưu thành `models/3dspeaker_speaker-embedding_advanced.onnx` (khớp
  `SPEAKER_MODEL_PATH` mặc định trong `env.ts`).
- Đổi model: set `SPEAKER_MODEL_FILE`/`SPEAKER_MODEL_URL` (và `SPEAKER_MODEL_PATH`
  trong `.env` trên node) trước khi chạy `deploy-hodao.sh`; tuỳ chọn
  `SPEAKER_MODEL_SHA256` để xác minh checksum sau tải.
- **Model/ngưỡng chưa benchmark** (plan.md câu hỏi mở #5) — chạy
  `npm run calibrate:speaker -- ./samples` (`<samples>/<person>/<file>.wav`,
  16kHz mono PCM16) để đo FAR/FRR/EER thật trước khi tin `SPEAKER_MATCH_THRESHOLD`
  mặc định (`0.5`).

## Env

Xem `.env.example` (đầy đủ) và `privos-app.json` § env. Bắt buộc production:
`SPEAKER_MODEL_PATH`, `VOICEPRINT_ENC_KEY`, `PRIVOS_FILES_ORIGIN`,
`PRIVOS_AGENT_BOT_USER_ID`, `PRIVOS_AGENT_BOT_CREDENTIAL`, và khoá của provider đang chọn.
