import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

export const LEGACY_USER_DATA_FOLDER = 'local-loom';

export function migrateUserDataDirectory(appDataDirectory: string, targetDirectory: string): void {
  const legacyDirectory = path.join(appDataDirectory, LEGACY_USER_DATA_FOLDER);
  if (!existsSync(legacyDirectory)) return;
  const targetExisted = existsSync(targetDirectory);
  if (!targetExisted) {
    try {
      renameSync(legacyDirectory, targetDirectory);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    }
  }
  // Preserve files already created in the new profile; fill only missing files.
  cpSync(legacyDirectory, targetDirectory, { recursive: true, force: false });
  // Keep the old profile when both existed because its conflicting files may differ.
  if (!targetExisted) rmSync(legacyDirectory, { recursive: true, force: true });
}
