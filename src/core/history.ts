import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Parameters as EditParameters } from './engine.ts';
import type { MaskPatch, MaskTile } from './mask.ts';

export type HistoryEntry = { patches: MaskPatch[]; before: EditParameters; after: EditParameters };
export type HistoryRecord = HistoryEntry | Uint8Array;
const sizes = new WeakMap<HistoryEntry, number>();
export function historySize(entry: HistoryRecord): number {
  if (entry instanceof Uint8Array) return entry.byteLength;
  let size = sizes.get(entry);
  if (size === undefined) {
    size = JSON.stringify([entry.before, entry.after]).length * 2;
    for (const patch of entry.patches) for (const side of ['before', 'after'] as const) if (patch[side]) size += patch[side]!.values.byteLength + patch[side]!.flags.byteLength;
    sizes.set(entry, size);
  }
  return size;
}
export function encodeHistory(entry: HistoryEntry): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const patches = entry.patches.map((patch, index) => {
    for (const side of ['before', 'after'] as const) {
      const tile = patch[side]; if (!tile) continue;
      files[`${index}-${side}.values`] = new Uint8Array(tile.values.buffer, tile.values.byteOffset, tile.values.byteLength);
      files[`${index}-${side}.flags`] = tile.flags;
    }
    return { key: patch.key, before: Boolean(patch.before), after: Boolean(patch.after) };
  });
  files['entry.json'] = strToU8(JSON.stringify({ before: entry.before, after: entry.after, patches }));
  return zipSync(files, { level: 1 });
}
export function decodeHistory(bytes: Uint8Array): HistoryEntry {
  const files = unzipSync(bytes), manifest = JSON.parse(strFromU8(files['entry.json'])) as { before: EditParameters; after: EditParameters; patches: { key: number; before: boolean; after: boolean }[] };
  const patches: MaskPatch[] = manifest.patches.map((patch, index) => {
    const load = (side: 'before' | 'after'): MaskTile | undefined => patch[side] ? { values: new Float32Array(files[`${index}-${side}.values`].slice().buffer), flags: files[`${index}-${side}.flags`] } : undefined;
    return { key: patch.key, before: load('before'), after: load('after') };
  });
  return { before: manifest.before, after: manifest.after, patches };
}
