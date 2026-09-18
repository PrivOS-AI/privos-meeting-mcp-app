/**
 * Locates and downloads ONE part file by `seq` for the live chunk worker —
 * distinct from `media/concat-parts.ts`, which ingests the full, already-
 * closed part list for the post-meeting job. Parts are still arriving live
 * here, so the folder is re-listed on every call rather than trusting a
 * cached list; the `meetingId8` stamp in the file name is still verified
 * (S2-10) before the file is trusted.
 */
import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { AppError } from '../../shared/app-error.js';
import { meetingId8, partFileName } from '../../shared/meeting-slug.js';
import { downloadRoomFile, listRoomFolderFiles } from '../media/hub-file-download.js';

/**
 * Downloads part `seq` of `meetingId` from `folderId` into `destPath`.
 * Throws when the part is not visible in Files yet — a legitimate, retryable
 * race between the client's `meeting_chunk_ready` call and its own upload
 * finishing, not corruption — or when the matched file's name lacks the
 * meeting's own `meetingId8` stamp (a different meeting's part leaking into
 * the same room/day/title folder).
 */
export async function downloadPartBySeq(
  hub: RoomBoundHubClient,
  roomId: string,
  folderId: string,
  meetingId: string,
  seq: number,
  destPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const files = await listRoomFolderFiles(hub, roomId, folderId, signal);
  const expectedName = partFileName(seq, meetingId);
  const file = files.find((f) => f.name === expectedName);
  if (!file) {
    throw new AppError(`Không tìm thấy phần ghi âm #${seq} của cuộc họp trong Files (có thể chưa upload xong).`);
  }
  if (!file.name.includes(meetingId8(meetingId))) {
    throw new AppError(`Phần ghi âm #${seq} không mang đúng dấu cuộc họp.`);
  }
  await downloadRoomFile(hub, file._id, destPath, signal);
}
