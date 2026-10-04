export function createCaptureCleanup(
  cleanups: Map<string, Promise<void>>,
  recordingId: string,
  abort: (recordingId: string) => Promise<void>,
): Promise<void> {
  const pending = cleanups.get(recordingId);
  if (pending) return pending;

  const cleanup = Promise.resolve().then(() => abort(recordingId)).finally(() => {
    if (cleanups.get(recordingId) === cleanup) cleanups.delete(recordingId);
  });
  cleanups.set(recordingId, cleanup);
  return cleanup;
}
