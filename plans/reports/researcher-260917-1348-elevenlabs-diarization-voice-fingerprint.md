# ElevenLabs STT + Persistent Voice Fingerprint — Research Report

## A. ElevenLabs Speech-to-Text (Scribe)

**Endpoint**: `POST /v1/speech-to-text/convert` (Node SDK: `@elevenlabs/elevenlabs-js`, method `client.speechToText.convert()`). [Official ref](https://elevenlabs.io/docs/api-reference/speech-to-text/convert), [SDK](https://github.com/elevenlabs/elevenlabs-js).

**Key params** (from official docs + elevenlabs/skills repo [transcription-options.md](https://github.com/elevenlabs/skills/blob/main/speech-to-text/references/transcription-options.md)):
- `model_id` (req): `scribe_v1` / `scribe_v2` (also realtime variant, separate WS product)
- `file` (max 5GB, min 100ms) or `source_url` (YouTube/TikTok too) or deprecated `cloud_storage_url` (max 2GB)
- `language_code`: ISO-639-1/3, optional hint
- `diarize` (bool): turn on speaker labels; `num_speakers` (up to 32, batch); `diarization_threshold` (0.1-0.4, default 0.22, higher = merges speakers more)
- **`use_speaker_library` (bool, default false)** — added per [changelog 2026-06-15](https://elevenlabs.io/docs/changelog/2026/6/15): matches diarized speakers against a **workspace-level "speaker library"** of registered profiles. Requires `diarize=true`.
- `detect_speaker_roles` (bool): labels as `agent`/`customer` (call-center use case), incompatible with `use_multi_channel`.
- `timestamps_granularity`: `none`|`word`(default)|`character`
- `tag_audio_events` (default true): tags laughter/applause etc.
- `use_multi_channel` + `multichannel_output_style`: separate-channel diarization, but **duration cap drops to 1hr** (vs 10hr standard mono)
- `webhook`/`webhook_id`/`webhook_metadata`/`enable_logging=false` for async/zero-retention
- `entity_detection`/`entity_redaction` (PII/PHI/PCI), `keyterms` (up to 1000 bias terms), `temperature`, `seed`, `no_verbatim` (scribe_v2 only)

**Limits**: file 5GB / 100ms min; **duration 10h standard, 1h multichannel** — covers your 1-3h meetings fine in standard mono mode.

**Response**: `words[]` each with `text`, `type` (`word`|`spacing`|`audio_event`), `start`, `end` (sec), `speaker_id`, `logprob`, `channel_index`(multichannel), `characters`(if granularity=character). Top-level: `language_code`, `language_probability`, `text`, `transcription_id`, `audio_duration_secs`.

**Pricing**: Scribe v2 batch ≈ **$0.22/hr ≈ $0.0037/min** API PAYG; subscription credit system charges 330 credits/min. Realtime ≈ $0.39/hr. Add-ons: entity detection $0.07/hr, keyterms $0.05/hr. [Source](https://elevenlabs.io/pricing/api) (WebFetch on pricing page 404'd; figures triangulated via WebSearch snippets from cekura.ai/flexprice — **treat as approximate, verify on elevenlabs.io/pricing/api before billing decisions**).

**Vietnamese**: rated "excellent accuracy" tier by ElevenLabs' own language page, covers Northern/Central/Southern accents; overall Scribe WER ~3.1-3.3% FLEURS, 96.7% English accuracy claimed. [elevenlabs.io/speech-to-text/vietnamese](https://elevenlabs.io/speech-to-text/vietnamese).

**CRITICAL FINDING — voice fingerprint**: ElevenLabs is **not** just per-request `speaker_0`/`speaker_1` labels. The `use_speaker_library` param (added June 2026) is exactly the cross-recording voice-fingerprint feature you need — it matches diarized speakers against a **workspace speaker library**. However:
- I could **not find a public API endpoint to programmatically register/enroll a speaker into the library** (searched `/v1/speaker*`, changelog, API ref). It may be dashboard/UI-managed only, or gated to certain plans — this is the single most important unresolved question (see below). If enrollment is UI-only, it breaks a fully-automated self-hosted MCP flow.
- No mention of exportable embeddings/vectors — ElevenLabs keeps this as a closed matching service, not a portable fingerprint you own.
- Confirms speaker_id without `use_speaker_library` is per-request only (`speaker_0`, `speaker_1`...), consistent with AssemblyAI/Deepgram/Speechmatics — none of those three have cross-file speaker ID either; identification across files is universally "a custom build with voice embeddings" per AssemblyAI's own comparison blog.

Given the enrollment-API gap is unverified, **do not architect around `use_speaker_library` as the primary mechanism** until confirmed live via ElevenLabs support/dashboard testing. Treat it as a possible future optimization, not the v1 design.

## B. Speaker-embedding approaches (ranked)

| # | Option | License | Dim | EER (VoxCeleb1) | Node integration | Verdict |
|---|--------|---------|-----|------|------|---------|
| 1 | **SpeechBrain ECAPA-TDNN** (`speechbrain/spkrec-ecapa-voxceleb`) | Apache-2.0, commercial OK | 192 | 0.69% | Python sidecar (FastAPI) or ONNX export → `onnxruntime-node` | **Best default** — permissive license, ungated HF repo, small model, well-documented, huge community. |
| 2 | pyannote/embedding + `speaker-diarization-3.1` | MIT (pipeline), but **gated** on HF (must accept terms) | — | — | Python sidecar | Good but gating adds friction for air-gapped setup (must pre-download while online). |
| 3 | pyannote **community-1** | CC-BY-4.0, "always free" per pyannoteAI blog | — | — (claimed better than 3.1) | Python sidecar | Newer, better OOTB, still gated login-wall on HF despite permissive license — same friction as #2. |
| 4 | NVIDIA NeMo TitaNet (small/large) | CC-BY-4.0 | — | strong (NeMo benchmarks) | Export via NeMo `export.py` → ONNX → `onnxruntime-node`; export path less documented ("no separate tutorial") | Viable but rougher export path; heavier NeMo dependency for conversion step only. |
| 5 | WeSpeaker (WeNet) | CC-BY-4.0 (VoxCeleb models) | varies | competitive | Native ONNX export documented (`infer_onnx.py`), `wespeakerruntime` PyPI pkg | Good alt to ECAPA, ONNX-first design fits Node via onnxruntime-node well. |
| 6 | Resemblyzer | permissive (MIT-like, unofficial wrapper of GE2E) | 256 | weaker than ECAPA (older d-vector approach) | Python sidecar | Lower accuracy, simple API — fallback only if others fail to install. |
| 7 | 3D-Speaker | Apache-2.0 (Alibaba DAMO) | varies | competitive, less English-language docs | Python sidecar | Less mainstream, keep as backup reference. |

**Node-native ONNX loader**: `speakeronnx` (GitHub `TigreGotico/speakeronnx`) — pure onnxruntime, no torch at runtime, does embedding extraction + cosine similarity directly — worth evaluating to avoid a Python sidecar entirely, but it's a small/less-vetted community project (verify maintenance before relying on it in production).

### Hosted APIs with real cross-recording speaker ID
- **pyannoteAI Precision-2** — commercial closed model, single REST endpoint does diarization+identification+voiceprint together. Voiceprint = biometric signature from **≥30s clean audio**, returns person id + confidence. Pricing from **€0.112/hr**, 30-day trial (150hrs). [pyannote.ai/changelog/precision-2](https://www.pyannote.ai/changelog/precision-2), [pyannote.ai/md/models](https://www.pyannote.ai/md/models). **Not self-hostable / not air-gapped-compatible** (cloud API only) — disqualifies it if air-gap is a hard requirement, but strong option if network egress is allowed.
- **AssemblyAI / Deepgram / Speechmatics** — diarization only, no enrollment/voiceprint product; AssemblyAI's own blog states cross-file speaker recognition "is still in development" / requires custom embeddings build. [assemblyai.com/blog/speaker-diarization-vs-recognition](https://www.assemblyai.com/blog/speaker-diarization-vs-recognition).
- **Azure Speaker Recognition** — **retired 2025-09-30**, do not design around it. [Microsoft retirement notice](https://vbcloudboy.medium.com/retirement-of-azure-ai-speaker-recognition-whats-next-for-you-7c5f445d0ba2).
- **Picovoice Eagle** — on-device (fully offline) Node.js SDK, real-time speaker recognition, good air-gap fit. Licensing: free console tier + paid "Foundation"/"Enterprise" plans (Foundation restricted to young/small startups); commercial use requires AccessKey + paid plan for scale. [picovoice.ai/docs/api/eagle-nodejs](https://picovoice.ai/docs/api/eagle-nodejs/). Worth a bake-off against SpeechBrain ECAPA since it needs **no Python sidecar at all** — but it's a proprietary black-box model (no visibility into embedding quality/EER, vendor lock-in, and per-plan usage caps could bite a 1-3h-meeting workload).

### Matching strategy
- Cosine similarity on ECAPA embeddings: **~0.25 raw threshold** is a commonly cited default (unlabeled community consensus, not vendor-official — no single canonical source, treat as starting point requiring your own calibration on real Vietnamese+English meeting data).
- Enrollment: 5-10 segments of 2-10s clean single-speaker speech, embeddings averaged/centroided per person; store multiple embeddings (not just one centroid) to handle mic/device variability, update centroid incrementally as new meetings confirm identity.
- Unknown speaker handling: below-threshold matches → create new `person_id` (unlabeled), prompt user to name/link to PrivOS user post-meeting.
- Cross-lingual: ECAPA/TitaNet/WeSpeaker are trained on VoxCeleb (mostly English/multilingual mix) — embeddings are largely **language-independent** (they model vocal-tract/prosody, not phonetics) so Vietnamese speakers should embed fine, but validate empirically — no vendor benchmarks specifically for Vietnamese speaker-ID EER.

## C. Recommended architecture

**Primary**: ElevenLabs Scribe (diarize=true, num_speakers if known) → ffmpeg slices per diarized segment (using `words[].start/end` grouped by `speaker_id`, take contiguous segments ≥2s, prefer the longest ones per speaker) → Python sidecar (FastAPI, single `/embed` endpoint) running SpeechBrain ECAPA-TDNN → cosine-match embedding against stored voiceprints (per-org corpus) → assign `person_id` if match ≥ threshold else create new unmatched-speaker record → LLM summarization/labeling pass lets user rename unmatched speakers, which back-fills the voiceprint store.

**Fallback**: If Python sidecar is operationally undesirable (pure-Node constraint), use `speakeronnx`/onnxruntime-node with WeSpeaker or ECAPA ONNX export directly in Node — same architecture, no sidecar process. If network egress is acceptable (not air-gapped), pyannoteAI Precision-2 collapses diarization+identification into one hosted call and removes the embedding-infra entirely — simplest but violates air-gap requirement and adds recurring per-hour cost on top of ElevenLabs STT cost.

```
POST /meetings/:id/process
  1. audio -> ElevenLabs STT (diarize=true) -> words[] with speaker_id
  2. group words by speaker_id -> contiguous segments -> pick top-N longest per speaker
  3. ffmpeg -ss start -to end -i audio.wav seg_speakerX_N.wav   (per segment)
  4. POST seg_*.wav -> embed sidecar -> embedding[192]
  5. for each speaker_id: avg/centroid its segment embeddings -> query voiceprint_store
       cosine_sim(embedding, stored.embeddings) >= threshold ? person_id : NEW
  6. persist: transcript (speaker_id -> person_id|unlabeled), voiceprint updates
  7. LLM summarize -> store transcript+summary in PrivOS files
  8. user renames "Unknown speaker 2" -> Person -> merges/creates voiceprint
```

**Data model**:
```
voiceprint {
  person_id        // FK -> privos_user_id | free_text_name
  embeddings: [{ vector: float[192], created_from_meeting_id, segment_duration_s, created_at }]
  centroid: float[192]        // recomputed on new embedding add
  quality_score: float        // e.g. avg intra-cluster cosine sim, flags noisy enrollments
  updated_at
}
speaker_assignment {
  meeting_id, elevenlabs_speaker_id, person_id (nullable until resolved), confidence
}
```

## D. LLM summarization (1 paragraph)

For long diarized transcripts (1-3h), chunk by topic/time-window (e.g. 10-15min windows or every N speaker turns) rather than raw token windows, carry forward a rolling short summary as context between chunks (map-reduce style), then a final pass merges chunk summaries into meeting-level summary + structured JSON (`{summary, decisions[], action_items:[{owner, task, due}], key_topics[]}`) enforced via tool-call/JSON-schema output. Model choice by cost/quality: use **claude-haiku-4-5-20251001** for the cheap per-chunk map pass (high volume, simple extraction), **claude-sonnet-5** for the reduce/final-merge pass (balances quality/cost for structured JSON), reserve **claude-opus-5** only if action-item extraction accuracy is failing on sonnet, and **claude-fable-5-1** if the org already standardizes on it as the top-tier default — verify exact current model ids in your PrivOS SDK config since naming may still shift.

## E. Realtime follow-up (live browser mic capture)

### 1. Scribe realtime — WS API
- **Endpoint**: `wss://api.elevenlabs.io/v1/speech-to-text/realtime` (regional variants: US/EU/India/Singapore). [Official ref](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime).
- **Auth for browser clients**: never expose the main API key client-side. Backend mints a **single-use token**: `POST https://api.elevenlabs.io/v1/single-use-token/realtime_scribe` (path param `token_type=realtime_scribe`) using your server-side API key; token **expires in 15 min, consumed on first use**. Browser connects passing the token via `token` query param (or `xi-api-key` header if server-to-server). [Create Single Use Token](https://elevenlabs.io/docs/api-reference/tokens/create), [Authentication](https://elevenlabs.io/docs/api-reference/authentication). This fits your flow: backend mints token per meeting-start, browser opens WS directly.
- **Audio format**: query/config param `audio_format`, options `pcm_8000/16000/22050/24000/44100/48000, ulaw_8000`, **default `pcm_16000`** (16-bit PCM, 16kHz — standard mic capture rate). Chunks sent as base64 in `input_audio_chunk` client messages; `commit_strategy` = `manual` or `vad` (with `vad_threshold`, `vad_silence_threshold_secs`, `min_speech_duration_ms`, `min_silence_duration_ms` tuning knobs for auto-commit).
- **Message types**: server→client: `session_started`, `partial_transcript` (interim, may change), `committed_transcript` (final for that segment), `committed_transcript_with_timestamps` (adds word timing, only when `include_timestamps=true`), `committed_transcript_entities`. Client→server: `input_audio_chunk`.
- **Diarization in realtime: CONFIRMED NOT SUPPORTED.** No `diarize`/`num_speakers`/`use_speaker_library` param exists in the realtime query-param list (only `model_id`, `language_code`, `audio_format`, `commit_strategy`, vad tuning, `include_timestamps`, `include_language_detection`, `keyterms`, `no_verbatim`, `entity_detection`, `filter_background_audio`, `enable_logging`). ElevenLabs states this is deliberate — diarization adds latency/complexity and other vendors (e.g. Deepgram) have reliability issues doing it live for non-English; not a current priority for the realtime model. [Source](https://elevenlabs.io/realtime-speech-to-text) (via search synthesis). The `TranscriptionWord`/`WordsItem` schema does carry an optional `speaker_id` field, but this appears to be a shared type definition, not an enabled realtime capability — treat live `speaker_id` as unreliable/absent in practice; **do not build live-speaker-labeling UI on it.**
- **Language**: `language_code` (ISO-639-1/3) same as batch, works for Vietnamese live captions too (same 90+ language coverage as batch, per product page).
- **Latency**: marketed **~150ms** end-to-end for Scribe v2 Realtime. [elevenlabs.io/realtime-speech-to-text](https://elevenlabs.io/realtime-speech-to-text).
- **Pricing**: **$0.39/hr** PAYG (or as low as ~$0.28/hr on annual Business plan per third-party pricing roundups — reverify on elevenlabs.io/pricing/api, same caveat as batch pricing in section A).
- **Max session length**: **not documented** — only an error code `session_time_limit_exceeded` exists with no published threshold. Treat as unknown; test empirically for a 1-3h continuous session or plan to reconnect/resume periodically as a safety net.
- **JS SDK**: package `@elevenlabs/client` (distinct from `@elevenlabs/elevenlabs-js` which is batch/REST-only — confirmed via SDK source, `client.speechToText` there only exposes `convert()` and `transcripts.get/delete`, no realtime/streaming methods). Realtime usage: `Scribe.connect()` → `RealtimeConnection`, or React `useScribe` hook; pass a `microphone` option (`echoCancellation`, `noiseSuppression`) and the SDK handles `getUserMedia` + encoding; listen via `connection.on('PARTIAL_TRANSCRIPT' | 'COMMITTED_TRANSCRIPT' | 'COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS', ...)`; supports `connection.commit()` (manual) alongside VAD auto-commit. [JS SDK docs](https://elevenlabs.io/docs/eleven-api/resources/libraries/scribe-stt/javascript-scribe).

### 2. Speaker library — definitive answer
Searched official docs, changelog, and **ground-truthed against the actual `elevenlabs-js` SDK source** (`gh api` dump of `reference.md`, not just docs prose): `client.speechToText` exposes only `convert()` (batch, accepts `use_speaker_library`) and `transcripts.get/delete`. **There is no `speechToText.speakers.*` or any "register/enroll speaker" sub-resource in the SDK or API reference.** The only "speaker" endpoints in the whole SDK belong to unrelated products: Dubbing (`dubbing.resource.speaker.create/update/findSimilarVoices`) and Voice PVC sample speaker-separation (`voices.pvc.samples.speakers.*`) — neither is the STT speaker library.
**Conclusion: `use_speaker_library` has no confirmed programmatic enrollment path today.** It likely reads from speaker profiles created/managed through the ElevenLabs **dashboard UI only** (unconfirmed — no doc page describes the enrollment UI either), making it unsuitable as an automation-first mechanism for your MCP app. This resolves prior report's open question #1: **do not depend on it; build the custom embedding pipeline (section C) as primary, full stop.**
Labeling format in `use_speaker_library` responses: docs don't show a sample response with it enabled; based on `speaker_id` field being a plain string in the schema everywhere else, it likely still returns an opaque `speaker_id`-like string (possibly the registered profile's id/name) rather than a structured `{name, person_id}` object — **unverified, would need a live API trial with a workspace that has profiles registered.**

### 3. Live-capture recommendation
1. **Record locally in-browser** (`MediaRecorder`, webm/opus, chunked to local storage or streamed to backend as a single blob) as the source-of-truth for diarized transcript — **do not** try to reconstruct speaker turns from the realtime stream, since realtime has no diarization and `speaker_id` there is unreliable.
2. Use realtime WS **only for live captions on screen** during the meeting (UX/liveness feedback) — treat its output as disposable/non-authoritative text, not the stored transcript.
3. On "End & summarize": upload the full local recording to backend → run **batch Scribe `diarize=true`** (section A/C pipeline) for the authoritative, speaker-attributed transcript + voiceprint matching; discard/ignore the realtime partial/committed text once batch result lands.

## F. Pure-Node speaker embedding (sherpa-onnx-node, no torch/ffmpeg)

**Confirmed via `gh api` source dump of [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)** (not just docs prose):
- **npm package**: `sherpa-onnx-node` (not `sherpa-onnx`, which is the WASM/browser build) — **Apache-2.0**, latest `1.13.8`, prebuilt native addon (node-addon-api) with published `linux-x64`/`linux-arm64` binaries (glibc; no separate ffmpeg/torch needed). [npm](https://registry.npmjs.org/sherpa-onnx-node).
- **API confirmed in source** (`scripts/node-addon-api/src/speaker-identification.cc`): `createSpeakerEmbeddingExtractor({model, numThreads, debug, provider})` → `.computeEmbedding(stream)` returns `Float32Array`; `createSpeakerEmbeddingManager(dim)` → `.add(name, embedding)`, `.addListFlattened(...)`, `.remove(name)`, `.search(embedding, threshold) -> name|""`, `.verify(name, embedding, threshold) -> bool`, `.contains(name)`, `.numSpeakers()`, `.getAllSpeakers()`. This is a direct add/search/verify voiceprint store, keyed by string `name` (you'd use your `person_id` as the name) — **no Python needed for embedding+matching at all**.
- **Input format**: a `stream` fed via `acceptWaveform({samples: Float32Array, sampleRate})` — i.e. **raw PCM float32 samples + sample rate**; feature extraction (fbank) happens inside the C++ core, not exposed to JS. 16kHz mono matches all shipped models.
- **Bundled/downloadable ONNX speaker models** (from [releases/speaker-recongition-models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models), all Apache/CC-BY per upstream): **NeMo TitaNet** (`nemo_en_titanet_large.onnx`, `nemo_en_titanet_small.onnx`, `nemo_en_speakerverification_speakernet.onnx`), **WeSpeaker** (`wespeaker_en_voxceleb_resnet34/152/221/293(_LM)`, `wespeaker_en_voxceleb_CAM++(_LM)`, `wespeaker_zh_cnceleb_resnet34(_LM)` — Chinese-tuned, not Vietnamese-specific), **3D-Speaker** (`3dspeaker_speech_eres2net_base/large_sv_zh-cn`, `3dspeaker_speech_eres2netv2_sv_zh-cn`, `3dspeaker_speech_campplus_sv_en_voxceleb` / `_zh_en_16k-common_advanced` — this last one is bilingual zh+en). **No Vietnamese-specific model shipped**; per section B, embeddings are largely language-independent, but validate empirically — prefer the multilingual/English VoxCeleb models (WeSpeaker or 3D-Speaker CAM++ zh_en) over the zh-only ones for a VN+EN meeting mix. No published per-model EER/size table on the releases page itself — sizes/EER must be checked per file (typically tens of MB; ResNet34 ~25-30MB range, CAM++ smaller) — **unverified exact numbers, download and `ls -la`/benchmark directly before committing to one**.
- **Bonus**: sherpa-onnx-node also ships a full **offline speaker diarization** pipeline in one Node call (`createOfflineSpeakerDiarization({segmentation: {pyannote: {model}}, embedding: {model}, clustering: {numClusters|threshold}})`) — pyannote segmentation (`sherpa-onnx-pyannote-segmentation-3-0`) + any of the above embedding models + clustering, entirely in-process. This could **replace ElevenLabs' `diarize=true` and your ffmpeg-slicing step entirely** for the offline/batch pass — a genuine architecture simplification worth prototyping, since it removes an external API dependency for the diarization step (though ElevenLabs Scribe's diarization+ASR-in-one-call is likely more accurate/simpler to keep; treat sherpa-onnx diarization as a cost-saving fallback if ElevenLabs cost becomes a concern, not a mandatory replacement).
- **CPU speed**: no official benchmark found for a 72-core box; these are small CNN/TDNN models (comparable to SpeechBrain ECAPA), should run well under real-time per segment on CPU-only ONNX Runtime — verify empirically.

**Decode webm/opus without system ffmpeg**: `@ffmpeg-installer/ffmpeg` (LGPL-2.1, ships prebuilt static binaries per-platform incl. `linux-x64`/`linux-arm64` as optional deps — no OS package install required, just `npm install`) is the simplest, most robust choice for arbitrary `MediaRecorder` webm/opus → WAV/PCM16k conversion via `fluent-ffmpeg` or direct spawn. [npm](https://registry.npmjs.org/@ffmpeg-installer/ffmpeg). Alternative if you want zero ffmpeg binary at all: `prism-media` (Apache-2.0, pure-JS webm/ogg-opus demuxer) + `@discordjs/opus` (MIT, native prebuilt Opus decoder bindings) decodes straight to PCM — more moving parts, less battle-tested for arbitrary browser `MediaRecorder` webm containers (built for Discord voice, not general webm). `ffmpeg-static` is the GPL-3.0 equivalent of `@ffmpeg-installer/ffmpeg` — same idea, copyleft license is the only reason to prefer the LGPL one.

**5-line recommendation**: Use **`sherpa-onnx-node` as primary** for the embedding+matching step — pure Node, Apache-2.0, no Python/torch, confirmed add/search/verify API, avoids a sidecar process entirely on this CPU-only box. Pick **WeSpeaker ResNet34/CAM++ (VoxCeleb) or 3D-Speaker CAM++ zh_en_advanced** over the SpeechBrain choice in section B/C (same model family, but zero-sidecar deployment beats marginally different EER). Use **`@ffmpeg-installer/ffmpeg`** for webm/opus→PCM16k decode of the browser recording (bundled binary, no system install, LGPL-clean). Keep the **Python/SpeechBrain sidecar as fallback only** if a chosen sherpa-onnx model underperforms on your VN+EN test set. Optionally prototype sherpa-onnx's built-in offline diarization to reduce reliance on ElevenLabs `diarize=true`, but don't block v1 on it — keep ElevenLabs Scribe as the diarization+ASR source of truth for now.

## Unresolved questions
1. **Can `use_speaker_library` be driven via API (enroll/register a speaker programmatically), or is it dashboard-only?** Not found in docs — needs direct ElevenLabs support ticket or hands-on API testing before relying on it. This determines whether ElevenLabs alone can solve the whole fingerprint requirement (no sidecar needed) or whether the custom-embedding pipeline in section C is mandatory.
2. Exact current ElevenLabs Scribe pricing page returned 404 on fetch; figures above are triangulated from third-party pricing blogs, not the primary source — reverify at https://elevenlabs.io/pricing/api before cost modeling.
3. No vendor publishes Vietnamese-specific speaker-ID EER (only ASR WER) — cross-lingual embedding quality assumption needs empirical validation on your own sample recordings.
4. Cosine similarity 0.25 threshold is a community rule-of-thumb, not an ECAPA/SpeechBrain official spec — must calibrate against a labeled validation set of your actual meeting recordings (device/mic variability affects raw threshold significantly).
5. `speakeronnx` (Node-native ONNX speaker embedding lib) is a small community project — maintenance/correctness unverified; treat as fallback to evaluate, not to commit to blind.
6. Realtime Scribe max session length is undocumented (only an unbounded `session_time_limit_exceeded` error code exists) — must test empirically for 1-3h continuous sessions or design a reconnect/resume strategy defensively.
7. sherpa-onnx-node speaker model file sizes/EER not published on the releases page — must download and benchmark candidates (WeSpeaker vs 3D-Speaker vs TitaNet) directly on real VN+EN meeting audio before picking one.
8. Whether `use_speaker_library`'s response labels speakers with a name/person-id or an opaque id is unverified (no sample response found) — moot now since section F's sherpa-onnx-node path is recommended as primary regardless.

Status: DONE_WITH_CONCERNS
Summary: ElevenLabs Scribe batch diarization is well-documented (32 speakers, 10h limit, ~$0.22/hr, excellent Vietnamese) but realtime Scribe (section E) has NO diarization by design (confirmed no diarize/num_speakers/use_speaker_library param in realtime API) and no confirmed programmatic enrollment for `use_speaker_library` (confirmed via SDK source — no speakers sub-resource exists), so the recommendation is: browser MediaRecorder full-audio capture + batch Scribe diarize=true as the only source of truth, realtime WS only for disposable live captions. For the CPU-only/no-torch/no-ffmpeg deployment (section F), `sherpa-onnx-node` (Apache-2.0, confirmed via source: SpeakerEmbeddingExtractor+Manager with add/search/verify, raw PCM float32 input, ships WeSpeaker/3D-Speaker/NeMo TitaNet ONNX models) replaces both the Python sidecar and ffmpeg (paired with `@ffmpeg-installer/ffmpeg` for webm/opus decode) as the primary embedding architecture, superseding the SpeechBrain-sidecar default from section C.
Concerns/Blockers: realtime max session length and exact sherpa-onnx model EER/size are unverified/undocumented (test empirically); `use_speaker_library` enrollment path remains unconfirmed but is now moot since section F provides a fully self-hosted alternative.
