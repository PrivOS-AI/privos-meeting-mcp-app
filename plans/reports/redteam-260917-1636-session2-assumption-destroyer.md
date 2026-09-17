# Red Team Session 2 — Assumption Destroyer + Scope Audit

Target: revised plan `plans/260917-1358-meeting-agent-mcp-app-elevenlabs-diarization-voice-fingerprint/`
Scope: changed design only — Soniox single-vendor STT, new Phase 5 live speaker naming, meeting clock, CSP, env.
Method: plan read in full (plan.md, P1, P2, P3, P5; P4/P6/P7/P8 skimmed) + Soniox official docs via fetch + npm registry + PrivOS platform docs. 8 findings.

Paths below are relative to the plan dir unless absolute.

---

## F-01 — CRITICAL — The chosen SDK cannot accept the PCM the design feeds it

**Location** `plan.md:47,81` · `phase-02:16,59,94,96,104-122,176,186,211`

**Flaw.** P2 mandates two mutually exclusive things at once. Line 104 heading: "Realtime client (SDK chính thức, không tự chế wire protocol)" — the RT-15 remediation from session 1. Everything under that heading is raw wire protocol:

- `soniox.sendAudio(pcm)` (`phase-02:59`) and `sendPcm(chunk: Int16Array): void` (`phase-02:117`)
- a hand-built config message in snake_case: `{ api_key, model, audio_format:'pcm_s16le', sample_rate:16000, num_channels:1, language_hints, enable_speaker_diarization, ... }` (`phase-02:120`)
- "Kết thúc audio = gửi **frame WebSocket rỗng**" (`phase-02:120`, also `phase-01:35`, `phase-02:64`)
- backpressure via `connection.bufferedAmount` (`phase-02:96`)
- manual backoff reconnect + mint-new-key-per-connect + `sessionIndex` roll (`phase-02:120`)

`@soniox/speech-to-text-web@1.4.0` exposes none of that. Its published API is `new SonioxClient({ apiKey })` → `.start({ model, languageHints, enableSpeakerDiarization, enableLanguageIdentification, enableEndpointDetection, context, translation, stream, onPartialResult, onError })` → `.stop()` / `.cancel()`.

**Evidence** (npm registry readme, `@soniox/speech-to-text-web@1.4.0`, published 2026-01-13):
> "The `SonioxClient` object processes audio from the user's microphone **or a custom audio stream**."
> "To transcribe audio from a custom source, you can pass a custom `MediaStream` to the `stream` option."
> "The key difference is that `stop()` gracefully waits for the server to process all buffered audio…"

Options are camelCase, audio ingest is a `MediaStream`, session termination is `stop()`. There is no documented raw-PCM ingest, no socket handle, no `bufferedAmount`. `@soniox/client@2.3.0` (2026-08-11) is a different SDK generation again (`SonioxClient` with `api_key: async () => …`, `client.realtime.*`, `client.tts.*`) — so plan.md open question #4's claim "đổi gói không đổi kiến trúc" is also false: every P2 call site changes.

**Failure scenario.** P2 day 1: the wrapper `soniox-realtime-client.ts` cannot be written as specified. The implementer takes the path of least resistance — hand-rolls the WebSocket, reintroducing exactly the defect session 1 booked as RT-15 ("tự chế wire protocol, 125 msg/s") — or adopts the SDK and silently drops the worklet, backpressure, per-frame drop, explicit empty-frame close and `sessionIndex` control, which are load-bearing for F-03 and F-05. Either way P2's effort estimate (3d) and P5's clock contract are invalid, and nobody notices until the 60-minute soak.

**Suggested fix.** Add an 11th P1 spike that *builds the wrapper*, not just connects: prove, with the pinned package, that you can (a) supply audio from your own worklet or accept the SDK's internal capture, (b) observe backpressure, (c) close cleanly, (d) reconnect with a fresh temp key. Decide package **before** P2 is written, not "P1-10 confirms and pins". If no SDK supports raw PCM ingest, delete the "SDK chính thức" mandate from P2:104 and re-accept RT-15 explicitly with the user, rather than leaving two contradictory requirements in the same phase.

