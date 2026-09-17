# Red-team review — Scope & Complexity Critic / Contract Verifier

Plan: `plans/260917-1358-meeting-agent-mcp-app-elevenlabs-diarization-voice-fingerprint/`
Role: hostile scope+complexity critic, contract verification across `plan.md` ↔ `phase-01..07`.
References verified: `~/projects/genealogy-privos-mcp-app`, `~/projects/privos-mcp-app-demo`, `~/projects/privos-dev-docs`.

## Finding 1: Manifest never grants the iframe microphone permission — the core feature cannot run

- **Severity:** Critical
- **Location:** Phase 1, section "Manifest (trích)"; plan.md § "Manifest permissions"
- **Flaw:** The platform gates iframe device access through `_meta.ui.permissions` (camera/microphone), a different mechanism from the OAuth-style scope table. The plan's manifest snippet declares `resourceUri`, `hideAiChat` and `csp` but no `permissions`. `ui.permissions` / `allow="microphone"` appears **zero times** in all 8 plan files (grep over `plans/260917-1358-*/**.md`), while the whole product depends on `getUserMedia` inside a sandboxed opaque-origin iframe.
- **Failure scenario:** Phase 2 step 10 handles `NotAllowedError` by "hướng dẫn cấp quyền" — but no user instruction can fix a missing iframe `allow` attribute. Recording is dead on arrival at the end of a 5-day investment (P1+P2), and the fix requires a manifest permission change → re-pair/re-publish (phase-07:219 "pair lại nếu permission đổi").
- **Evidence:**
  - `phase-01-scaffold-app-foundation.md:69-72` — `"ui": { "resourceUri": …, "hideAiChat": true, "csp": {…} }` (no `permissions`).
  - `plan.md:124-137` — permission table covers only hub scopes; line 137 mentions only `ui.csp`.
  - `~/projects/privos-dev-docs/mcp-app-platform/developer-guide.md:47` — `permissions: [],  // camera, microphone, etc.` inside `_meta.ui`.
  - `phase-02-live-recording-and-realtime-captions.md:43` — `getUserMedia({ audio: {...} })`.
- **Suggested fix:** Add `"permissions": ["microphone"]` to the `meeting_agent` tool `ui` block in `plan.md` § Manifest permissions and `phase-01` step 8, and make "mic permission works inside the Hub iframe" a Phase 1 success criterion (before any recording code is written), not a Phase 2 discovery.

## Finding 2: Tools invented in P2–P4 are never added to `privos-app.json`; one tool is undeclared everywhere

- **Severity:** Critical
- **Location:** Phases 2/3/4 "Related Code Files → Modify"; plan.md § "MCP tools"
- **Flaw:** In the reference app the manifest file is the tool source of truth and `createManifest()` projects it byte-for-byte; the Hub lists what `privos-app.json` declares, not what `tools/registry.ts` holds. Phase 1 writes the manifest with exactly 3 tools. P2 adds `meeting_realtime_token`, P3 adds `meeting_process`/`meeting_status`, P4 adds 5 speaker tools, P7 adds `meeting_settings_set`/`meeting_elevenlabs_status` — none of those phases list `privos-app.json` under Modify (only P5, and only for scopes, and P7 for a version bump). Separately, `meeting_speaker_reembed` exists in Phase 4 (4 mentions) but is absent from the plan.md tool contract table — a 15th tool that no contract owns. Likewise `bot:room:join` / `bot:identity:read` are declared as scopes but no phase's Create/Modify list ever implements the "add bot to room" affordance they pay for (mentioned only in risk rows).
- **Failure scenario:** Each phase's manual verification ("mở tool trong phòng") passes for the UI tool while every new tool silently 404s / is not listed by the Hub, and the team discovers at P7 that permissions/tool changes force a re-pair for the whole app. Tool-surface drift also means `manifest:lint` in P1 validates a 3-tool manifest that never matches the shipped registry.
- **Evidence:**
  - `~/projects/genealogy-privos-mcp-app/src/server/manifest.ts:29,39,44-45` + `scripts/generate-manifest.ts:11-14` — manifest is projected from `privos-app.json`; `UI_RESOURCE_URI` is read out of `publisherManifest.tools`.
  - `phase-01-scaffold-app-foundation.md:191` — "Viết `privos-app.json` … + **3 tool**".
  - `phase-02:180-183`, `phase-03:173-180`, `phase-04:158-169` — Modify lists contain `tools/index.ts` but no `privos-app.json`.
  - `phase-04:135,138,182,188,202` — `meeting_speaker_reembed`; absent from `plan.md:109-121`.
  - `plan.md:135` — `bot:room:join` / `bot:identity:read` scopes with no implementing file in any phase.
