/**
 * Node-local registry of every room this app has bootstrapped, kept in a JSON
 * file under `dataDir` (never in App DB).
 *
 * Why local, not `app_settings`: the boot + 6h retention/requeue sweeps run with
 * NO room context (they enumerate rooms BEFORE any room is known), and the Hub's
 * permission model grants `db:read` only at the `room` context this app declares
 * — a room-less (workspace-context) query can never match it, so reading the
 * room list from a global App DB collection fails closed at boot. The room list
 * is pure node-operational state (which rooms to sweep), so a local file is both
 * the correct home and the only source those room-less sweeps can read without a
 * grantable room context.
 *
 * Writes are serialized in-process (bootstrap can race for two rooms at once)
 * and land atomically via a temp-file rename so a crash mid-write cannot leave a
 * truncated list behind.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { dataDir } from '../paths.js';

const KNOWN_ROOMS_FILE = path.join(dataDir, 'known-rooms.json');

/** Serializes read-modify-write so two concurrent `addKnownRoom` calls cannot last-write-wins-drop an entry. */
let writeChain: Promise<unknown> = Promise.resolve();

async function readFile(): Promise<string[]> {
  try {
    const raw = await fs.readFile(KNOWN_ROOMS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is string => typeof r === 'string' && r.length > 0);
  } catch {
    // Absent (fresh install) or corrupt → no known rooms yet.
    return [];
  }
}

async function writeFile(rooms: string[]): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${KNOWN_ROOMS_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rooms), 'utf8');
  await fs.rename(tmp, KNOWN_ROOMS_FILE);
}

/** Every room this node has bootstrapped, or `[]` when none/unreadable. */
export async function readKnownRooms(): Promise<string[]> {
  return readFile();
}

/** Add a roomId if absent; returns the full list. Serialized against concurrent callers. */
export async function addKnownRoom(roomId: string): Promise<string[]> {
  const next = writeChain.then(async () => {
    const rooms = await readFile();
    if (rooms.includes(roomId)) return rooms;
    const updated = [...rooms, roomId];
    await writeFile(updated);
    return updated;
  });
  // Keep the chain alive even if this link rejects, so a single failure does not wedge every later write.
  writeChain = next.catch(() => undefined);
  return next;
}
