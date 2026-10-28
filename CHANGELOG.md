# Changelog

## [1.1.0] — 2026-10-28

Marketplace packaging, built-in speech recognition and meeting intelligence.
1.0.1 was never released; everything below ships as 1.1.0.

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
- **Built-in speech recognition (`local`, now the default).** Vietnamese and
  English Zipformer models (sherpa-onnx, CPU) baked into the image with Silero
  VAD, pyannote segmentation and the 3D-Speaker embedding, all sha256-pinned.
  Each utterance is decoded by both models and the better fit (mean token
  log-prob) wins, so mixed Vietnamese/English meetings need no language ID.
  Live captions: the iframe pushes 16 kHz PCM every ~500 ms
  (`meeting_audio_push`) and gets the new captions back. Post-meeting: VAD +
  diarization run in a worker thread, every word gets its speaker. No vendor
  key is needed; Soniox and ElevenLabs stay selectable per room.
- Data policy rewritten to match actual behaviour, including what is not
  deleted automatically (transcripts, summaries, data left after uninstall).
- Dependencies: `@privos_ai/app-server` 0.12, `@privos_ai/app-react` 0.8, `zod` 4,
  patched `body-parser`.
- `SCOPES.md` maps every permission to its call sites and degraded behaviour.
- **Open in Files** works: the iframe sandbox blocks `window.open`, so the button
  asks the host (`OPEN_LINK`) to open the room's Files tab at the meeting folder
  (`/group/<room>/files/<folderId>`; room type and name from `rooms.info`). The
  chat summary links `summary.md` with the Hub's own `@Files:<roomId>/<path>`
  syntax instead of an unresolved `privos://` link.
- Live captions keep up: a push may carry ~4 s of audio (was 1 s), so the client
  sends everything captured during the ~1.5 s relay round trip instead of
  falling further behind on every push.
- A recording with no recognisable speech says so ("No speech was recognised…")
  instead of "No transcript content to summarize".
- `npm run diagnose:local-stt` (`scripts/diagnose-local-stt.ts`): downloads a
  meeting's audio as the bot and prints its level, VAD segments and what the
  recognizer hears in each.
- UI polish, checked screen by screen against a mock host:
  - Summaries render their markdown (headings, lists, bold) instead of showing
    `##` and `-`; rendered as React elements, never as HTML.
  - Status badges: `interrupted` meetings are labelled (they showed "Private"),
    and a finished meeting without a summary says "Transcript only".
  - History table: column headers, titles reachable by keyboard, dates in the
    app language, a labelled sort menu, `Ctrl+K` shown off macOS; on a phone
    the status and row menu stay on screen (they were cut off).
  - Speakers nobody named show as "Speaker N" instead of `speaker_2`; avatars
    always have a background and use one initial when small.
  - A recording the Hub cannot serve shows a plain notice instead of a raw
    technical error, and no longer hides behind the page error.
  - New meeting: the provider is named ("built-in"), a warning appears when
    the built-in recognizer is paired with a language it does not support, and
    a disabled Start button says what is missing.
  - The rail no longer shows the permanently disabled Bookmarks and Search
    entries (both live in History and the meeting view).
- Faster live captions with the built-in recognizer: the speech in progress shows
  as a draft about once a second (one model, the language last heard) and the
  final caption replaces it; a push waits up to 0.7 s for the decodes it
  started, so a finished sentence arrives in the same answer instead of the
  next one; the owner check of `meeting_audio_push` is cached for 30 s instead
  of costing an App DB round trip per push; the client sends again as soon as
  a push returns with audio waiting; long utterances are cut at 10 s (was 15).
- New room settings under Settings › AI summary: the live summary cadence
  (`liveSummaryMinutes`: on demand, 3, 5 (default), 10 or 15 minutes; it was
  fixed at 10) and `autoSendSummaryToChat` (off by default), which posts the
  summary to the room as the bot as soon as processing finishes, once per
  meeting; a refusal leaves the "Send to chat" button.
- Settings › Speech recognition: provider cards per role (live captions /
  transcript after the meeting) with what each is good at and whether it is
  ready, instead of two selects and a table of internal names; model details
  sit under "Technical details".
