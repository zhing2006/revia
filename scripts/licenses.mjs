import { readFile, readdir, writeFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const runtimePackages = ['@jsquash/webp', 'ag-psd', 'bits-ui', 'exifr', 'fast-png', 'fflate', 'jpeg-js', 'lcms-wasm', 'svelte', 'three'];
const seen = new Set(), notices = [];
async function collect(name, require) {
  let location;
  for (const path of require.resolve.paths(name) ?? []) {
    try { location = await realpath(join(path, name, 'package.json')); break; } catch {}
  }
  if (!location) throw new Error(`Cannot find license metadata for ${name}`);
  const metadata = JSON.parse(await readFile(location, 'utf8')), key = `${metadata.name}@${metadata.version}`;
  if (seen.has(key)) return;
  seen.add(key);
  const folder = dirname(location), files = (await readdir(folder)).filter(file => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file));
  const texts = await Promise.all(files.map(file => readFile(join(folder, file), 'utf8')));
  notices.push(`${key}\nLicense: ${metadata.license ?? 'See package license'}\n${texts.join('\n\n') || metadata.repository?.url || ''}`);
  const localRequire = createRequire(location);
  for (const dependency of Object.keys(metadata.dependencies ?? {})) await collect(dependency, localRequire);
}
export async function writeLicenses() {
  for (const name of runtimePackages) await collect(name, createRequire(import.meta.url));
  await writeFile('dist/THIRD_PARTY_LICENSES.txt', notices.join('\n\n' + '='.repeat(72) + '\n\n'));
}
