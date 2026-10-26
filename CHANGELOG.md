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
- Room settings can be changed only by the room's owners and moderators, or a
  workspace admin, read from the Hub-signed `room_roles` / `workspace_roles`
  claims (new optional `rooms:roles:read`). Without them nobody can write (fail
  closed). Workspace admins are recognised from `workspace_roles` instead of
  guessed JWT claims. The speaker-threshold slider is disabled for others.
- The room's "Keep original audio" setting now takes effect: `meeting_process`
  reads `keepOriginalAudio` on the server and stamps `keepAudio` on the meeting
  (the iframe no longer writes it, and used to hard-code `true`). Merged audio
  is deleted after processing by default.
- The retention sweep also deletes audio that a failed summary left behind,
  after the room's auto-delete period; before, that audio was never deleted.
- `meeting_bootstrap` only runs for the caller's own room; before, any verified
  user could make the bot sweep and purge audio in another room.
- A meeting owner can no longer add voice samples to someone else's voiceprint
  (picked by id, matched by display name, or found through a linked user):
  only the profile's creator, the linked person or a workspace admin may.
  Others still label the speaker; the result says `enrol_not_permitted`.
- Data policy rewritten to match actual behaviour, including what is not
  deleted automatically (transcripts, summaries, data left after uninstall).
- Dependencies: `@privos_ai/app-server` 0.12, `@privos_ai/app-react` 0.8, `zod` 4,
  patched `body-parser`.
- `SCOPES.md` maps every permission to its call sites and degraded behaviour.
