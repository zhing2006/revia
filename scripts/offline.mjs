import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { writeLicenses } from './licenses.mjs';
import { dictionaries } from '../src/i18n/index.ts';

async function walk(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await walk(child)); else if (!['sw.js', 'offline-manifest.json'].includes(entry.name)) files.push(child);
  }
  return files;
}
await writeLicenses();
await copyFile('LICENSE', 'dist/LICENSE');
await writeFile('dist/i18n.json', JSON.stringify(dictionaries));
const files = await walk('dist'), hash = createHash('sha256');
for (const path of files) hash.update(await readFile(path));
const version = hash.digest('hex').slice(0, 16), assets = files.map(path => './' + relative('dist', path).replaceAll('\\', '/'));
await writeFile('dist/offline-manifest.json', JSON.stringify({ version, assets }));
await writeFile('dist/sw.js', `const CACHE = 'revia-${version}';
const ASSETS = ${JSON.stringify([...assets, './offline-manifest.json'])};
async function notify(message) { for (const client of await self.clients.matchAll({includeUncontrolled:true})) client.postMessage(message); }
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE); let finished = 0;
  try {
    const pending = [...ASSETS];
    await Promise.all(Array.from({length:4}, async () => { while(pending.length) { const asset = pending.shift(); await cache.add(asset); await notify({type:'offline-progress',fraction:++finished/ASSETS.length}); } }));
    await self.skipWaiting();
  } catch(error) { await caches.delete(CACHE); await notify({type:'offline-error'}); throw error; }
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if(name.startsWith('revia-') && name !== CACHE) await caches.delete(name);
  await self.clients.claim(); await notify({type:'offline-ready'});
})()));
self.addEventListener('message', event => { if(event.data.type === 'status') event.source?.postMessage({type:'offline-ready'}); });
self.addEventListener('fetch', event => {
  if(event.request.method !== 'GET' || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith((async () => { const cache = await caches.open(CACHE); const response = await cache.match(event.request); if(response) return response; if(event.request.mode === 'navigate') return await cache.match('./index.html'); return fetch(event.request); })());
});
`);
console.log(`Prepared ${assets.length} offline resources (${version}).`);
