# Red-team review — ASSUMPTION DESTROYER

Plan: `plans/260917-1358-meeting-agent-mcp-app-elevenlabs-diarization-voice-fingerprint/`
Perspective: skeptic (load-bearing assumptions) + SCOPE AUDITOR
Date: 2026-09-17

---

## Finding 1: Manifest never declares `ui.permissions` — the iframe cannot open the microphone, so the whole product is unbuildable as planned

- **Severity:** Critical
- **Location:** Phase 1, "Manifest (trích)"; Phase 2, "Luồng" (`getUserMedia`); plan.md § Manifest permissions
- **Flaw:** The app UI runs in a Hub-controlled iframe with `sandbox="allow-scripts"` and **no** `allow-same-origin`. The Hub only delegates camera/microphone to an app that declares it in `_meta.ui.permissions`. The plan's manifest excerpt declares `resourceUri`, `hideAiChat` and `csp` — and nothing else. `grep -rn "ui.permissions\|microphone" plans/.../*.md` returns only a Settings panel filename; the mic capability is never requested anywhere in 7 phases, while every acceptance criterion depends on it.
- **Failure scenario:** Phase 2 day 1: `getUserMedia({audio:…})` rejects with `NotAllowedError` in the room tab (a permission-policy denial, not a user prompt, so the plan's "hướng dẫn cấp quyền" UX cannot recover it). Recording, live captions, diarization, voiceprints and every downstream phase are blocked behind a manifest change that requires a republish + admin re-approval cycle.
- **Evidence:**
  - `/home/roxane/projects/privos-dev-docs/mcp-app-platform/security-and-data-model.md:18` — "**Permissions**: camera/microphone only granted if declared in `_meta.ui.permissions`"
  - `/home/roxane/projects/privos-dev-docs/mcp-app-platform/developer-guide.md:47` — `permissions: [],  // camera, microphone, etc.`
  - `/home/roxane/projects/privos-dev-docs/mcp-app-platform/auth-and-rest-integration.md:31-33` — "deny-by-default sandbox (`sandbox="allow-scripts"`, **no** `allow-same-origin`)"
  - Plan `phase-01-scaffold-app-foundation.md:69-72` — `"ui": { "resourceUri": …, "hideAiChat": true, "csp": {…} }` (no `permissions`)
  - Plan `phase-02-live-recording-and-realtime-captions.md:43` — `getUserMedia({ audio: {…} })`
- **Suggested fix:** Add `"permissions": ["microphone"]` to the `meeting_agent` tool's `ui` block in Phase 1 and make "mic actually opens inside the Hub room tab (not a standalone browser tab)" a Phase-1 exit gate, before any recording code is written. If the Hub rejects the permission value, the whole plan needs re-planning — that is a Phase-1 spike, not a Phase-2 surprise.

---

## Finding 2: IndexedDB is assumed available inside an opaque-origin sandbox — the crash-recovery architecture and the 60-minute buffer rest on storage that is documented to fail there

- **Severity:** Critical
- **Location:** Phase 2, "IndexedDB chunk store" / "recovery-banner"; plan.md § Acceptance criteria, § Rủi ro chính
- **Flaw:** The plan buffers every 5-second MediaRecorder chunk into IndexedDB inside the app iframe. That iframe has no `allow-same-origin`, i.e. an opaque origin. PrivOS's own SDK documentation states that the app document's own `localStorage` "throws or is wiped between loads" for exactly this reason, and ships `app.storage` (a host-proxied string KV store) as the substitute. IndexedDB in an opaque origin is in the same bucket (Chrome/Firefox reject or silently isolate it). The plan acknowledges the opaque origin only for *assets and fonts* (`phase-01:28`, `phase-01:195`, `phase-01:246`), never for storage — the risk table treats IndexedDB as a given. `app.storage` is not a substitute: it is string-only, host-`localStorage`-backed, and cannot hold ~40 MB/h of binary chunks.
- **Failure scenario:** `indexedDB.open('meeting-agent')` throws `SecurityError` on first run in the room tab. Fallback is in-RAM Blob accumulation, so a 2-3 h meeting holds 60-120 MB of Blobs in the tab, and any tab crash/refresh loses the entire meeting — silently, since there are no orphan chunks left to recover. Acceptance criterion "Ghi 60 phút liên tục, tab crash giữa chừng → khôi phục audio từ IndexedDB" (plan.md:29) can never pass.
- **Evidence:**
  - `/home/roxane/projects/privos-dev-docs/mcp-app-platform/react-sdk-reference.md:126-128` — "The app document runs in a **sandboxed opaque origin**, so its own `localStorage` throws or is wiped between loads. `app.storage` proxies over the host bridge…"
  - `/home/roxane/projects/privos-dev-docs/mcp-app-platform/security-and-data-model.md:16` — "Iframe sandbox: deny-by-default — no `allow-same-origin`"
  - `/home/roxane/projects/genealogy-privos-mcp-app/node_modules/@privos_ai/app-react/dist/index.d.ts:55-62` — `AppStorage` is `get/set/remove` of `string` only
  - Plan `phase-02:15`, `phase-02:89-100`, `phase-02:242-244`, `plan.md:29`, `plan.md:173`
- **Suggested fix:** Phase-1 spike: open IndexedDB from a UI resource actually served through `mcp-apps.ui-resource` in a room tab and write/read a 5 MB blob. If it fails, the durable-buffer design must change (e.g. incremental upload of each 5 s chunk to a Hub-side session, or `mcpapp.objects.put` of ≤32 MiB parts), and Phase 2's effort estimate is wrong.

---

## Finding 3: Global collections are registered through a room-bound call — the Hub stamps `roomId` on them, so the "persistent cross-meeting voiceprint" silently degrades to per-room

- **Severity:** Critical
- **Location:** Phase 1, "App DB schema module" (`ensureAppDbSchema` inside `meeting_bootstrap {roomId}`); Phase 4, step 5; plan.md § Câu hỏi chưa giải quyết #7
- **Flaw:** `speaker_profiles` and `app_settings` are `scope:'global'` (plan.md:91-92), but the only registration path is `meeting_bootstrap {roomId}` → `callAppPlatformTool(..., roomId)` where `roomId` is a **required** parameter of the transport (phase-01:107-114). The reference implementation documents a real Hub defect on exactly this path: a global collection registered from a room-bound caller gets the caller's `roomId` persisted onto its schema, which "breaks every reference to it", and the only repair is dropping and re-registering **from a room-less surface**. The plan's `ensureAppDbSchema` never inspects `schema.roomId`, and its recovery (`updateSchema` on "already registered") does not clear it. The plan's open question #7 also asserts as fact that the endpoint "luôn nhận `roomId` và kiểm tra membership" — the REST contract says `roomId` is **optional**, so the plan has misdiagnosed both the risk and its own escape hatch.
- **Failure scenario:** Room A bootstraps first; `speaker_profiles` is stored room-stamped to A. In room B the job either gets "Collection 'speaker_profiles' not found for app … in the exact room scope" or writes into a second, disjoint profile set. Auto-identification looks fine in the demo room and simply never matches anywhere else — discovered in Phase 4 acceptance testing at the earliest, with biometric data already written to a poisoned collection that cannot be dropped without data loss.
- **Evidence:**
  - `/home/roxane/projects/genealogy-privos-mcp-app/src/ui/data/app-db-schema.ts:192-203` — "Drops any empty global reference target whose stored schema carries a roomId — the corrupt state left by a Hub that persisted the caller's roomId on global collections… re-register it cleanly from the room-less surface"; `:144-146` — Hub phrasing "Collection 'clans' not found for app … in the exact room scope"
  - `/home/roxane/projects/privos-dev-docs/mcp-app-platform/apis/rest-tool-call.md:22` — `roomId` | string | **No** | "Room context for the tool execution"; `:56` — membership validated only "When `roomId` is provided"
  - `/home/roxane/projects/privos-dev-docs/mcp-app-platform/apis/tools-database.md:8-10` — global = `app_{appId}_{collection}`, "shared across all rooms"
  - Plan `phase-01:112-120`, `phase-01:144-153`, `phase-04:179`, `plan.md:190`
- **Suggested fix:** Make `roomId` optional in `bot-tool-call.ts` and register/read global collections with `roomId` omitted (a room-less call the REST contract already allows). Add a Phase-1 assertion that `getSchema('speaker_profiles')` returns `scope:'global'` with no `roomId`, and a drop-and-re-register heal for the stamped case while the collection is still empty. Do this in Phase 1, not Phase 4 — after enrolment starts, healing is destructive.

---

## Finding 4: `actor.roomId === args.roomId` is presented as the authorization model, but it authorizes nothing for global biometric data, and `meeting_process` trusts a caller-supplied `audioFileId`

- **Severity:** Critical
- **Location:** Phase 3, "Tools" (line 150); Phase 4, "Tools" (line 138); Phase 7, "Non-functional / hardening" (line 34)
- **Flaw:** Every backend tool runs on the installation bot's credential, which "bỏ qua ranh giới người dùng" — the plan says so itself. The single stated control is that the caller's verified room equals the `roomId` argument. That check is satisfied by *any* member of *any* room where the app is installed, while `speaker_profiles` and `app_settings` are workspace-global. Nothing binds a `profileId`, `meetingId` or `audioFileId` to the caller's room.
  1. `speaker_profile_list {roomId}` enumerates every voiceprint in the workspace, including `displayName` + `privosUserId` of people who only ever spoke in private rooms the caller cannot see.
  2. `speaker_profile_delete {roomId, profileId}` lets any member of any room permanently destroy another team's biometric profiles (the plan explicitly makes deletion unrecoverable — plan `phase-07:175`).
  3. `meeting_settings_set {roomId, key, value}` writes global settings (match threshold, retention days, keep-audio) from any room, with no admin/role check (`usePrivosContext().userRoles` is never consulted).
  4. `meeting_process {meetingId, roomId, audioFileId}` passes `audioFileId` straight to a bot-credential download (`phase-03:74-78`) with no check that the file lives in `roomId`. A member of room A can name a file id from room B (the bot is a member of many rooms) and have its audio transcribed, diarized and written as `transcript.md` into room A's Files — cross-room exfiltration through the app's own privileged identity.
- **Failure scenario:** A contractor added to one project room calls `speaker_profile_list` and receives the voice-profile roster of the whole workspace; then calls `meeting_process` with a file id harvested from a Files deep link of another room and reads the resulting transcript in their own room. Both calls are "authorized" by the plan's check.
- **Evidence:**
  - Plan `phase-03:150` — "`meeting_process` và `meeting_status` xác thực `context.actor.roomId === args.roomId`… bot credential bỏ qua ranh giới người dùng nên kiểm tra actor là bắt buộc" (this is the *only* stated control)
  - Plan `phase-04:138` — "Mọi tool kiểm `context.actor.roomId === args.roomId` trước khi chạm dữ liệu"; `phase-07:34`
  - Plan `phase-03:74-78` — `downloadRoomFile(hub, fileId, destPath)` uses the raw `fileId`
  - `/home/roxane/projects/privos-dev-docs/mcp-app-platform/apis/tools-database.md:8-10` — global collections are shared across all rooms
  - `/home/roxane/projects/genealogy-privos-mcp-app/node_modules/@privos_ai/app-server/dist/context/tool-call-context.d.ts:13-24` — `VerifiedActor` carries only `userId`/`username`/`roomId`; `actor?` is optional and `identityState` may be `'missing'`
- **Suggested fix:** Add per-object ownership checks, not just a room echo: (a) scope `speaker_profiles` reads/writes by an owning room or workspace-admin role and record `ownerRoomId` on each profile; (b) gate `speaker_profile_delete`, `meeting_settings_set` and "Xoá toàn bộ voiceprint" on `userRoles` containing owner/admin; (c) in `meeting_process`, resolve `audioFileId` metadata first and reject when `file.channel_id !== args.roomId`; (d) reject when `context.actor` is absent or `identityState !== 'verified'`.

---

## Finding 5: The upload path for a 1-3 h recording is not implementable from the iframe — `uploadFile` is base64-only and the chunked fallback cannot be expressed through `app.rest`

- **Severity:** High
- **Location:** Phase 2, "Upload có fallback chunked" (`meeting-upload.ts`)
- **Flaw:** The plan branches at 95 MB: direct `app.uploadFile` below, "chunked (`upload-chunked-init` → `upload-chunk` ×N → `upload-chunked-complete`)" above. Two unverified assumptions collapse here. (1) `app.uploadFile` takes `base64Data: string` — the entire file crosses the postMessage bridge as a ~1.37× inflated string; a 40 MB/h opus meeting is a ~55 MB JS string for 1 h and ~165 MB for 3 h, built on top of the original Blob in the same tab. (2) `POST file-management.files.upload-chunk` is `multipart/form-data` with a `file` part plus an MD5 `checksum`; `app.rest()` accepts only `method/path/query/body` with a JSON body and returns parsed JSON — there is no multipart or binary channel, and the host bridge additionally rejects any `{method, path}` outside the static scope→path allowlist. No reference app performs a chunked upload; genealogy's only upload path is `app.uploadFile` with base64.
- **Failure scenario:** The 2 h meeting in the acceptance criteria produces an ~80 MB blob. Direct upload marshals ~110 MB of base64 through the bridge and either OOMs the tab or trips an undocumented bridge message cap; the "fallback chunked" path cannot be written at all with the SDK the plan depends on, so the recording is unrecoverable (the source chunks live only in the tab — see Finding 2).
- **Evidence:**
  - `/home/roxane/projects/genealogy-privos-mcp-app/node_modules/@privos_ai/app-react/dist/index.d.ts:44-54` — `UploadFileParams { channelId; fileName; base64Data: string; … }`; `:5-13` `RestRequestParams { method; path; query?; body?: any; timeoutMs? }`; `:75,:77`
  - `/home/roxane/projects/privos-dev-docs/file-management/file-management-api.md:199-213` — `POST /file-management.files.upload-chunk`, `Content-Type: multipart/form-data`, params `file` (File), `sessionId`, `chunkIndex`, `checksum` (MD5)
  - `/home/roxane/projects/privos-dev-docs/mcp-app-platform/auth-and-rest-integration.md:38-46` — host bridge "rejects any request whose `{method, path}` doesn't match an entry derived from `app.scopes`"
  - `/home/roxane/projects/genealogy-privos-mcp-app/src/ui/data/room-file-upload.ts:23-32` — the only shipped upload path, base64 via `app.uploadFile`
  - Plan `phase-02:29`, `phase-02:120-131`
- **Suggested fix:** Spike the real upload ceiling in Phase 1/2 (upload 20/50/100 MB through `app.uploadFile` in a room tab and record where it breaks). Prefer moving the upload to the backend: iframe streams/hands off chunks and the bot credential performs `file-management.files.upload` / chunked upload server-side, where multipart and streams are available (`hub-file-upload.ts` already proves that transport). If direct base64 is kept, cap meeting length explicitly and state it as a product constraint instead of an unverified fallback.

---

## Finding 6: The declared CSP allows only ElevenLabs, but review/playback fetches presigned storage URLs from a different origin

- **Severity:** High
- **Location:** Phase 1, "Manifest (trích)" (`ui.csp.connect-src`); Phase 6, "Tải transcript + audio" and "Player"
- **Flaw:** The tool declares `connect-src: ["https://api.elevenlabs.io", "wss://api.elevenlabs.io"]` and the Hub enforces app-declared CSP. Phase 6 then calls `fetch(downloadUrl)` on a **presigned** URL and feeds the same kind of URL to `<audio src>`. Presigned download URLs point at the object store (MinIO/S3-style host), not at the Hub API path the bridge serves — so both `connect-src` (fetch) and `media-src` (audio element) need that origin, and neither is declared anywhere in the plan. The CSP is also declared only on the `meeting_agent` tool; the plan never states which surfaces inherit it.
- **Failure scenario:** History/detail opens, transcript fetch fails with `Refused to connect` and the player never starts — for every meeting, including ones already processed. The plan's mitigation table only anticipates *expired* presigned URLs (`phase-06:399`), so the failure gets misread as expiry and "fixed" by re-requesting the URL in a loop.
- **Evidence:**
  - `/home/roxane/projects/privos-dev-docs/mcp-app-platform/security-and-data-model.md:19` — "**CSP**: app-declared CSP from `_meta.ui.csp` enforced"
  - Plan `phase-01:72` — `csp: { "connect-src": ["https://api.elevenlabs.io", "wss://api.elevenlabs.io"] }`
  - Plan `phase-06:270-282` — `const url = (meta?.body ?? meta)?.file?.downloadUrl; const doc = await (await fetch(url)).json()`; `phase-06:298-302` — `<audio preload="metadata">` with the presigned URL
  - `/home/roxane/projects/privos-dev-docs/file-management/file-management-api.md:44` — `downloadUrl?: string; // Presigned download URL (temporary)`
- **Suggested fix:** Resolve the object-store origin during Phase 1 (read one `downloadUrl` in the target workspace) and add it to `connect-src` **and** `media-src`; make it configurable per deployment, since the presign host differs per install. Verify playback inside the Hub iframe in Phase 6 acceptance, not in a standalone browser tab.

---

## Finding 7: The realtime caption client invents an unverified wire protocol and streams ~125 WebSocket messages per second

- **Severity:** High
- **Location:** Phase 2, "Luồng" / "PCM16 worklet" / "Realtime client" / "Tool mint token"
- **Flaw:** Every concrete detail of the realtime path is asserted, not sourced: the message envelope `{ type:'input_audio_chunk', audio_chunk: base64 }`, the message names `session_started`/`partial_transcript`/`committed_transcript`, the query string `?token=…&model_id=…&audio_format=pcm_16000&commit_strategy=vad`, the model id `scribe_v2_realtime`, and the mint endpoint body/response `{ token }`. The project's own research report verified the *endpoint* and the *token mechanism* but explicitly points at the official client (`@elevenlabs/client`, `Scribe.connect()` / `RealtimeConnection`, events `PARTIAL_TRANSCRIPT` / `COMMITTED_TRANSCRIPT`) — the plan hand-rolls a parallel implementation of that SDK without citing a protocol reference. Separately, the worklet posts one message per render quantum: at a 16 kHz context that is 128 frames ≈ 8 ms, i.e. ~125 `postMessage` + ~125 `ws.send` per second with no batching — ~1.35 M messages for a 3 h meeting, each a base64-encoded 256-byte payload.
- **Failure scenario:** The WS handshake is accepted but every audio frame is discarded (wrong envelope/field name) or the server closes on an unknown `model_id`; captions never appear and the failure looks like a network problem because the reconnect loop just re-mints tokens. If the protocol is right, the send rate saturates the main thread and the socket, and captions lag exactly where the acceptance criterion says "< 1s".
- **Evidence:**
  - `plans/reports/researcher-260917-1348-elevenlabs-diarization-voice-fingerprint.md:110` — "package `@elevenlabs/client`… `Scribe.connect()` → `RealtimeConnection`… listen via `connection.on('PARTIAL_TRANSCRIPT' | 'COMMITTED_TRANSCRIPT' …)`"; `:101-102` endpoint + single-use token confirmed, protocol frames not
  - Plan `phase-02:47-48` (`ws.send({ type: 'input_audio_chunk', audio_chunk: base64 })`, query string), `phase-02:61-85` (mint endpoint + `scribe_v2_realtime`), `phase-02:104-116` (`process()` posts every quantum), `phase-02:144`
- **Suggested fix:** Either use `@elevenlabs/client` (the SDK the research actually verified) or spike the raw protocol against a live key in Phase 2 step 1 before building the store/UI on it. Regardless, buffer PCM in the worklet to 100-250 ms frames before crossing the port and the socket.

---

## Finding 8: Fields the code writes and filters on are not in the registered schema — audio retention can never fire

- **Severity:** Medium
- **Location:** plan.md § Data model (`meetings`, `processing_jobs`); Phase 3 "Job state"; Phase 7 "Functional — job dọn dẹp"
- **Flaw:** `src/shared/app-db-schema.ts` is declared the single source of truth for every collection, and App DB enforces a `$jsonSchema` validator (`updateSchema` runs at `validationLevel: 'moderate'`; the Hub surfaces breaches as "Document failed validation"). Yet: `meetings` has no `keepAudio` field (plan.md:93) while the retention job filters on `meetings.keepAudio` (phase-07:30, phase-07:74) and nothing in Phase 2/3 ever writes it — `keepAudio` only ever exists as a `meeting_process` argument. Likewise `processing_jobs` (plan.md:97) has no `roomId`, `audioFileId`, `language`, `title` or `keepAudio`, but `JobRecord` (phase-03:45-52) carries all five and the job is required to be resumable from them.
- **Failure scenario:** Retention silently deletes nothing forever — `keepAudio` is `undefined` on every record, so the filter never matches. E2E checklist item 9 ("bật Giữ audio gốc + retention 1 ngày → audio biến mất") fails after a 1-day wait, or worse, is "fixed" by loosening the filter and deleting audio users asked to keep. In parallel, `processing_jobs` writes either fail validation or store undeclared, unindexed fields, and `meeting_bootstrap`'s stale-job sweep cannot rebuild the job (no `audioFileId`) to retry it.
- **Evidence:**
  - Plan `plan.md:93` — `meetings` field list (no `keepAudio`); `plan.md:97` — `processing_jobs` field list
  - Plan `phase-03:45-52` — `JobRecord { … roomId; audioFileId; language; title; keepAudio; … }`
  - Plan `phase-07:30` and `phase-07:74` — "lọc `keepAudio` && `endedAt < now - N ngày`"
  - `/home/roxane/projects/privos-dev-docs/mcp-app-platform/apis/tools-database.md:107-111` — `updateSchema` "bumps version, uses `validationLevel: 'moderate'`"
  - `/home/roxane/projects/genealogy-privos-mcp-app/src/ui/data/app-db-schema.ts:155-163` — "a write failed the collection's `$jsonSchema` validator… the Hub surfaces this as MongoDB's 'Document failed validation'"
- **Suggested fix:** Reconcile the schema table with every field any phase reads or writes before Phase 1 ships (`keepAudio` on `meetings`; `roomId`/`audioFileId`/`language`/`title`/`keepAudio` on `processing_jobs`), and add a test that diffs the declared schema against the repository/job types so drift fails CI instead of failing retention silently.

---

## Scope coverage audit (user-requested scope vs plan)

Covered: live recording + captions (P2), batch diarization (P3), persistent voiceprint auto-ID (P4), speaker = PrivOS user or free name via `channels.members` + `rooms:read` (P4 — the `channels.members` route and the `rooms:read` grant are real, verified at `/home/roxane/projects/genealogy-privos-mcp-app/src/ui/data/room-members.ts:1-68` and `privos-app.json:82`), AI summary + save to Files (P5), history/detail review (P6), screens 1a-1e (P1/P2/P6/P7).

Deviations, in descending severity:

1. **Translation is dead UI.** `showTranslation` is in the recording store (`phase-02:155`), the detail screen toggles "bản dịch EN" (`phase-06:36`), and Settings exposes it twice (`phase-07:19`, `phase-07:25`) — but no phase ever produces a translated field. P6 guards it with "chỉ khi transcript có trường `en`", and nothing writes `en`. Ship a disabled/removed control with a roadmap note, or add a producer; do not ship a toggle that can never turn on.
2. **Design 1e API-key field removed (QĐ-09)** — justified and documented; keep.
3. **"Ask AI" downgraded to keyword search (P6)** — documented as a v1 non-goal with a relabel; acceptable.
4. **"Chia sẻ với tôi" filter relabeled to "Của tôi" (`phase-06:242`)** — acceptable, but it silently drops the sharing concept from the design; state it in `design-guidelines.md`.
5. **Retention sweep is room-triggered only**, justified by a false premise ("endpoint `mcp-apps.tool-call` luôn cần `roomId`", `phase-07:30`) that the REST contract contradicts (`rest-tool-call.md:22`, `roomId` optional). The known limitation ("phòng chưa ai mở… chỉ được quét khi có người mở app") is self-inflicted and avoidable.

---

Status: DONE_WITH_CONCERNS
Summary: Four Critical assumption failures (missing `ui.permissions` for the microphone, IndexedDB in an opaque-origin sandbox, global collections poisoned by room-bound registration, and a room-echo "authorization" model over workspace-global biometric data plus a caller-supplied `audioFileId`) each independently block or compromise the plan as written; three High findings (iframe upload ceiling, CSP omitting the presign origin, invented realtime protocol at 125 msg/s) and one Medium schema-drift defect follow. Scope coverage is otherwise complete apart from a translation toggle no phase can ever satisfy.