---

## F-02 — CRITICAL — AudioWorklet cannot load in this iframe, and the CSP does not allow the only workaround

**Location** `phase-02:58,94,186,209` · `phase-01:47,82-83` · `phase-08:39,186`

**Flaw.** The caption branch depends on `src/ui/data/pcm-tap-worklet.js` loaded "bằng `new URL(..., import.meta.url)` để Vite bundle" (`phase-02:94`). Vite emits that as a **separate sibling asset fetched by relative URL**. The app document is `srcdoc` in a sandbox without `allow-same-origin`:

> "No frame headers needed since HTML is loaded via `srcdoc`" — `~/projects/privos-dev-docs/mcp-app-platform/developer-guide.md:132`
> "**Iframe sandbox**: deny-by-default — no `allow-same-origin`" — `security-and-data-model.md:16`
> "the app document runs in a **sandboxed opaque origin**" — `react-sdk-reference.md:126`

In a `srcdoc` document `import.meta.url` is `about:srcdoc`; a relative sibling URL does not resolve to anything fetchable. P1 already knows this and forbids it — `phase-01:47`: "Iframe opaque origin → mọi asset (css/js/svg) inline/bundle, **không fetch URL anh em**" — yet P2 does exactly that. The only workaround, `audioWorklet.addModule(URL.createObjectURL(new Blob([src])))`, is a script load governed by `script-src`. The declared CSP has only `connect-src` and `media-src` (`phase-01:82-83`), and `phase-08:39` pins that as final ("**không hơn**"). No spike covers it: the 10 P1 spikes (`phase-01:28-37`) cover mic, upload ceiling, presign, DB, Hub AI, bot, IndexedDB, Soniox WS, Soniox async, npm package — none touches AudioWorklet.

Secondary defect at the same site: `phase-01:78-83` splits UI metadata across `_meta.ui.permissions` and a **sibling** top-level `"ui": { resourceUri, hideAiChat, csp }`. The platform documents a single object: `_meta: { ui: { resourceUri, permissions, csp, hideAiChat } }` (`developer-guide.md:44-50`). A CSP declared in the wrong place is not rejected — it is ignored, and the failure surfaces as "Refused to connect" to Soniox with a manifest that lints clean.

Third: `https://api.soniox.com` is in the iframe `connect-src` (`phase-01:82`) but nothing in the iframe calls it — the backend mints the key (`phase-02:73`). It contradicts P8's own "không hơn" rule.

**Failure scenario.** P2 integration day: `addModule` throws in the room tab (it worked in `npm run dev` standalone, where the document has a real origin). Fix attempt via blob URL is blocked by CSP. Manifest edits require republish/approve cycles. Zero captions, zero speaker labels, and P5 has no turn stream at all — three phases blocked on a directive nobody spiked.

**Suggested fix.** New P1 spike: load an AudioWorklet from inside a real room tab, from a blob URL, and record which CSP directives are required. Add `script-src`/`worker-src` with `blob:` to `phase-01:82`, move all of `resourceUri`/`permissions`/`csp`/`hideAiChat` under `_meta.ui`, and drop `https://api.soniox.com` from the iframe CSP unless a spike proves the iframe needs it.

---

## F-03 — CRITICAL — The meeting clock (QĐ-17) joins two unsynchronised timelines and the design guarantees drift

**Location** `plan.md:96` (QĐ-17) · `phase-02:40,52,96,126-128` · `phase-05:59,63-64,78,201`

**Flaw.** `tokenToMeetingMs(t) = wsSessionOffsetMs[sessionIndex] + t.start_ms` (`phase-02:126`), with `wsSessionOffsetMs = performance.now() - recordingEpochMs` captured **"tại lúc WS mở"** (`phase-02:127`). That equation is only valid if Soniox's internal audio clock advances in lockstep with wall clock from the moment the socket opens. Three plan decisions break it, and none is compensated:

