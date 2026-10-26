# Changelog

## [1.0.1]

Marketplace packaging.

- Dockerfile (Debian slim, non-root, patched OS packages) with the speaker model
  baked in from the `SPEAKER_MODEL_URL` build argument, `.dockerignore`, and
  `.gitattributes` so the source archive excludes `.env.example` and agent files.
- The server boots in a production container without identity or secrets and
  serves only its manifest (`/health` 200, `/ready` 503), as the build probe expects.
- UI ships as a split build (`dist/ui`, `ui.distDir`) served through `serveBuiltUi`;
  the UI resource is now `ui://ai.privos.meeting-agent/app.html`.
- Manifest: one `data` volume at `/app/data`, `tmpSizeMb` 1024, data-policy
  destinations and voiceprint retention, no `PORT` declaration, and
  `PRIVOS_FILES_ORIGIN` renamed to `FILES_ORIGIN` (the old name is still read).
- `meeting_settings_set` describes its actual policy (any verified room member).
- The room's "Keep original audio" setting now takes effect: `meeting_process`
  reads `keepOriginalAudio` on the server and stamps `keepAudio` on the meeting
  (the iframe no longer writes it, and used to hard-code `true`). Merged audio
  is deleted after processing by default.
- The retention sweep also deletes audio that a failed summary left behind,
  after the room's auto-delete period; before, that audio was never deleted.
- Data policy rewritten to match actual behaviour, including what is not
  deleted automatically (transcripts, summaries, data left after uninstall).
- Dependencies: `@privos_ai/app-server` 0.12, `@privos_ai/app-react` 0.8, `zod` 4,
  patched `body-parser`.
- `SCOPES.md` maps every permission to its call sites and degraded behaviour.