- **Suggested fix:** Make `privos-app.json` an explicit Modify entry in every phase that registers a tool, add `meeting_speaker_reembed` to the plan.md tool table (or delete it, see Finding 7), and add one success criterion per phase: `dist/manifest.json` tool list == registry tool list.

## Finding 3: `processing_jobs` / `meetings` schemas cannot hold the job contract the phases assume

- **Severity:** Critical
- **Location:** plan.md § "Data model"; Phase 3 "Job state"; Phase 7 "Retention job"
- **Flaw:** `JobRecord` declares `roomId`, `audioFileId`, `language`, `title`, `keepAudio` — none of those five fields exist in the `processing_jobs` collection definition, which is the declared single source of truth ("KHÔNG có file job state cục bộ"). Symmetrically, the retention job filters `meetings` on `keepAudio`, a field the `meetings` collection does not define either. App DB is schema-registered with `validationLevel moderate` per phase-01, so these are not free-form documents.
- **Failure scenario:** (a) After a pm2 restart, `meeting_bootstrap` marks the job `failed(interrupted)` and the UI offers "Xử lý lại" — but the record has no `audioFileId`/`roomId`, so nothing can re-run without the iframe re-supplying arguments; the Phase 3 acceptance test at line 231 cannot pass. (b) `keepAudio` arrives as a `meeting_process` argument and is never persisted on `meetings`, so the Phase 7 purge predicate reads `undefined` for every row: either it deletes audio the user asked to keep or it never deletes anything. The Phase 7 criterion at line 202 is unverifiable as written.
- **Evidence:**
  - `plan.md:97` — `processing_jobs` fields: `meetingId, jobId, status, step, progress, error, resultJson, startedAt, heartbeatAt, finishedAt`.
  - `phase-03-post-meeting-diarization-pipeline.md:45-52` — `JobRecord { … roomId; audioFileId; language; title; keepAudio; … }`.
  - `plan.md:93` — `meetings` field list, no `keepAudio`.
  - `phase-07-settings-hardening-tests-and-hodao-deploy.md:30,74` — purge predicate `status='summarized' && keepAudio && endedAt < now - N`.
  - `phase-03:23,28,145,196,233` — `keepAudio` threaded through tool input, job and success criteria.
- **Suggested fix:** Add the five job fields to `processing_jobs` and `keepAudio` to `meetings` in plan.md § Data model and `src/shared/app-db-schema.ts` (Phase 1, before any writer exists), or drop `keepAudio` from the tool input and read it exclusively from `app_settings.keepOriginalAudio` at purge time. Pick one owner; do not keep three.

## Finding 4: Contradictory ownership of `meetings` / `action_items` writes between P2, P3 and P5

- **Severity:** High
- **Location:** plan.md § "Data model" (Quyền ghi); Phase 2 "Luồng"; Phase 3 "Success Criteria"
- **Flaw:** plan.md assigns the iframe write access to `meetings` during recording. Phase 2 implements exactly that (`db.create('meetings', {status:'recording'})`, `db.update(...)`, `meeting-draft-repository.ts`). Phase 3 then states the iframe does **not** write those collections and makes "no write operation from the iframe" a pass/fail acceptance criterion. Phase 5 adds a third variant: the iframe writes `action_items.listItemId`, while plan.md grants the iframe only `action_items.done`.
- **Failure scenario:** Whoever implements P3 either rips out P2's recording repository (losing the `status:'recording'` row that the recovery banner and History "Processing" badge depend on) or ships with a failing acceptance criterion. Beyond the contradiction it is a genuine concurrency hazard the plan waves away at `plan.md:99` ("Hai bên không ghi cùng trường, cùng thời điểm"): the End & summarize path has the iframe writing `status:'uploading'` while the job writes `status:'processing'` on the same record with no compare-and-set.
- **Evidence:**
  - `plan.md:99` — "**iframe** (user context) ghi `meetings` lúc ghi âm + `bookmarks` + `action_items.done`".
  - `phase-02:42,54,171,195` — iframe creates/updates `meetings`; `meeting-draft-repository.ts`.
  - `phase-03:201` — "iframe KHÔNG ghi hai collection này"; `phase-03:229` — "`meetings` + `processing_jobs` … được **backend** ghi (không có thao tác ghi nào từ iframe)".
  - `phase-05:169` — `action-item-read-model.ts` … `setListItemId`.