1. **Deliberate frame dropping.** `phase-02:40`: "bỏ frame PCM khi `ws.bufferedAmount` vượt trần nhỏ (caption là disposable)". Soniox derives `start_ms` from the audio bytes it has received. Every dropped 100-250 ms frame permanently shortens Soniox's timeline relative to wall clock. The error is **monotonic and unbounded** — 40 dropped frames over an hour is up to 10 s of accumulated skew. Correct for captions (disposable), fatal for P5, which uses the same numbers to index into recorded PCM.
2. **Pre-key buffering.** If the SDK is used (F-01), audio is captured before the temp key resolves: "Until this function resolves and returns an API key, audio data is buffered in memory. When the temporary API key is fetched, the buffered audio data will be sent to the server" (`@soniox/speech-to-text-web` readme). So `start_ms = 0` maps to *capture start*, not *socket open* — `wsSessionOffsetMs` is systematically wrong by the full mint latency (one round trip to the backend plus a Soniox API call), in the wrong direction, on every connect, reconnect and 280-minute roll.
3. **Mixed clocks in the subtraction.** `phase-05:59,63`: `chunkStartSec = reg.decodedSecBefore(seq) − overlap` is on the **ffmpeg-decoded part timeline**; `seg.startMs` is on the **WS timeline**; line 63 subtracts one from the other. `phase-05:78` correctly rejects `seq × 60` for the part side ("timeslice của MediaRecorder có jitter") — but applies no equivalent correction to the WS side, so the two are still only coupled through a single `performance.now()` reading taken at t=0.

There is also no detection: `phase-05:201` nominates "liveConfidence thấp đều" as the drift signal, which is indistinguishable from a bad threshold, a bad ONNX model, or a noisy room — all of which are separately unvalidated (`plan.md:227`).

**Failure scenario.** Minute 45 of a real meeting, after a network dip caused frame drops. Soniox says a turn runs 2700.0–2706.0 s. The real audio for that speaker is at 2694–2700 s. `chunk-worker` slices six seconds of the *previous* speaker, feeds it to `computeEmbedding`, and the registry attributes B's voice to A's `sessionSpeakerId`. Nothing throws. The UI shows a confident wrong name, and if anyone uses quick-assign on it, the contaminated centroid is sealed into `pendingEmbedding` and enrolled permanently (see F-06).

**Suggested fix.** Stop inferring the Soniox timeline. Count what you send: maintain `sentSamples` in the PCM tap and define `wsAudioMs = sentSamples / 16` so a dropped frame is *visible* in the mapping instead of invisible; better, do not drop frames on a branch whose timestamps are load-bearing — buffer or degrade the caption instead. Add an explicit drift budget and a hard gate: if `|tokenToMeetingMs(lastToken) − elapsedWallMs| > 750 ms`, mark the chunk `approxClock` and skip embedding rather than embedding the wrong audio. Add a P1 spike that measures observed skew over 10 minutes with induced drops.

---

## F-04 — HIGH — Turns crossing a part boundary are silently dropped; the success criterion that says otherwise is untestable

**Location** `phase-05:25,63-64,69,183` · `phase-02:32,187,230`

**Flaw.** `phase-05:25` states the requirement: "Turn vắt qua biên part được xử lý **trọn vẹn đúng một lần**, ở chunk chứa `startMs` của nó." `phase-05:183` makes it a success criterion with a concrete fixture: "turn vắt qua biên hai part được embed đúng **một** lần (test có fixture turn `[58s, 63s]`)".

The pseudocode does the opposite. The chunk window is `[overlap_tail_of_previous_chunk] + [this part]` — the ring buffer is filled from the **tail** of the current chunk for the *next* one (`phase-05:69`), so the window only extends **backwards**. For a turn `[58s, 63s]` in a chunk covering roughly `[-8 s … 60 s]`, line 64 evaluates `to > pcm.length / 16000` → `63 > 60` → `continue`. The turn is discarded. It is not picked up by chunk `seq+1` either, because dedupe is keyed on `startMs` belonging to the previous chunk (`phase-05:25`, `alreadyProcessed`). The named fixture, if written honestly, fails.

