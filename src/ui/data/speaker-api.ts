/**
 * Thin `callServerTool` wrapper for the 5 speaker-identity tools — the iframe
 * never touches `speaker_profiles`/`meeting_speakers` vectors directly, it
 * only calls these (same `parseToolResult` unwrap pattern as `app-db-client.ts`).
 */
import { parseToolResult } from '@privos_ai/app-react';
import type { McpApp } from '@privos_ai/app-react';

export type SpeakerResolveMode = 'user' | 'name' | 'merge' | 'skip';

/**
 * A manual assignment the user makes on a REALTIME speaker (from second one),
 * before the embedding pipeline has a session speaker for it. The recording
 * store applies the label at once and defers enrolment (voiceprint) until a
 * matching session speaker appears.
 */
export interface RealtimeAssignChoice {
  mode: SpeakerResolveMode;
  displayName?: string;
  privosUserId?: string;
  profileId?: string;
}

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

/** Voiceprint hygiene scalars — attached only when the caller may edit this profile. Never a vector; counts and cosine numbers only. */
export interface SpeakerProfileHealth {
  vectorCounts: { userLive: number; userPost: number; autoPost: number; legacy: number };
  minPairwiseCosine: number;
  meanPairwiseCosine: number;
  outlierCount: number;
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
  /** Present only for a profile the caller may edit (same gate as rename/delete). */
  health?: SpeakerProfileHealth;
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

export interface SpeakerProfileUpdateResult {
  profile: SpeakerProfileListItem | null;
  /** Only present after `action: 'pruneOutliers'` — how many flagged vectors were actually removed. */
  pruned?: number;
}

export async function speakerProfileUpdate(
  app: McpApp,
  input: { profileId: string; displayName?: string; privosUserId?: string; privosUsername?: string; action?: 'reenrol' | 'pruneOutliers' },
): Promise<SpeakerProfileUpdateResult> {
  return callTool<SpeakerProfileUpdateResult>(app, 'speaker_profile_update', input);
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
