import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Settings { ssh?: string; sshConfig?: string; claude?: string }

export function settingsPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'claude-tether', 'config.json');
}

export async function readSettings(path = settingsPath()): Promise<Settings> {
  let contents: string;
  try { contents = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  try {
    const settings: unknown = JSON.parse(contents);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error();
    for (const [key, value] of Object.entries(settings)) {
      if (!['ssh', 'sshConfig', 'claude'].includes(key) || typeof value !== 'string' || !value.trim()) throw new Error();
    }
    return settings as Settings;
  } catch { throw new Error(`Invalid settings in ${path}. Expected ssh, sshConfig and/or claude strings.`); }
}

export async function saveSettings(settings: Settings, path = settingsPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
