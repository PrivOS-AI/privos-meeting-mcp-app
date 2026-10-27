# Debian slim, not Alpine: sherpa-onnx-node ships glibc-only linux binaries.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# Speech models, baked into the image (never committed), from sherpa-onnx's
# official GitHub releases, each pinned by sha256 (a changed file fails the build):
#   models/asr/vi        Zipformer Vietnamese 30M int8 (offline transducer)
#   models/asr/en        Zipformer small English int8
#   models/asr/silero_vad.onnx                VAD
#   models/asr/segmentation/model.onnx        pyannote segmentation 3.0 (diarization)
#   models/3dspeaker_speaker-embedding_advanced.onnx   3D-Speaker CAM++ zh/en "advanced"
#                                             (voiceprints + diarization embeddings)
FROM node:22-bookworm-slim AS model
ARG SHERPA=https://github.com/k2-fsa/sherpa-onnx/releases/download
WORKDIR /dl
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bzip2 \
    && curl -fsSLO "$SHERPA/asr-models/sherpa-onnx-zipformer-vi-30M-int8-2026-02-09.tar.bz2" \
    && curl -fsSLO "$SHERPA/asr-models/sherpa-onnx-zipformer-small-en-2023-06-26.tar.bz2" \
    && curl -fsSLO "$SHERPA/asr-models/silero_vad.onnx" \
    && curl -fsSLO "$SHERPA/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2" \
    && curl -fsSLO "$SHERPA/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx" \
    && printf '%s\n' \
      "da8b637947091829d7ee9eda23da2a4ec7caa399233a3f4e34eb719fb2ea6b9b  sherpa-onnx-zipformer-vi-30M-int8-2026-02-09.tar.bz2" \
      "c8bff1091c26c49731cddbcd60ef18061142ea11523df1b73bf1b14451b9c15e  sherpa-onnx-zipformer-small-en-2023-06-26.tar.bz2" \
      "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6  silero_vad.onnx" \
      "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488  sherpa-onnx-pyannote-segmentation-3-0.tar.bz2" \
      "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2  3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx" \
      | sha256sum -c - \
    && for f in *.tar.bz2; do tar -xjf "$f"; done \
    && mkdir -p /models/asr/vi /models/asr/en /models/asr/segmentation \
    && V=sherpa-onnx-zipformer-vi-30M-int8-2026-02-09 \
    && cp "$V/encoder.int8.onnx" "$V/decoder.onnx" "$V/joiner.int8.onnx" "$V/tokens.txt" /models/asr/vi/ \
    && E=sherpa-onnx-zipformer-small-en-2023-06-26 \
    && cp "$E/encoder-epoch-99-avg-1.int8.onnx" /models/asr/en/encoder.int8.onnx \
    && cp "$E/decoder-epoch-99-avg-1.int8.onnx" /models/asr/en/decoder.int8.onnx \
    && cp "$E/joiner-epoch-99-avg-1.int8.onnx" /models/asr/en/joiner.int8.onnx \
    && cp "$E/tokens.txt" /models/asr/en/tokens.txt \
    && cp silero_vad.onnx /models/asr/ \
    && cp sherpa-onnx-pyannote-segmentation-3-0/model.onnx /models/asr/segmentation/model.onnx \
    && cp 3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx /models/3dspeaker_speaker-embedding_advanced.onnx \
    && du -sh /models

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3012
WORKDIR /app
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm && rm -f /usr/local/bin/npm /usr/local/bin/npx \
    && mkdir -p /app/data && chown node:node /app/data
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json /app/privos-app.json /app/tsconfig.json /app/tsconfig.server.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
COPY --from=model --chown=node:node /models ./models
ARG PRIVOS_MCP_MANIFEST_JSON
ARG PRIVOS_MCP_MANIFEST_DIGEST
LABEL io.privos.mcp.manifest="${PRIVOS_MCP_MANIFEST_JSON}" \
      io.privos.mcp.manifest-digest="${PRIVOS_MCP_MANIFEST_DIGEST}"
USER node
EXPOSE 3012
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/server/index.ts"]
