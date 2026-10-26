/**
 * Diagnose "Insufficient scope" / "bot not in room" reports on a paired
 * standalone install, in the order that finds the real cause first:
 *
 *   npm run diagnose:scopes -- [--room <roomId>] [--write]
 *
 *   1. credential present   (identity file / env)
 *   2. credential valid     (GET /api/v1/me as the bot)
 *   3. manifest approved    (pinned digest vs the local manifest hash)
 *   4. scopes on the Hub    (mcp-apps.get vs privos-app.json)
 *   5. app installed        (mcp-apps.installations in --room)
 *   6. bot is a member      (subscriptions.getOne in --room) ← most reports end here
 *   7. scoped tools         (db:schema:read, db:read, files:read; db:schema:write with --write)
 *
 * Read-only unless --write. Never prints the credential. Without --room it
 * lists the rooms the bot belongs to.
 */
import 'dotenv/config';

import {
  createAgentBotHubClient,
  loadStandaloneIdentity,
  readAgentBotCredential,
  setAdoptedAgentBotCredential,
  type RoomBoundHubClient,
} from '@privos_ai/app-server';
import { lintManifest } from '@privos_ai/app-server/manifest-tools';

import manifest from '../privos-app.json';

interface Args {
  room?: string;
  write: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { write: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--room') args.room = argv[++i];
    else if (argv[i] === '--write') args.write = true;
  }
  return args;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return { raw: text };
  }
}

async function get(client: RoomBoundHubClient, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await client.authorizedFetch(path, { method: 'GET', requiredScope: 'basic:information', retryMode: 'never' });
  return { status: response.status, body: await readJson(response) };
}

async function toolCall(client: RoomBoundHubClient, mcpAppId: string, roomId: string, toolName: string, requiredScope: string, args: Record<string, unknown>): Promise<string> {
  const response = await client.authorizedFetch('/api/v1/mcp-apps.tool-call', {
    method: 'POST',
    requiredScope,
    retryMode: 'never',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mcpAppId, toolName, arguments: args, roomId }),
  });
  const body = await readJson(response);
  if (!response.ok || body.success === false) {
    return `REFUSED (HTTP ${response.status}): ${typeof body.error === 'string' ? body.error : JSON.stringify(body).slice(0, 300)}`;
  }
  const first = (Array.isArray(body.content) ? body.content[0] : undefined) as { text?: string } | undefined;
  return `OK: ${(first?.text ?? JSON.stringify(body)).slice(0, 200)}`;
}

