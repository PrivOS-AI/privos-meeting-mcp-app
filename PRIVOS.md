# PRIVOS.md

This file provides guidance to PrivOS (privos.ai) when working with the project in this repository.

Meeting Agent is a PrivOS MCP app (`ai.privos.meeting-agent`) for meeting
capture: browser-mic recording, bilingual live captions with live speaker
labels, cross-session speaker identity via encrypted voiceprints, Hub-AI
summaries, questions and notes, and transcript/summary storage in PrivOS Files.
Speech recognition runs inside the container by default (sherpa-onnx models
baked into the image). Boot goes through the SDK's unified `serveApp`
(`src/server/index.ts`); runtime mode is auto-detected, never set by env.

## Deployment — one Docker container, always from `main`

The dev install runs as a single container (`privos-meeting`) built from the
repo's `Dockerfile`, **always from the latest `origin/main`**: branch work
reaches it only after a PR is merged. `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` are
symlinks to this file, so every agent reads it. Connection details, the run
command and secrets stay out of the repo.

- Build from `git archive origin/main`; tag the image `privos-meeting:main-<sha>`;
  run it `--read-only` with tmpfs `/tmp`, the `privos-meeting-data` volume at
  `/app/data`, the identity **directory** mounted and `.env` (0600) as env-file.
- Secrets live only in `.env` + the identity file. `VOICEPRINT_ENC_KEY` **must
  be backed up** — losing it loses every voiceprint.
- Verify: the log shows `relay.connected`; `/ready` is 200. `MANIFEST_DRIFT`
  means the manifest changed: an admin clicks Refresh (Admin → Apps → app →
  Settings).

### A UI change needs a new version

A Hub reads a version's UI once (install, upgrade, or the Refresh after a
manifest change) and keeps serving that asset set. Deploying a changed UI under
the same version leaves the Hub with the old assets while the live shell names
new ones, and the tab shows **"App assets unavailable"**. So, whenever the UI
changes:

1. bump `version` in `privos-app.json` **and** `package.json` (and the lockfile);
2. `npm run build && npm run ui:lock` (records the bundle digest for that version);
3. after deploying, an admin clicks Refresh.

`npm run check:ui-version` (part of `verify:fast-pr`) fails when the built UI
differs from the one locked for the current version. The container log has one
`[ui] resources/read …` line per UI read: a Hub that reads only `shell` and
never the assets it names is serving a stale asset set.

### Recording from the Room browser (Google Meet)

A meeting can be recorded from the Room's shared browser (PrivOS Remote Browser
sitting in a Google Meet call) instead of the microphone. The app server reads
Remote Browser's `GET /audio-tap?roomId=` (raw 16 kHz PCM) directly, because
PrivOS has no app-to-app call yet; `src/server/browser-audio/`. To turn it on:

- set the same random secret (32+ characters) as `REMOTE_BROWSER_AUDIO_TAP_KEY`
  in both apps' `.env`, and `REMOTE_BROWSER_AUDIO_URL` in this app's (the
  Remote Browser controller, e.g. `http://remote-browser-dev:8787`);
- put both containers on one Docker network (`docker network connect`), so the
  URL resolves without publishing the route anywhere new.

Unset, the "Audio source" choice is hidden and nothing changes.

## Settings

- STT provider (built-in by default; Soniox/ElevenLabs, realtime + async) is switched from Settings
  in the app, PER ROOM (keys `room:<roomId>:<key>` in `app_settings`). Only the
  room's owners and moderators, or a workspace admin, may change it — read from
  the Hub-signed `room_roles` / `workspace_roles` claims, which need the
  optional `rooms:roles:read` grant (`tools/can-manage-room-settings.ts`). Fail
  closed: without that grant, or on the managed runtime (SDK 0.12 does not carry
  roles through the dispatch assertion), nobody can change settings in the app.
  Never requires a redeploy or manifest republish; CSP already declares both
  vendor WS origins. After adding `rooms:roles:read`, an admin must approve it
  (Admin → Apps → this app) before roles reach the app.
- Backup/rotation of `VOICEPRINT_ENC_KEY` and first-deploy steps:
  `docs/deployment-guide.md` (its pm2 sections predate the container).
