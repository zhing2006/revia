<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Scene, OrthographicCamera, Mesh, PlaneGeometry, MeshBasicMaterial, DataTexture, RGBAFormat, UnsignedByteType, SRGBColorSpace, NearestFilter, NoToneMapping } from 'three/webgpu';
  import { WebGPURenderer } from 'three/webgpu';
  import type { Brush, Point, Preview, Rect } from './core/types';

  let { preview, comparison, comparisonLabels, dimensions, brush, editable, onstroke, onpreview, oncancel, onzoom, onview, onbackend, onerror } : {
    preview?: Preview;
    comparison?: Preview;
    comparisonLabels: { result: string; target: string; position: string };
    dimensions: { width: number; height: number };
    brush: Brush;
    editable: boolean;
    onstroke: (points: Point[]) => void;
    onpreview: (points: Point[]) => void;
    oncancel: () => void;
    onzoom: (zoom: number) => void;
    onview: (view: { region: Rect; maxEdge: number }) => void;
    onbackend: (backend: string) => void;
    onerror: (message: string) => void;
  } = $props();
  let host: HTMLDivElement;
  let renderer: WebGPURenderer | undefined;
  const scene = new Scene(), camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100), material = new MeshBasicMaterial({ transparent: true, toneMapped: false });
  const mesh = new Mesh(new PlaneGeometry(1, 1), material); scene.add(mesh); camera.position.z = 10;
  const targetScene = new Scene(), targetMaterial = new MeshBasicMaterial({ transparent: true, toneMapped: false, depthTest: false });
  const targetMesh = new Mesh(mesh.geometry, targetMaterial); targetScene.add(targetMesh);
  let zoom = $state(1), panX = $state(0), panY = $state(0), width = $state(1), height = $state(1), cursor = $state<Point | null>(null), drawing = $state<Point[]>([]), space = false;
  let splitPosition = $state(0.5);
  let targetTexture: DataTexture | undefined;
  let lastDimensions = '', previousTexture: DataTexture | undefined, mounted = false, disposed = false;
  let gesture: { x: number; y: number; panX: number; panY: number } | undefined;
  let start: Point | undefined;
  const touches = new Map<number, Point>();
  let pinch: { distance: number; midpoint: Point; zoom: number; panX: number; panY: number } | undefined;
  const left = $derived(width / 2 + panX - dimensions.width * zoom / 2), top = $derived(height / 2 + panY - dimensions.height * zoom / 2);

  function render() {
    if (!renderer || !mounted) return;
    camera.left = -width / 2; camera.right = width / 2; camera.top = height / 2; camera.bottom = -height / 2; camera.updateProjectionMatrix();
    const region = preview?.region ?? { x: 0, y: 0, ...dimensions };
    mesh.scale.set(region.width * zoom, region.height * zoom, 1); mesh.position.set(panX + (region.x + region.width / 2 - dimensions.width / 2) * zoom, -panY - (region.y + region.height / 2 - dimensions.height / 2) * zoom, 0);
    renderer.setScissorTest(false); renderer.clear();
    if (comparison && targetTexture) {
      targetMesh.scale.copy(mesh.scale); targetMesh.position.copy(mesh.position);
      const boundary = Math.round(width * splitPosition);
      renderer.setScissorTest(true);
      renderer.setScissor(0, 0, boundary, height);
      if (boundary > 0) renderer.render(scene, camera);
      renderer.setScissor(boundary, 0, width - boundary, height);
      if (boundary < width) renderer.render(targetScene, camera);
      renderer.setScissorTest(false);
    } else renderer.render(scene, camera);
  }
  function notifyView() {
    const x = Math.max(0, Math.floor(-left / zoom) - 24), y = Math.max(0, Math.floor(-top / zoom) - 24);
    const right = Math.min(dimensions.width, Math.ceil((width - left) / zoom) + 24), bottom = Math.min(dimensions.height, Math.ceil((height - top) / zoom) + 24);
    if (right <= x || bottom <= y) return;
    const region = { x, y, width: right - x, height: bottom - y };
    onview({ region, maxEdge: Math.ceil(Math.max(region.width, region.height) * Math.min(1, zoom * Math.min(devicePixelRatio, 2))) });
  }
  export function fit() { if (width <= 72 || height <= 72) return; lastDimensions = `${dimensions.width}x${dimensions.height}`; zoom = Math.min((width - 72) / dimensions.width, (height - 72) / dimensions.height); panX = panY = 0; onzoom(zoom); render(); notifyView(); }
  export function changeZoom(factor: number) { zoomAt(width / 2, height / 2, factor); }
  function zoomAt(x: number, y: number, factor: number) {
    const old = zoom; zoom = Math.max(0.01, Math.min(64, zoom * factor));
    panX = x - width / 2 - (x - width / 2 - panX) * zoom / old; panY = y - height / 2 - (y - height / 2 - panY) * zoom / old;
    onzoom(zoom); render(); notifyView();
  }
  const position = (event: PointerEvent) => { const rect = host.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  const imagePosition = (point: Point, event?: PointerEvent): Point => ({ x: (point.x - left) / zoom, y: (point.y - top) / zoom, pressure: event?.pointerType === 'pen' ? event.pressure : 1 });
  function down(event: PointerEvent) {
    const p = position(event); host.setPointerCapture(event.pointerId);
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, p);
      if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch = { distance: Math.hypot(b.x - a.x, b.y - a.y), midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, zoom, panX, panY }; drawing = []; oncancel(); start = undefined; return; }
    }
    if (space || event.button === 1 || event.button === 2 || (comparison && event.button === 0)) { gesture = { x: p.x, y: p.y, panX, panY }; return; }
    if (event.button !== 0) return;
    if (!editable) return;
    start = imagePosition(p, event);
    drawing = [start]; onpreview(drawing);
  }
  function move(event: PointerEvent) {
    const p = position(event); cursor = p;
    if (touches.has(event.pointerId)) touches.set(event.pointerId, p);
    if (pinch && touches.size === 2) {
      const [a, b] = [...touches.values()], mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      zoom = Math.max(0.01, Math.min(64, pinch.zoom * Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, pinch.distance)));
      panX = mx - width / 2 - (pinch.midpoint.x - width / 2 - pinch.panX) * zoom / pinch.zoom;
      panY = my - height / 2 - (pinch.midpoint.y - height / 2 - pinch.panY) * zoom / pinch.zoom; onzoom(zoom); render(); notifyView(); return;
    }
    if (gesture) { panX = gesture.panX + p.x - gesture.x; panY = gesture.panY + p.y - gesture.y; render(); notifyView(); return; }
    if (!start) return;
    const events = event.getCoalescedEvents?.() ?? [];
    drawing = [...drawing, ...(events.length ? events : [event]).map(e => imagePosition(position(e), e))]; onpreview(drawing);
  }
  function up(event: PointerEvent) {
    touches.delete(event.pointerId);
    if (pinch) { if (!touches.size) pinch = undefined; return; }
    if (drawing.length) {
      const points = drawing; drawing = [];
      onstroke(points);
    }
    gesture = undefined; start = undefined;
  }
  function moveDivider(event: PointerEvent) {
    event.stopPropagation();
    if (!(event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId)) return;
    splitPosition = Math.max(0, Math.min(1, (event.clientX - host.getBoundingClientRect().left) / width));
    render();
  }
  function dividerKey(event: KeyboardEvent) {
    const step = event.shiftKey ? 0.1 : 0.01;
    if (event.key === 'ArrowLeft') splitPosition = Math.max(0, splitPosition - step);
    else if (event.key === 'ArrowRight') splitPosition = Math.min(1, splitPosition + step);
    else if (event.key === 'Home') splitPosition = 0;
    else if (event.key === 'End') splitPosition = 1;
    else return;
    event.preventDefault(); event.stopPropagation(); render();
  }
  function wheel(event: WheelEvent) {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey || event.altKey) { const rect = host.getBoundingClientRect(); zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.004)); }
    else { panX -= event.deltaX; panY -= event.deltaY; render(); notifyView(); }
  }
  onMount(() => {
    const observer = new ResizeObserver(() => { width = host.clientWidth; height = host.clientHeight; renderer?.setSize(width, height); if (lastDimensions !== `${dimensions.width}x${dimensions.height}`) fit(); else { render(); notifyView(); } }); observer.observe(host);
    const keydown = (event: KeyboardEvent) => { if (event.code === 'Space' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) { space = true; event.preventDefault(); } };
    const blur = () => { space = false; };
    window.addEventListener('blur', blur);
    const keyup = (event: KeyboardEvent) => { if (event.code === 'Space') space = false; };
    window.addEventListener('keydown', keydown); window.addEventListener('keyup', keyup);
    void (async () => {

      const instance = new WebGPURenderer({ alpha: true, antialias: false });
      await instance.init();
      if (disposed) { instance.dispose(); return; }
      renderer = instance; renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(width, height); renderer.setClearColor(0x000000, 0); renderer.toneMapping = NoToneMapping; renderer.autoClear = false; material.depthTest = false;
      host.prepend(renderer.domElement); mounted = true;
      onbackend((renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2');
      fit(); render();
    })().catch(error => onerror(String(error)));
    return () => { disposed = true; observer.disconnect(); window.removeEventListener('blur', blur); window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); previousTexture?.dispose(); targetTexture?.dispose(); mesh.geometry.dispose(); material.dispose(); targetMaterial.dispose(); renderer?.dispose(); };
  });
  $effect(() => {
    targetTexture?.dispose(); targetTexture = undefined;
    if (comparison) {
      targetTexture = new DataTexture(comparison.data, comparison.width, comparison.height, RGBAFormat, UnsignedByteType);
      targetTexture.colorSpace = SRGBColorSpace; targetTexture.magFilter = NearestFilter; targetTexture.flipY = true; targetTexture.needsUpdate = true;
    }
    targetMaterial.map = targetTexture ?? null; targetMaterial.needsUpdate = true;
    untrack(render);
  });
  $effect(() => {
    if (!preview) return;
    if (previousTexture?.image.data === preview.data) previousTexture.needsUpdate = true;
    else {
      const texture = new DataTexture(preview.data, preview.width, preview.height, RGBAFormat, UnsignedByteType);
      texture.colorSpace = SRGBColorSpace; texture.magFilter = NearestFilter; texture.flipY = true; texture.needsUpdate = true;
      material.map = texture; material.needsUpdate = true; previousTexture?.dispose(); previousTexture = texture;
    }
    untrack(() => {
      const key = `${dimensions.width}x${dimensions.height}`;
      if (key !== lastDimensions) fit(); else render();
    });
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="viewport" class:comparing={Boolean(comparison)} bind:this={host} onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={() => { drawing = []; oncancel(); start = undefined; gesture = undefined; touches.clear(); pinch = undefined; }} onpointerleave={() => cursor = null} onwheel={wheel} oncontextmenu={event => event.preventDefault()}>
  <svg class="canvas-overlay" width={width} height={height} aria-hidden="true">
    <defs><pattern id="pixel-grid" width={zoom} height={zoom} patternUnits="userSpaceOnUse" x={left} y={top}><path d={`M ${zoom} 0 L 0 0 0 ${zoom}`} fill="none" stroke="rgba(128,128,128,0.4)" stroke-width="0.5" /></pattern></defs>
    {#if zoom >= 8}<rect x={left} y={top} width={dimensions.width * zoom} height={dimensions.height * zoom} fill="url(#pixel-grid)" />{/if}

    {#if cursor && editable}<circle cx={cursor.x} cy={cursor.y} r={Math.max(2, brush.size * zoom / 2)} fill="none" stroke="white" stroke-width="1" /><circle cx={cursor.x} cy={cursor.y} r={Math.max(1, brush.size * zoom / 2 - 1)} fill="none" stroke="#222" stroke-width="1" />{/if}
  </svg>
  {#if comparison}
    <div class="comparison-labels" aria-hidden="true">{#if splitPosition > 0.08}<span class="comparison-result">{comparisonLabels.result}</span>{/if}{#if splitPosition < 0.92}<span class="comparison-target">{comparisonLabels.target}</span>{/if}</div>
    <div class="compare-divider" role="slider" tabindex="0" aria-label={comparisonLabels.position} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(splitPosition * 100)} aria-orientation="horizontal" style:left={`${splitPosition * 100}%`} onpointerdown={event => { event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus(); moveDivider(event); }} onpointermove={moveDivider} onpointerup={event => { event.stopPropagation(); event.currentTarget.releasePointerCapture(event.pointerId); }} onpointercancel={event => event.stopPropagation()} onkeydown={dividerKey}><span aria-hidden="true">↔</span></div>
  {/if}
</div>
