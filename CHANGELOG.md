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
- Every tool input is bounded: ids and strings carry `maxLength`, arrays
  `maxItems` matching the server caps, array items a typed shape; caption lines
  are capped at 2,000 characters and `speaker_resolve` at 50 assignments. Tool
  definitions live in code only: `npm run manifest:sync-tools` copies them into
  `privos-app.json`, and the parity test now compares input schemas too.
- `meeting_send_to_chat` posts once per meeting: a retry, double click or
  concurrent call returns the first send instead of posting again.
- `speaker_profile_update` binds its App DB calls to the caller's room; the
  room-less client it used resolves to a context the Hub never grants.
- One dead-job threshold (2 minutes without a heartbeat) for the `stale` flag,
  for accepting a re-run and for the sweep (was 30 s / 20 min / 10 min). A job
  interrupted by a restart is re-queued once, resuming its Soniox upload, then
  failed if interrupted again.
- Tool errors carry stable codes. An `AppError` is returned as an `isError`
  result with `structuredContent.error = { code, message, details }`; before,
  `serveApp` turned every thrown error into a bare `-32603 Internal error`, so
  the UI never saw the message (the capacity notice could never show).
- A bot-path `Insufficient scope` is probed: a bot outside the room becomes
  `ASSISTANT_NOT_IN_ROOM` (the UI offers **Add to room**, or the manual invite
  with the bot handle), a real grant gap `PERMISSION_NOT_GRANTED`.
- `npm run diagnose:scopes` walks the bot diagnosis ladder on a paired install.
- The live screen says when recording audio is at risk: parts waiting to
  upload, parts lost after the 15-minute retry window, too many parts queued,
  or the browser recorder stopping. These were recorded in state and never shown.
- Settings that were saved but never read now take effect or are gone: the
  post-meeting summary follows the room's `summaryLength` and `summaryLanguage`
  (new default `auto` = the meeting's language, all 8 languages offered); the
  recording uses the Stage caption size, the Stage speaker-label toggle, the
  default bilingual choice and (on the getUserMedia fallback) the chosen mic;
  the speaker-threshold slider starts at the saved value. Removed: the
  `speakerSession*` keys (env-only) and the caption reveal-delay slider.
- Room settings are read by exact key; one 200-row page of the shared
  `app_settings` collection missed a room's rows once a workspace had enough rooms.
- Deleting a meeting also removes the voice samples taken from it (new
  `meeting_forget_voiceprints`, called first; nothing is deleted if it fails)
  and its node-local diagnostics.
- New room setting `autoDeleteMeetingsDays` (default 0 = keep): the retention
  sweep deletes a finished meeting's voice samples, files and records after N
  days, keeping the row for a retry if a file cannot be deleted.
- Voiceprint recognition is a room setting (`speakerRecognition`, on by
  default). Off: no embedding, matching or enrolment anywhere — live chunks are
  not processed, the post-meeting pass keeps assigned names without reading
  audio, `speaker_resolve`/`meeting_relabel_speaker` save names only. On: the
  new-meeting screen tells the recorder voices may be matched and requires them
  to confirm they told participants; the time is stored as `voiceprintNoticeAt`.
- Data policy rewritten to match actual behaviour, including what is not
  deleted automatically (transcripts, summaries, data left after uninstall).
- Dependencies: `@privos_ai/app-server` 0.12, `@privos_ai/app-react` 0.8, `zod` 4,
  patched `body-parser`.
- `SCOPES.md` maps every permission to its call sites and degraded behaviour.
