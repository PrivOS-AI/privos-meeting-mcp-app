/**
 * `speaker_profile_list` / `_update` / `_delete` — the workspace-wide (global,
 * room-less) speaker-identity registry. `_list` returns display data ONLY,
 * never a vector, and is readable by any verified user (plan.md: showing the
 * roster workspace-wide is an accepted, documented trade-off). `_update`/
 * `_delete` require `createdByUserId === actor.userId || isWorkspaceAdmin`.
 *
 * `_update`'s `action:'reenrol'` deliberately does NOT exist yet — it needs
 * `meetings.audioDeletedAt`/re-decode plumbing this tool does not have
 * access to without a `roomId` (this collection is global). It responds with
 * a clear "not yet supported" AppError rather than silently no-op'ing, so a
 * caller cannot mistake acceptance for having actually re-embedded anything.
 */
import { sanitizeDisplayName } from '../../shared/sanitize-display-name.js';
import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { getSetting } from '../hub/app-settings.js';
import * as profileStore from '../speaker/profile-store.js';
import { isWorkspaceAdmin, requireVerifiedActor } from './authz.js';
import type { AppTool } from './registry.js';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Display-only projection of a profile — no `embeddings`/`centroid` ever leave this module. */
function toListItem(profile: profileStore.SpeakerProfile) {
  return {
    id: profile.id,
    displayName: profile.displayName,
    privosUserId: profile.privosUserId,
    privosUsername: profile.privosUsername,
    colorKey: profile.colorKey,
    sampleCount: profile.sampleCount,
    lastSeenAt: profile.lastSeenAt,
    createdByUserId: profile.createdByUserId,
    meetingCount: new Set(profile.embeddings.map((e) => e.meetingId).filter(Boolean)).size,
  };
}

export const speakerProfileListTool: AppTool = {
  name: 'speaker_profile_list',
  title: 'Danh sách hồ sơ giọng nói',
  description: 'Liệt kê mọi hồ sơ giọng nói trong workspace (tên, liên kết, số mẫu) — không bao giờ trả về vector.',
  inputSchema: { type: 'object', properties: {} },
  async execute(_args, context) {
    requireVerifiedActor(context);
    const db = new AppDbBotClient();
    const profiles = await profileStore.listProfiles(db);
    return { profiles: profiles.map(toListItem) };
  },
};

export const speakerProfileUpdateTool: AppTool = {
  name: 'speaker_profile_update',
  title: 'Cập nhật hồ sơ giọng nói',
  description: 'Đổi tên, liên kết người dùng PrivOS hoặc ghi nhận lại giọng nói cho một hồ sơ — chỉ người tạo hồ sơ hoặc quản trị viên workspace.',
  inputSchema: {
    type: 'object',
    required: ['profileId'],
    properties: {
      profileId: { type: 'string' },
      displayName: { type: 'string', maxLength: 80 },
      privosUserId: { type: 'string' },
      privosUsername: { type: 'string' },
      action: { type: 'string', enum: ['reenrol'] },
    },
  },
  async execute(args, context) {
    const actor = requireVerifiedActor(context);
    const profileId = asString(args.profileId);
    if (!profileId) throw new AppError('profileId là bắt buộc.');

    const db = new AppDbBotClient();
    const profile = await profileStore.getProfile(db, profileId);
    if (!profile) throw new AppError('Không tìm thấy hồ sơ giọng nói.');
    if (profile.createdByUserId !== actor.userId && !isWorkspaceAdmin(actor)) {
      throw new AppError('Chỉ người tạo hồ sơ hoặc quản trị viên workspace mới sửa được hồ sơ này.');
    }

    if (args.action === 'reenrol') {
      // Re-embedding from stored audio needs a room-bound Files read this
      // global-scope tool does not have (no `roomId` in its input by design —
      // plan.md keeps `speaker_profile_*` room-less). Surfacing this clearly
      // beats silently accepting a request that does nothing.
      throw new AppError('Ghi nhận lại giọng nói từ audio đã lưu chưa được hỗ trợ ở phiên bản này.');
    }

    if (typeof args.displayName === 'string') {
      const displayName = sanitizeDisplayName(args.displayName);
      if (!displayName) throw new AppError('Tên hiển thị không hợp lệ.');
      await profileStore.renameProfile(db, profileId, displayName);
    }
    if (typeof args.privosUserId === 'string' && args.privosUserId) {
      await profileStore.linkPrivosUser(db, profileId, args.privosUserId, typeof args.privosUsername === 'string' ? args.privosUsername : undefined);
    }

    const updated = await profileStore.getProfile(db, profileId);
    return { profile: updated ? toListItem(updated) : null };
  },
};

export const speakerProfileDeleteTool: AppTool = {
  name: 'speaker_profile_delete',
  title: 'Xoá hồ sơ giọng nói',
  description: 'Xoá hẳn một hồ sơ giọng nói và mọi liên kết của nó trong tất cả các phòng — chỉ người tạo hồ sơ hoặc quản trị viên workspace.',
  inputSchema: { type: 'object', required: ['profileId'], properties: { profileId: { type: 'string' } } },
  async execute(args, context) {
    const actor = requireVerifiedActor(context);
    const profileId = asString(args.profileId);
    if (!profileId) throw new AppError('profileId là bắt buộc.');

    const db = new AppDbBotClient();
    const profile = await profileStore.getProfile(db, profileId);
    if (!profile) throw new AppError('Không tìm thấy hồ sơ giọng nói.');
    if (profile.createdByUserId !== actor.userId && !isWorkspaceAdmin(actor)) {
      throw new AppError('Chỉ người tạo hồ sơ hoặc quản trị viên workspace mới xoá được hồ sơ này.');
    }

    const knownRooms = (await getSetting<string[]>(db, 'knownRooms')) ?? [];
    await profileStore.deleteProfile(db, profileId, knownRooms);
    return { deleted: true };
  },
};
