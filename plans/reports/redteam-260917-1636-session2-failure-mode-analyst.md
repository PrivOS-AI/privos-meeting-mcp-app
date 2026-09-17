# Red team session 2 — failure mode analyst (Soniox single vendor + live speaker naming)

Scope: only the revised design — Soniox realtime (captions + labels) / Soniox async (authoritative), new Phase 5 live naming from 60s parts, meeting clock (QĐ-17), retroactive relabel, session registry, reconcile.
Method: flow trace speech → WS tokens → caption line → part upload → `meeting_chunk_ready` → chunk worker → `meeting_live_speakers` → relabel → End → async pass → reconcile → saved transcript.
Read fully: `plan.md`, `phase-02`, `phase-03`, `phase-05`. Skimmed `phase-01/04/06/07/08`. Verified against Soniox docs (WebSocket API, temporary API key, async), PrivOS file-management docs, `render-queue.ts` source.

---

## F1 — Session registry binds a Soniox label to a person on first sight and never re-verifies; one label reuse poisons the centroid and then poisons the permanent voiceprint

**Severity: CRITICAL**

**Location:** `phase-05-live-speaker-naming-from-chunks.md:89-101` (`observe`), `:27` (new-label rule), `:29` (no auto split), `:32` (`pendingEmbedding` = sealed centroid), `phase-04-speaker-identity-and-voice-fingerprint.md:34` (quick-assign enrols from `pendingEmbedding`), `phase-02-live-recording-and-realtime-captions.md:31` (label namespacing).

**Flaw:** `observe()` runs an embedding match **only when `byLabel` has no entry for the Soniox label**. For every subsequent observation carrying that label, the embedding is appended to that session speaker unconditionally (`s.embeddings.push(emb); s.centroid = meanNormalize(...)`). The design therefore treats the Soniox label as ground truth for identity, while the plan's own risk table states the opposite: labels "có thể đổi tạm" and merge incorrectly (`plan.md:209`, `phase-02:32`, open question #3 `plan.md:225`). The first-observation binding is also the *weakest* possible evidence: one turn of ≥ `SPEAKER_MIN_SEGMENT_SEC` (2s) matched at an uncalibrated `SPEAKER_SESSION_MATCH_THRESHOLD = 0.40` (`plan.md:180`, open question #5 `plan.md:227`).

**Failure scenario:** Soniox reassigns label `2` from Nam to Linh mid-meeting (documented behaviour: "temporary speaker switches that stabilize"). Linh's embeddings flow into Nam's session speaker; the centroid drifts to a mixture. Consequences chain:
1. `matchPendingAgainstProfiles` matches the mixed centroid against workspace profiles → either no match (both people stay `Người nói N` forever, `profileAttempts` burns its 5 tries) or a wrong match → every caption line of both people is retro-labelled with one wrong name (`phase-05:110-111`).
2. `maybeMerge` then compares the polluted centroid against other session speakers at 0.60; a mixture sits closer to everyone → cascading merges. There is no split in v1 (`phase-05:29`), so this is irreversible for the rest of the meeting.
3. The user "fixes" it with quick-assign → `speaker_resolve` decrypts `pendingEmbedding` (= the polluted centroid) and **enrols it into `speaker_profiles`** (`phase-04:25,34`). A two-voice vector now permanently contaminates the workspace voiceprint and degrades every future meeting. This crosses from a UI defect into durable data corruption.

