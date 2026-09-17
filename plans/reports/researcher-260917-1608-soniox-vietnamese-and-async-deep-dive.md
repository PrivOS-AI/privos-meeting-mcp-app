# Soniox Vietnamese Quality + Async API Deep Dive

Context: prior report ([researcher-260917-1550](./researcher-260917-1550-live-diarization-market-survey.md)) picked Soniox realtime as #1 for live captions+diarization. This report checks if Soniox async can ALSO replace ElevenLabs Scribe batch, making Soniox the single vendor.

## 1. Vietnamese quality

- Models: current active = `stt-rt-v5` (realtime), `stt-async-v5` (async); old `-v4` names alias to `-v5`. Both cover "60+ languages" incl Vietnamese, w/ diarization + language-ID + translation built in. [models docs](https://soniox.com/docs/stt/models)
- Code-switching: `enable_language_identification` tags each **token** with a language code; `language_hints` (ISO codes) biases the model without hard-restricting — good fit for VN/EN mixed meetings, use both `vi`+`en` hints. Vendor doc admits realtime lang-ID is "more challenging" live (less context) causing "temporary misclassification... revised as more context arrives" but claims "highly reliable detection of language switches." [lang-id docs](https://soniox.com/docs/stt/concepts/language-identification), [lang-hints docs](https://soniox.com/docs/stt/concepts/language-hints)
- Tone marks/accents: no dedicated doc section found on VN tone-mark handling or Northern/Southern accent split — not documented, not testable except empirically.
- **VN WER claim (5.4%, or 1.25% on a differently-worded claim) is SONIOX-SELF-REPORTED** — comes from Soniox's own "2025 study across 60 languages, real-world YouTube audio" cited only on soniox.com compare pages, no named third-party author found. [compare page](https://soniox.com/compare/soniox-vs-openai/vietnamese)
- Checked the one genuinely independent leaderboard, **Artificial Analysis** (artificialanalysis.ai) — real third party, methodology = AA-AgentTalk/VoxPopuli/Earnings22 datasets — but its published Soniox page only shows an **aggregate multi-dataset WER, no Vietnamese-specific breakdown**. [artificialanalysis.ai/speech-to-text/models/soniox](https://artificialanalysis.ai/speech-to-text/models/soniox)
- Checked Pipecat's independent STT benchmark (real third-party, `pipecat-ai/stt-benchmark-data` on HF, open-source) — Soniox scores well there (83.3% perfect transcripts) but **dataset is English-only, no Vietnamese**. [pipecat docs](https://docs.pipecat.ai/api-reference/server/services/stt/soniox)
- No Reddit/HN/GitHub-issue community reports on Soniox+Vietnamese found despite targeted searches — Soniox is small/new enough that community chatter specific to VN doesn't exist yet. No customer references in Vietnam found either.
- **Verdict on VN quality: unverified by any independent source.** All specific VN WER numbers trace back to Soniox marketing. This is the single biggest gap — same conclusion as prior report, now confirmed after deeper digging.

## 2. Async (file) API

- Endpoint family: `POST /v1/files` (upload, returns `file_id`) then `POST /v1/transcriptions` with `model`, `audio_url` OR `file_id` (mutually exclusive), `language_hints`, `enable_speaker_diarization`, `enable_language_identification`, `webhook_url`, `context`. Poll `GET` on transcription id or use webhook for `queued`→`processing`→`completed`/`error`. [create endpoint](https://soniox.com/docs/api-reference/stt/transcriptions/create_transcription), [async overview](https://soniox.com/docs/stt/async/async-transcription)
- Auth: Bearer API key from console.soniox.com, same key type as realtime (or a scoped temporary key).
- Formats: auto-detected — aac, aiff, amr, asf, flac, mp3, ogg, wav, **webm**, m4a, mp4. Browser MediaRecorder webm/opus output is directly accepted, no ffmpeg transcode needed for the async leg. [async docs](https://soniox.com/docs/stt/async/async-transcription)
- Diarization: `enable_speaker_diarization` flag, "each token includes a speaker identifier" — max 15 speakers per session/file, doc explicitly says async has "significantly higher diarization accuracy... full audio context" vs realtime. [diarization concept](https://soniox.com/docs/stt/concepts/speaker-diarization) — this directly covers our 2-6 speaker range with margin.
- Output schema: tokens carry timing + speaker + language fields (exact field names not fully enumerated by docs fetch — likely `start_ms`/`end_ms`/`speaker`/`language` per realtime parity, **not 100% confirmed field-by-field**, verify with a live test call).
- Max file size/duration, processing speed/turnaround: **not documented** on the pages found — not stated anywhere I could reach. Must test empirically with a 2-3h file before committing.
- Pricing: **$0.10/hr async** vs $0.12/hr realtime — cheaper than realtime, both "same model, identical accuracy/features" per vendor pricing page. [pricing](https://soniox.com/pricing) (token-based billing under the hood: $1.50/1M input-audio tokens async vs $2.00/1M realtime.)
- Retention: async data auto-deletes after 30 days unless kept; deletable anytime via console/API; realtime is zero-retention by default (nothing stored unless you use async explicitly). [security docs](https://soniox.com/docs/security-and-privacy)
- Compliance: **SOC 2 Type 2, ISO/IEC 27001:2022, GDPR, HIPAA** certified per Soniox's own security page — strong claim, documentation gated behind console login so not independently viewable by us here. [security docs](https://soniox.com/docs/security-and-privacy)
- Region: not confirmed EU vs US data residency options in what was fetched — console likely has region selection, unconfirmed.
- Rate limits (documented for realtime, presumed shared account-wide): 100 req/min, 10 concurrent WS connections (raisable via console request). Async-specific limits not separately documented. [limits docs](https://soniox.com/docs/stt/rt/limits-and-quotas)

## 3. Realtime specifics for design

- Max WS session: **hard cap 300 min (5h)** per connection — comfortably covers our 1-3h meetings with zero reconnect needed. Reconnecting the same connection cannot extend it; for anything near the cap, roll to a fresh WS before hitting it. [limits docs](https://soniox.com/docs/stt/rt/limits-and-quotas)
- `is_final` semantics: **confirmed explicit** — non-final tokens can change, "final tokens... are confirmed and never change in future responses" per realtime docs. [rt docs](https://soniox.com/docs/stt/rt/real-time-transcription)
- Speaker-label stability: doc says "temporary speaker switches that stabilize as more context is available" but **does NOT explicitly state whether a token already marked `is_final` can later have its `speaker` field revised** — this is the one open question the prior report also flagged; still unresolved after this pass. Since `is_final` text itself is locked, the safest assumption for the app is that **speaker on final tokens is also locked** (consistent phrasing), but this is inferred, not vendor-confirmed — verify empirically.
- Endpoint detection: automatic finalization when speaker stops, or force via `{"type":"finalize"}` message — but doc explicitly warns forcing early finalization "reduces diarization accuracy," a real trade-off for snappy captions vs correct labels.
- Audio: auto-detected common formats (webm/opus, mp3, wav, etc.) OR raw PCM (signed/unsigned/float, various bit depths, mulaw/alaw) with manual sample-rate/channel config — `pcm_s16le` 16kHz mono is supported as a manual raw format.
- Temp API key: `POST https://api.soniox.com/v1/auth/temporary-api-key`, body `{"usage_type":"transcribe_websocket","expires_in_seconds":N}`, optional `client_reference_id`, `single_use`, `max_session_duration_seconds`. Response = `api_key`+`expires_at`. This is a clean fit for our browser-proxy pattern (backend mints, browser consumes). [auth docs](https://soniox.com/docs/api-reference/auth/create_temporary_api_key)
- SDKs (verified via npm registry, published 2026-08-11 by Soniox-owned npm accounts): `@soniox/client` v2.3.0 (browser), `@soniox/node` v2.3.0 (Node), `@soniox/react` v2.3.0 (React hooks). The older `@soniox/speech-to-text-web` v1.4.0 (published ~8 months ago) still resolves on npm but looks superseded by `@soniox/client` — **use `@soniox/client`+`@soniox/node`, not the older package**, and confirm with Soniox docs/changelog before wiring in (npm alone doesn't prove deprecation, but the version+maintainer+recency gap is a strong signal).

## 4. Speaker identity across sessions

Confirmed: no enrollment/voiceprint feature anywhere in Soniox docs (models, diarization concept, or async/rt pages) — diarization is per-session integer/label only, same limitation noted in prior report. **Our sherpa-onnx voiceprint pipeline stays as the only cross-meeting identity mechanism.**

## 5. Vendor maturity/risk

- Company: very small — one source says 15 employees, another (older) 2 — team clearly grew but still tiny vs Deepgram/AssemblyAI. CEO Klemen Simonic. Backed by Samsung Venture Investment (per Crunchbase/PitchBook/Tracxn aggregator listings, not primary-sourced beyond that). [Crunchbase](https://www.crunchbase.com/organization/soniox)
- Status page (status.soniox.com, live-checked): "All systems operational," 90-day uptime US/EU/India 100.0%, Japan 99.99%, Console 99.98%, no incidents past 7 days — good recent track record, but **no long-history/SLA numbers published**, and no public SLA contract terms found. [status.soniox.com](https://status.soniox.com/)
- Pricing has been stable in the sense that the current page shows one flat rate per mode across ALL languages (no VN premium) — a genuine differentiator vs vendors that gate VN behind a pricier tier (AssemblyAI Pro, per prior report).
- Adoption risk: newer/smaller vendor, no major public case studies found beyond its own marketing pages (Soniox-App vertical landing pages for VN don't name real customers). Abandonment risk is nontrivial for a company this size, though SOC2/ISO/HIPAA certs plus Samsung-linked funding are points in favor of durability.

## 6. Verdict

**(a) Can Soniox VN quality replace ElevenLabs' "excellent" VN tier?**
**Confidence: LOW-MEDIUM, unverified.** No independent WER number exists for Soniox+Vietnamese; every figure traces to Soniox's own comparison pages. Do NOT commit to full replacement on paper claims alone.
**Required 30-min A/B test**: record (or reuse) one real VN/EN-code-switched meeting clip w/ 3-6 speakers incl at least one Northern + one Southern-accented speaker, run through both Soniox async (`enable_speaker_diarization`+`language_hints:["vi","en"]`) and ElevenLabs Scribe batch, then measure: (1) WER on VN segments specifically (manual reference transcript), (2) token-level language-ID accuracy at VN/EN switch points, (3) speaker-diarization accuracy (DER) on the full clip, (4) qualitative check of VN tone-mark/diacritic correctness, (5) numbers/proper-noun handling. If Soniox WER is within ~2x of ElevenLabs and DER is comparable, ship it — Soniox's price/feature/single-vendor advantages outweigh a small quality gap for an internal meeting tool (not legal/medical transcript).

**(b) Single-vendor Soniox (rt+async) vs Soniox rt + ElevenLabs batch?**
**Recommendation: single-vendor Soniox, PENDING the A/B test above passing.** Cost/2h meeting: Soniox rt+async ≈ 2h×$0.12 (live) + 2h×$0.10 (async re-pass) = **$0.44** total (if you run both realtime AND async for the same audio — realtime for live captions, async for the authoritative post-meeting transcript). Soniox rt + ElevenLabs batch: 2h×$0.12 (Soniox rt) + ElevenLabs Scribe batch rate (not re-priced here, covered in prior context report — historically ~$0.30-0.40/hr range for batch diarization tiers, i.e. ≈$0.60-0.80 for 2h) → **≈$0.84-1.04** total. Single-vendor Soniox is materially cheaper AND removes a second vendor integration/contract/retention-policy surface, one webhook model instead of two, one compliance story (SOC2/ISO/GDPR/HIPAA already covers both legs). This is the strictly better architecture IF the VN async quality holds up in testing.

**(c) Risks**:
1. VN WER is vendor-self-reported only — the single biggest open risk, gates the whole decision (test in `6a` above).
2. Speaker-label revision-after-final behavior is inferred, not documented, for realtime — verify empirically before building UI that assumes locked-once-final speaker tags.
3. Tiny company (teens of employees) — real abandonment/pivot/pricing-change risk vs Deepgram/AssemblyAI's scale; mitigate by keeping the ElevenLabs integration code path dormant (not deleted) as a fallback.
4. Async output token schema (`speaker`/`start_ms`/`end_ms`/`language` field names) not fully confirmed from docs — get exact JSON shape from a live test call before writing the parser, not from docs alone.
5. No confirmed EU/US data-residency selection — if PrivOS meeting content must stay in a specific region for compliance, this must be confirmed with Soniox support before launch.
6. Max file size/duration and processing turnaround for async are undocumented — test with an actual 2-3h recording; if async turnaround is slow, it affects "authoritative transcript ready promptly after meeting ends" UX expectations.
7. `@soniox/speech-to-text-web` (old) vs `@soniox/client` (new) package split found on npm — pick the currently-maintained one, don't blindly follow older tutorial code snippets that reference the old package name.

## Unresolved questions
1. Independent, Vietnamese-specific WER/DER benchmark for Soniox — does not exist publicly; only resolvable via our own A/B test.
2. Whether a `speaker` field on an already-`is_final:true` realtime token can later be corrected — not stated in docs, assume locked but verify with live test.
3. Exact async output JSON schema (field names for timestamps/speaker/language per token) — confirm via one live API call.
4. Max async file size/duration limit and typical processing turnaround time — undocumented, need empirical test with a 2-3h file.
5. EU/US data-residency selection availability for compliance-sensitive deployments — not found in fetched docs, ask Soniox support/console.
6. Whether Samsung Venture funding info (from aggregator sites, not Soniox itself) is current/accurate — not primary-sourced.

Status: DONE_WITH_CONCERNS
Summary: Soniox async ($0.10/hr, webm-native, `enable_speaker_diarization`, 15-speaker cap, SOC2/ISO/GDPR/HIPAA certified) can technically replace ElevenLabs batch, making Soniox a viable single-vendor stack for both live captions+labels and the authoritative post-meeting transcript — cheaper (~$0.44 vs ~$0.84-1.04 per 2h meeting) and simpler than a two-vendor setup. But every Vietnamese-accuracy number found is Soniox-self-reported with zero independent confirmation, so the recommendation is conditional on a 30-min VN/EN A/B test (Soniox vs ElevenLabs) passing before cutting ElevenLabs.
Concerns/Blockers: VN quality claims unverified by any third party (biggest blocker); realtime speaker-label-after-final-lock behavior undocumented; async output schema and file-size/turnaround limits undocumented — all need a live API test pass, not just docs review, before final go/no-go.