Compounding it: `phase-02:32` restricts `meeting_chunk_ready` to `is_final` lines only, and `turnsInPart(seq)` runs the instant the part blob closes. Soniox finalises on endpoint detection, i.e. after the speaker stops — so the last seconds of every 60 s part are never final at send time and are never resent (`seq` fires once). Every part systematically loses its trailing turns. That directly contradicts the P2 criterion `phase-02:230`: "`segments` phủ đúng khoảng thời gian của part".

**Failure scenario.** The only speakers who get named fast are those whose turns fall neatly inside a part. A person who speaks in long stretches — the chair of the meeting, the most important label to get right — loses a fragment at every boundary. With `LIVE_MIN_SPEECH_SEC = 8` and `SPEAKER_MIN_SEGMENT_SEC = 2` (`plan.md:179,181`), the 8 s budget fills more slowly than modelled, and the ≤90 s acceptance criterion (`plan.md:34`, `phase-05:186`) is missed without any error being raised.

**Suggested fix.** Pick one and write it down: either (a) defer boundary-crossing turns — hold turns whose `endMs` exceeds the chunk window and process them in chunk `seq+1` with a forward-overlap of the previous part's tail, keyed by `startMs` for dedupe; or (b) truncate the turn at the window edge and only embed it if the truncated span still exceeds `SPEAKER_MIN_SEGMENT_SEC`. Then restate `phase-05:25` and the `[58s,63s]` fixture to match the chosen behaviour. Separately, allow a `seq` to be re-sent once with late-finalised turns, or accept the loss explicitly in the criterion at `phase-02:230`.

---

## F-05 — HIGH — 10 concurrent WebSockets account-wide caps the whole workspace at 10 simultaneous meetings; "error 413" is invented

**Location** `plan.md:21,215,228` · `phase-02:29-30,188,246` · `phase-05:41,205`

**Flaw (a) — the real ceiling is unmodelled.** Soniox's documented realtime limits are per account, and every browser session in every room streams under a temporary key minted from the one `SONIOX_API_KEY` (`plan.md:175`):

> "The maximum number of simultaneous active WebSocket connections is **10**."
> "The limit is **100** [requests per minute], with a note that 'Exceeding this may result in rate limiting.'"
> — https://soniox.com/docs/stt/rt/limits-and-quotas

So the 11th person in the workspace who presses record gets no captions and no speaker labels. The plan mentions this only as a parenthetical inside open question #6 (`plan.md:228`), attached to a *data-residency* question. It appears in no risk table, no acceptance criterion, no error path, and no UI state. Worse, P5 sizes its own resources for **twice** that: "giới hạn 20 meeting đồng thời" (`phase-05:41`, repeated `phase-05:205`) — the plan is internally inconsistent about how many meetings can exist. The proactive roll at ~280 min (`phase-02:30`) opens a second socket before closing the first, consuming two slots; five long meetings rolling near the same time exhaust the pool.

**Flaw (b) — fabricated error code.** "cap cứng 300 phút/kết nối (**lỗi 413** 'maximum allowed duration')" is asserted as fact in `plan.md:21` and `plan.md:215`, and becomes code in `phase-02:188` ("bắt lỗi 413 như mất WS") and a trigger signal in `phase-02:246`. The limits page states only:

> "Each real-time session is capped at 300 minutes… This limit is fixed and cannot be increased."

No 413, no "maximum allowed duration" string, anywhere in the fetched limits or WebSocket API docs. The researcher report (`researcher-260917-1608:32`) does not mention it either. A WebSocket that has completed its handshake does not deliver an HTTP status; it closes with a close code and reason. Branching on `413` will not match anything.

