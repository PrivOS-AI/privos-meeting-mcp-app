/**
 * Process entry point. `serveApp` resolves exactly one runtime mode
 * (managed > standalone-production > development) and wires the transport +
 * trust bootstrap + agent-bot hub internally. The one app-local piece is the
 * interactive `development` Relay loop (`PRIVOS_TRANSPORT=relay`, `npm run dev`).
 *
 * At boot the app validates provider keys (fatal in production) and self-checks
 * the installation-bot credential, warning when it is not configured.
 */
import 'dotenv/config';
import path from 'node:path';

import express from 'express';
import { serveApp, RuntimeModeError, type RoomBoundHubClient } from '@privos_ai/app-server';

import { assertProviderKeysAtBoot } from './env.js';
import { startAudioRetention } from './jobs/audio-retention-job.js';
import { meetingQueue } from './jobs/meeting-queue.js';
import { startupSweep } from './jobs/startup-sweep.js';
import { createManifest, buildRelayAppDescriptor, manifest } from './manifest.js';
import { createMcpHandler } from './mcp-handler.js';
import { repoRoot } from './paths.js';
import { registerAllTools } from './tools/index.js';
import { setDevPublicUrl, uiResourceProvider } from './ui-resource.js';

/**
 * SIGTERM/SIGINT: stop accepting new processing jobs immediately (pm2's
 * `kill_timeout: 15000` is spent letting in-flight work finish, not starting
 * new work that cannot complete in time) and stop the retention interval
 * timer. Registered BEFORE `serveApp()` so it runs ahead of the SDK's own
 * `installSignalHandlers` (default true) — `serveApp` owns closing the
 * transport/server, this only owns this app's own background loops.
 */
let stopAudioRetention: (() => void) | undefined;
function installDrainHandlers(): void {
  const drain = () => {
    meetingQueue.startDraining();
    stopAudioRetention?.();
  };
  process.on('SIGTERM', drain);
  process.on('SIGINT', drain);
}

/** Manifest-only degraded surface for a bare production container (no identity). */
function startManifestOnlySurface(reason: string): void {
  const port = Number(process.env.PORT || manifest.port || 3012);
  const app = express();
  app.get('/.well-known/mcp/manifest.json', (_req, res) => res.json(createManifest()));
  app.get('/health', (_req, res) => res.status(200).json({ ok: true, status: 'alive', degraded: true }));
  app.get('/ready', (_req, res) => res.status(503).json({ ok: false, status: 'not_ready', reason: 'PRODUCTION_WITHOUT_IDENTITY' }));
  app.listen(port, '0.0.0.0', () => {
    console.error(`No runtime identity: ${reason}`);
    console.error(`Serving the manifest only on :${port} — no MCP surface until an identity is present.`);
  });
}

/** Boot-time configuration + credential self-checks (non-fatal in dev). */
async function runBootChecks(): Promise<void> {
  for (const problem of assertProviderKeysAtBoot()) {
    console.warn(`[boot] Cảnh báo cấu hình: ${problem}`);
  }
}

/**
 * Validate the installation-bot credential through the RESOLVED bot transport.
 * Must run after `serveApp` built it: in standalone-production the credential
 * is delivered over the control channel and seeded from the identity file
 * inside `serveApp`, so an env-only check before that reports a false
 * "not-configured" for a perfectly live credential.
 */
async function logAgentBotCredentialStatus(agentBotHub: RoomBoundHubClient): Promise<void> {
  try {
    const response = await agentBotHub.authorizedFetch('/api/v1/me', { requiredScope: 'basic:information', retryMode: 'never' });
    if (response.ok) console.log('[boot] Agent-bot credential valid.');
    else console.warn(`[boot] Agent-bot credential rejected by Hub (HTTP ${response.status}).`);
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    console.warn(
      name === 'AgentBotCredentialAbsentError'
        ? '[boot] Agent-bot credential not delivered yet — a workspace admin must issue it (Admin > Apps > this app).'
        : `[boot] Agent-bot credential check could not complete: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function start(): Promise<void> {
  registerAllTools();
  installDrainHandlers();
  await runBootChecks();

  const transportOverride = process.env.PRIVOS_TRANSPORT === 'relay' ? ('relay' as const) : undefined;

  const handle = await serveApp({
    descriptor: buildRelayAppDescriptor(),
    createHandler: (ctx) => {
      void logAgentBotCredentialStatus(ctx.agentBotHub);
      // Fire-and-forget: reloads queued jobs, fails stale processing jobs,
      // marks abandoned recordings interrupted, sweeps dead vendor garbage —
      // across every known room. Never blocks the handler from being ready.
      void startupSweep(ctx.agentBotHub).catch((error) => {
        console.warn('[boot] startupSweep thất bại:', error instanceof Error ? error.message : error);
      });
      // Retention sweep: boot + every 6h across every known room (P8).
      stopAudioRetention = startAudioRetention(ctx.agentBotHub);
      return createMcpHandler(ctx);
    },
    ui: uiResourceProvider,
    port: Number(process.env.PORT || manifest.port || 3012),
    ...(transportOverride ? { transportOverride } : {}),
    resolveManifest: () => createManifest(),
    configure: (app) => {
      app.use('/public', express.static(path.join(repoRoot, 'public')));
      app.get('/.well-known/mcp/manifest.json', (_req, res) => res.json(createManifest()));
    },
  });

  if (handle.mode === 'development' && transportOverride === 'relay') {
    if (process.env.PRIVOS_DEV_UI === '1') {
      const { startDevUiServer } = await import('./dev-server.js');
      const dev = await startDevUiServer();
      setDevPublicUrl(dev.publicUrl);
      console.log(`Serving UI from the Vite dev server at ${dev.publicUrl}`);
    }
    const { startDevelopmentRelay } = await import('./relay-transport.js');
    await startDevelopmentRelay();
  }
}

start().catch((error) => {
  if (error instanceof RuntimeModeError && error.code === 'PRODUCTION_WITHOUT_IDENTITY') {
    startManifestOnlySurface(error.message);
    return;
  }
  console.error('Failed to start the Meeting Agent app server:', error instanceof Error ? error.message : error);
  process.exit(1);
});
