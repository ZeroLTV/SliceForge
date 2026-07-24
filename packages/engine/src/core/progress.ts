export type ProgressCallback = (message: string) => void;

export function notifyProgress(callback: ProgressCallback | undefined, message: string): void {
  try {
    callback?.(message);
  } catch {
    // Progress reporting must never change workflow state or outcomes.
  }
}