Amplifier: every WS reconnect resets the label namespace, so every label is "new" and every person is re-bound by a single-turn match. Reconnect cadence is not rare as assumed: the mint body (`phase-02:75-76`) omits `max_session_duration_seconds`, whose default is undocumented (docs: integer 1–18000, "the connection will be dropped" when exceeded — https://soniox.com/docs/api-reference/auth/create_temporary_api_key), and `expires_in_seconds` is capped at 3600 while `SONIOX_TEMP_KEY_TTL_SEC` defaults to 900 (`plan.md:177`). The plan asserts "khoá chỉ dùng lúc connect" (`phase-02:245`) with no vendor statement behind it. If key expiry or an implicit session cap closes the socket, a 3h meeting re-binds every speaker 12+ times.

**Evidence:** `phase-05:89-101`; `plan.md:209`; `phase-02:31-32`; `phase-04:25,34`; Soniox temporary API key reference (fields/limits above); Soniox diarization concept page ("speaker label" is per-session only).

**Suggested fix:** Make the label a *hint*, never an identity. On **every** observation, compute cosine against the bound session speaker's centroid; below a rejection threshold, re-run `matchSpeaker` across all session speakers and rebind (or fork a new one). Require ≥2 independent turns before a label→session binding becomes sticky. Never seal a centroid into `pendingEmbedding` for enrolment unless its intra-cluster dispersion is below a bound (reject bimodal clusters); add the `phase-04:240` "Không phải một người" escape to quick-assign as well. Set `max_session_duration_seconds` explicitly at mint and spike the actual socket lifetime in P1.

---

## F2 — The meeting clock assumes Soniox's audio timeline equals wall-clock; dropped PCM frames and mute make it drift permanently, and the chunk worker slices PCM with that clock

**Severity: CRITICAL**

**Location:** `phase-02:126` (`tokenToMeetingMs(t) = wsSessionOffsetMs[t.sessionIndex] + t.start_ms`), `phase-02:40,96` (drop PCM frames on `bufferedAmount`), `phase-02:26` (mic mute control), `phase-05:59-65` (`chunkStartSec`, `from/to`, `pcm.subarray`).

**Flaw:** `wsSessionOffsetMs` is measured **once** with `performance.now()` at socket open. `token.start_ms` is produced by Soniox from the *bytes it received*, i.e. an audio-duration clock. The two only agree if every PCM frame produced after socket open is actually delivered. The design deliberately violates that: backpressure drops frames (`phase-02:40,96`) and the mute control may stop sending. Each dropped 100–250ms frame shifts every later token **earlier** on the meeting clock, monotonically, with no resync — while the backend's clock (`decodedSecBefore`, sum of real decoded part durations, `phase-05:78`) tracks the *recorder's* timeline, which did not lose those frames.

**Failure scenario:** A congested uplink drops 8% of frames over 40 minutes → ~3 minutes of accumulated skew. `meeting_chunk_ready` segments arrive with `startMs` up to 180s earlier than the audio they describe. In the worker, `from = startSec - chunkStartSec` is negative or out of range → turns are silently `continue`d (`phase-05:64`) and live naming simply stops producing labels; for mid-range skew the guard passes and `pcm.subarray()` returns **another person's speech**, which is then embedded and fed into F1's registry (wrong name shown, wrong voiceprint enrolled). `droppedFrames` is counted and displayed (`phase-02:96`) but never fed back into the clock — the signal exists and is discarded. A 30-second hardware mute has the same effect if mute is implemented as "stop sending PCM".

**Related contract break in the same path:** `turnsInPart(seq)` is computed synchronously at part-upload time and "cắt theo biên part" (`phase-02:187,192`). That contradicts `phase-05:25` ("Turn vắt qua biên part được xử lý trọn vẹn đúng một lần, ở chunk chứa `startMs` của nó") and makes the P5 acceptance fixture `[58s, 63s]` (`phase-05:183`) unreachable — the client will emit `[58,60]` and `[60,63]`, and the 2s remnant is at/under `SPEAKER_MIN_SEGMENT_SEC` so it is dropped. Separately, Soniox finalizes on endpoint detection, so finals covering the last seconds of part *N* arrive **after** `chunk_ready(N)` was already sent; those turns are never delivered to any chunk — a systematic loss at every one of the 60 part boundaries per hour, precisely at turn ends.

**Evidence:** `phase-02:40,96,126,187,192`; `phase-05:25,59-65,78,183`; Soniox WebSocket API (`is_final`, endpoint detection, no resume/resync on reconnect).

**Suggested fix:** Derive the caption timestamp from an audio-sample counter (count samples actually *sent* to the socket, per session) rather than a wall-clock offset, and transmit `sentSamplesAtSocketOpen` so the backend can convert. Make dropped frames fatal to the clock: on any drop, stamp the session with a correction and re-baseline (or stop dropping — a 16k mono s16 stream is 32 kB/s; the backpressure branch is protecting against a load that should not occur). Add a per-chunk sanity check (correlate the segment's expected energy envelope, or reject chunks where `|expected − actual| > 1s`) and mark them `approxClock` instead of embedding blind. Resolve the clipping-vs-whole-turn contract in one place, and hold `chunk_ready(N)` until finals covering `partEnd(N)` have arrived (or carry them into `chunk_ready(N+1)` with explicit `startMs`).

---

## F3 — One failed or dropped chunk permanently desynchronises every later chunk; the "errors are contained" claim is false, and the copied RenderQueue provides neither per-meeting serialisation nor real cancellation

**Severity: CRITICAL**

**Location:** `phase-05:51-75` (worker `try/catch`, `noteDecoded` at `:70` inside the `try`), `:73` (`catch` + log, no rethrow), `:42` ("mọi lỗi chỉ log + bỏ chunk đó"), `:152` (queue keeps "chunk mới nhất + 2", drops older), `phase-03:76-79` (queue = copy of `render-queue.ts`), `~/projects/genealogy-privos-mcp-app/src/server/export/render-queue.ts:7-41`.

**Flaw A — clock corruption on any skipped chunk.** `reg.noteDecoded(req.seq, durationSec)` sits **inside** the try block, after decode and the segment loop. If the part download 404s, ffmpeg fails, or the 60s chunk timeout fires, that part's duration is never recorded. `decodedSecBefore(seq)` then under-counts by ~60s for **every subsequent chunk**, so `chunkStartSec` is wrong for the rest of the meeting and every slice embeds the wrong speech (feeding F1 again). Same for the deliberate drop policy at `:152`. The documented fallback ("thiếu part trước → `seq × PART_MS`, `approxClock:true`", `phase-05:78`) only triggers when a part is *missing at that moment*; it does not repair a gap in the accumulator, and mixing nominal and real durations leaves a permanent offset equal to the accumulated timeslice jitter. The plan's containment claim ("chunk worker không bao giờ làm hỏng nhánh ghi âm ... mọi lỗi chỉ log", `:42`) is true for the recording branch and false for the live-naming branch: one transient error silently degrades all subsequent labels with no signal.

**Flaw B — ring buffer contiguity.** `reg.ring.set(tail of this chunk)` (`:69`) and `chunkStartSec = decodedSecBefore(seq) − overlapLen` (`:59`) both assume the ring holds the immediately preceding audio. After a dropped/failed chunk the ring holds the tail of chunk *n−2* or older while the worker treats it as contiguous with chunk *n* → the prepended overlap is audio from a different minute, and the computed `chunkStartSec` is wrong by a whole part.

**Flaw C — the queue does not do what the plan says.** `RenderQueue` is a single global FIFO mutex (`render-queue.ts:7-23`) with **no key**, an **unbounded** waiter list, and a timeout that explicitly does **not** stop the task: "`task` itself keeps running in the background ... this only stops it from blocking everyone behind it" (`render-queue.ts:25-41`). So: (i) "concurrency 1 cho mỗi meeting" does not exist — after a 60s chunk timeout the timed-out worker keeps mutating `reg.embeddings/centroid/ring/processed` while the next chunk for the *same* meeting starts, i.e. a genuine data race on in-memory state with no lock; (ii) "hàng chờ chỉ giữ chunk mới nhất + 2" does not exist — waiters are unbounded FIFO; (iii) with one instance, 20 concurrent meetings serialise behind one global lock, so a 3h workspace-wide load grows the queue monotonically (20 meetings × 1 chunk/60s vs. download+decode+embed per chunk) and the "thà mất một nhãn" drop policy then fires constantly, which via Flaw A corrupts every meeting's clock.

**Evidence:** `phase-05:42,51-75,78,152`; `phase-03:76-79`; `render-queue.ts:7-41` (verbatim comment quoted above).

**Suggested fix:** Move `noteDecoded` (and only it) into a path that always runs for a part whose duration is knowable — or better, stop deriving the clock from processing success entirely: have the worker record `(seq → decodedDurationSec)` in `processing_jobs`/`meetings` as parts are handled, and reconstruct absolute offsets from the part sequence, not from a mutable accumulator. Do not reuse `render-queue.ts` for this workload; it is a mutex for Chromium renders, not a keyed bounded queue. Write (or import) a keyed queue with per-`meetingId` serialisation, a bounded backlog, and an `AbortController` the worker actually observes between stages so a timeout stops mutation before the next chunk starts. Set a distinct chunk-queue depth alarm; treat "chunk dropped" as a meeting-level degradation flag surfaced in `meeting_live_speakers`.

---

## F4 — Reconcile is specified against data that is never persisted, and its precedence rule contradicts itself in the same bullet

**Severity: CRITICAL**

**Location:** `phase-05:35` (reconcile rule), `:36` (registry rebuild), `:193` (acceptance), `phase-03:154` (`alignByMaxOverlap(a: TimedSpan[], b: TimedSpan[])`), `plan.md:109` (`meeting_speakers` fields), `phase-04:25` (`pendingEmbedding` deleted on resolve).

**Flaw A — the input does not exist.** `alignByMaxOverlap` needs **time spans** for both sides. The async side has them (tokens). The live side has none: `meeting_speakers` stores `sonioxLabels`, `liveSpeechSec`, `liveConfidence`, `liveUpdatedAt`, and a single `sampleStartSec/sampleEndSec` pair — no per-turn timeline. The registry that *did* hold turn times is in-memory only, is capped at 20 meetings, and by the time `meeting_process` runs (after upload, concat, and a full async round trip whose turnaround is undocumented, `plan.md:224`) it may have been evicted or lost to a pm2 restart. Result: reconcile either silently no-ops (and the acceptance criterion at `:193` cannot be met) or is implemented by matching on aggregate speech seconds, which mis-assigns whenever two participants talk for similar durations — producing confidently wrong names in the saved `transcript.json/.md/.srt` and in the summary.

**Flaw B — self-contradiction.** `phase-05:35` says both "giữ nguyên ... **tên người dùng đã gán giữa họp** (không bắt họ gán lại)" and "Nhãn/`profileId` của pass async **thắng** khi mâu thuẫn". These are the same field. The acceptance criterion `:193` then asserts the user's name survives, while the risk table `:206` says "pass async thắng cho dữ liệu lưu". An implementer will pick one and half the acceptance criteria will fail; in the "async wins" reading, an explicit human correction is silently overwritten by an uncalibrated cosine match.

**Flaw C — row identity is undefined.** P5 writes `meeting_speakers` rows keyed by `sessionSpeakerId`; P3/P4 write rows keyed by `speakerId` (async ids), via an `upsertMeetingSpeakers` described only as "merge theo trường, không ghi đè" (`phase-04:33`, `phase-05:135`). Nothing states the join key, whether live rows are retired after reconcile, or how merged session speakers (`mergedInto`, `phase-05:104`) are garbage-collected. Expected outcome: a 4-person meeting shows 7–9 speakers in the detail screen and in `transcript.json.speakers[]`, and `meetings.speakerCount` is wrong.

**Flaw D — restart recovery is lossy for exactly the speakers that matter.** `phase-05:36` rebuilds the registry centroid from `pendingEmbedding`, but `phase-04:25` deletes `pendingEmbedding` as soon as `speaker_resolve` succeeds. So after a mid-meeting quick-assign + pm2 restart, the confirmed speakers are the ones that cannot be restored; they get fresh `sessionSpeakerId`s and their labels revert to `Người nói N`, contradicting the acceptance criterion at `:190`.

**Evidence:** `plan.md:109`; `phase-05:35,36,104,135,190,193,206`; `phase-03:154`; `phase-04:25,33`.

**Suggested fix:** Persist live turn spans (compact: `sessionSpeakerId, startMs, endMs` runs, or a run-length encoded array on the `meeting_speakers` row) at each chunk upsert — reconcile must not depend on process memory. Define one precedence rule and write it once: recommend "human assignment > async profile match > live profile match", with async speaker **segmentation** always authoritative for the transcript and only the *name* subject to that precedence; log and surface conflicts instead of silently discarding. Define the `meeting_speakers` primary key explicitly (`meeting + speakerId` after reconcile, live rows carrying `speakerId: null` until mapped) and specify deletion of merged/unmapped rows. Keep a non-enrolment copy of the centroid (or retain `pendingEmbedding` until `endedAt`) so restart recovery works for resolved speakers.

---

## F5 — Two meetings in one room can share a folder and part filenames; `duplicateAction: 'replace'` is an in-place upsert, so one meeting overwrites the other's audio and then deletes its parts

**Severity: CRITICAL (data loss)**

**Location:** `phase-02:48` (`ensureMeetingFolder(roomId, date, slug)`), `:100` (`partName(seq) = audio.part-NNNN.webm`, `duplicateAction:'replace'`), `:191` ("Idempotent theo tên"), `phase-01:197` (`slugify(title)` → `<yyyy-mm-dd>-<slug>`), `phase-03:85` (concat then delete parts).

**Flaw:** The folder key is date + title-slug and the part key is a per-meeting sequence number — neither includes `meetingId`. PrivOS replace semantics are an in-place upsert on `(channel_id, file_path)` guaranteed unique by index `uniq_channel_filepath` (`~/projects/privos-dev-docs/file-management/stable-file-id-and-replace-semantics.md:19-40`). So two meetings with the same title on the same day in the same room resolve to the same folder and the same `audio.part-0001.webm` record, and the second upload **overwrites the first's bytes at the same `_id`** — the first meeting's `partFileIds` still resolve, now to someone else's audio.

**Failure scenario:** A recurring "Standup" is recorded by two people in the same room (or one user records, the tab crashes, they start a *new* meeting rather than using the recovery banner — a very likely user action given the banner is opt-in, `phase-02:199`). Both write `audio.part-0001…N.webm` interleaved. `concatParts` byte-concatenates a mixture of two WebM streams (`phase-03:85`), whose sequence check passes because the numbering is dense. Then it **deletes the parts** — destroying the live meeting's uploaded audio while it is still recording, which the recovery banner also cannot repair. The async pass transcribes a corrupt stream; worst case the concatenated file decodes partially and the meeting owner receives a transcript containing another meeting's content — a confidentiality failure inside the room, and an irrecoverable loss of the original recording.

**Evidence:** `phase-02:48,100,191,199`; `phase-01:197`; `phase-03:85`; `stable-file-id-and-replace-semantics.md:19-40` ("Replace is now an in-place upsert keyed by `(channel_id, file_path)`", "unique index `uniq_channel_filepath`").

**Suggested fix:** Put `meetingId` (or a short random suffix) in the folder name **and** the part name: `Meetings/<yyyy-mm-dd>-<slug>-<meetingId-6>/audio.part-NNNN.webm`. Have `concatParts` verify every part's `_id` equals the `partFileIds[seq]` recorded at upload time (not a name lookup) and that each part's `updatedAt` falls inside `[startedAt, endedAt]`; abort loudly on mismatch. Never delete parts by folder scan — delete only ids recorded in `processing_jobs.partFileIds`, and only after `audio.webm` upload is confirmed. Add a P8 negative test: two concurrent recordings, identical title, same room.

---

## F6 — Part-upload retry budget is ~7 seconds against a stated tolerance of a 10-minute degraded network; recording stops and cannot resume

**Severity: HIGH (data loss)**

**Location:** `phase-02:35` ("retry 3 lần/part, thất bại bền → dừng ghi"), `:100` (backoff 1s/2s/4s), `:250` (risk row), against `:201` (60-minute test with 10 minutes of throttled network), `:232` (10s outage → "part vẫn đủ và liên tục"), `plan.md:32` (acceptance: lose at most ~60s).

**Flaw:** Three attempts with 1/2/4s backoff exhaust in ~7 seconds of wall time. Any network interruption longer than that terminates recording. There is no pending-part queue, no re-drive of failed parts, and no unbounded (or even minute-scale) retry — yet the phase's own manual test throttles the network for 10 minutes and the acceptance criterion promises continuity.

**Failure scenario:** Office Wi-Fi flaps for 20 seconds at minute 43 of a 90-minute meeting. `uploadPart` gives up; recording stops; 47 minutes of the meeting are never captured. The recovery banner can only finalise from parts already uploaded, so the loss is permanent and silent-to-late (the user notices when the UI errors mid-discussion). The same interruption also drops the fire-and-forget `meeting_chunk_ready` for that part (`phase-02:192` — "lỗi chỉ log"), which via F3 Flaw A desynchronises `decodedSecBefore` for the remainder of the meeting even if recording survives.

**Evidence:** `phase-02:35,100,192,201,232,250`; `plan.md:32`.

**Suggested fix:** Keep failed part blobs in an in-memory (and, if P1-7 confirms IndexedDB, mirrored) FIFO and retry with capped exponential backoff for at least the duration the acceptance criteria claim to tolerate (minutes, not seconds), bounded by a memory budget (e.g. 20 parts ≈ 5 MB at 60s/opus) — stop recording only when that budget is exceeded, and say so in the UI before it happens ("Mạng yếu — đang giữ N phút chưa tải lên"). Make `meeting_chunk_ready` retry-on-failure with the part, or have the backend derive missing chunk work from `partCount` so a lost notification degrades latency, not correctness.

---

## F7 — Soniox cleanup runs in a `finally` with an aborted signal and no durable record of the remote ids, so timed-out or crashed jobs leave full meeting audio and transcripts at the vendor and re-bill on retry

**Severity: HIGH (data exposure + cost)**

**Location:** `phase-03:118` ("finally: DELETE /v1/files/{id} + DELETE /v1/transcriptions/{id}"), `:121` (retry/`signal`), `:32` (timeout → abort fetch), `:192` (test: "cleanup vẫn chạy khi lỗi"), `:199` (status tool strips "không id job phía Soniox"), `plan.md:112` (`processing_jobs` fields — no provider id), `plan.md:168` / `phase-08:24` (dataPolicy: "app **chủ động xoá** file + transcription sau mỗi job thay vì chờ auto-xoá 30 ngày").

**Flaw A:** The whole provider call takes one `AbortSignal` that is also used for the cleanup `fetch`. When `MEETING_JOB_TIMEOUT_MS` fires or the job is aborted, the `finally` block issues DELETEs on an **already-aborted** signal — each rejects immediately, the cleanup silently fails, and the plan's own test ("cleanup vẫn chạy khi lỗi") passes because it exercises the transcription-error path, not the abort path.

**Flaw B:** Neither `processing_jobs` nor `meetings` stores the Soniox `file_id`/`transcription_id` (`plan.md:112`; `SttResult.providerJobId` exists at `phase-03:101` but is never persisted, and `meeting_status` deliberately strips it at `:199`). A pm2 kill mid-poll therefore leaves an unreclaimable orphan: nothing in the system knows the id, so no sweep can delete it. The audio sits at the vendor for 30 days, directly contradicting the user-facing dataPolicy shown in Settings (`phase-08:24`).

**Flaw C — retry idempotency:** "Gọi lại ... `failed`/`stale` → reset record và chạy lại từ đầu" (`phase-03:30`) re-uploads the same audio and creates a second transcription. There is no `client_reference_id`-based lookup of an existing transcription for the meeting, so a job that timed out at 95% (a real possibility given async turnaround is undocumented, `plan.md:224`) is paid for twice and, if the first one completes after the reset, produces a second orphan.

**Evidence:** `phase-03:30,32,101,118,121,192,199`; `plan.md:112,168,224`; `phase-08:24`; Soniox async docs (files/transcriptions deletable individually or in bulk; behaviour when deleting mid-processing undocumented).

**Suggested fix:** Persist `sonioxFileId`/`sonioxTranscriptionId` on `processing_jobs` the moment each is created (before the first poll), and run cleanup on a **fresh, unaborted** signal with its own short timeout — cleanup must not inherit the job's signal. Add a boot/bootstrap sweep that lists Soniox files/transcriptions by `client_reference_id = meetingId` and deletes anything whose job is `completed`/`failed`. On retry, look up the existing transcription by `client_reference_id` and resume polling rather than re-uploading. Add a test that aborts mid-poll and asserts both DELETEs were issued **and** returned 2xx.

---

## F8 — Nobody finalises an abandoned meeting: status stays `recording` forever, parts are outside every retention sweep, and each abandoned meeting permanently consumes one of the 20 live-naming slots

**Severity: HIGH**

**Location:** `phase-05:41` (cap 20 concurrent meetings, "vượt thì từ chối chunk mới"), `phase-02:34,199` (recovery banner — owner reopens the app), `phase-08:30-32` (retention: only `meetings.status='summarized'` && `keepAudio===true` && `audioDeletedAt` empty → deletes `audio.webm`), `plan.md:108` (`meetings.status` enum), `phase-03:35` (boot sweep covers `processing_jobs`, not `meetings` stuck in `recording`).

**Flaw:** Every finalisation path is client-initiated by the meeting owner. If the iframe is closed (tab closed, laptop lid, room switched, browser crash) there is no server-side timeout that ends a meeting.
- `meetings.status` stays `'recording'`, which keeps `meeting_realtime_token` and `meeting_chunk_ready` accepting calls for it indefinitely (`plan.md:135-136`) and keeps it in the recovery-banner query for every future session.
- The uploaded `audio.part-NNNN.webm` files are covered by **no** sweep: the retention job only touches `audio.webm` of `summarized` meetings (`phase-08:32`), and `concatParts` (the only part-deleting code) runs only inside a job that was never started. Raw meeting audio accumulates in the room's Files indefinitely — both a storage leak and a privacy exposure (unreviewed, unsummarised recordings visible to room members).
- The in-memory registry entry, its ring buffer, and the decrypted profile cache for that meeting are never released (no TTL is specified anywhere in `phase-05`), so the "cap 20 meeting đồng thời" becomes a permanent count. After 20 abandoned meetings the backend **refuses new chunks for every new meeting in the workspace** (`phase-05:41`) — live naming silently stops working product-wide until pm2 is restarted, with only a log line.
- Only the owner can recover (`requireMeetingOwner`); if the owner leaves the workspace, the meeting is unrecoverable and its parts are unreachable through the app.

**Evidence:** `phase-05:41`; `phase-02:34,199`; `phase-03:35`; `phase-08:30-32`; `plan.md:108,135-136`.

**Suggested fix:** Add a server-side abandonment sweep in `meeting_bootstrap` + the boot sweep: `status='recording'` with no new part for > 3 × `PART_MS` → set `endedAt` from the last part's real duration and either auto-run `meeting_process` or move to `status='abandoned'` with a parts-retention deadline. Give registry entries an idle TTL (evict after ~5 minutes with no chunk) so the concurrency cap tracks *active* meetings; evict LRU rather than refusing new meetings, and emit a metric. Extend the retention job to orphaned `audio.part-*` files. Let any room member (or a workspace admin) finalise an abandoned meeting.

---

## Secondary observations (not scored, worth folding into the phases)

- **App DB write amplification:** `liveSpeakerRepository.upsertAll(... reg.snapshot())` runs every chunk for every session speaker (`phase-05:72`) with a re-sealed `pendingEmbedding` each time (new IV → always a write). A 3h meeting with 6 speakers ≈ 1,000+ bot tool-calls, on top of `meeting_live_speakers` polling every 3–5s per participant. `security-and-data-model.md:33` documents per-app rate limits on tool calls without publishing the numbers, and `items-query.md:47-48` shows the platform does enforce per-minute caps elsewhere. Write only changed speakers, and only when `liveSpeechSec` or the label set actually moved.
- **CSP surface not fully enumerated:** the manifest declares `connect-src` and `media-src` only (`plan.md:165-166`). `AudioWorklet.addModule(new URL(...))` (`phase-02:94`) depends on `script-src`/`worker-src` under the app-declared CSP (`security-and-data-model.md:19`), and none of the 10 P1 spikes (`phase-01:209`) covers worklet loading — if it is blocked there are no captions at all, discovered at P2 rather than P1. Also `https://api.soniox.com` in `connect-src` is not needed by the iframe (the key is minted server-side); drop it to shrink the surface.
- **`meeting_live_speakers` authz** is "thành viên phòng của meeting" (`plan.md:137`) while `meeting_chunk_ready` is owner-only — any room member can poll who is speaking in a recording they are not part of. Probably intended, but state it in the dataPolicy.

---

## Unresolved questions

1. Does Soniox's realtime speaker namespace actually reset per connection, and does an expired temporary key terminate an in-progress socket? Both are assumed by `phase-02:31,245`; neither is stated in the docs. P1 must measure.
2. What is the default `max_session_duration_seconds` when the mint body omits it? Docs give the range (1–18000) but no default — the 280-minute roll design depends on it.
3. Which clock do `meeting_chunk_ready.segments[].speaker` values use — the raw Soniox label or the `s{sessionIndex}:{label}` namespaced key? `phase-02:31` implies namespaced, `phase-05:89-101` reads like raw. Pick one and state it in the tool contract.
4. After reconcile, what is the primary key and lifecycle of a `meeting_speakers` row (live row vs async row vs merged row)?
5. Is mute implemented as `track.enabled = false` (audio timeline preserved, safe for F2) or as "stop sending PCM" (timeline breaks)?

Status: DONE_WITH_CONCERNS
Summary: Eight findings — five CRITICAL (label-trust centroid poisoning that propagates into permanent voiceprints; unbounded meeting-clock vs Soniox-audio-clock drift feeding wrong PCM to the embedder; a single failed chunk permanently desynchronising all later chunks plus a copied queue that provides neither per-meeting serialisation nor cancellation; reconcile specified against never-persisted spans with a self-contradictory precedence rule; folder/part name collisions that let one meeting overwrite and then delete another's audio) and three HIGH (7-second upload retry budget vs a 10-minute network-tolerance claim; Soniox cleanup that fails on abort and leaves unreclaimable vendor-side copies of meeting audio; no server-side finalisation for abandoned meetings, which leaks parts and permanently consumes the 20-meeting live-naming cap).
Concerns/Blockers: F1/F2/F3 compound — each independently produces wrong names, and together they make live naming quietly wrong rather than visibly broken; F5 is the only finding that destroys user data outright and should be fixed before any P2 code lands.
