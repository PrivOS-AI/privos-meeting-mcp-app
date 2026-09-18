# Deployment Guide

Runbook đầy đủ (Phase 8). `npm run verify:fast-pr` (typecheck + test + build +
preflight) đã xanh **offline** — 325 test / 62 file, `npm run manifest:lint` +
`npm run preflight` sạch. Deploy thật lên hodao, pairing, cấp bot credential và
checklist e2e thủ công (`manual-e2e-checklist.md`) **chưa chạy** trong môi
trường phát triển này (không có Hub thật/node thật) — thực hiện theo runbook
dưới đây khi có quyền truy cập node.

## Runtime mode (tự phát hiện)

| Mode | Resolved khi | Ghi chú |
|---|---|---|
| `managed` | có `PRIVOS_WORKLOAD_SOCKET` | platform cấp trust |
| `standalone-production` | có `privos-standalone-identity.json` (`npm run pair`) | self-host — dùng cho hodao |
| `development` | không có cả hai, `NODE_ENV`≠production | `npm run dev`, unverified actor cho phép qua `ALLOW_UNVERIFIED_ACTOR=1` |

Có cả socket lẫn identity, hoặc `NODE_ENV=production` mà không có gì → lỗi khởi động.
Container production trần (chưa cài) phục vụ **manifest-only** (`/health` degraded, `/ready` 503).

## Development

```bash
NODE_ENV=development npm install --include=dev
npm run dev    # PRIVOS_TRANSPORT=relay + Vite dev UI; nhập pairing URL lần đầu
```

> Shell có `NODE_ENV=production` sẽ khiến `npm install` bỏ devDependencies
> (thiếu tsc/vite/vitest). Cài với `NODE_ENV=development ... --include=dev`.

## Verify trước khi ship

```bash
npm run verify:fast-pr   # typecheck + test + build + preflight
```

Chạy riêng từng gate khi cần cô lập lỗi:

```bash
tsc -p tsconfig.json --noEmit && tsc -p tsconfig.server.json --noEmit   # typecheck (ui + server)
npm run test                                                            # vitest — 325 test / 62 file
npm run build                                                           # vite build + generate-manifest + manifest:lint
NODE_ENV=development npm run preflight                                  # marketplace validation mirror
```

## Production trên hodao (pm2, port 3012)

Sửa code local → rsync → restart trên node. **Không** chạy local và node cùng
lúc (relay báo trùng identity, app rớt kết nối).

```bash
bash scripts/deploy-hodao.sh
```

Script làm gì:
1. In trạng thái cổng 3012 trên node (thông tin, không chặn).
2. `rsync -az` loại trừ `node_modules/`, `.git/`, `.recyclebin/`, `*.tsbuildinfo`, `data/`.
3. `chown -R root:root` + `chmod 600` `privos-standalone-identity.json`/`.env`
   (pm2 chạy root; rsync giữ nguyên uid local nên phải chỉnh lại).
4. Tải model ONNX vào `models/` nếu chưa có (idempotent, xem mục riêng dưới).
5. `npm install --no-audit --no-fund` + `npm run build`.
6. `pm2 reload`/`restart`/`start` (dùng `ecosystem.config.cjs` nếu app đã có entry
   ở đó, `--kill-timeout 15000` khi tự `pm2 start`) + `pm2 save`.
7. Health check `/health` + `/ready` (5 lần, in kết quả — không chặn deploy).
8. In nhắc backup `VOICEPRINT_ENC_KEY` nếu đây là lần đầu sinh khoá.

- Node: `ssh -i ~/.ssh/thanh-dev -p 22087 root@hub002.roxane.one` (OS hostname `hodao`)
- Remote: `/opt/privos/apps/meeting-agent` · pm2 process: `meeting-agent` · port `3012`
  (đã xác minh trống lúc lập kế hoạch — chỉ 3011 gia-phả và 3000 business-hub đang dùng)

