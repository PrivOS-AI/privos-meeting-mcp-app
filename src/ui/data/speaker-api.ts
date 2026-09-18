/**
 * Thin `callServerTool` wrapper for the 5 speaker-identity tools — the iframe
 * never touches `speaker_profiles`/`meeting_speakers` vectors directly, it
 * only calls these (same `parseToolResult` unwrap pattern as `app-db-client.ts`).
 */
import { parseToolResult } from '@privos_ai/app-react';
import type { McpApp } from '@privos_ai/app-react';

export type SpeakerResolveMode = 'user' | 'name' | 'merge' | 'skip';

export interface SpeakerResolveAssignment {
  speakerId: string;
  mode: SpeakerResolveMode;
  privosUserId?: string;
  displayName?: string;
  profileId?: string;
}

export interface SpeakerResolveResult {
  speakerId: string;
  enrolled: boolean;
  profileId?: string;
  displayName?: string;
  reason?: string;
}

export interface SpeakerProfileListItem {
  id: string;
  displayName: string;
  privosUserId?: string;
  privosUsername?: string;
  colorKey: string;
  sampleCount: number;
  lastSeenAt?: string;
  createdByUserId: string;
  meetingCount: number;
}

async function callTool<T>(app: McpApp, name: string, args: Record<string, unknown>): Promise<T> {
  const raw = await app.callServerTool({ name, arguments: args });
  return parseToolResult(raw) as T;
}

export async function speakerResolve(app: McpApp, roomId: string, meetingId: string, assignments: SpeakerResolveAssignment[]): Promise<SpeakerResolveResult[]> {
  const result = await callTool<{ resolved: SpeakerResolveResult[] }>(app, 'speaker_resolve', { roomId, meetingId, assignments });
  return result.resolved;
}

export async function speakerProfileList(app: McpApp): Promise<SpeakerProfileListItem[]> {
  const result = await callTool<{ profiles: SpeakerProfileListItem[] }>(app, 'speaker_profile_list', {});
  return result.profiles;
}

export async function speakerProfileUpdate(
  app: McpApp,
  input: { profileId: string; displayName?: string; privosUserId?: string; privosUsername?: string; action?: 'reenrol' },
): Promise<SpeakerProfileListItem | null> {
  const result = await callTool<{ profile: SpeakerProfileListItem | null }>(app, 'speaker_profile_update', input);
  return result.profile;
}

export async function speakerProfileDelete(app: McpApp, profileId: string): Promise<boolean> {
  const result = await callTool<{ deleted: boolean }>(app, 'speaker_profile_delete', { profileId });
  return result.deleted;
}

export async function meetingRelabelSpeaker(
  app: McpApp,
  input: { roomId: string; meetingId: string; speakerId: string; profileId?: string; displayName?: string },
): Promise<{ updated: boolean; profileId: string; displayName: string; enrolled: boolean }> {
  return callTool(app, 'meeting_relabel_speaker', input);
}
