// Separate processes make the pre-lock interleaving deterministic without adding
// a test-only synchronization hook to the production updater.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

const [root, version, archivePath, gate] = process.argv.slice(2) as [string, string, string, string];
const archive = await fs.readFile(archivePath);
const digest = createHash('sha256').update(archive).digest('hex');
const filename = `claude-tether-${version}.tgz`;
const prefix = `https://github.com/JackXing875/claude-tether/releases/download/v${version}/`;
const listing = [{ tag_name: `v${version}`, draft: false, prerelease: version.includes('-'),
  published_at: '2026-10-25T00:00:00Z', assets: [filename, 'SHA256SUMS'].map(name => ({
    name, state: 'uploaded', browser_download_url: prefix + name,
    ...(name === filename ? { digest: `sha256:${digest}` } : {}),
  })) }];

if (gate === 'pause') {
  const original = fs.open;
  const lock = join(dirname(dirname(root)), '.tether-update.lock');
  fs.open = async (path, flags, ...args) => {
    if (String(path) === lock && flags === 'wx') {
      const resume = once(process, 'message');
      process.send!({ stage: 'before-lock' });
      await resume;
    }
    return original(path, flags, ...args);
  };
  syncBuiltinESMExports();
}

const { update } = await import('../../src/update.js');
const logs: string[] = [], downloads: string[] = [];
try {
  await update({ root, log: message => logs.push(message), getBytes: async url => {
    downloads.push(url);
    if (url.includes('/releases?')) return Buffer.from(JSON.stringify(listing));
    if (url.endsWith('/SHA256SUMS')) return Buffer.from(`${digest}  ./${filename}\n`);
    if (url.endsWith('/' + filename)) return archive;
    throw new Error('Unexpected fixture download');
  } });
  console.log(JSON.stringify({ logs, downloads }));
} catch (error) { console.error(error); process.exitCode = 1; }
finally { if (process.connected) process.disconnect(); }
