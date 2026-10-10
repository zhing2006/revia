import { mount } from 'svelte';
import { dictionaries, systemLocale, translate } from './i18n';
import type { Locale } from './i18n';
import './styles.css';

async function start() {
  const target = document.getElementById('app')!;
  const saved = localStorage.getItem('revia-language');
  const locale: Locale = saved && saved in dictionaries ? saved as Locale : systemLocale([navigator.language]);
  document.documentElement.dataset.theme = localStorage.getItem('revia-theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const splash = document.createElement('div'), title = document.createElement('strong'), label = document.createElement('p'), progress = document.createElement('progress');
  splash.className = 'startup'; title.textContent = 'revia'; label.textContent = translate(locale, 'loadingResources'); progress.max = 1; progress.value = 0;
  splash.append(title, label, progress); target.append(splash);
  if (import.meta.env.PROD) {
    try {
      const manifestUrl = new URL(`${import.meta.env.BASE_URL}offline-manifest.json`, document.baseURI);
      const response = await fetch(manifestUrl);
      const { assets } = await response.json() as { assets: string[] };
      const pending = [...assets]; let complete = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (pending.length) {
          const response = await fetch(new URL(pending.shift()!, manifestUrl), { cache: 'force-cache' });
          if (!response.ok) throw new Error('resourcesFailed');
          await response.arrayBuffer(); progress.value = ++complete / assets.length;
          label.textContent = `${translate(locale, 'loadingResources')} ${complete}/${assets.length}`;
        }
      }));
    } catch { label.textContent = translate(locale, 'resourcesFailed'); }
  }
  const { default: App } = await import('./App.svelte');
  target.replaceChildren(); mount(App, { target });
}
const basePath = import.meta.env.BASE_URL;
if (import.meta.env.PROD && basePath.startsWith('/') && !location.pathname.startsWith(basePath)) {
  location.replace(new URL(basePath, location.href));
} else {
  void start();
}
