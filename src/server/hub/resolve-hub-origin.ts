/**
 * Resolve the Hub's own origin — not this app's public URL — for backend calls
 * that must reach the Hub directly (the dev Relay loop, the agent-bot
 * credential self-check, every `mcp-apps.tool-call`). Mode-aware, thin lookup
 * over SDK primitives:
 *  - `development`: the relay `PRIVOS_URL`.
 *  - `standalone-production`: the paired identity file's Relay origin.
 *  - `managed`: the workload broker's `hubOrigin`.
 * Returns `undefined` when none is available.
 */
import { getWorkloadIdentityClient, loadStandaloneIdentity, resolveRuntimeMode } from '@privos_ai/app-server';

export async function resolveHubOrigin(): Promise<string | undefined> {
  let mode: string;
  try {
    mode = resolveRuntimeMode().mode;
  } catch {
    return undefined;
  }
  if (mode === 'development') {
    const url = process.env.PRIVOS_URL;
    return url && /^https?:\/\//.test(url) ? url.replace(/\/+$/, '') : undefined;
  }
  if (mode === 'standalone-production') {
    try {
      return loadStandaloneIdentity().relay.privosUrl;
    } catch {
      return undefined;
    }
  }
  try {
    return (await getWorkloadIdentityClient().brokerContext()).hubOrigin;
  } catch {
    return undefined;
  }
}
