<script lang="ts">
  import { onMount } from 'svelte';
  import { Tabs } from 'bits-ui';
  import Viewport from './Viewport.svelte';
  import { EditorClient } from './client';
  import { dictionaries, localeNames, systemLocale, translate } from './i18n';
  import type { Locale } from './i18n';
  import type { EditorInfo, ViewMode } from './core/engine';
  import type { Brush, Point, Preview, Progress, Rect, Matrix } from './core/types';
  import type { ImageProbe } from './core/image';
  import type { Command } from './worker';

  const client = new EditorClient();
  const savedLocale = localStorage.getItem('revia-language');
  let manualLocale = $state(Boolean(savedLocale && savedLocale in dictionaries));
  let locale = $state<Locale>(savedLocale && savedLocale in dictionaries ? savedLocale as Locale : systemLocale([navigator.language]));
  let theme = $state(localStorage.getItem('revia-theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const t = (key: string) => translate(locale, key);
  let info = $state<EditorInfo>();
  let sources = $state<Partial<Record<'original' | 'modified', { name: string; width: number; height: number; url: string }>>>({});
  let preview = $state<Preview>(), comparison = $state<Preview>(), splitEnabled = $state(false), viewport = $state<Viewport>();
  let view = $state<ViewMode>('result'), overlay = $state(false), comparing = $state(false), zoom = $state(1), backend = $state('');
  let progress = $state<Progress | null>(null), pendingTasks = $state(0), error = $state('');
  let offline = $state(false), offlineFraction = $state(0), help = $state(false);
  let brush = $state<Brush>({ mode: 'add', size: 64, hardness: 0.7, opacity: 1, pressure: true });
  let format = $state<'png' | 'mask' | 'psd'>('png');
  let fileInput: HTMLInputElement, activeSlot: 'original' | 'modified' = 'original';
  let frameChoice = $state<{ bytes: Uint8Array; name: string; slot: 'original' | 'modified'; frames: number }>();
  let chosenFrame = $state(1);
  let viewRequest: { region: Rect; maxEdge: number } | undefined, previewTimer: ReturnType<typeof setTimeout>;
  let previewVersion = 0, loadVersion = 0, strokeSequence = 0;
  let liveStroke: { id: number; brush: Brush; points: Point[]; running: boolean } | undefined;
  const hasPair = $derived(Boolean(info?.modified));
  const busy = $derived(pendingTasks > 0);
  const editable = $derived(hasPair && !busy && !comparing && !splitEnabled && (view === 'result' || view === 'mask'));

  $effect(() => { document.documentElement.lang = locale; if (manualLocale) localStorage.setItem('revia-language', locale); window.reviaDesktop?.setLocale(locale); });
  $effect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('revia-theme', theme); });
  $effect(() => { if (format === 'psd' && !info?.psdSupported) format = 'png'; });

  async function request<T>(command: Command): Promise<T | undefined> {
    try { return await client.request<T>($state.snapshot(command) as Command); }
    catch (failure) { const message = failure instanceof Error ? failure.message : String(failure); if (message !== 'cancelled') error = message; }
  }
  async function task(action: () => Promise<unknown>) {
    pendingTasks++; error = '';
    try { await action(); } finally { pendingTasks--; }
  }
  async function renderPreview() {
    if (!info) return;
    const version = ++previewVersion;
    const settings = viewRequest ?? { maxEdge: 1600 };
    const [result, target] = await Promise.all([
      request<Preview>({ type: 'preview', view: comparing ? 'original' : view, overlay: !comparing && !splitEnabled && view === 'result' && overlay, ...settings }),
      splitEnabled && !comparing && view === 'result' ? request<Preview>({ type: 'preview', view: 'modified', overlay: false, ...settings }) : Promise.resolve(undefined),
    ]);
    if (version === previewVersion && result) { preview = result; comparison = target; }
  }
  function changeView(next: { region: Rect; maxEdge: number }) {
    if (JSON.stringify(next) === JSON.stringify(viewRequest)) return;
    viewRequest = next; clearTimeout(previewTimer); previewTimer = setTimeout(() => void renderPreview(), 60);
  }
  async function refreshSources() {
    const result = await request<{ slot: 'original' | 'modified'; name: string; width: number; height: number; bytes: Uint8Array }[]>({ type: 'sources' });
    if (!result) return;
    for (const source of Object.values(sources)) if (source) URL.revokeObjectURL(source.url);
    sources = Object.fromEntries(result.map(source => [source.slot, { ...source, url: URL.createObjectURL(new Blob([source.bytes.slice().buffer], { type: 'image/png' })) }]));
  }
  async function analyze(matrix?: Matrix, sensitivity?: number) { await task(async () => { await request({ type: 'analyze', matrix, sensitivity }); await renderPreview(); }); }
  function alignValue(key: 'x' | 'y' | 'rotation' | 'scale', value: number) {
    if (!info || !Number.isFinite(value)) return;
    const matrix = [...info.settings.matrix] as Matrix;
    if (key === 'x') matrix[4] = value;
    else if (key === 'y') matrix[5] = value;
    else {
      const angle = key === 'rotation' ? value * Math.PI / 180 : Math.atan2(matrix[1], matrix[0]);
      const scale = key === 'scale' ? value / 100 : Math.hypot(matrix[0], matrix[1]);
      if (scale <= 0) return;
      matrix[0] = matrix[3] = scale * Math.cos(angle); matrix[1] = scale * Math.sin(angle); matrix[2] = -matrix[1];
    }
    void analyze(matrix);
  }
  async function loadBytes(bytes: Uint8Array, name: string, slot: 'original' | 'modified', frame?: number) {
    const version = ++loadVersion;
    await task(async () => {
      const loaded = await request<EditorInfo>({ type: 'load', slot, bytes, name, frame });
      if (loaded?.modified && version === loadVersion) await request({ type: 'analyze' });
      if (version === loadVersion) await renderPreview();
    });
  }
  async function loadFile(file: File, slot: 'original' | 'modified') {
    error = '';
    const bytes = new Uint8Array(await file.arrayBuffer()), probe = await request<ImageProbe>({ type: 'probe', bytes });
    if (!probe) return;
    if (probe.frames > 1) { frameChoice = { bytes, name: file.name, slot, frames: probe.frames }; chosenFrame = 1; return; }
    await loadBytes(bytes, file.name, slot);
  }
  function chooseImage(slot: 'original' | 'modified') { activeSlot = slot; fileInput.click(); }
  async function drop(event: DragEvent, slot?: 'original' | 'modified') {
    event.preventDefault(); event.stopPropagation();
    const files = [...event.dataTransfer?.files ?? []].filter(file => /^image\//.test(file.type));
    if (files.length >= 2 && !slot) { await loadFile(files[0], 'original'); await loadFile(files[1], 'modified'); }
    else if (files[0]) await loadFile(files[0], slot ?? (info ? 'modified' : 'original'));
  }
  function strokeSettings() {
    return { view, overlay: view === 'result' && overlay, ...(viewRequest ?? { maxEdge: 1600 }) };
  }
  function applyPatch(result: Preview | undefined, version: number) {
    if (!result?.update || !preview || version !== previewVersion || result.width !== preview.width || result.height !== preview.height || JSON.stringify(result.region) !== JSON.stringify(preview.region)) return;
    const { x, y, width, height } = result.update;
    for (let row = 0; row < height; row++) preview.data.set(result.data.subarray(row * width * 4, (row + 1) * width * 4), ((y + row) * preview.width + x) * 4);
    preview = { ...preview, update: result.update };
  }
  async function stroke(points: Point[]) {
    const current = liveStroke;
    liveStroke = undefined;
    if (!current) return;
    const version = previewVersion;
    const result = await request<Preview>({ type: 'stroke', strokeId: current.id, points, brush: current.brush, ...strokeSettings() });
    applyPatch(result, version);
  }
  async function previewStroke(points: Point[]) {
    if (!editable) return;
    const current = liveStroke ??= { id: ++strokeSequence, brush: $state.snapshot(brush), points, running: false };
    current.points = points;
    if (current.running) return;
    current.running = true;
    while (liveStroke === current) {
      const sent = current.points, version = previewVersion;
      const result = await request<Preview>({ type: 'previewStroke', strokeId: current.id, points: sent, brush: current.brush, ...strokeSettings() });
      applyPatch(result, version);
      if (sent === current.points) break;
    }
    current.running = false;
  }
  async function cancelStroke() {
    liveStroke = undefined;
    await request({ type: 'cancelStroke' });
    await renderPreview();
  }
  function toggleSplit() {
    splitEnabled = !splitEnabled; view = 'result';
    if (!splitEnabled) comparison = undefined;
    void renderPreview();
  }
  function selectBrush(mode: Brush['mode']) {
    brush.mode = mode;
    if (splitEnabled || (view !== 'result' && view !== 'mask')) {
      splitEnabled = false; comparison = undefined; view = 'result'; void renderPreview();
    }
  }
  function compare(value: boolean) { comparing = value; void renderPreview(); }
  async function download() {
    await task(async () => {
      const data = await request<Uint8Array>({ type: 'export', format }); if (!data) return;
      const url = URL.createObjectURL(new Blob([data.slice().buffer], { type: format === 'psd' ? 'application/octet-stream' : 'image/png' }));
      const anchor = document.createElement('a'); anchor.href = url;
      anchor.download = `${info!.original.replace(/\.[^.]+$/, '')}-${t(format === 'mask' ? 'mask' : 'result')}.${format === 'psd' ? 'psd' : 'png'}`;
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
  }
  function handleKey(event: KeyboardEvent) {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) return;
    const modifier = event.metaKey || event.ctrlKey, key = event.key.toLowerCase();
    if (modifier && key === 'z') { event.preventDefault(); if (!busy) void request({ type: event.shiftKey ? 'redo' : 'undo' }); }
    else if (modifier && key === 's') { event.preventDefault(); if (hasPair && !busy) void download(); }
    else if (modifier && key === 'o') { event.preventDefault(); chooseImage('original'); }
    else if (!modifier) {
      if (key === 'x') selectBrush(brush.mode === 'add' ? 'erase' : 'add');
      if (key === 'b') selectBrush('add');
      if (key === 'e') selectBrush('erase');
      if (key === '[') brush.size = Math.max(1, Math.round(brush.size / 1.2));
      if (key === ']') brush.size = Math.min(2048, Math.round(brush.size * 1.2));
      if (key === 'f') viewport?.fit();
      if (key === '1' && !comparing) compare(true);
      if (key === 'escape') help = false;
    }
  }
  function openModal(node: HTMLDialogElement) { node.showModal(); return { destroy: () => node.close() }; }
  onMount(() => {
    indexedDB.deleteDatabase('revia');
    client.onEvent = event => {
      if (event.type === 'progress') progress = event.value as Progress | null;
      if (event.type === 'changed') {
        const next = event.info as EditorInfo;
        if (info?.width !== next?.width || info?.height !== next?.height) viewRequest = undefined;
        info = next; if (event.command !== 'stroke') void renderPreview();
        if (event.command === 'load') void refreshSources();
      }
    };
    if (window.reviaDesktop) offline = true;
    const offlineMessage = (event: MessageEvent) => {
      if (event.data.type === 'offline-progress') offlineFraction = event.data.fraction;
      if (event.data.type === 'offline-ready') offline = true;
      if (event.data.type === 'offline-error') error = 'resourcesFailed';
    };
    if (import.meta.env.PROD && !window.reviaDesktop && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', offlineMessage);
      void navigator.serviceWorker.register('./sw.js').then(async registration => {
        const active = registration.active ?? (await navigator.serviceWorker.ready).active;
        active?.postMessage({ type: 'status' });
      }).catch(() => { error = 'resourcesFailed'; });
    }
    const paste = (event: ClipboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement).tagName)) return;
      const files = [...event.clipboardData?.files ?? []].filter(file => file.type.startsWith('image/'));
      if (files.length) { event.preventDefault(); void (async () => { for (let i = 0; i < Math.min(files.length, 2); i++) await loadFile(files[i], files.length >= 2 ? i === 0 ? 'original' : 'modified' : info ? 'modified' : 'original'); })(); }
    };
    const keyup = (event: KeyboardEvent) => { if (event.key === '1') compare(false); };
    const blur = () => { if (comparing) compare(false); };
    const languageChange = () => { if (!manualLocale) locale = systemLocale([navigator.language]); };
    window.addEventListener('blur', blur); window.addEventListener('languagechange', languageChange);
    window.addEventListener('keydown', handleKey); window.addEventListener('keyup', keyup); window.addEventListener('paste', paste);
    return () => {
      clearTimeout(previewTimer); client.dispose();
      for (const source of Object.values(sources)) if (source) URL.revokeObjectURL(source.url);
      navigator.serviceWorker?.removeEventListener('message', offlineMessage);
      window.removeEventListener('blur', blur); window.removeEventListener('languagechange', languageChange);
      window.removeEventListener('keydown', handleKey); window.removeEventListener('keyup', keyup); window.removeEventListener('paste', paste);
    };
  });
