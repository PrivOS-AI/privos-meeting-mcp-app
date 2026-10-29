// Calls the PrivOS Meeting app's tools for the Room's agent, through the Hub
// (`mcp-apps.tool-call`, as the person the Sandbox works for). Nothing here
// holds a credential: the Sandbox's own skill SDK signs the call.
//
//   node meeting-tool.mjs APP_ID|auto ROOM_ID|auto TOOL_NAME JSON_ARGUMENTS
//
// The room id is filled into the arguments; the agent never passes it twice.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export const ALLOWED_TOOLS = new Set(['meeting_listen_start', 'meeting_listen_status', 'meeting_listen_stop', 'meeting_ask', 'meeting_status']);
const MEETING_APP = /^ai\.privos\.meeting-agent(?:-[a-z0-9-]+)?$/;

/** Which Meeting app to call from the Room's chat: the one active install in this Room, or a question back. */
export function pickMeetingApp(installations) {
  const apps = (Array.isArray(installations) ? installations : []).filter((item) => item?.status === 'ACTIVE'
    && typeof item.mcpAppId === 'string' && MEETING_APP.test(item.appId ?? ''));
  if (apps.length === 1) return { appId: apps[0].mcpAppId };
  if (apps.length === 0) return { error: 'This Room has no PrivOS Meeting app. Ask a Room owner to add it to this Room.' };
  return { error: `This Room has ${apps.length} Meeting apps: ${apps.map((item) => `${item.appId} (APP_ID ${item.mcpAppId})`).join(', ')}. Ask the user which one to use, then pass its APP_ID instead of auto.` };
}

export async function resolveBinding(hub, appArg, roomArg, env = process.env) {
  const roomId = !roomArg || roomArg === 'auto' ? env.PRIVOS_ROOM_ID : roomArg;
  if (!roomId) throw new Error('No ROOM_ID: pass the room_id from [ACTIVE_CONTEXT].');
  if (appArg && appArg !== 'auto') return { appId: appArg, roomId };
  const response = await hub.get(`/api/v1/mcp-apps.installations?roomId=${encodeURIComponent(roomId)}`);
  const body = typeof response?.json === 'function' ? await response.json() : response;
  if (response?.ok === false) throw new Error("PrivOS did not list this Room's apps; pass the app_id from [ACTIVE_CONTEXT].");
  const picked = pickMeetingApp(body?.installations);
  if (picked.error) throw new Error(picked.error);
  return { appId: picked.appId, roomId };
}

/** The tool's answer, or its error in words the agent can act on (the app's stable code included). */
export function toolResult(body) {
  const result = body?.result ?? body;
  const structured = result?.structuredContent;
  const textPart = Array.isArray(result?.content) ? result.content.find((part) => part?.type === 'text')?.text : undefined;
  let parsed = structured;
  if (parsed === undefined && typeof textPart === 'string') {
    try { parsed = JSON.parse(textPart); } catch { parsed = textPart; }
  }
  const error = parsed?.error;
  if (result?.isError || error) {
    const code = typeof error?.code === 'string' ? ` [${error.code}]` : '';
    throw new Error(`${typeof error?.message === 'string' ? error.message : typeof textPart === 'string' ? textPart : 'The Meeting app refused the request.'}${code}`);
  }
  if (body?.success === false) throw new Error(body?.error || 'PrivOS refused the Meeting app call.');
  return parsed ?? null;
}

async function main() {
  const [appArg, roomArg, toolName, rawArguments = '{}'] = process.argv.slice(2);
  if (!appArg || !roomArg || !toolName) throw new Error('Usage: meeting-tool.mjs APP_ID|auto ROOM_ID|auto TOOL_NAME JSON_ARGUMENTS');
  if (!ALLOWED_TOOLS.has(toolName)) throw new Error(`Unsupported meeting tool: ${toolName}`);
  let argumentsValue;
  try { argumentsValue = JSON.parse(rawArguments); } catch { throw new Error('JSON_ARGUMENTS must be valid JSON'); }
  if (!argumentsValue || Array.isArray(argumentsValue) || typeof argumentsValue !== 'object') throw new Error('JSON_ARGUMENTS must be an object');

  let hub;
  try { ({ hub } = require('@privos/skill-sdk')); } catch { throw new Error('@privos/skill-sdk is unavailable in this Sandbox.'); }
  const { appId, roomId } = await resolveBinding(hub, appArg, roomArg);
  if (process.env.PRIVOS_SANDBOX_MODE === 'true' && process.env.PRIVOS_ROOM_ID !== roomId) throw new Error('ROOM_ID does not match the current Sandbox room binding.');
  const response = await hub.post('/api/v1/mcp-apps.tool-call', { json: { mcpAppId: appId, roomId, toolName, arguments: { ...argumentsValue, roomId } } });
  const body = await response.json();
  if (!response.ok && body?.success === false) throw new Error(body?.error || `PrivOS refused the Meeting app call (${response.status}).`);
  process.stdout.write(`${JSON.stringify(toolResult(body))}\n`);
}

// Run only as a script, so the helpers above can be imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
