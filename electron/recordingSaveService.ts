import { randomUUID } from 'node:crypto';
import { copyFile, link, open, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export function createRecordingFilename(date = new Date()): string {
  const twoDigits = (value: number) => String(value).padStart(2, '0');
  return `Recording-${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}-${twoDigits(date.getHours())}-${twoDigits(date.getMinutes())}-${twoDigits(date.getSeconds())}.webm`;
}

export function ensureWebMExtension(filePath: string): string {
  return filePath.toLowerCase().endsWith('.webm') ? filePath : `${filePath}.webm`;
}

export async function atomicCopyRecording(
  sourcePath: string,
  destinationPath: string,
  expectedSizeBytes: number,
  allowOverwrite = true,
): Promise<number> {
  const sourceInfo = await stat(sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.size !== expectedSizeBytes) {
    throw Object.assign(new Error('The finalized recording changed before it could be saved.'), { code: 'SOURCE_CHANGED' });
  }

  const destinationDirectory = path.dirname(destinationPath);
  const stagingPath = path.join(
    destinationDirectory,
    `.${path.basename(destinationPath)}.${randomUUID()}.partial`,
  );

  try {
    await copyFile(sourcePath, stagingPath, constants.COPYFILE_EXCL);
    const stagingInfo = await stat(stagingPath);
    if (!stagingInfo.isFile() || stagingInfo.size !== expectedSizeBytes) {
      throw Object.assign(new Error('The copied recording size did not match.'), { code: 'SIZE_MISMATCH' });
    }

    const handle = await open(stagingPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (allowOverwrite) {
      await rename(stagingPath, destinationPath);
    } else {
      // Hard-link publication is atomic and fails with EEXIST instead of
      // replacing a file that appeared after the user chose a path.
      await link(stagingPath, destinationPath);
    }
    return stagingInfo.size;
  } finally {
    await rm(stagingPath, { force: true }).catch(() => undefined);
  }
}

export function explainSaveError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : '';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return 'OneTake could not write to that location. Choose a folder where you have permission to save.';
  }
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return 'There is not enough space to save this recording. Free some space and try again.';
  }
  if (code === 'EEXIST') {
    return 'A file with that name already exists. Choose another name and try again.';
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return 'The selected folder is no longer available. Choose another location and try again.';
  }
  if (code === 'SOURCE_CHANGED' || code === 'SIZE_MISMATCH') {
    return 'The finalized recording could not be verified. Keep the preview open and try again.';
  }
  return 'The recording could not be saved. Choose another location or try again.';
}
