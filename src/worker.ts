/// <reference lib="webworker" />
import { Engine } from './core/engine';
import type { ViewMode } from './core/engine';
import { probeImage } from './core/image';
import type { Brush, Point, Rect, Matrix } from './core/types';

export type Command =
  | { type: 'load'; slot: 'original' | 'modified'; bytes: Uint8Array; name: string; frame?: number }
  | { type: 'probe'; bytes: Uint8Array }
  | { type: 'analyze'; matrix?: Matrix; sensitivity?: number }
  | { type: 'preview'; view: ViewMode; maxEdge: number; overlay: boolean; region?: Rect }
  | { type: 'stroke'; strokeId: number; points: Point[]; brush: Brush; view: ViewMode; maxEdge: number; overlay: boolean; region?: Rect }
  | { type: 'previewStroke'; strokeId: number; points: Point[]; brush: Brush; view: ViewMode; maxEdge: number; overlay: boolean; region?: Rect }
  | { type: 'color'; strength: number }
  | { type: 'export'; format: 'png' | 'mask' | 'psd' }
  | { type: 'undo' | 'redo' | 'sources' | 'cancel' | 'cancelStroke' };

const engine = new Engine();
let queue = Promise.resolve(), controller = new AbortController(), running = '';
const readOnly = new Set(['preview', 'previewStroke', 'sources', 'probe', 'export', 'cancelStroke']);
self.onmessage = (event: MessageEvent<Command & { id: number }>) => {
  const command = event.data;
  if (command.type === 'cancel') { controller.abort(); postMessage({ id: command.id, result: true }); return; }
  if (running === 'analyze' && !readOnly.has(command.type)) controller.abort();
  if (running === 'previewStroke' && command.type !== 'previewStroke') controller.abort();
  queue = queue.then(async () => {
    controller = new AbortController(); running = command.type;
    const progress = (value: unknown) => postMessage({ type: 'progress', value });
    try {
      let result: unknown;
      switch (command.type) {
        case 'load': progress({ stage: 'loading' }); await engine.load(command.slot, command.bytes, command.name, command.frame); break;
        case 'probe': result = probeImage(command.bytes); break;
        case 'analyze': await engine.analyze(progress, controller.signal, command.matrix, command.sensitivity); break;
        case 'preview': result = await engine.preview(command.view, command.maxEdge, command.overlay, controller.signal, command.region); break;
        case 'stroke': {
          const dirty = engine.stroke(command.points, command.brush, command.strokeId);
          if (dirty) result = await engine.preview(command.view, command.maxEdge, command.overlay, controller.signal, command.region, engine.mask, dirty);
          break;
        }
        case 'cancelStroke': engine.cancelStroke(); break;
        case 'previewStroke': result = await engine.previewStroke(command.points, command.brush, command.view, command.maxEdge, command.overlay, command.region, controller.signal, command.strokeId); break;
        case 'color': engine.update({ colorStrength: command.strength }); break;
        case 'undo': await engine.undo(); break;
        case 'redo': await engine.redo(); break;
        case 'export': result = await engine.export(command.format, progress, controller.signal); break;
        case 'sources': result = await engine.sources(); break;
      }
      if (!readOnly.has(command.type)) {
        engine.limitHistory();
        postMessage({ type: 'changed', info: engine.info(), command: command.type });
      }
      const imageResult = ['preview', 'previewStroke', 'stroke'].includes(command.type);
      const response = { id: command.id, result: imageResult ? result : result ?? engine.info() };
      if (result instanceof Uint8Array) postMessage(response, [result.buffer]);
      else if (imageResult && result) postMessage(response, [(result as { data: Uint8Array }).data.buffer]);
      else postMessage(response);
    } catch (error) {
      postMessage({ id: command.id, error: error instanceof Error ? error.message : String(error), cancelled: error instanceof DOMException && error.name === 'AbortError' });
    } finally { running = ''; postMessage({ type: 'progress', value: null }); }
  });
};
