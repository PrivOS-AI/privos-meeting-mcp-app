# PRIVOS.md

This file provides guidance to PrivOS (privos.ai) when working with the project in this repository.

Meeting Agent is a PrivOS MCP app (`ai.privos.meeting-agent`) for offline meeting
capture: browser-mic recording, bilingual live captions with speaker labels,
cross-session speaker identity via encrypted voiceprints, Hub-AI summaries, and
transcript/summary storage in PrivOS Files. Boot goes through the SDK's unified
`serveApp` (`src/server/index.ts`); runtime mode is auto-detected, never set by env.

## Deployment — runs on the hodao node (not locally)

This app runs in **production on the hodao node**, managed by pm2 (systemd boot).
`CLAUDE.md`/`AGENTS.md`/`GEMINI.md` are symlinks to this file, so every agent reads it.

**Workflow: edit code locally here → rsync to the node → restart there.**
Do NOT run the app locally and on the node at the same time — duplicate pairing
identity conflicts on the relay.

- Node: `ssh -i ~/.ssh/thanh-dev -p 22087 root@hub002.roxane.one` (OS hostname `hodao`)
- Remote path: `/opt/privos/apps/meeting-agent`
- pm2 process: `meeting-agent` · port `3012`
- No system ffmpeg, no GPU, Node v22, python3 without torch → audio decode +
  speaker embedding are pure-Node (`@ffmpeg-installer/ffmpeg`, `sherpa-onnx-node`).
- Secrets live only in `.env` (0600) + `privos-standalone-identity.json`.
  `VOICEPRINT_ENC_KEY` **must be backed up** — losing it loses every voiceprint.

Redeploy after a local edit (see `scripts/deploy-hodao.sh`):

```bash
bash scripts/deploy-hodao.sh
```

Notes:
- The deploy script `chown -R root:root` + `chmod 600` the identity/.env after rsync
  (rsync preserves the local uid; pm2 runs as root and refuses the identity otherwise).
- `npm install` only when deps changed; ONNX model + `.env` are provisioned on the node.
- Verify: `pm2 logs meeting-agent` should show `relay.connected`; also check
  `curl localhost:3012/health` and `/ready` (both 200) — the deploy script prints these.
- STT provider (Soniox/ElevenLabs, realtime + async) is switched from Settings
  in the app, PER ROOM (keys `room:<roomId>:<key>` in `app_settings`). Interim
  policy: any verified room member may change it — the Hub's user token carries
  no workspace/room role, so owner-only cannot be enforced yet (tighten in
  `tools/can-manage-room-settings.ts` once the Hub exposes room roles). Never
  requires a redeploy or manifest republish; CSP already declares both vendor
  WS origins.
- Full runbook (backup/rotate `VOICEPRINT_ENC_KEY`, rollback, pm2 ecosystem
  entry, first-deploy steps): `docs/deployment-guide.md`.
