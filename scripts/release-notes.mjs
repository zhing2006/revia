import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function releaseNotes(tag, version, changelog) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(tag)) {
    throw new Error('Expected a version tag such as v0.1.0 or v0.2.0-beta.1.');
  }
  if (tag !== `v${version}`) throw new Error(`Tag ${tag} does not match package version ${version}.`);
  const text = changelog.replaceAll('\r\n', '\n');
  const sections = [...text.matchAll(/^## \[([^\]]+)\][^\n]*\n/gm)];
  const matches = sections.filter(section => section[1] === version);
  if (matches.length !== 1) throw new Error(`Expected exactly one CHANGELOG section for ${version}.`);
  const section = matches[0], next = sections[sections.indexOf(section) + 1];
  const notes = text.slice(section.index + section[0].length, next?.index)
    .replace(/^\[[^\]]+\]:[^\n]*$/gm, '').trim();
  if (!notes.split('\n').some(line => line.trim() && !/^\s*#/.test(line))) throw new Error(`CHANGELOG section ${version} is empty.`);
  return `${notes}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const [tag = `v${version}`, output] = process.argv.slice(2).filter(argument => argument !== '--');
  const notes = releaseNotes(tag, version, readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'));
  if (output) writeFileSync(resolve(output), notes);
  else process.stdout.write(notes);
}