**Failure scenario.** The 280-minute roll works in the happy path, so nobody checks the error branch. A real 5 h+ meeting, or a reconnect storm, hits either the duration cap or the concurrency cap; the handler that "bắt lỗi 413" never fires; the app shows "Caption tạm ngắt" forever, retries five times, and gives up. Meanwhile every other room in the workspace is also degraded because the connection pool is exhausted — and the recovery banner is never shown, because recording itself is fine.

**Suggested fix.** Treat the account limits as first-class capacity: add a backend-side concurrency counter to `meeting_realtime_token` (it already gates issuance, `plan.md:135`) that refuses the 11th active session with an explicit user-visible message rather than letting Soniox reject it opaquely; reconcile `phase-05:41`'s 20-meeting cap with the real 10. Replace every `413` reference with what the P1-8 spike actually observes — make "record the close code and reason at cap" an explicit spike output at `phase-01:35`. Set `max_session_duration_seconds: 16800` when minting (documented, range 1–18000 — https://soniox.com/docs/api-reference/auth/create_temporary_api_key) so the roll boundary is enforced by the vendor, not by a client-side timer.

---

## F-06 — HIGH — Client-supplied segment boundaries drive permanent biometric enrolment

**Location** `phase-05:23,32,34,67` · `phase-02:56-57` · `plan.md:136,142` · `phase-04` (`speaker_resolve`)

**Flaw.** `meeting_chunk_ready` accepts `segments[{speaker, startMs, endMs}]` from the iframe. Validation is arithmetic only — "≤ 200 phần tử, `endMs > startMs`, tổng ≤ 5× thời lượng part" (`phase-05:23`). The backend then uses those client-chosen spans to slice server-held PCM (`phase-05:63-67`), builds a centroid, seals it into `meeting_speakers.pendingEmbedding` (`phase-05:32`), and `speaker_resolve` decrypts that same blob to enrol a **workspace-global** `speaker_profiles` record, optionally bound to a `privosUserId` (`plan.md:142`, `phase-04` requirements; collection scope `global`, `plan.md:106`).

Two independent problems converge here:

