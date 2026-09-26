#!/usr/bin/env -S npx tsx
/**
 * Pulls ONE meeting's artefacts out of the Hub (as this app's installation
 * bot) into a local directory, for offline speaker/transcript analysis:
 * every file in the meeting's Files folder (audio.webm, transcript.*,
 * live-turns.json, captions-*.json, speaker-diagnostics.jsonl, summary.md)
 * plus the App DB `meetings` row and its `meeting_speakers` rows.
 *
 * Runs ON THE NODE (needs the paired identity + .env), never locally:
 *   cd /opt/privos/apps/meeting-agent
 *   npx tsx scripts/export-meeting-artifacts.ts --room <roomId> --list
 *   npx tsx scripts/export-meeting-artifacts.ts --room <roomId> --meeting <meetingId> --out ./data/export/<name>
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createAgentBotHubClient, loadStandaloneIdentity, setAdoptedAgentBotCredential } from '@privos_ai/app-server';

import { AppDbBotClient, extractDbRecords } from '../src/server/hub/app-db-bot-client.js';
import { resolveHubOrigin } from '../src/server/hub/resolve-hub-origin.js';
import { downloadRoomFile, listRoomFolderFiles } from '../src/server/media/hub-file-download.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const roomId = arg('room');
  if (!roomId) throw new Error('--room <roomId> is required');
  // Outside `serveApp` nothing seeds the bot credential from the paired identity file — do it here.
  const credential = loadStandaloneIdentity().identity.agentBotCredential;
  if (!credential) throw new Error('identity file carries no agentBotCredential');
  setAdoptedAgentBotCredential(credential);
  const db = new AppDbBotClient(roomId);

  if (process.argv.includes('--list')) {
    const rows = extractDbRecords(await db.query('meetings', 'room', { limit: 200 }));
    for (const r of rows) console.log(`${r._id}  ${String(r.startedAt ?? '').slice(0, 19)}  ${r.status}  ${r.durationSec ?? '?'}s  ${r.title}`);
    return;
  }

  const meetingId = arg('meeting');
  const out = arg('out');
  if (!meetingId || !out) throw new Error('--meeting <id> and --out <dir> are required');
  await mkdir(out, { recursive: true });

  const meeting = await db.getById('meetings', 'room', meetingId);
  if (!meeting) throw new Error(`meeting ${meetingId} not found in room ${roomId}`);
  await writeFile(path.join(out, 'meeting.json'), JSON.stringify(meeting, null, 2));

  const speakers = extractDbRecords(await db.query('meeting_speakers', 'room', { where: [{ field: 'meeting', op: '==', value: meetingId }], limit: 1000 }));
  await writeFile(path.join(out, 'speakers.json'), JSON.stringify(speakers, null, 2));
  console.log(`meeting "${meeting.title}" — ${speakers.length} speaker rows`);

  const folderId = typeof meeting.folderId === 'string' ? meeting.folderId : '';
  if (!folderId) throw new Error('meeting has no folderId');
  const hub = createAgentBotHubClient({ resolveHubOrigin });
  const files = await listRoomFolderFiles(hub, roomId, folderId);
  for (const f of files) {
    const dest = path.join(out, f.name);
    await downloadRoomFile(hub, f._id, dest);
    console.log(`downloaded ${f.name}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
