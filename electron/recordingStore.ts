import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_QUEUED_CHUNKS = 4;
export const PREVIEW_SCHEME = 'onetake';

interface ActiveRecording {
  id: string;
  path: string;
  handle: Awaited<ReturnType<typeof open>>;
  queue: Promise<void>;
  pendingChunks: number;
  sizeBytes: number;
  failure: Error | null;
  acceptingChunks: boolean;
}

export interface FinalizedRecording {
  id: string;
  path: string;
  sizeBytes: number;
  mimeType: 'video/webm';
}

class RecordingStore {
  private active: ActiveRecording | null = null;
  private finalized = new Map<string, FinalizedRecording>();

  async cleanupOrphanedFiles(): Promise<void> {
    const directory = path.join(app.getPath('temp'), 'OneTake');
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    const orphanName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webm$/i;
    await Promise.all(entries
      .filter((entry) => entry.isFile() && orphanName.test(entry.name))
      .map((entry) => rm(path.join(directory, entry.name), { force: true })));
  }

  async begin(): Promise<string> {
    if (this.active) throw new Error('A recording is already active.');

    const directory = path.join(app.getPath('temp'), 'OneTake');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const filePath = path.join(directory, `${id}.webm`);
    const handle = await open(filePath, 'wx', 0o600);
    this.active = {
      id,
      path: filePath,
      handle,
      queue: Promise.resolve(),
      pendingChunks: 0,
      sizeBytes: 0,
      failure: null,
      acceptingChunks: true,
    };
    return id;
  }

  async append(id: string, input: unknown): Promise<void> {
    const active = this.active;
    if (!active || active.id !== id || !active.acceptingChunks) {
      throw new Error('There is no active recording for that request.');
    }

    const bytes = toBytes(input);
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_CHUNK_BYTES) {
      throw new TypeError('Recording chunk has an invalid size or type.');
    }
    if (active.pendingChunks >= MAX_QUEUED_CHUNKS) {
      throw new RangeError('Recording disk writer is behind the capture stream.');
    }

    active.pendingChunks += 1;
    const write = active.queue.then(async () => {
      if (active.failure) throw active.failure;
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await active.handle.write(bytes, offset, bytes.byteLength - offset, null);
        if (bytesWritten <= 0) throw new Error('Recording chunk could not be written.');
        offset += bytesWritten;
      }
      active.sizeBytes += bytes.byteLength;
    });
    active.queue = write.catch((error: unknown) => {
      active.failure ??= asError(error);
    });

    try {
      await write;
    } finally {
      active.pendingChunks -= 1;
    }
  }

  async finalize(id: string): Promise<FinalizedRecording> {
    const active = this.active;
    if (!active || active.id !== id) throw new Error('There is no active recording to finalize.');
    active.acceptingChunks = false;

    try {
      await active.queue;
      if (active.failure) throw active.failure;
      await active.handle.sync();
      await active.handle.close();

      const fileInfo = await stat(active.path);
      if (active.sizeBytes < 4 || fileInfo.size !== active.sizeBytes) {
        throw new EmptyRecordingError();
      }

      const check = await open(active.path, 'r');
      try {
        const signature = Buffer.alloc(4);
        const { bytesRead } = await check.read(signature, 0, signature.length, 0);
        if (bytesRead !== signature.length || !signature.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
          throw new EmptyRecordingError();
        }
      } finally {
        await check.close();
      }

      const finalized: FinalizedRecording = {
        id,
        path: active.path,
        sizeBytes: fileInfo.size,
        mimeType: 'video/webm',
      };
      this.finalized.set(id, finalized);
      this.active = null;
      return finalized;
    } catch (error) {
      await this.removeActive(active);
      throw error;
    }
  }

  async abort(id: string): Promise<void> {
    if (!this.active || this.active.id !== id) return;
    await this.removeActive(this.active);
  }

  async abortActive(): Promise<void> {
    if (this.active) await this.removeActive(this.active);
  }

  getFinalized(id: string): FinalizedRecording | null {
    return this.finalized.get(id) ?? null;
  }

  createPreviewUrl(id: string): string {
    if (!this.finalized.has(id)) throw new Error('Recording is not finalized.');
    return `${PREVIEW_SCHEME}://recording/${id}`;
  }

  async discard(id: string): Promise<void> {
    const recording = this.finalized.get(id);
    if (!recording) return;
    this.finalized.delete(id);
    await rm(recording.path, { force: true });
  }

  async dispose(): Promise<void> {
    await this.abortActive();
    const oldFiles = [...this.finalized.values()];
    this.finalized.clear();
    await Promise.all(oldFiles.map(({ path: filePath }) => rm(filePath, { force: true })));
  }

  private async removeActive(active: ActiveRecording): Promise<void> {
    active.acceptingChunks = false;
    try {
      await active.queue;
    } catch {
      // The partial file is removed even when its final queued write failed.
    }
    try {
      await active.handle.close();
    } catch {
      // It may already have been closed by a failed finalization.
    }
    await rm(active.path, { force: true }).catch(() => undefined);
    if (this.active === active) this.active = null;
  }
}

export class EmptyRecordingError extends Error {
  constructor() {
    super('The capture did not produce a valid WebM recording.');
    this.name = 'EmptyRecordingError';
  }
}

function toBytes(input: unknown): Buffer | null {
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  return null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Recording write failed.');
}

export const recordingStore = new RecordingStore();