1. **Trust boundary.** The only checks are owner + `status ∈ {recording, uploading}`. Any room member who can start a recording controls which audio becomes whose voiceprint. Sending `{speaker:'1', startMs: X, endMs: X+9000}` pointed at a colleague's speech, then quick-assigning it to `mode:'user'` with that colleague's — or their own — `privosUserId`, creates or poisons a workspace-wide biometric record with no consent from the person enrolled and no verification step. `speaker_profile_list` then exposes the result to every verified user (`plan.md:143`). The plan's own threat framing (RT-04, `plan.md:244`) established the rule "fileId phải được suy ra từ dữ liệu đã lưu, không bao giờ nhận từ client" (`phase-03:139`) — the new `segments[]` surface reintroduces exactly that class of input and is not covered by it.
2. **Correctness feeds the same sink.** Soniox documents realtime diarization as the weaker mode — "Real-time speaker diarization is more challenging due to low-latency constraints", "Higher speaker attribution errors compared to async mode", "Temporary speaker switches that stabilize as more context is available" (https://soniox.com/docs/stt/concepts/speaker-diarization). So even an honest client ships turn boundaries that sometimes contain two voices. `phase-05:31` correctly forbids auto-enrol — "KHÔNG enrol lúc live … tránh nhiễm bẩn voiceprint" — but lines 32 and 34 then hand that same live centroid to the enrolment path via quick-assign. The stated protection does not hold.

**Failure scenario.** Meeting 1: a mixed turn (A's tail + B's opening) produces a blended centroid; the user quick-assigns it to "Nguyễn Văn A" because A's name was on screen. `speaker_resolve` enrols the blend. Meeting 2, different room: B speaks, matches the poisoned profile at 0.55 and is auto-labelled "Nguyễn Văn A" — and P4 auto-enrols on match, deepening the contamination. Cross-room, silent, and the recovery path (`meeting_relabel_speaker` back-propagation) only removes embeddings per meeting, so the blended one persists.

**Suggested fix.** Do not let live-derived centroids into `speaker_profiles`. Make quick-assign record *intent* only — `meeting_speakers.displayName` + a pending link — and enrol from the **async pass** segments in P3/P4, which the plan already designates as the source of truth (`phase-03:20`) and which the vendor documents as materially more accurate. If live enrolment must stay, gate it on a purity test (intra-cluster cosine spread below a threshold across ≥3 independent turns) and require the enrolled subject's own confirmation before binding a `privosUserId`. Independently: validate `segments[]` against server-known part duration and against `sttSessionMeta`, and log a security event when they do not fit.

---

## F-07 — HIGH — The QĐ-15 A/B gate blocks the entire plan and has no owner, no inputs, and a criterion its own evidence does not support

**Location** `phase-01:39-43,190,210,237,256` · `plan.md:94,201,207,223`

**Flaw.** "Cổng A/B tiếng Việt (QĐ-15) — chạy trước khi bắt đầu P2" gates phases 2–8. Four things make it unrunnable as written:

1. **No audio exists and nobody is assigned to produce it.** It requires "≥30 phút audio họp **thật** VN+EN code-switch, 3-6 người, có ít nhất một giọng Bắc và một giọng Nam" plus "transcript tham chiếu **do người ghi tay**" (`phase-01:40`). Hand-transcribing 30 minutes of multi-speaker code-switched speech is 1–2 person-days on its own. No owner, no date, no budget. And it is circular: the product being built is the thing that records such meetings.
2. **DER is not computable from the stated inputs.** Metric (3) is "DER toàn clip" (`phase-01:42`). DER requires reference **speaker turn boundaries with timestamps**, not a hand-written text transcript. The gate asks for an artefact that cannot produce the metric it gates on.
3. **The ElevenLabs leg has no credentials path.** `phase-01:41` requires running the same audio through `scribe_v2` batch with `diarize=true` (the model id and parameter both check out — https://elevenlabs.io/docs/api-reference/speech-to-text/convert). `phase-01:183` simultaneously forbids any ELEVENLABS_* variable "trong `.env.example`, `env.ts` hay manifest", and `phase-08:186` restricts the name to the spike script and docs. So the script must authenticate against a paid account that the plan never provisions, from a variable the plan bans. No ElevenLabs account, billing, or key-handling instruction appears anywhere.
4. **The pass criterion silently tightened by roughly 10×.** `phase-01:43` and `plan.md:94`: pass when "WER VN của Soniox ≤ WER ElevenLabs **+2 điểm**". The evidence it cites says the opposite tolerance: "If Soniox WER is within **~2x** of ElevenLabs and DER is comparable, ship it — Soniox's price/feature/single-vendor advantages outweigh a small quality gap for an internal meeting tool" (`plans/reports/researcher-260917-1608-soniox-vietnamese-and-async-deep-dive.md:55`). At a plausible 12 % baseline, "+2 points" = 14 % while "2×" = 24 %. The plan adopted a far stricter bar than its source, did not flag the change, and attached a "+2d rework, do not lower the criterion" penalty to it (`phase-01:256`).

**Failure scenario.** P1 runs 3 days of scaffolding, reaches step 8c, and stops. Either the team waits weeks for someone to record and transcribe a meeting, or — far more likely — the gate is quietly executed on a short YouTube clip with a machine-generated reference, produces a meaningless WER, and the "signed decision" at `phase-01:237` rubber-stamps a vendor choice the whole architecture rests on.

**Suggested fix.** Name the owner, the source recording, and the date in `phase-01`, and budget the reference transcription as its own line item (P1 is currently 3d including ten spikes, the full scaffold and this gate). Reduce the reference to what is measurable: timestamped speaker turns + verbatim text for a 10-minute excerpt is enough for both WER and DER; 30 minutes of hand transcript is not affordable and not necessary. Decide explicitly with the user whether the bar is "+2 points" or the sourced "~2×", and record the rationale in QĐ-15. Add an ElevenLabs key-handling line (spike-local env, never committed) or drop the comparative leg and gate on an absolute WER target instead.

---

## F-08 — MEDIUM — Scope: a parallel live-translation pipeline was built for a feature the vendor already ships

**Location** `plan.md:91` (QĐ-12) · `phase-02:18,61,132,189,213` · `plan.md:138` (`meeting_translate`)

**Flaw.** QĐ-12 routes live bilingual captions through Hub AI: `translate-buffer.ts` batching finalised lines every 3–5 s, a `meeting_translate` tool with per-meeting rate limiting, deferred fill-in of already-rendered lines, and a documented 3–5 s user-visible lag (`plan.md:33`). Its "alternative rejected" column lists "Engine dịch riêng; dịch đồng bộ chặn caption" — it never considers that Soniox realtime already does this on the connection the app is already paying for:

> "Yes, Soniox real-time STT supports built-in translation… streams both transcripts and translations together over a single WebSocket connection"
> `{"translation": {"type": "two_way", "language_a": "en", "language_b": "es"}}`
> — https://soniox.com/docs/stt/rt/real-time-translation

`two_way` with `language_a: 'vi'`, `language_b: 'en'` is precisely the VN/EN meeting case. `translation` is a documented field in both the realtime config (websocket-api reference) and the async create-transcription body, and the chosen SDK exposes it directly (`translation: { type: 'two_way', … }` in the `@soniox/speech-to-text-web` readme). Tokens carry `translation_status` and `source_language` to separate the streams.

This is not just redundancy: the Hub AI path is slower (3–5 s vs token-by-token), adds a tool, a buffer module, a rate limiter, four tests and per-meeting AI cost, and it re-translates text that the STT model has richer context for.

**Failure scenario.** Two translation implementations ship (live via Hub AI, batch via Hub AI in P6), and the live one is the weaker of the two available options. Later, someone discovers the vendor flag and the `meeting_translate` surface becomes dead code that still has to be maintained, rate-limited and security-reviewed.

**Caveat to verify before adopting** — do not swap blindly: the WebSocket API reference states timestamps are **omitted on translation tokens** ("Start timestamp of the token (in milliseconds). Not included if `translation_status` is `translation`"), so `turnsInPart()` and `tokenToMeetingMs()` must filter on `translation_status === 'original'` or the meeting clock breaks. Interaction of `translation` with `enable_speaker_diarization` is not documented on the diarization page and must be spiked.

**Suggested fix.** Add to P1-8: run the realtime spike once with `translation: {type:'two_way', language_a:'vi', language_b:'en'}` alongside `enable_speaker_diarization`, and record whether `speaker` is still populated, whether original tokens keep their timestamps, and what it costs. If it holds, delete `translate-buffer.ts`, `meeting_translate` and its rate limiter from P2 and rewrite QĐ-12's rejected-alternatives column; keep the Hub AI path for the P6 batch pass only. While in the mint path, also set `single_use: true` on the temporary key (documented optional field) — the plan currently mints a 900 s key with no single-use and no session cap (`plan.md:135`, `phase-02:75-77`), so a key captured from the tab is replayable for its full TTL.

---

## Scope audit — requested features

| Requested | Present | Where | Note |
|---|---|---|---|
| Live captions with speaker labels | Yes | `plan.md:33`, `phase-02:16` | Delivery blocked by F-01/F-02 |
| Diarization (live + authoritative) | Yes | QĐ-01, QĐ-03, `phase-03:14` | Async pass is source of truth |
| AI summary | Yes | `phase-06` | Hub AI only, map-reduce, zod-validated |
| Save to PrivOS Files | Yes | `plan.md:125`, `phase-06` | 5 artefacts in `Meetings/<date>-<slug>/` |
| Review (history, detail, player, search, export) | Yes | `phase-07` | Depends on `PRIVOS_FILES_ORIGIN` spike |
| Speaker = PrivOS user **or** free-text name | Yes | `speaker_resolve` modes `user`/`name`/`merge`/`skip`, `plan.md:142` | Enrolment consent gap — see F-06 |
| Persistent voiceprint auto-ID | Yes | `phase-04`, `plan.md:106` | Thresholds and model EER still uncalibrated (`plan.md:227`) |
| Bilingual translation, live + batch | Yes | QĐ-12, `phase-02:18`, `phase-06` | Built twice on the wrong transport — see F-08 |
| Design screens 1a–1e | Yes | `phase-02:196-197` (1a/1b), `phase-07` (1c/1d), `phase-08:19` (1e) | One documented deviation: QĐ-08 removes the STT API-key field from 1e — correct call, correctly recorded |

**No scope creep found** in the session-2 delta. The new Phase 5 reuses P3/P4 modules rather than duplicating them (`phase-05:136` "chỉ **dùng lại**, không sửa logic"), and QĐ-16 removes the server-side diarization model rather than adding one — a genuine reduction. The ElevenLabs removal is thorough: `grep -rni "elevenlabs\|scribe"` across all 9 files returns hits only in the four places `plan.md:256` says are intentional (QĐ-15 fallback criteria, red-team history, references, P1 A/B). The claimed fallback is *documented* but not *credible on today's plan*, for the reason in F-07: the only thing that would trigger it is a gate that cannot currently be run.

**Housekeeping.** `plan.md` ends with stray tool-call residue at lines 259-261 (`</content>`, `</invoke>`); `phase-05` has the same at line 207. `phase-01:208` says the manifest carries "3 tool" while `phase-01:78-89` and `phase-01:230` both say 4.

---

## Unresolved questions

1. Which npm package is actually being used, and does any Soniox browser SDK accept caller-supplied PCM? F-01 and F-03 both change shape depending on the answer, and it must be settled before P2 is written, not during it.
2. Has anyone loaded an AudioWorklet inside a PrivOS room tab? If `script-src blob:` is not grantable, the entire live-caption branch needs a different audio path (e.g. `MediaStream` straight into the SDK, giving up backpressure and frame-level control).
3. Is the "+2 WER points" bar the user's decision or an unflagged tightening of the researcher's "~2×"? QĐ-15 should record which, since a +2 failure costs +2d and a vendor swap.
4. Who records and hand-annotates the A/B audio, and by when — and does the workspace have an ElevenLabs account for the comparison leg?
5. Does `translation: {type:'two_way'}` coexist with `enable_speaker_diarization` on `stt-rt-v5`? Undocumented; determines whether `meeting_translate` should exist at all.
6. What is the intended behaviour when the workspace exceeds 10 concurrent recordings — queue, refuse, or degrade to recording-without-captions? The plan has no answer and P5 assumes twice the capacity that exists.

Status: DONE_WITH_CONCERNS
Summary: Eight findings against the session-2 delta — three Critical (the chosen Soniox SDK cannot ingest the PCM the design produces; AudioWorklet cannot load in a srcdoc/opaque-origin iframe and the CSP omits the only workaround; the QĐ-17 meeting clock joins two unsynchronised timelines while the design deliberately drops frames), four High (boundary-crossing turns are dropped despite a success criterion asserting the opposite; the 10-concurrent-WebSocket account limit is unmodelled and the "413" error code is invented; client-supplied segment spans drive workspace-global biometric enrolment; the QĐ-15 A/B gate has no owner, no inputs, an uncomputable metric and a criterion its own source does not support), one Medium (a parallel Hub AI live-translation pipeline duplicates Soniox's built-in `two_way` realtime translation). Requested feature scope is complete with one documented design deviation and no scope creep.
Concerns/Blockers: F-01, F-02 and F-03 all land in Phase 2 and none is covered by the ten P1 spikes; Phase 5 inherits all three. F-07 gates Phases 2-8 on work nobody is assigned to do.
