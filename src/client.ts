import type { Command } from './worker';
export class EditorClient {
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private sequence = 0;
  private pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  onEvent: (event: Record<string, unknown>) => void = () => {};
  constructor() {
    this.worker.onmessage = ({ data }) => {
      if (data.id === undefined) { this.onEvent(data); return; }
      const pending = this.pending.get(data.id); if (!pending) return;
      this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.cancelled ? 'cancelled' : data.error)); else pending.resolve(data.result);
    };
  }
  request<T>(command: Command): Promise<T> {
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: result => resolve(result as T), reject });
      this.worker.postMessage({ ...command, id });
    });
  }
  dispose() { this.worker.terminate(); }
}
