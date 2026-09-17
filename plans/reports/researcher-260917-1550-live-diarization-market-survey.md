# Live/Streaming Speaker Diarization Market Survey (2026)

Builds on prior report (sections A/E not repeated): ElevenLabs realtime confirmed NO diarization; batch Scribe diarize=true is current authoritative source.

## 1. Cloud streaming STT with realtime diarization

### Deepgram (Nova-3)
- Streaming: pass diarization model version (`v1`/`latest`; `v2` streaming-unsupported) — this alone enables diarization, no separate `diarize=true` needed on streaming. [docs](https://developers.deepgram.com/docs/diarization)
- Streaming returns bare `speaker` int (no confidence score, unlike batch) — doc doesn't explicitly split partial-vs-final label stability; treat as **unverified** whether early speaker tags get revised.
- VN: added w/ 11-language Nova-3 expansion, "works streaming+batch, no retraining/config" per Deepgram's own language blog. [source](https://deepgram.com/learn/deepgram-expands-nova-3-with-11-new-languages-across-europe-and-asia)
- Max speakers: no documented hard cap ("language-agnostic" clustering).
- Pricing: base streaming ~$0.0048-0.0077/min ($0.29-$0.46/hr, promo vs list — third-party aggregator, reverify at deepgram.com/pricing) + diarization add-on **$0.0020/min (~$0.12/hr)**. [pricing note](https://brasstranscripts.com/blog/deepgram-pricing-per-minute-2025-real-time-vs-batch)
- Enrollment/voiceprint: **none** — confirmed no cross-session speaker-ID feature exists (only per-session int labels). [community discussion](https://github.com/orgs/deepgram/discussions/475)
- Node/browser auth: `deepgram-js-sdk`, server mints scoped access token (`ttl_seconds`, max 3600s) consumed once by browser WS — good fit for backend-proxy pattern. [token docs](https://developers.deepgram.com/guides/fundamentals/token-based-authentication)
- Retention: processed server-side; opt-out-of-training exists but no confirmed "zero retention" toggle on standard plans — enterprise-only, unconfirmed specifics.

### AssemblyAI (Universal-Streaming / Universal-3.5 Pro Realtime)
- `speaker_labels: true`, `max_speakers` 1-10. Emits **live turn-by-turn labels**, then **~0.5s post-stream-end revision pass** cleans up early calls — so labels ARE on near-real-time turn results but **not perfectly stable** (a final correction is expected by design). [blog](https://www.assemblyai.com/blog/streaming-diarization-major-upgrade)
- VN: **not** in base "Universal-Streaming Multilingual" (only 6 EU langs) — needs **Universal-3.5 Pro Streaming** (18 langs incl Vietnamese) or Whisper-rt (99 langs, likely higher latency). [multilingual docs](https://www.assemblyai.com/docs/streaming/universal-streaming/multilingual-transcription)
- Pricing: base Universal Streaming $0.15/hr + diarization add-on $0.12/hr; VN requires Pro Realtime tier priced separately (~$0.45/hr per one source) — **triangulated, not vendor-primary, verify at assemblyai.com/pricing**.
- Enrollment: none — AssemblyAI's own blog states cross-file speaker recognition "is still in development." [source](https://www.assemblyai.com/blog/speaker-diarization-vs-recognition)
- Auth: `client.streaming.createTemporaryToken()`, token TTL 1-600s (just for the WS handshake), session max `max_session_duration_seconds` up to **10800s = 3h** — right at the edge of our 1-3h meetings, must handle reconnect defensively. [docs](https://www.assemblyai.com/docs/streaming/authenticate-with-a-temporary-token)

### Speechmatics Realtime
- **Genuine speaker-identification/enrollment**: enroll via 5-30s clean single-speaker clips → get an identifier → reuse identifier in later realtime/batch jobs to get **stable named labels** across sessions; unenrolled speakers get generic `S1..` labels. Max **50 identifiers/session**, `max_speakers` up to 10 applies only to generic speakers. [enrollment docs](https://docs.speechmatics.com/speech-to-text/realtime/speaker-identification)
- **Caveat**: identifiers are **model-version-locked** — "whenever a model is updated, existing identifiers must always be regenerated" — a real recurring-maintenance cost. [same doc]
- VN: supported (55+ langs), but a third-party benchmark (Soniox's own comparison, so treat cautiously) puts VN WER at 8.9% vs Soniox 5.4%. [comparison](https://soniox.com/compare/soniox-vs-speechmatics/vietnamese)
- Pricing: Pro usage from $0.24/hr base; enrollment/ID feature pricing tier not separately published.
- Node: WS API documented (`realtime-transcription-websocket`), standard API-key/JWT auth model, browser-proxy-friendly.

### Google Cloud STT v2 streaming
- `diarization_config` on `StreamingRecognitionConfig`. Docs: "all words from the beginning ... sent in every consecutive response, which helps improve speaker tags **as models learn to identify speakers over time**" — this is the strongest documented evidence of any vendor that **speaker labels get revised/reassigned progressively within a session** (i.e., least stable of the group by design). [rpc reference](https://docs.cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v2)
- VN (`vi-VN`) generally supported by Cloud STT, but diarization-specific VN accuracy not separately published — unconfirmed.
- Pricing: streaming base ~$0.016/min (~$0.96/hr); diarization add-on figure (~$0.36/hr) only found via low-confidence aggregator, **not vendor-verified**.
- No enrollment/voiceprint feature.

### AWS Transcribe streaming
- `ShowSpeakerLabel=true` (HTTP/2) or `show-speaker-label=true` (presigned WS URL). Officially labels 2-10 speakers, "accuracy decreases past 5." [AWS announcement](https://aws.amazon.com/about-aws/whats-new/2020/08/amazon-transcribe-supports-speaker-labeling-streaming-transcription)
- **Language conflict found**: AWS's own dg page (older) states realtime speaker ID works only for **en-US**; general streaming-language list (54 langs incl Vietnamese) covers transcription broadly but does **not confirm diarization parity across all 54** — this is a real risk for VN, needs a live trial before committing.
- Pricing: speaker labeling is a **free add-on** to standard streaming pricing (no extra $/hr).
- No enrollment (separate "Amazon Voice ID" product exists for call-center auth, not integrated into Transcribe diarization).

### Azure Speech (Conversation Transcription / real-time diarization)
- GA feature, SDK ≥1.31.0, `diarizationEnabled: true`. Labels are **generic GUEST1/GUEST2...**, and docs explicitly state it "**intentionally does not use voice signatures**" — no enrollment by design. [GA announcement](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/announcing-general-availability-of-real-time-diarization/4147556)
- Azure's separate Speaker Recognition product (would've given enrollment) was **retired 2025-09-30** (confirmed in prior report) — no path to cross-session ID on Azure now.
- VN diarization-specific accuracy unconfirmed.

### Gladia Live
- **Realtime diarization not supported** — Gladia's own docs recommend live captions via streaming + a second async-API pass afterward for diarized transcript. [docs](https://docs.gladia.io/chapters/speech-to-text-api/pages/live-speech-recognition) This is architecturally identical to our current ElevenLabs plan (live captions + batch diarize) — Gladia doesn't solve the live-labeling problem either, disqualified for this task.

### Soniox realtime (`stt-rt-v5`)
- Speaker diarization **available for all 60+ supported languages** in realtime, incl Vietnamese, plus **token-level language ID** (useful for VN/EN code-switching within one meeting). Vendor caveat: "real-time speaker diarization ... higher attribution errors compared to async." [docs](https://soniox.com/docs/stt/concepts/speaker-diarization)
- Pricing: flat **$0.12/hr** streaming, same price/features regardless of language — cheapest of the group by a wide margin. [pricing](https://soniox.com/pricing)
- VN WER 5.4% per Soniox's own comparison page (self-reported, single source — treat as vendor marketing until cross-checked).
- Enrollment: not found in docs — presumed per-session labels only, same limitation as Deepgram/AssemblyAI.
- SDK: official `speech-to-text-web` (JS/TS) WS library.

### Rev AI streaming
- **Diarization is async-API-only** — streaming API returns only partial/final text hypotheses, no speaker separation live. [docs](https://docs.rev.ai/api/streaming) Disqualified for live labeling.

### ElevenLabs — confirmed still none (prior report section E, not repeated).

## 2. Self-hosted / on-device streaming diarization

### diart (pyannote-based streaming)
- MIT-licensed Python framework, incremental clustering on a rolling 500ms buffer, built specifically for live use. [repo](https://github.com/juanmc2005/diart)
- Depends on gated-HF pyannote segmentation/embedding models (same friction noted in prior report section B).
- **CPU speed risk**: only official RTF found is for the *full offline* pyannote 3.0 pipeline: **RTF 0.5-1 on CPU = 30-60min to process a 1hr file** (i.e., borderline real-time to 2x slower). [github discussion](https://github.com/pyannote/pyannote-audio/discussions/778) diart's incremental design may be faster per-chunk, but **no official CPU-only RTF for diart itself was found** — must benchmark empirically on the 72-core box before relying on it live.
- Python/PyTorch stack — conflicts with the "no torch" backend constraint; would need a Python sidecar + torch install just for this path.

### NVIDIA NeMo Streaming Sortformer
- State-of-art streaming diarization design (Arrival-Order Speaker Cache), genuinely built for live use with minimal latency. [NVIDIA blog](https://developer.nvidia.com/blog/identify-speakers-in-meetings-calls-and-voice-apps-in-real-time-with-nvidia-streaming-sortformer/)
- **Max 4 speakers** (`diar_streaming_sortformer_4spk-v2`/`v2.1`), "performance degrades on 5+ speakers" — **does not cover our 2-6 speaker range at the top end**. [model card](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2)
- GPU-optimized primarily (trained on 8×V100 nodes); CPU/x86 RTF **not published** — only Apple-Silicon CoreML conversion numbers exist (5.7x-125x RTF), not transferable evidence for our Linux CPU box.
- PyTorch/NeMo-heavy, no Node integration path — would need ONNX export + Python sidecar, conflicts with "no torch" constraint same as diart.

### WhisperX / whisper-diarization
- **Batch-only, confirmed**: an open GitHub issue on the official repo states the diarization module treats each new chunk as a separate session and **does not maintain speaker consistency across streaming chunks** — no viable live path. [issue](https://github.com/m-bain/whisperX/issues/1065) Disqualified for live use.

### Picovoice Falcon (on-device diarization)
- Node/web npm package (`@picovoice/falcon-web`), AccessKey-gated commercial SDK. [docs](https://picovoice.ai/docs/falcon/)
- Licensing: free console tier + paid Foundation (restricted to startups <5yr, <$50M funding, <20 employees) / Enterprise plans — may not fit an established org, verify eligibility.
- Positioned as diarization for "any ASR, including Whisper" — framing suggests an overlay/post-processing role rather than a purpose-built sub-second-latency live primitive; not confirmed as truly incremental-streaming vs fast-batch-on-chunks. Pairs with Picovoice **Eagle** (cross-session speaker ID, covered in prior report) — both proprietary, closed-model, same vendor lock-in tradeoff as Eagle noted previously.

### SpeechBrain
- Toolkit only, no ready-made streaming diarization pipeline — would require significant custom engineering to build an incremental wrapper. Lowest priority; diart already targets this niche with less effort.

## 3. Comparison table

| Option | Latency-to-label | VN diarization quality | Cost/h | Self-host | Enrollment/voiceprint | Integration effort |
|---|---|---|---|---|---|---|
| **Soniox realtime** | live (turn-based), some accuracy loss vs async (vendor-stated) | Best claimed WER (5.4%, self-reported) | **$0.12/hr flat** | No | No | Low — JS/TS SDK, WS |
| **Speechmatics realtime+ID** | live | 8.9% WER (3rd-party, cautious) | ~$0.24+/hr | No | **Yes — real enrollment/ID**, but model-version-locked | Low-Med — WS API, enrollment call flow |
| Deepgram Nova-3 | live, stability unconfirmed | Vietnamese supported, no VN-specific DER published | ~$0.29-0.46/hr +$0.12/hr diarize | No | No | Low — mature SDK, scoped tokens |
| AssemblyAI Universal-3.5 Pro | live turn + 0.5s revision (labels can shift) | VN only via Pro/Whisper-rt tier | ~$0.45+/hr (Pro reqd for VN) + $0.12/hr | No | No | Low-Med — 3h session cap edge case |
| Google STT v2 | live, but **docs confirm labels get revised as model "learns" mid-session** | unconfirmed | ~$0.96/hr + unclear diarize add-on | No | No | Med — gRPC, less turnkey Node SDK ergonomics |
| AWS Transcribe | live | **VN diarization support unconfirmed/conflicting** (older docs say en-US only) | diarize free add-on | No | No | Med — must verify VN before committing |
| Azure Conversation Transcription | live | unconfirmed | unclear | No | No (explicitly no voice signatures) | Med |
| Gladia Live | **no live diarization at all** | n/a | n/a | No | No | n/a — disqualified |
| Rev AI streaming | **no live diarization at all** | n/a | n/a | No | No | n/a — disqualified |
| diart (pyannote) | incremental, CPU RTF for diart itself unverified (full pipeline RTF 0.5-1x is a red flag) | language-independent (unverified for VN specifically) | $0 infra only | **Yes** | No | High — Python/torch sidecar, gated HF models, conflicts w/ "no torch" |
| NeMo Streaming Sortformer | designed for low latency, but no CPU/x86 benchmark | language mix untested | $0 infra only | **Yes** | No | High — GPU-oriented, **caps at 4 speakers** (misses our 5-6 speaker cases), Python/NeMo sidecar |
| WhisperX/whisper-diarization | n/a | n/a | n/a | Yes | No | n/a — **batch only, confirmed no live path** |
| Picovoice Falcon | unclear (overlay-style framing) | language-independent claim, unverified | licensing-gated, not $/hr | **Yes (on-device)** | No (Eagle is separate) | Med — proprietary SDK, startup-eligibility license gate |

## 4. Recommendation

**#1 Soniox realtime.** Cheapest ($0.12/hr all-in), realtime diarization across all its languages incl Vietnamese, token-level language-ID is a genuine differentiator for VN/EN code-switch inside one meeting, pure WS/JS SDK — drops in as a **direct ElevenLabs-realtime replacement**, giving live captions AND live speaker labels in one call, while we keep our own sherpa-onnx voiceprint pipeline (prior report section F) for cross-meeting identity since Soniox has no enrollment either. Risks: newer/smaller vendor (adoption/maturity risk vs Deepgram/AssemblyAI's larger installed base), VN WER figure is vendor-self-reported (no independent benchmark found), no official statement on realtime label re-assignment behavior within a session — verify empirically before relying on labels as final.

**#2 Speechmatics realtime + speaker identification.** The **only mainstream cloud vendor with genuine persistent cross-session voiceprint-style enrollment built into the realtime path** — this directly answers the "can any option replace our custom voiceprint pipeline" question: **yes, natively**, via 5-30s enrollment clips → reusable identifiers → stable named labels in future sessions. Trade-offs: identifiers are **locked to a model version and must be re-enrolled on every model upgrade** (recurring ops burden), VN WER is worse than Soniox in the one benchmark found, and enrollment-tier pricing isn't separately published (verify before committing budget). Given our project already plans a self-hosted sherpa-onnx voiceprint layer regardless (per prior report), Speechmatics' native ID is a **nice-to-have consolidation opportunity**, not a hard blocker if we skip it — but worth a hands-on trial since it could let us drop the ffmpeg-slicing + embedding-matching pipeline entirely for the live-labeling use case.

**(a) vs (b) verdict**: **(a) full cloud replacement wins.** Self-hosted live diarization (diart, NeMo Sortformer) is CPU-risky (borderline/unverified RTF, Python/torch/GPU-oriented stacks that conflict with our no-torch Node box) and NeMo caps at 4 speakers (misses our 5-6-speaker upper range). Cloud (Soniox primarily) is cheaper, simpler, proven, and needs zero Python/GPU. Keep self-hosted diarization only as a future cost-saving fallback if cloud egress or per-minute cost becomes disallowed later — not for v1.

**Concrete v1 change**: replace ElevenLabs realtime WS (captions-only, no diarization) with **Soniox realtime** (captions + live diarization together) for the on-screen live experience; keep ElevenLabs batch `diarize=true` + sherpa-onnx voiceprint matching (per prior report) as the authoritative post-meeting pipeline, OR evaluate replacing that too with Soniox's own async endpoint if quality is comparable (out of scope here, batch already covered in prior report). Optionally pilot Speechmatics enrollment in parallel to test whether it can absorb the cross-meeting-identity job natively.

## Unresolved questions
1. Soniox: no official statement found on live-label re-assignment/stability within a session, nor an independent (non-vendor) VN WER/DER benchmark — needs a hands-on trial with real VN+EN meeting audio.
2. Soniox: WS auth model (scoped/temporary token vs raw API key for browser) not confirmed in the search results found — verify via Soniox's own auth docs before building the browser-proxy flow.
3. Speechmatics: exact retention duration/limits for stored enrollment identifiers, and whether the 50-identifier cap is per-session or account-wide over time, are not clearly documented — confirm with Speechmatics support before depending on it for a growing org roster.
4. AWS Transcribe: conflicting evidence on whether realtime diarization works for non-en-US languages (older doc says en-US only; newer streaming-language list of 54 langs doesn't explicitly confirm diarization parity) — must be tested live with Vietnamese audio, not assumed from the general language list.
5. diart's own CPU-only RTF (as opposed to the full offline pyannote pipeline's 0.5-1x figure) was not found anywhere — this is the single biggest gap for the self-host option and should be benchmarked directly on the 72-core box if self-hosting is ever revisited.
6. Google STT v2 and Azure realtime diarization VN-specific accuracy figures are unpublished — would need a live trial to compare against Soniox/Speechmatics.
7. Exact current pricing for Deepgram/AssemblyAI/Google/Speechmatics streaming+diarization combos was triangulated from third-party aggregators in several cases (flagged inline) — reverify each vendor's own pricing page before final cost modeling.

Status: DONE_WITH_CONCERNS
Summary: Soniox realtime ($0.12/hr, all-language live diarization incl VN, token-level lang-ID) is the top pick to replace ElevenLabs realtime for live captions+speaker labels; Speechmatics realtime is the only vendor with genuine native cross-session speaker enrollment, a possible future replacement for our custom voiceprint pipeline. Self-hosted live diarization (diart, NeMo Sortformer) is CPU/GPU-risky and Python/torch-heavy, so cloud (option a) beats self-host (option b) for v1.
Concerns/Blockers: several vendor claims (Soniox VN WER, label-stability behavior across all vendors, AWS VN-diarization support, Speechmatics identifier retention limits) are unverified against primary/official sources or contradicted between sources — recommend a short hands-on trial against real VN+EN meeting audio before finalizing the swap.
