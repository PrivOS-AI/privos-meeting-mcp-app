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

echo "Deploying $LOCAL -> $SSH_HOST:$REMOTE"

rsync -az -e "ssh -i $SSH_KEY -p $SSH_PORT" \
  --exclude node_modules/ --exclude .git/ --exclude .recyclebin/ \
  --exclude '*.tsbuildinfo' --exclude data/ \
  "$LOCAL" "$SSH_HOST:$REMOTE/"

# rsync preserves the local uid; pm2 runs as root and refuses the identity/.env
# unless they are root-owned and 0600. Model + .env are provisioned on the node.
ssh -i "$SSH_KEY" -p "$SSH_PORT" "$SSH_HOST" \
  "cd $REMOTE \
   && chown -R root:root . \
   && ([ -f privos-standalone-identity.json ] && chmod 600 privos-standalone-identity.json || true) \
   && ([ -f .env ] && chmod 600 .env || true) \
   && npm install --no-audit --no-fund \
   && npm run build \
   && (pm2 restart meeting-agent || pm2 start 'npm run start:standalone' --name meeting-agent)"

echo "Done. Verify: ssh ... 'pm2 logs meeting-agent' should show relay.connected."
