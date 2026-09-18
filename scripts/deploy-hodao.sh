#!/usr/bin/env bash
# Deploy Meeting Agent to the hodao node (pm2 process `meeting-agent`, port 3012).
# Edit locally → rsync → restart there. Do NOT run the app locally and on the
# node at the same time (duplicate pairing identity conflicts on the relay).
set -euo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/thanh-dev}"
SSH_PORT="${SSH_PORT:-22087}"
SSH_HOST="${SSH_HOST:-root@hub002.roxane.one}"
REMOTE="${REMOTE:-/opt/privos/apps/meeting-agent}"
LOCAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/"

# Speaker-embedding model (P4, QĐ-02) — never committed, downloaded once on the
# node if missing. Default matches env.ts's SPEAKER_MODEL_PATH; override both
# SPEAKER_MODEL_FILE and SPEAKER_MODEL_URL together to switch model/candidate
# (plan.md open question #5 — pick a default only after
# `npm run calibrate:speaker` on real audio). Archive layout/URL per the
# sherpa-onnx speaker-recognition-models release (see docs/deployment-guide.md).
SPEAKER_MODEL_FILE="${SPEAKER_MODEL_FILE:-3dspeaker_speaker-embedding_advanced.onnx}"
SPEAKER_MODEL_URL="${SPEAKER_MODEL_URL:-https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx}"
SPEAKER_MODEL_SHA256="${SPEAKER_MODEL_SHA256:-}"

echo "Deploying $LOCAL -> $SSH_HOST:$REMOTE"

# Informational only (never fatal) — confirms port 3012 is either free or
# already owned by THIS app's own pm2 process before touching anything.
ssh -i "$SSH_KEY" -p "$SSH_PORT" "$SSH_HOST" 'ss -ltnp | grep :3012 || echo "port 3012 free"' || true

rsync -az -e "ssh -i $SSH_KEY -p $SSH_PORT" \
  --exclude /node_modules/ --exclude /.git/ --exclude /.recyclebin/ \
  --exclude '*.tsbuildinfo' --exclude /data/ --exclude /dist/ --exclude /models/ \
  "$LOCAL" "$SSH_HOST:$REMOTE/"

# rsync preserves the local uid; pm2 runs as root and refuses the identity/.env
# unless they are root-owned and 0600. .env is provisioned on the node; the
# speaker model downloads itself below on first deploy only (idempotent).
ssh -i "$SSH_KEY" -p "$SSH_PORT" "$SSH_HOST" \
  "cd $REMOTE \
   && chown -R root:root . \
   && ([ -f privos-standalone-identity.json ] && chmod 600 privos-standalone-identity.json || true) \
   && ([ -f .env ] && chmod 600 .env || true) \
   && mkdir -p models \
   && if [ ! -f 'models/$SPEAKER_MODEL_FILE' ]; then \
        echo 'Downloading speaker embedding model...'; \
        curl -fL -o 'models/$SPEAKER_MODEL_FILE' '$SPEAKER_MODEL_URL'; \
        if [ -n '$SPEAKER_MODEL_SHA256' ]; then \
          echo '$SPEAKER_MODEL_SHA256  models/$SPEAKER_MODEL_FILE' | sha256sum -c -; \
        fi; \
      else \
        echo 'Speaker embedding model already present, skipping download.'; \
      fi \
   && npm install --no-audit --no-fund \
   && npm run build \
   && ([ -f /opt/privos/apps/ecosystem.config.cjs ] && grep -q 'meeting-agent' /opt/privos/apps/ecosystem.config.cjs \
       && pm2 reload meeting-agent \
       || (pm2 restart meeting-agent || pm2 start 'npm run start:standalone' --name meeting-agent --kill-timeout 15000)) \
   && pm2 save"

# Health check — non-fatal (a slow first boot should not fail the deploy
# script outright), but always printed so a bad deploy is visible immediately.
echo "Health check:"
ssh -i "$SSH_KEY" -p "$SSH_PORT" "$SSH_HOST" '
  for i in 1 2 3 4 5; do
    sleep 2
    health="$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3012/health || true)"
    ready="$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3012/ready || true)"
    echo "  attempt $i: /health=$health /ready=$ready"
    [ "$health" = "200" ] && [ "$ready" = "200" ] && break
  done
' || true

cat <<'EOF'

Done. Verify manually:
  ssh ... 'pm2 logs meeting-agent --lines 50'   -> should show relay.connected, no repeated errors
  Call meeting_agent_bot_credential_check from a room -> should be "valid"

REMINDER — VOICEPRINT_ENC_KEY: if this is the FIRST deploy (key just generated),
back it up NOW to your organization's secret store. Losing it makes every
stored voiceprint permanently undecryptable — there is no recovery path.
See docs/deployment-guide.md § Backup và xoay VOICEPRINT_ENC_KEY.
EOF
