/**
 * Ghép các part audio đã upload thành một `audio.webm` cục bộ. Sort theo
 * `seq`, chặn một dãy có khoảng trống, và kiểm TỪNG part khớp với
 * `processing_jobs.partFileIds` của chính job này (chặn trôi dạt giữa lúc
 * `meeting_process` khám phá part và lúc job thật sự chạy) + mang đúng dấu
 * `meetingId8` trong tên (chặn part của một cuộc họp khác cùng phòng/ngày/
 * tiêu đề lẫn vào — FM F8 / S2-10). Tải + ghép theo stream với backpressure,
 * không bao giờ giữ một part trọn vẹn trong RAM.
 */
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { AppError } from '../../shared/app-error.js';
import { meetingId8 } from '../../shared/meeting-slug.js';
import { deleteRoomFile, fetchFileReadable } from './hub-file-download.js';

export interface PartRef {
  fileId: string;
  seq: number;
  name: string;
}

export async function concatParts(
  hub: RoomBoundHubClient,
  meetingId: string,
  parts: readonly PartRef[],
  jobPartFileIds: readonly string[],
  destPath: string,
  signal: AbortSignal,
): Promise<void> {
  if (parts.length === 0) {
    throw new AppError('Cuộc họp không có phần ghi âm nào để ghép.');
  }
  const sorted = [...parts].sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].seq === sorted[i - 1].seq) continue;
    if (sorted[i].seq !== sorted[i - 1].seq + 1) {
      throw new AppError(`Bản ghi thiếu phần ghi âm số ${sorted[i - 1].seq + 1}.`);
    }
  }

  const digest = meetingId8(meetingId);
  const allowed = new Set(jobPartFileIds);
  const dest = createWriteStream(destPath);
  try {
    for (const part of sorted) {
      if (signal.aborted) throw new AppError('Job đã huỷ trong lúc ghép phần ghi âm.');
      if (!allowed.has(part.fileId)) {
        throw new AppError(`Phần ghi âm "${part.name}" không khớp với job xử lý — huỷ ghép.`);
      }
      if (!part.name.includes(digest)) {
        throw new AppError(`Phần ghi âm "${part.name}" không mang đúng dấu cuộc họp — có thể thuộc cuộc họp khác.`);
      }
      const source = await fetchFileReadable(hub, part.fileId, signal);
      for await (const chunk of source) {
        if (signal.aborted) throw new AppError('Job đã huỷ trong lúc ghép phần ghi âm.');
        if (!dest.write(chunk)) await once(dest, 'drain');
      }
    }
  } finally {
    dest.end();
    await once(dest, 'close').catch(() => undefined);
  }
}

/**
 * Deletes exactly the fileIds recorded in `processing_jobs.partFileIds` —
 * NEVER scans the folder. Best-effort per part: a delete failure is logged,
 * not thrown, so one stuck part does not block the rest of the job (a
 * leftover part is harmless clutter; the boot sweep does not need to chase it
 * since only the audio.webm/transcript matter to the finished meeting).
 */
export async function deletePartFiles(hub: RoomBoundHubClient, partFileIds: readonly string[], signal?: AbortSignal): Promise<void> {
  for (const fileId of partFileIds) {
    await deleteRoomFile(hub, fileId, signal).catch((error) => {
      console.warn('[concat-parts] xoá part thất bại:', fileId, error instanceof Error ? error.message : error);
    });
  }
}