</script>

<svelte:head><title>Revia</title></svelte:head>
<input class="visually-hidden" bind:this={fileInput} type="file" accept="image/png,image/jpeg,image/webp" onchange={event => { const file = event.currentTarget.files?.[0]; if (file) void loadFile(file, activeSlot); event.currentTarget.value = ''; }} />
<div class="app-shell">
  <header class="app-header">
    <a class="brand" href="./" aria-label="Revia"><svg width="26" height="30" viewBox="0 0 26 30" aria-hidden="true"><path d="M3 3h12c10 0 10 15 0 15H3z" fill="none" stroke="currentColor" stroke-width="3"/><path d="M3 17v10m10-10 10 10" stroke="currentColor" stroke-width="3"/></svg><span>revia</span></a>
    <span class="tagline">{t('tagline')}</span>
    <div class="header-actions">
      <select class="language" aria-label={t('language')} value={manualLocale ? locale : 'system'} onchange={event => { manualLocale = event.currentTarget.value !== 'system'; if (manualLocale) locale = event.currentTarget.value as Locale; else { localStorage.removeItem('revia-language'); locale = systemLocale([navigator.language]); } }}><option value="system">{t('system')}</option>{#each Object.entries(localeNames) as [value, label]}<option {value}>{label}</option>{/each}</select>
      <button class="icon-button theme-toggle" aria-label={t('theme')} title={t(theme === 'dark' ? 'light' : 'dark')} onclick={() => theme = theme === 'light' ? 'dark' : 'light'}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{#if theme === 'dark'}<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4"/>{:else}<path d="M20.5 13.3A8.5 8.5 0 0 1 10.7 3.5a8.5 8.5 0 1 0 9.8 9.8Z"/>{/if}</svg></button>
      <div class="export-group"><select aria-label={t('exportFormat')} bind:value={format}><option value="png">PNG</option><option value="mask">{t('maskPng')}</option><option value="psd" disabled={!info?.psdSupported}>PSD</option></select><button class="primary" disabled={!hasPair || busy} onclick={download}>{t('export')} <span aria-hidden="true">↗</span></button></div>
    </div>
  </header>
  <main class="workspace">
    <section class="canvas-area" aria-label={t('result')}>
      <div class="canvas-toolbar">
        <Tabs.Root value={view} onValueChange={value => { view = value as ViewMode; splitEnabled = false; comparison = undefined; void renderPreview(); }}><Tabs.List class="view-tabs" aria-label={t('view')}>{#each ['result', 'mask', 'original', 'modified'] as mode}<Tabs.Trigger value={mode}>{t(mode)}</Tabs.Trigger>{/each}</Tabs.List></Tabs.Root>
        <div class="history"><button class="icon-button" title={t('undo')} aria-label={t('undo')} disabled={!info?.canUndo || busy} onclick={() => request({ type: 'undo' })}>↶</button><button class="icon-button" title={t('redo')} aria-label={t('redo')} disabled={!info?.canRedo || busy} onclick={() => request({ type: 'redo' })}>↷</button></div>
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="canvas-stage" ondragover={event => event.preventDefault()} ondrop={event => drop(event)}>
        {#if info}<Viewport bind:this={viewport} {preview} {comparison} comparisonLabels={{ result: t('result'), target: t('modified'), position: t('splitPosition') }} dimensions={{ width: info.width, height: info.height }} {brush} {editable} onstroke={stroke} onpreview={previewStroke} oncancel={cancelStroke} onzoom={value => zoom = value} onview={changeView} onbackend={value => backend = value} onerror={value => error = value}/>
        {:else}<div class="empty-state"><div class="empty-art" aria-hidden="true"><span class="art-back"></span><span class="art-front"><svg viewBox="0 0 100 90" fill="none"><path d="M17 65 40 32l17 22 11-15 17 26" stroke="currentColor" stroke-width="2"/><circle cx="70" cy="23" r="7" stroke="currentColor" stroke-width="2"/></svg></span><span class="art-spark">✧</span></div><span class="eyebrow">{t('studio')}</span><h1>{t('emptyTitle')}</h1><p>{t('emptyBody')}</p><button class="primary large" onclick={() => chooseImage('original')}>{t('addOriginal')} <span aria-hidden="true">＋</span></button><small>{t('dropPair')}</small></div>{/if}
        {#if busy}<div class="processing" role="status"><span>{t(progress?.stage ?? 'preparing')}</span>{#if progress?.fraction !== undefined}<span>{Math.round(progress.fraction * 100)}%</span>{/if}<progress max="1" value={progress?.fraction}></progress><button class="quiet" onclick={() => request({ type: 'cancel' })}>{t('cancel')}</button></div>{/if}
      </div>
      <div class="canvas-footer"><div class="view-actions"><button class="quiet" aria-pressed={splitEnabled} disabled={!hasPair || busy} onclick={toggleSplit}>{t('splitCompare')}</button><button class="quiet" aria-pressed={overlay} disabled={!info || splitEnabled || view !== 'result'} onclick={() => { overlay = !overlay; void renderPreview(); }}>{t('overlay')}</button><button class="quiet" disabled={!info} onpointerdown={event => { event.currentTarget.setPointerCapture(event.pointerId); compare(true); }} onpointerup={() => compare(false)} onpointercancel={() => compare(false)} onkeydown={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); compare(true); } }} onkeyup={() => compare(false)} onblur={() => compare(false)}>{t('compare')}</button></div><div class="zoom-control"><button class="icon-button" aria-label={t('zoomOut')} disabled={!info} onclick={() => viewport?.changeZoom(0.8)}>−</button><span>{info ? `${Math.round(zoom * 100)}%` : '—'}</span><button class="icon-button" aria-label={t('zoomIn')} disabled={!info} onclick={() => viewport?.changeZoom(1.25)}>+</button><button class="quiet" disabled={!info} onclick={() => viewport?.fit()}>{t('fit')}</button></div></div>
    </section>
    <aside class="sidebar">
      <section class="inputs"><div class="section-heading"><h2>{t('images')}</h2><span>01</span></div><p class="helper">{t('imagesHint')}</p>
        {#each ['original', 'modified'] as slot}<div class="source-wrap"><span class="field-label">{t(slot)}</span><!-- svelte-ignore a11y_no_static_element_interactions --><div class="source-card" class:populated={Boolean(sources[slot as 'original' | 'modified'])} ondragover={event => event.preventDefault()} ondrop={event => drop(event, slot as 'original' | 'modified')}><button aria-label={t(slot === 'original' ? 'addOriginal' : 'addModified')} onclick={() => chooseImage(slot as 'original' | 'modified')}>{#if sources[slot as 'original' | 'modified']}<img src={sources[slot as 'original' | 'modified']!.url} alt={t(slot)}/><span><strong>{sources[slot as 'original' | 'modified']!.name}</strong><small>{sources[slot as 'original' | 'modified']!.width} × {sources[slot as 'original' | 'modified']!.height}</small></span>{:else}<span class="source-plus" aria-hidden="true">＋</span><span><strong>{t(slot === 'original' ? 'addOriginal' : 'addModified')}</strong><small>{t('importHint')}</small></span>{/if}</button></div></div>{/each}
        <div class="automatic-status"><span class:complete={info?.analyzed} aria-hidden="true">{info?.analyzed ? '✓' : '✧'}</span><p>{t(info?.analyzed ? !info.alignmentReliable ? 'alignmentUncertain' : info.hasChanges ? 'automaticReady' : 'noChanges' : 'automaticHint')}</p></div>
      </section>
      <section class="brush-panel"><div class="section-heading"><h2>{t('refineMask')}</h2><span>02</span></div><p class="helper">{t('brushHint')}</p><div class="brush-switch"><button class:active={brush.mode === 'add'} aria-pressed={brush.mode === 'add'} disabled={!hasPair} onclick={() => selectBrush('add')}><span aria-hidden="true">＋</span>{t('addBrush')}</button><button class:active={brush.mode === 'erase'} aria-pressed={brush.mode === 'erase'} disabled={!hasPair} onclick={() => selectBrush('erase')}><span aria-hidden="true">−</span>{t('eraseBrush')}</button></div><label class="slider-label" for="brush-size">{t('size')}<span>{brush.size} px</span></label><input id="brush-size" type="range" min="1" max="512" step="1" bind:value={brush.size} disabled={!hasPair}/><label class="slider-label" for="brush-softness">{t('softness')}<span>{Math.round((1 - brush.hardness) * 100)}%</span></label><input id="brush-softness" type="range" min="0" max="1" step="0.01" value={1 - brush.hardness} oninput={event => brush.hardness = 1 - +event.currentTarget.value} disabled={!hasPair}/>
      </section>
      <details class="adjustments"><summary>{t('advanced')}<span aria-hidden="true">＋</span></summary><p class="helper">{t('advancedHint')}</p><h3>{t('positionAlignment')}</h3><div class="alignment-grid">{#each ['x', 'y', 'rotation', 'scale'] as key}<label>{t(key)}<input type="number" step={key === 'x' || key === 'y' ? '0.1' : '0.01'} disabled={!hasPair || busy} value={+(key === 'x' ? info?.settings.matrix[4] ?? 0 : key === 'y' ? info?.settings.matrix[5] ?? 0 : key === 'rotation' ? Math.atan2(info?.settings.matrix[1] ?? 0, info?.settings.matrix[0] ?? 1) * 180 / Math.PI : Math.hypot(info?.settings.matrix[0] ?? 1, info?.settings.matrix[1] ?? 0) * 100).toFixed(2)} onchange={event => alignValue(key as 'x' | 'y' | 'rotation' | 'scale', +event.currentTarget.value)}/></label>{/each}</div><button class="secondary full" disabled={!hasPair || busy} onclick={() => analyze()}>{t('realign')}</button><label class="slider-label" for="color-strength">{t('colorMatch')}<span>{Math.round((info?.settings.colorStrength ?? 1) * 100)}%</span></label><input id="color-strength" type="range" min="0" max="1" step="0.01" value={info?.settings.colorStrength ?? 1} disabled={!hasPair || busy} onchange={event => request({ type: 'color', strength: +event.currentTarget.value })}/><label class="slider-label" for="sensitivity">{t('sensitivity')}<span>{(info?.settings.sensitivity ?? 1).toFixed(1)}×</span></label><input id="sensitivity" type="range" min="0.5" max="1.6" step="0.1" value={info?.settings.sensitivity ?? 1} disabled={!hasPair || busy} onchange={event => analyze(info?.settings.matrix, +event.currentTarget.value)}/><p class="helper">{t('sensitivityHint')}</p></details>
      <p class="privacy-note">{t('private')}</p>
    </aside>
  </main>
  <footer class="statusbar"><span class="status-dot"></span><span>{t(busy ? 'working' : 'ready')}</span><span class="status-spacer"></span>{#if import.meta.env.PROD}<span>{offline ? t('offline') : `${t('preparingOffline')} ${Math.round(offlineFraction * 100)}%`}</span>{/if}<span class="backend">{backend}</span><button class="quiet" onclick={() => help = !help}>? <span>{t('help')}</span></button></footer>
</div>
{#if error}<div class="error-toast" role="alert"><span>{t(error)}</span><button class="quiet" aria-label={t('dismiss')} onclick={() => error = ''}>×</button></div>{/if}
{#if help}<div class="shortcut-popover"><strong>{t('help')}</strong><p>{t('shortcutHelp')}</p></div>{/if}
{#if frameChoice}<dialog use:openModal class="modal" aria-label={t('chooseFrame')} oncancel={() => frameChoice = undefined}><h2>{t('chooseFrame')}</h2><p>{frameChoice.name}</p><label>{t('frame')}<input type="number" min="1" max={frameChoice.frames} bind:value={chosenFrame}/></label><div class="modal-actions"><button class="quiet" onclick={() => frameChoice = undefined}>{t('cancel')}</button><button class="primary" disabled={chosenFrame < 1 || chosenFrame > frameChoice.frames} onclick={async () => { const image = frameChoice!; frameChoice = undefined; await loadBytes(image.bytes, image.name, image.slot, chosenFrame - 1); }}>{t('continue')}</button></div></dialog>{/if}
