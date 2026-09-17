/**
 * Provider selection. The active realtime/async vendor is read from
 * `app_settings` (workspace admin choice) with the env default as fallback
 * (QĐ-15). Switching provider is a Settings change, never a code change — all
 * four shells are always wired in.
 */
import type { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { getSetting } from '../hub/app-settings.js';
import { env } from '../env.js';
import { elevenLabsBatchProvider } from './elevenlabs-batch-provider.js';
import { elevenLabsRealtimeProvider } from './elevenlabs-realtime-token.js';
import { sonioxAsyncProvider } from './soniox-async-provider.js';
import { sonioxRealtimeProvider } from './soniox-realtime-token.js';
import type { AsyncSttProvider, ProviderStatus, RealtimeTokenProvider, SttVendor } from './stt-provider.js';

const REALTIME: Record<SttVendor, RealtimeTokenProvider> = {
  soniox: sonioxRealtimeProvider,
  elevenlabs: elevenLabsRealtimeProvider,
};

const ASYNC: Record<SttVendor, AsyncSttProvider> = {
  soniox: sonioxAsyncProvider,
  elevenlabs: elevenLabsBatchProvider,
};

function asVendor(value: unknown, fallback: SttVendor): SttVendor {
  return value === 'soniox' || value === 'elevenlabs' ? value : fallback;
}

export function realtimeProviderFor(vendor: SttVendor): RealtimeTokenProvider {
  return REALTIME[vendor];
}

export function asyncProviderFor(vendor: SttVendor): AsyncSttProvider {
  return ASYNC[vendor];
}

/** The active realtime vendor: app_settings override, else env default. */
export async function resolveRealtimeVendor(db?: AppDbBotClient): Promise<SttVendor> {
  const override = db ? await getSetting<string>(db, 'sttRealtimeProvider') : undefined;
  return asVendor(override, env.realtimeProvider);
}

/** The active async vendor: app_settings override, else env default. */
export async function resolveAsyncVendor(db?: AppDbBotClient): Promise<SttVendor> {
  const override = db ? await getSetting<string>(db, 'sttAsyncProvider') : undefined;
  return asVendor(override, env.asyncProvider);
}

/** Status of BOTH vendors' realtime + async surfaces — for the status tool. */
export async function allProviderStatuses(): Promise<ProviderStatus[]> {
  return Promise.all([
    sonioxRealtimeProvider.status(),
    elevenLabsRealtimeProvider.status(),
    sonioxAsyncProvider.status(),
    elevenLabsBatchProvider.status(),
  ]);
}