### pm2 entry (`/opt/privos/apps/ecosystem.config.cjs`)

```js
{
  name: 'meeting-agent',
  cwd: '/opt/privos/apps/meeting-agent',
  script: 'npm', args: 'run start:standalone',
  env: { NODE_ENV: 'production', PORT: '3012' },
  max_memory_restart: '2G',
  autorestart: true, kill_timeout: 15000,
  out_file: '/var/log/privos/meeting-agent.out.log',
  error_file: '/var/log/privos/meeting-agent.err.log',
}
```

`kill_timeout: 15000` để job đang chạy kịp dừng khi pm2 gửi SIGTERM: `index.ts`
đăng ký handler dừng nhận job mới (`meetingQueue.startDraining()`) và dừng vòng
lặp retention ngay lập tức, để pm2's `kill_timeout` chỉ còn phải chờ job **đang
chạy** (nếu có) tới khi tự xong hoặc tự timeout — không có job mới bị cắt giữa
chừng. `serveApp` tự xử lý SIGTERM/SIGINT cho transport/HTTP server
(`installSignalHandlers`, mặc định bật).

Chưa có entry trong `ecosystem.config.cjs` (lần đầu deploy) → script tự
`pm2 start 'npm run start:standalone' --name meeting-agent --kill-timeout 15000`;
thêm entry ở trên vào file dùng chung rồi `pm2 save` để sống sót qua
`pm2 resurrect`/reboot node.

### Lần đầu deploy (thủ công, ngoài script)

1. Xác minh cổng 3012 còn trống (`ss -ltnp`).
2. Tạo `/opt/privos/apps/meeting-agent`, copy `.env` (chmod 600) — xem § Env.
3. Chạy `scripts/deploy-hodao.sh` (tải model, build, cài đặt).
4. `npm run pair` (2 lần theo quy trình gia-phả — lần 1 sinh identity, lần 2 xác nhận).
5. Nhờ admin Hub cấp `PRIVOS_AGENT_BOT_USER_ID`/`PRIVOS_AGENT_BOT_CREDENTIAL`
   (Admin → Apps → Meeting Agent → Settings) và thêm bot vào một phòng thử.
6. Thêm entry vào `ecosystem.config.cjs`, `pm2 start` (hoặc để script tự làm), `pm2 save`.
7. Health check (xem dưới) + gọi `meeting_agent_bot_credential_check` từ phòng thử → `valid`.
8. Chạy `docs/manual-e2e-checklist.md` trên node thật, ghi kết quả vào chính file đó.

### Health check

```bash
curl -s localhost:3012/health                                    # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}' localhost:3012/ready       # 200
pm2 logs meeting-agent --lines 50                                 # relay.connected, không lỗi lặp
```

Gọi tool `meeting_agent_bot_credential_check` từ một phòng đã cài app → `status:'valid'`.

### Rollback

`pm2 stop meeting-agent` → app biến mất khỏi Hub ngay, dữ liệu App DB/Files giữ
nguyên (không mất gì). Quay lại phiên bản trước: rsync lại từ tag git trước đó
(`git checkout <tag-cũ> -- .` trên một checkout sạch, hoặc rsync từ máy local đã
`git checkout`) rồi chạy lại `scripts/deploy-hodao.sh`. **Không bao giờ**
`dropCollection`/xoá App DB trong lúc rollback — voiceprint không tái tạo được
từ audio đã xoá (audio gốc bị xoá theo `keepOriginalAudio`/`autoDeleteAudioDays`
ngay sau khi xử lý xong).

## Model nhận diện giọng nói (`SPEAKER_MODEL_PATH`)

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
  `SPEAKER_MODEL_SHA256` để xác minh checksum sau tải (`sha256sum -c`).
