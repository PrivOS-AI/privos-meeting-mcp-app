---
title: Lập kế hoạch Meeting Agent MCP app (ElevenLabs diarization + voiceprint)
date: 2026-09-17
summary: "Plan 7 phase / 22d cho PrivOS MCP app ghi âm họp offline, diarization, voiceprint mã hoá, Hub AI tóm tắt + dịch; red-team 16 findings đều được áp dụng"
---

# Lập kế hoạch Meeting Agent MCP app (ElevenLabs diarization + voiceprint)

## What happened
- Scout: `~/projects/privos-mcp-app-demo` (manifest v3, bot-credential tool-call), `~/projects/genealogy-privos-mcp-app` (template + rsync/pm2 hodao), design export `resources/Caption application design` (5 screens 1a-1e).
- Research: ElevenLabs Scribe batch có diarization (≤32 speaker, 10h), realtime KHÔNG có diarization, KHÔNG có API enroll speaker library (soát SDK source). Voiceprint → `sherpa-onnx-node` thuần Node (hodao không ffmpeg/torch/GPU).
- Plan: `plans/260917-1358-meeting-agent-mcp-app-elevenlabs-diarization-voice-fingerprint/` — 7 phase, 22d, 16 MCP tools, 185 task.
- Red-team 4 lens → 32 findings thô → 16 sau khử trùng lặp → 13 Accept, 3 Accept-modified, 0 Reject.

## Root causes / lessons
- Planner giả định backend không gọi được `mcpapp.db.*` khi không có user session → SAI: demo `src/app-platform-tool-call.ts` dùng `createAgentBotHubClient().authorizedFetch('/api/v1/mcp-apps.tool-call')`. Luôn đối chiếu code mẫu trước khi dựng workaround.
- Iframe MCP app là opaque-origin sandbox → IndexedDB không đáng tin cho độ bền audio; `app.uploadFile` là base64 qua postMessage → không upload file lớn một lần. Giải pháp: upload part-file tuần tự trong lúc ghi.
- Mic chỉ được cấp khi khai `_meta.ui.permissions: ["microphone"]` (Hub `use-mcp-bridge-host.ts:196`).
- Hub source: `roomId` chỉ bắt buộc với collection `scope:'room'` (`mcp-app-db-schema-registry.ts:19-23`) → global collection đăng ký/đọc room-less được.

## Decision (user)
- Chỉ ghi âm live qua mic (theo design); App DB thay Lists (Lists chỉ có 5 field type); voiceprint lưu App DB nhưng AES-256-GCM + HMAC với `VOICEPRINT_ENC_KEY`; summarizer + translator = Hub AI (`agents.sandbox.generate-async`, bot token), bỏ ANTHROPIC key; dịch song ngữ cả live lẫn batch, chấp nhận trễ.
- Deploy: dev local → rsync → pm2 `meeting-agent` :3012 trên hodao.

## Next steps
- Chạy `/ak:cook <plan>/plan.md`; P1 là cổng spike (mic, uploadFile ceiling, CSP/presign origin, global room-less tool-call, Hub AI generate-async bằng bot credential, `mcpapp.bot.getMe`).
- Câu hỏi mở: calibrate ngưỡng cosine trên dữ liệu VN; EER model sherpa; giá ElevenLabs; giới hạn session realtime; App DB quota.
- AgentWiki publish skipped.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