- **Suggested fix:** Write one ownership table in plan.md at field granularity (iframe: `title/slug/startedAt/endedAt/durationSec/language/ownerUserId/status∈{recording,uploading}/folderId/audioFileId` + `bookmarks` + `action_items.done|listItemId`; backend: everything else) and restate Phase 3's criterion as "backend owns post-processing fields", not "no iframe writes".

## Finding 5: The declared CSP and the host-bridge transports break Phase 2 upload and Phase 6 playback

- **Severity:** High
- **Location:** plan.md § "Manifest permissions" (CSP line); Phase 2 "Upload có fallback chunked"; Phase 6 "Tải transcript + audio"
- **Flaw:** Three transport assumptions are each contradicted by the platform reference:
  1. `ui.csp.connect-src` is pinned to the two ElevenLabs origins, and Phase 7 makes "CSP chỉ mở đúng api.elevenlabs.io" a hardening success criterion. Phase 6 then does a raw `fetch(presignedDownloadUrl)` for `transcript.json` and feeds `<audio>` a presigned URL — both point at the storage origin, which `connect-src`/`media-src` will refuse.
  2. `app.rest()` accepts a JSON `body` only, with a 10 s default bridge timeout. Phase 2's chunked upload (`upload-chunk` × N, multipart + MD5) and Phase 6's binary download fallback have no transport that can carry them.
  3. `app.uploadFile()` takes `base64Data: string`. A 30–40 MB webm becomes a ~53 MB base64 string pushed through the host bridge — and the plan itself refuses to push a transcript through that channel at QĐ-11, citing a cap. (The 8 MB cap the plan cites is actually `mcpapp.bot.sendAttachment`'s, so the justification is also misattributed — the real bridge limit for `rooms/upload` is undocumented and untested here.)
- **Failure scenario:** P2 "passes" with a 5-minute recording if the bridge tolerates ~4 MB base64, then a real 60-minute meeting (the stated acceptance case, `plan.md:29`) fails at upload with no fallback that can actually execute. P6's player and transcript view fail at runtime in the room, after the CSP was "hardened" in P7 — i.e. the last phase breaks the second-to-last phase.
- **Evidence:**
  - `plan.md:137`, `phase-01:72`, `phase-07:36` — connect-src pinned to ElevenLabs only.
  - `phase-06-history-and-meeting-detail-review.md:57-62,65,83-84` — `fetch(url)` on `downloadUrl`, `<audio>` with presigned URL, binary fallback via `app.rest`.
  - `~/projects/privos-dev-docs/mcp-app-platform/react-sdk-reference.md:82-90` — `RestRequestParams` `body: any` (JSON), `timeoutMs` default 10000.
  - `~/projects/privos-dev-docs/mcp-app-platform/react-sdk-reference.md:99-118` — `uploadFile({ base64Data })`.
  - `~/projects/privos-dev-docs/mcp-app-platform/apis/tools-bot.md:206` — the 8 MB cap belongs to `sendAttachment.source.base64Data`, not the MCP channel as claimed in `plan.md:81`.
- **Suggested fix:** In Phase 1, spike the three transports against the dev Hub (upload a 40 MB blob, fetch a presigned URL from inside the iframe, POST a multipart chunk) and write the measured limits into plan.md before P2 designs around them. Add the storage/Hub origin to `connect-src`/`media-src` (or route downloads through the host bridge) and fix QĐ-11's justification to cite the real constraint.

## Finding 6: Retention sweeper is complexity built on a false premise, with two competing config sources

- **Severity:** High
- **Location:** Phase 7, section "Functional — job dọn dẹp" / "Retention job"
- **Flaw:** The per-room sweep design, the in-memory `knownRooms` set, the 6 h interval and the documented "rooms nobody opened are never swept" defect all exist to work around the claim that "`mcp-apps.tool-call` luôn cần `roomId`". The REST contract says `roomId` is optional ("Room context for the tool execution"), and `speaker_profiles`/`app_settings` are already `scope:'global'` in this very plan — a global collection query needs no room. Separately the retention window has two sources of truth that disagree: env `MEETING_AUDIO_RETENTION_DAYS` (default `0` = off) and the Settings field `autoDeleteAudioDays` (default `90`), and the purge predicate reads only the env.
- **Failure scenario:** A user sets "Tự xoá audio sau 90 ngày" in Settings; nothing is ever deleted because the env default is `0`. Meanwhile the team carries a stateful room registry, an interval timer, a drain flag interaction and a documented data-retention hole — for a feature whose entire logic is one filtered query plus a DELETE.
- **Evidence:**
  - `phase-07:30` — "(endpoint `mcp-apps.tool-call` **luôn cần** `roomId`) … `setInterval` 6h lặp qua các `roomId` đã thấy kể từ lúc boot … Giới hạn đã biết: phòng chưa ai mở … chỉ được quét khi có người mở app".
  - `~/projects/privos-dev-docs/mcp-app-platform/apis/rest-tool-call.md:22` — `| roomId | string | **No** | Room context for the tool execution |`.
  - `plan.md:150` — `MEETING_AUDIO_RETENTION_DAYS … default 0`; `phase-07:24,50` — "Tự xoá audio sau N ngày (mặc định **90**)" / `autoDeleteAudioDays: number`.
  - `phase-07:30,74` — predicate uses `MEETING_AUDIO_RETENTION_DAYS` only.
  - `plan.md:190` (open question #7) rests on the same unverified premise for `speaker_profiles`.
- **Suggested fix:** Verify a room-less `mcp-apps.tool-call` in Phase 1 (one curl), then either sweep globally or state honestly that the sweep is bootstrap-triggered only. Delete `MEETING_AUDIO_RETENTION_DAYS` or delete `autoDeleteAudioDays`; the surviving one is read by the purge query.

## Finding 7: Dead surface area — a second summarizer, a settings-write tool, and unreferenced profile APIs

- **Severity:** Medium
- **Location:** Phase 5 "Adapter"; plan.md § "MCP tools" / § "Env vars"; Phase 4 "profile store"
- **Flaw:** Gold plating beyond both the request and the design export:
  - `hub-ai-summarizer.ts` + `createSummarizer()` factory + `SUMMARY_PROVIDER` env exist for a provider the plan itself rules out (QĐ-07: `sandbox:*` needs a live user session that a background job does not have) and that Phase 5 admits is "chưa verify trên node". That is an abstraction, an env var, a doc entry and a code path with zero reachable callers.
  - `meeting_settings_set` wraps a single `app_settings` write that the iframe can already perform via `mcpapp.db.*` with the `db:write` it already holds; the stated reason ("cùng một nguồn với phần backend đọc") does not hold — the backend reads the same collection either way.
  - `profile-store.mergeProfiles()` is specified and implemented in Phase 4 step 5, but no tool, UI or flow calls it (`speaker_resolve mode:'merge'` enrols into an existing profile; it does not merge two profiles).
  - `meeting_speaker_reembed` adds a 15th tool plus a UI button for re-enrolment, on top of `speaker_profile_update {action:'reenrol'}` which already exists in the plan.md contract.
- **Failure scenario:** Fifteen MCP tools against the reference app's two (`gia_pha_tree`, `export.render`), each needing a manifest entry, a scope justification, actor verification, a test and a re-pair. Every unreachable path still costs review, typecheck, docs and publish-review time, and the platform guidance is explicitly REST-first over bespoke tools.
- **Evidence:**
  - `phase-05:52` — `env.SUMMARY_PROVIDER === 'hub-ai' ? createHubAiSummarizer() : …`; `phase-05:165` — "fallback có tài liệu, **chưa verify trên node**"; `plan.md:77,148`.
  - `plan.md:114` — `meeting_settings_set`; `~/projects/privos-dev-docs/mcp-app-platform/react-sdk-reference.md:262-263` — "**Mutations** — … `app.callServerTool()`"; "**Database** — call `mcpapp.db.*` … there is no dedicated hook".
  - `phase-04:120,179` — `mergeProfiles` specified and built, no caller.
  - `phase-04:135` vs `plan.md:118` — `meeting_speaker_reembed` duplicating `speaker_profile_update {action:'reenrol'}`.
  - `~/projects/genealogy-privos-mcp-app/privos-app.json:125,140` — the reference app ships 2 tools.
- **Suggested fix:** Cut `hub-ai-summarizer.ts` + the factory + `SUMMARY_PROVIDER` (keep the one-paragraph rationale in `docs/system-architecture.md`; re-add when a verified app-context path exists), cut `mergeProfiles` until a UI needs it, and fold `meeting_speaker_reembed` into `speaker_profile_update`. If `meeting_settings_set` survives, state the concrete reason (e.g. server-side validation of `speakerMatchThreshold`) in QĐ form.

## Finding 8: Reinvented infrastructure the reference apps already provide, and effort estimates that do not match the file lists

- **Severity:** Medium
- **Location:** Phase 3 "Queue"; Phase 2 "Upload có fallback chunked"; plan.md § "Phases"
- **Flaw:** (a) `job-queue.ts` (FIFO + concurrency + `withTimeout` + drain) re-derives genealogy's `RenderQueue`, 59 lines that already implement serialized execution with per-task timeout; the plan never mentions it even though `hub-file-upload.ts` and `list-provisioner.ts` from the same repo are explicitly cited as copy sources. (b) The iframe grows a second upload implementation (`meeting-upload.ts` + `spark-md5`) alongside the backend's `files/hub-file-upload.ts`, for a >95 MB branch that no acceptance criterion exercises (the stated test is 60 minutes ≈ 35 MB) and that, per Finding 5, `app.rest()` cannot transport anyway. (c) Effort is internally inconsistent: Phase 1 budgets 2 d for ~68 authored files (plus 45 icon copies, 7 docs, 3 test files, first Hub pairing); Phase 7 budgets the same 2 d for 7 settings panels, the retention job, a full security sweep, a real-ffmpeg integration test, 7 docs files, the deploy script, the first production deploy **and** an 11-step manual e2e that requires two separate meetings with ≥3 real people; Phase 6 budgets 3 d for a hand-rolled virtualizer, an audio player with presign refresh, DOCX generation, stats and two full screens. Phase 4's 3 d additionally hides an unresolved architecture fork (global-scope App DB) whose fallback changes two collections' scope and introduces `SPEAKER_PROFILE_ROOM_ID`, an env var absent from plan.md's env table.
- **Failure scenario:** The 18 d total reads as planned when the risk is concentrated in P4 (architecture fork) and P7 (everything deferred). P7 slipping is the worst case: it is the only phase that contains deployment, the security review and the retention/settings wiring, so a slip ships an un-reviewed app or none at all.
- **Evidence:**
  - `~/projects/genealogy-privos-mcp-app/src/server/export/render-queue.ts:7,33,43` — `class RenderQueue` … `run<T>(task, timeoutMs)` … `runWithTimeout`; vs `phase-03:66`.
  - `phase-02:123-131,182` — `meeting-upload.ts`, `DIRECT_LIMIT = 95MB`, `spark-md5` dependency; `phase-03:169` — second uploader.
  - `plan.md:29` — acceptance records 60 minutes; `plan.md:175` — >100 MB only past ~2.5 h.
  - `plan.md:156-164` — phase/effort table; `phase-01:161-177` (Create list), `phase-07:130-149` (Create+Modify), `phase-07:115-126` (11-step manual e2e).
  - `phase-04:234` — fallback env `SPEAKER_PROFILE_ROOM_ID`, absent from `plan.md:141-152`; `phase-04:179` cites "open question **#8**" while plan.md has 7 (`plan.md:184-190`).
- **Suggested fix:** Copy `RenderQueue` verbatim and extend it rather than writing a queue; defer the chunked-upload branch behind a measured bridge limit (Finding 5) instead of shipping an untestable path plus a dependency; re-cut the phase table so P7 is ≥4 d (or move Settings panels into P2/P4/P5 where their data already lands), and resolve the global-scope question in Phase 1 rather than mid-P4.

## Unresolved questions

1. Phase 6 downgrades the designed "Ask AI" answer card (design 1d has an AI answer card with source links) to keyword search and relabels the control. The user asked for the design export UI — is dropping the AI answer card for v1 accepted, or should P6 carry a real answer path?
2. `speaker_profiles` at `scope:'global'` means one voiceprint pool for the whole workspace: any room member who opens the app can call `speaker_profile_list` and enumerate every identified person across all rooms. Is that the intended product behaviour for biometric data, or should profiles be room-scoped by default?
3. `plan.md:32` requires `npm run preflight` green, but Phase 1 verifies only `manifest:lint` and Phase 7 runs `verify:fast-pr`. Which command is the gate?

Status: DONE_WITH_CONCERNS
Summary: Eight findings — three Critical (missing iframe microphone permission, MCP tools never reaching `privos-app.json`, job/meeting schemas that cannot hold the fields the job and retention contracts require), plus CSP/bridge transport assumptions that break P2 upload and P6 playback, a retention design built on a documented-false premise with two competing config sources, dead surface area (second summarizer, unreferenced profile APIs, 15 tools vs the reference app's 2), and effort estimates inconsistent with the phase file lists.