- **Model/ngưỡng chưa benchmark trên dữ liệu thật** (plan.md câu hỏi mở #5) —
  chạy `npm run calibrate:speaker -- ./samples` (`<samples>/<person>/<file>.wav`,
  16kHz mono PCM16) để đo FAR/FRR/EER trước khi tin `SPEAKER_MATCH_THRESHOLD`
  mặc định (`0.5`).

## Backup và xoay `VOICEPRINT_ENC_KEY`

**Mất khoá này = mất khả năng giải mã TOÀN BỘ voiceprint đã lưu — không có
đường khôi phục.** Bắt buộc backup ngay sau khi sinh khoá, trước khi có người
dùng thật enrol giọng.

1. **Sinh khoá** (chỉ một lần, trước lần deploy đầu tiên):
   ```bash
   openssl rand -base64 32
   ```
2. Đặt vào `.env` trên node: `VOICEPRINT_ENC_KEY=<giá trị trên>`, sau đó
   `chmod 600 .env` (script deploy đã tự làm bước chmod sau mỗi rsync).
3. **Backup ngay**: sao chép giá trị vào kho bí mật của tổ chức (password
   manager / secret vault dùng chung của team vận hành) — **không** commit vào
   git, **không** gửi qua chat không mã hoá.
4. Xác nhận backup đọc lại được trước khi coi là hoàn tất (không chỉ lưu, mà
   thử lấy lại).

**Quy trình xoay khoá** (khi nghi lộ hoặc theo chính sách định kỳ của tổ chức):
Không có cách "re-encrypt tại chỗ" — mọi voiceprint mã hoá bằng khoá cũ trở
thành không đọc được với khoá mới (HMAC sai → `openEmbedding` trả `null` +
log `hmac_mismatch`, không crash app). Quy trình:
1. Thông báo trước cho người dùng: auto-label sẽ ngừng hoạt động tạm thời.
2. Đổi `VOICEPRINT_ENC_KEY` trong `.env`, `pm2 restart meeting-agent`.
3. Mỗi người cần được nhận diện lại phải qua `speaker_resolve` (gán tên/link
   lại) ở cuộc họp kế tiếp — hồ sơ mới enrol bằng khoá mới, không migrate hồ sơ cũ.
4. `speaker_profile_delete` các hồ sơ cũ không còn dùng được nếu muốn dọn sạch
   (tuỳ chọn — hồ sơ cũ không tự mất, chỉ không match được nữa).

## Nhà cung cấp STT (`stt-provider.ts`, đổi qua Settings)

Bốn cài đặt sau interface chung: `soniox-realtime` | `elevenlabs-realtime` |
`soniox-async` | `elevenlabs-batch`. Chọn bằng **Settings › Speech recognition**
trong app (chỉ workspace admin, `meeting_settings_set` ghi `app_settings.sttRealtimeProvider`/
`sttAsyncProvider`) — đổi provider là đổi một ô Settings, **không cần** deploy
lại hay republish manifest (CSP đã khai sẵn cả hai origin WS).

| | Realtime | Async |
|---|---|---|
| Soniox | `SONIOX_API_KEY`, `SONIOX_RT_MODEL`, `SONIOX_TEMP_KEY_TTL_SEC` | `SONIOX_API_KEY`, `SONIOX_ASYNC_MODEL` |
| ElevenLabs | `ELEVENLABS_API_KEY`, `ELEVENLABS_REALTIME_MODEL` | `ELEVENLABS_API_KEY`, `ELEVENLABS_BATCH_MODEL`, `ELEVENLABS_DIARIZATION_THRESHOLD` |

Hệ quả khi chọn `elevenlabs-realtime`: **không có nhãn người nói trực tiếp**
(P5 tắt cho cuộc họp đó, QĐ-18) — UI hiện cảnh báo, nhãn đến từ pass async sau
khi họp kết thúc. `meeting_stt_status` (admin) probe rẻ cả hai nhà cung cấp
(Soniox: mint temp key TTL 10s rồi bỏ; ElevenLabs: `GET /v1/user/subscription`)
và hiện `configured`/`ok`/`reason` (`not_configured`/`invalid_key`/`network_error`/
`http_error`) + usage (ElevenLabs: tier/characterCount/characterLimit) cho
**cả hai** provider, kể cả cái không đang dùng — để so sánh trước khi đổi.
Không có ô nhập API key ở bất kỳ đâu trong UI (QĐ-08) — khoá luôn là env trên
máy chủ.

**A/B tiếng Việt**: `scripts/spikes/ab-vietnamese-quality.ts` — chưa chạy trong
môi trường này (cần audio thật + cả hai khoá vendor). Chỉ chọn giá trị MẶC ĐỊNH
của `STT_*_PROVIDER`, không chặn bất kỳ phase nào (QĐ-15).

## Retention (job dọn dẹp)

Nguồn cấu hình duy nhất: `app_settings` (không còn env riêng cho retention).
Chạy lúc boot + mỗi 6h (`src/server/jobs/audio-retention-job.ts`'s
`startAudioRetention`, khởi động trong `index.ts`) trên mọi `knownRooms`, và
ngay khi một phòng mở qua `meeting_bootstrap` (`purgeExpiredAudio`).

- `autoDeleteAudioDays` (mặc định 90, `0` = tắt): xoá `audioFileId` của cuộc
  họp `summarized` có `keepAudio:true` khi `endedAt` quá hạn, set `audioDeletedAt`.
- `interruptedPartsRetentionDays` (mặc định 7): xoá các `audio.part-*` mồ côi
  của cuộc họp `interrupted` quá hạn.
- `pendingEmbedding` (cố định 30 ngày, không cấu hình được — phase-04's mục nợ
  kỹ thuật): xoá ciphertext biometric còn treo (chưa qua `speaker_resolve`) của
  một cuộc họp đã kết thúc ≥30 ngày; nhãn "Người nói N" giữ nguyên, chỉ ciphertext bị xoá.

Đổi `autoDeleteAudioDays`/`interruptedPartsRetentionDays` qua Settings › Privacy
(admin-only, `meeting_settings_set`).

## Phụ thuộc phía Hub chưa xác nhận: `screen-wake-lock`

`privos-app.json`'s `_meta.ui.permissions` đã khai `["microphone", "screen-wake-lock"]`
(P2 — màn hình không tắt khi đang ghi), nhưng Hub hiện chỉ cấp
`camera`/`microphone` trong `allow` của iframe sandbox
(`use-mcp-bridge-host.ts:193-198`, `buildSandboxAttrs`/`embedAllowAttribute`).
App tự vẫn hoạt động nếu Hub chưa cấp — `navigator.wakeLock.request('screen')`
thất bại êm, UI hiện dải `keep-awake-notice` hướng dẫn người dùng tự tắt sleep,
**ghi âm không phụ thuộc wake lock** (không mất part nào). Cần một ticket phía
đội Hub để thêm `screen-wake-lock` vào danh sách `allow` cấp cho MCP app iframe
trước khi checklist e2e mục 21 có thể PASS đầy đủ trên thiết bị thật (plan.md
câu hỏi mở #12).

## Env

Xem `.env.example` (đầy đủ) và `privos-app.json` § env. Bắt buộc production:
`SPEAKER_MODEL_PATH`, `VOICEPRINT_ENC_KEY`, `PRIVOS_FILES_ORIGIN`,
`PRIVOS_AGENT_BOT_USER_ID`, `PRIVOS_AGENT_BOT_CREDENTIAL`, và khoá của (các)
provider đang chọn (`SONIOX_API_KEY` và/hoặc `ELEVENLABS_API_KEY` — nhà cung
cấp đang chọn ở `STT_REALTIME_PROVIDER`/`STT_ASYNC_PROVIDER` **bắt buộc** phải
có khoá, kiểm lúc boot và fail-fast trong production nếu thiếu).