async function main(): Promise<void> {
  const { room, write } = parseArgs(process.argv.slice(2));
  const loaded = loadStandaloneIdentity();
  const identity = loaded.identity as { mcpAppId: string; agentBotCredential?: { botUserId: string; token: string } };

  // 1. Credential present.
  const credential = identity.agentBotCredential ?? readAgentBotCredential() ?? undefined;
  if (!credential) {
    console.log('1. credential: MISSING — an admin must issue it (Hub Admin > Apps > this app > Settings); the app picks it up when online.');
    process.exit(2);
  }
  setAdoptedAgentBotCredential(credential);
  const client = createAgentBotHubClient({ resolveHubOrigin: async () => loaded.relay.privosUrl });
  const mcpAppId = identity.mcpAppId;
  console.log(`Hub ${loaded.relay.privosUrl} · mcpAppId ${mcpAppId} · bot ${credential.botUserId} (@${manifest.agentBot.slug})`);
  console.log('1. credential: present');

  // 2. Credential valid.
  const me = await get(client, '/api/v1/me');
  console.log(`2. credential valid (GET /api/v1/me): ${me.status === 200 ? 'yes' : `NO (HTTP ${me.status}) — rotated or revoked; re-issue it in Admin. Not a scope problem.`}`);
  if (me.status !== 200) process.exit(3);

  // 3. Manifest approved: the digest pinned at pairing vs this checkout.
  const pinned = (loaded.trust as { affinity?: { manifestDigest?: string } } | undefined)?.affinity?.manifestDigest;
  const local = lintManifest(manifest).canonicalManifestHash;
  console.log(
    `3. manifest approved: ${pinned && local && pinned !== local ? `DRIFT — pinned ${pinned}, local ${local}. Admin > Apps > this app > Settings > Refresh (new optional scopes start unapproved).` : `pinned ${pinned ?? '(none)'}`}`,
  );

  // 4. Scopes the Hub recorded.
  const appRecord = await get(client, `/api/v1/mcp-apps.get?_id=${encodeURIComponent(mcpAppId)}`);
  const app = (appRecord.body.app ?? {}) as Record<string, unknown>;
  const hubScopes = Array.isArray(app.scopes) ? (app.scopes as string[]) : [];
  const missing = manifest.permissions.filter((p) => !hubScopes.includes(p.scope));
  console.log(`4. Hub scopes (${hubScopes.length}): ${hubScopes.join(', ') || '(none)'}`);
  for (const p of missing) console.log(`   not on the Hub: ${p.scope} (${p.requirement}) — approve it in Admin > Apps`);

  if (!room) {
    const subs = await get(client, '/api/v1/subscriptions.get');
    const rooms = (Array.isArray(subs.body.update) ? subs.body.update : []) as Array<{ rid?: string; t?: string; fname?: string; name?: string }>;
    console.log(`\nRooms the bot belongs to (${rooms.length}):`);
    for (const r of rooms) console.log(`   ${r.rid}  ${r.t}  ${r.fname ?? r.name ?? ''}`);
    console.log('\nPass --room <roomId> for steps 5–7.');
    return;
  }

  // 5. App installed in the room (the bot only sees installations of rooms it belongs to).
  const installs = await get(client, `/api/v1/mcp-apps.installations?roomId=${encodeURIComponent(room)}`);
  const mine = (Array.isArray(installs.body.installations) ? installs.body.installations : []).filter((i) => (i as { mcpAppId?: string }).mcpAppId === mcpAppId);
  console.log(`5. installed in ${room}: ${installs.body.success === false ? `cannot tell (${String(installs.body.error)}) — see step 6` : mine.length ? 'yes' : 'no — install the app in this room'}`);

  // 6. Bot membership — the usual cause of "Insufficient scope" for every scope.
  const sub = await get(client, `/api/v1/subscriptions.getOne?roomId=${encodeURIComponent(room)}`);
  const member = 'subscription' in sub.body ? Boolean(sub.body.subscription) : undefined;
  console.log(
    `6. bot is a member: ${member === undefined ? `unknown (${JSON.stringify(sub.body).slice(0, 120)})` : member ? 'yes' : 'NO — open the app in the room and press "Add to room" (bot:room:join), or invite @' + manifest.agentBot.slug + ' by hand'}`,
  );
  console.log(`   context.get (no scope) → ${await toolCall(client, mcpAppId, room, 'mcpapp.context.get', 'basic:information', {})}`);

  // 7. Scoped tools — only now is a remaining "Insufficient scope" a real grant gap.
  console.log(`7. db.listCollections (db:schema:read) → ${await toolCall(client, mcpAppId, room, 'mcpapp.db.listCollections', 'db:schema:read', {})}`);
  console.log(`   db.query meetings (db:read)         → ${await toolCall(client, mcpAppId, room, 'mcpapp.db.query', 'db:read', { collection: 'meetings', limit: 1 })}`);
  const files = await get(client, `/api/v1/file-management.files.channel/${encodeURIComponent(room)}?count=1`);
  console.log(`   files list (files:read)             → ${files.status === 200 ? 'OK' : `REFUSED (HTTP ${files.status}): ${JSON.stringify(files.body).slice(0, 200)}`}`);
  if (write) {
    console.log(
      `   db.registerCollection probe (db:schema:write) → ${await toolCall(client, mcpAppId, room, 'mcpapp.db.registerCollection', 'db:schema:write', {
        name: 'meeting_scope_probe',
        scope: 'room',
        fields: [{ name: 'note', type: 'string', required: false }],
      })}`,
    );
  } else {
    console.log('   (add --write to also try db:schema:write on a throwaway "meeting_scope_probe" collection)');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
