import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { readSettings, saveSettings } from '../src/settings.js';

test('settings are optional, replaced atomically and contain only supported preferences', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tether-settings-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'nested', 'config.json');
  assert.deepEqual(await readSettings(path), {});
  await saveSettings({ ssh: 'first-vps' }, path);
  await saveSettings({ ssh: 'second-vps', claude: 'claude' }, path);
  assert.deepEqual(await readSettings(path), { ssh: 'second-vps', claude: 'claude' });
  assert.deepEqual(await readdir(dirname(path)), ['config.json']);
  for (const invalid of ['{', 'null', '[]', '{"ssh":1}', '{"ssh":""}', '{"token":"not-supported"}']) {
    await writeFile(path, invalid);
    await assert.rejects(readSettings(path), /Invalid settings/);
    assert.equal(await readFile(path, 'utf8'), invalid);
  }
});
