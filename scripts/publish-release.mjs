import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseNotes } from './release-notes.mjs';

const runGh = arguments_ => execFileSync('gh', arguments_, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

export function publishRelease({ tag, version, changelog, directory, repository, gh = runGh }) {
  const body = releaseNotes(tag, version, changelog);
  if (!repository) throw new Error('GITHUB_REPOSITORY is required.');
  const filename = `revia-${version}-windows-x64.zip`;
  const packages = readdirSync(directory).filter(name => /\.(zip|dmg|exe|AppImage)$/i.test(name));
  if (packages.length !== 1 || packages[0] !== filename) throw new Error(`Expected only ${filename} in the release directory.`);
  const releases = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`])).flat();
  const existing = releases.find(release => release.tag_name === tag);
  if (existing && !existing.draft) throw new Error(`Release ${tag} is already public and will not be replaced.`);

  const notes = join(directory, 'release-notes.md'), checksums = join(directory, 'SHA256SUMS.txt');
  writeFileSync(notes, body);
  writeFileSync(checksums, `${createHash('sha256').update(readFileSync(join(directory, filename))).digest('hex')}  ${filename}\n`);
  if (!existing) {
    gh(['release', 'create', tag, '--repo', repository, '--verify-tag', '--draft', '--title', `Revia ${tag}`, '--notes-file', notes, ...(tag.includes('-') ? ['--prerelease'] : [])]);
  } else {
    for (const asset of existing.assets ?? []) if (![filename, 'SHA256SUMS.txt'].includes(asset.name)) {
      gh(['release', 'delete-asset', tag, asset.name, '--repo', repository, '--yes']);
    }
  }
  gh(['release', 'upload', tag, join(directory, filename), checksums, '--repo', repository, '--clobber']);
  gh(['release', 'edit', tag, '--repo', repository, '--title', `Revia ${tag}`, '--notes-file', notes, `--prerelease=${tag.includes('-')}`, '--draft=false']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  publishRelease({ tag: process.env.GITHUB_REF_NAME, version, repository: process.env.GITHUB_REPOSITORY,
    directory: resolve(process.argv[2] ?? 'release'), changelog: readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8') });
}
