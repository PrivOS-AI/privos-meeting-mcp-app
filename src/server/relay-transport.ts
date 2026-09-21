/**
 * Development-only Relay transport wiring. `serveApp` owns the
 * standalone-production and managed transports; the ONE piece that stays
 * app-local is the interactive `development` pairing loop (`npm run dev`):
 * relaxed compatibility pairing, cached to `.env`, unverified actor, never
 * persisted as a standalone identity file.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import {
  connectRelay,
  createAgentBotHubClient,
  pairFromDescriptor,
  type PairingResult,
  type RelayHandle,
} from '@privos_ai/app-server';
import WebSocket from 'ws';

import { buildRelayAppDescriptor } from './manifest.js';
import { createMcpHandler } from './mcp-handler.js';
import { repoRoot } from './paths.js';
import { resolveHubOrigin } from './hub/resolve-hub-origin.js';
import { uiResourceProvider } from './ui-resource.js';

const ENV_PATH = path.join(repoRoot, '.env');

/** Save key=value pairs to `.env` — development cache only. */
function saveDevCredentialsToEnv(vars: Record<string, string>): void {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8') : '';
  for (const [key, value] of Object.entries(vars)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    content = regex.test(content)
      ? content.replace(regex, `${key}=${value}`)
      : `${content}${content.endsWith('\n') || content === '' ? '' : '\n'}${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, content, { mode: 0o600 });
}

async function promptForPairingUrl(): Promise<string> {
  console.log('\nNo PrivOS credentials found. Starting the pairing flow.');
  console.log('Get a pairing URL from: PrivOS Admin → Apps → Register Relay App\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Pairing URL: ');
    const trimmed = answer.trim();
    if (!trimmed) throw new Error('A pairing URL is required to connect over the relay.');
    return trimmed;
  } finally {
    rl.close();
  }
}

function relayLogger(prefix: string): (event: string, fields: Record<string, unknown>) => void {
  return (event, fields) => {
    if (event.includes('error') || event.includes('fail') || event.includes('rejected')) {
      console.error(`${prefix} ✗ ${event}`, fields);
    } else {
      console.log(`${prefix} · ${event}`);
    }
  };
}

/**
 * `npm run dev`. Reuses cached `.env` credentials, else prompts once and caches.
 * `persistIdentityFile: false` is load-bearing: a standalone identity file would
 * make the NEXT boot resolve to `standalone-production` instead of `development`.
 * Also caches `MCP_APP_ID` from the pairing response so backend bot tool-calls
 * can resolve this install's id in dev.
 */
export async function startDevelopmentRelay(): Promise<RelayHandle> {
  let privosUrl = process.env.PRIVOS_URL;
  let clientId = process.env.CLIENT_ID;
  let clientSecret = process.env.CLIENT_SECRET;

  if (!privosUrl || !clientId || !clientSecret) {
    const pairUrl = await promptForPairingUrl();
    const paired: PairingResult = await pairFromDescriptor(pairUrl, buildRelayAppDescriptor(), WebSocket, {
      persistIdentityFile: false,
    });
    privosUrl = paired.privosUrl;
    clientId = paired.clientId;
    clientSecret = paired.clientSecret;

    const cache: Record<string, string> = { PRIVOS_URL: privosUrl, CLIENT_ID: clientId, CLIENT_SECRET: clientSecret };
    const mcpAppId = (paired as { mcpAppId?: string }).mcpAppId;
    if (mcpAppId) {
      cache.MCP_APP_ID = mcpAppId;
      process.env.MCP_APP_ID = mcpAppId;
    }
    saveDevCredentialsToEnv(cache);
    console.log(`[Relay] Paired! Credentials cached to ${ENV_PATH} for the next \`npm run dev\`.`);
  }

  const agentBotHub = createAgentBotHubClient({ resolveHubOrigin });
  const handler = createMcpHandler({ mode: 'development', agentBotHub, resolveHubOrigin });

  const handle = connectRelay({
    privosUrl,
    clientId,
    clientSecret,
    descriptor: buildRelayAppDescriptor(),
    handler,
    ui: uiResourceProvider,
    logger: relayLogger('[Relay]'),
  });

  await handle.whenConnected();
  console.log('Relay connected — the Meeting Agent tab is now available in PrivOS (development, unverified actor).');
  return handle;
}
