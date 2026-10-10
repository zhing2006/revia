import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseNotes } from '../../scripts/release-notes.mjs';
import { publishRelease } from '../../scripts/publish-release.mjs';

const changelog = '# Changelog\n\n## [Unreleased]\n\n- Future work.\n\n## [0.1.0]\n\n- First release.\n\n## [0.0.1]\n\n- Older work.\n';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'revia-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = 'revia-0.1.0-windows-x64.zip';
  writeFileSync(join(directory, filename), 'abc');
  const calls = [];
  const gh = args => {
    calls.push(args);
    if (args[0] === 'api') return JSON.stringify([options.existing ? [options.existing] : []]);
    if (args[1] === 'upload' && options.failUpload) throw new Error('Upload interrupted');
    return '';
  };
  return { directory, filename, calls, publish: () => publishRelease({ tag: 'v0.1.0', version: '0.1.0', changelog, directory, repository: 'example/revia', gh }) };
}

test('extracts the tagged version without unpublished or older notes', () => {
  assert.equal(releaseNotes('v0.1.0', '0.1.0', changelog), '- First release.\n');
  assert.equal(releaseNotes('v0.2.0-beta.1', '0.2.0-beta.1', '## [0.2.0-beta.1] - 2026-10-10\r\n\r\n- Preview.\r\n'), '- Preview.\n');
});

test('stops a release whose tag and changelog do not describe the package version', () => {
  assert.throws(() => releaseNotes('v0.2.0', '0.1.0', changelog), /does not match/);
  assert.throws(() => releaseNotes('v0.2.0', '0.2.0', changelog), /exactly one/);
  assert.throws(() => releaseNotes('v0.1.0', '0.1.0', '## [0.1.0]\n\n### Added\n'), /empty/);
});

test('stages the Windows ZIP and its checksum before making the release public', t => {
  const { directory, filename, calls, publish } = fixture(t);
  publish();
  assert.equal(readFileSync(join(directory, 'release-notes.md'), 'utf8'), '- First release.\n');
  assert.equal(readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8'), `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  ${filename}\n`);
  assert(calls[1].includes('--draft'));
  assert(calls[1].includes('--verify-tag'));
  const upload = calls.find(args => args[1] === 'upload');
  assert.deepEqual(upload.slice(3, 5), [join(directory, filename), join(directory, 'SHA256SUMS.txt')]);
  assert(calls.at(-1).includes('--draft=false'));
});

test('keeps an incomplete upload private and leaves an existing public release untouched', t => {
  const failed = fixture(t, { failUpload: true });
  assert.throws(failed.publish, /Upload interrupted/);
  assert(!failed.calls.some(args => args.includes('--draft=false')));
  const published = fixture(t, { existing: { tag_name: 'v0.1.0', draft: false } });
  assert.throws(published.publish, /already public/);
  assert.equal(published.calls.length, 1);
});

test('removes obsolete assets when resuming a draft so only the intended files are released', t => {
  const { calls, publish } = fixture(t, { existing: { tag_name: 'v0.1.0', draft: true, assets: [{ name: 'old-build.zip' }, { name: 'SHA256SUMS.txt' }] } });
  publish();
  assert(calls.some(args => args[1] === 'delete-asset' && args[3] === 'old-build.zip'));
  assert(!calls.some(args => args[1] === 'create'));
  assert(calls.at(-1).includes('--draft=false'));
});

test('rejects mixed release artifacts before publishing', t => {
  const { directory, calls, publish } = fixture(t);
  writeFileSync(join(directory, 'other-platform.zip'), 'unexpected');
  assert.throws(publish, /Expected only/);
  assert.equal(calls.length, 0);
});
