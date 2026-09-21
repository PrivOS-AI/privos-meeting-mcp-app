/**
 * Resolve THIS app's own installation id (`mcpAppId`, the Hub's Mongo `_id` for
 * this installation) — required as the `mcpAppId` body field on every
 * `POST /api/v1/mcp-apps.tool-call` bot-credential call (see `bot-tool-call.ts`).
 * Mode-aware, same shape as `resolve-hub-origin.ts`:
 *  - `managed`: the workload broker's own binding.
 *  - `standalone-production`: the paired identity file's `mcpAppId`.
 *  - `development`: `MCP_APP_ID`, cached to `.env` by the dev pairing loop from
 *    the SAME pairing response. Absent until a fresh `npm run pair` / `npm run dev`.
 * Returns `undefined` when none is available.
 */
import { getWorkloadIdentityClient, loadStandaloneIdentity, resolveRuntimeMode } from '@privos_ai/app-server';

export async function resolveOwnMcpAppId(): Promise<string | undefined> {
  let mode: string;
  try {
    mode = resolveRuntimeMode().mode;
  } catch {
    return undefined;
  }
  if (mode === 'development') {
    const id = process.env.MCP_APP_ID;
    return id && id.trim() ? id.trim() : undefined;
  }
  if (mode === 'standalone-production') {
    try {
      return loadStandaloneIdentity().identity.mcpAppId;
    } catch {
      return undefined;
    }
  }
  try {
    return (await getWorkloadIdentityClient().brokerContext()).binding.mcpAppId;
  } catch {
    return undefined;
  }
}