- Live speakers with the built-in recognizer: every finished utterance is
  embedded (the voiceprint model) and folded into the meeting's session
  speaker registry, the same one the Soniox chunk path uses, so captions show
  "Speaker N" while the meeting runs, known voices are named from voiceprints,
  speakers can be renamed live, and the names carry into the post-meeting
  transcript through `live-turns.json`. Utterances under 1 s stay with the
  previous speaker when they follow closely. Off when the room turned speaker
  recognition off. New `liveSpeakers` capability (`meeting_live_speakers` now
  answers for any provider that has it). Ending a recording writes the last
  live speakers before the job reads them.
- Action items know who asked and who does it. The summary now returns, per
  item: `type` (task / request / open question), `owner`, `requester`, the
  deadline as said (`due`) and as a date when it can be worked out from the
  meeting date (`due_date`), the timestamp and the words that stated it
  (`quote`); decisions carry who made them and when. Every field is checked on
  the server before it is stored: names must be speakers (or short plain
  names), a quote must really be in the transcript, a timestamp inside the
  meeting, a date a real date — anything else is dropped, never guessed. A
  name links to a PrivOS account only through a speaker whose voiceprint
  profile is linked to one. New `decisions` collection; new `action_items`
  fields. `summary.md` gets "Requested by", the quote, and separate Requests /
  Open questions sections; the app shows decisions, "A → B", the deadline with
  its date, the quote and a filter by person; DOCX and the Smart List carry the
  requester (Smart List also gets a Type field).
- Fixed: a deadline said as words ("Friday") was dropped before being stored
  (it went through `new Date()`), and was pushed as text into the Smart List's
  DATE field. Now the words are kept and only a real date goes into DATE.
- Fixed: deleting a meeting (by hand or by auto-delete) left its action items,
  bookmarks and speaker rows behind — orphan items still counted as "open".
  All of a meeting's rows are deleted with it now.
- Ask about a meeting (`meeting_ask`, new "Ask" tab while recording and after):
  the answer comes only from the transcript (the captions so far during the
  meeting), with the lines it rests on — click one to jump there. The model
  returns line ids from the prompt and only those survive, so a citation always
  points at something said. A long meeting is narrowed to the lines that share
  words with the question (diacritics ignored). Nothing is stored; "Save to
  Files" (`meeting_save_answer`) appends that exact answer to the meeting's
  `qa.md`, accepted only with the short-lived token the server issued for this
  person, meeting and answer; saving twice adds it once.
- Meeting notes (`meeting_notes_save`, new "Notes" tab): the owner's notes save
  automatically to the meeting and to `notes.md` in Files, with a revision that
  only goes up so a slow save never overwrites a newer one; "Insert time"
  stamps the meeting clock while recording; the summary gives the recorder's
  points weight (facts and owners still come from the transcript).
- The room's AI Chat knows which meeting is open (`host/chatContext.set`): the
  one being recorded, or the one being read, with its summary.
- Finished meetings drop their live working files (`live-turns.json`,
  `captions-<id8>.json`); the folder keeps what people read.
- Side-panel tabs wrap onto a second row instead of overlapping.
- Manifest: three new tools; data policy says where questions, saved answers
  and notes go. An admin Refresh is needed after deploying.
- More accurate recognition when the capture is quiet or noisy (measured with
  the new `scripts/eval-asr.ts`):
  - The Vietnamese model is now the int8 Zipformer trained on ~70k hours
    (was 30M / ~6k hours). At SNR 5 dB, and when quiet and noisy, it keeps
    ~92 % of words where the old model lost 25–42 %. It is ~1.4× slower.
  - Every utterance is brought to ~-20 dBFS before recognition (an English
    clip at -40 dB went from 96 % to 2 % word errors).
  - Decoding uses `modified_beam_search` (4 paths).
  - The microphone is captured with `autoGainControl`.
  - An ffmpeg denoise chain was measured and left out (worse at SNR 0).
- People's PrivOS avatars instead of initials: in the rail, transcripts,
  speaker lists, history rows and the member picker. Avatars are public at
  `<hub>/avatar/<username>`; `meeting_bootstrap` now returns the Hub origin.
  A person is matched by user id, else by a name exactly one room member has.
  Initials stay when nobody matches, without `rooms:read`, or when the image
  fails.
- Fixed "App assets unavailable" after deploys that changed only the UI: the
  version never moved, so the Hub kept serving the asset set it read for the
  old one. Version 1.1.0; `ui-bundle.lock.json` records the UI bundle digest
  per version and `npm run check:ui-version` fails when the UI changes without
  a version bump. The container now logs every UI read (`[ui] resources/read …`).
