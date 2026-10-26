# Debian slim, not Alpine: sherpa-onnx-node ships glibc-only linux binaries.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# Speaker-embedding model, baked into the image (never committed). Without a URL
# the image still builds and runs; voiceprint matching then reports
# "model not found" while captions, transcripts and summaries keep working.
FROM node:22-bookworm-slim AS model
ARG SPEAKER_MODEL_URL=""
ARG SPEAKER_MODEL_SHA256=""
RUN mkdir -p /models \
    && if [ -n "$SPEAKER_MODEL_URL" ]; then \
         apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
         && curl -fsSL "$SPEAKER_MODEL_URL" -o /models/3dspeaker_speaker-embedding_advanced.onnx \
         && { [ -z "$SPEAKER_MODEL_SHA256" ] || echo "$SPEAKER_MODEL_SHA256  /models/3dspeaker_speaker-embedding_advanced.onnx" | sha256sum -c -; }; \
       else echo "WARN: SPEAKER_MODEL_URL not set — image ships without the speaker model"; fi

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
