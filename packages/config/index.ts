import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { BridgeError, id } from '../protocol/index.js';

export const credentialSchema = z
  .object({ device_id: id, token: z.string().min(32).max(512) })
  .strict();
export type DeviceCredential = z.infer<typeof credentialSchema>;

/** Deliberately separate from project configuration and the official Claude login. */
export function stateHome(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME;
  if (base && !isAbsolute(base))
    throw new BridgeError('INVALID_CONFIG', 'XDG_STATE_HOME must be an absolute path.');
  return join(base || join(homedir(), '.local', 'state'), 'claude-tether');
}

export function ensurePrivateDirectory(path: string): string {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new BridgeError(
      'STATE_PERMISSIONS',
      'State directory must be a private regular directory (chmod 700).',
    );
  }
  return realpathSync(absolute);
}

export function readCredential(path: string): DeviceCredential {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4096) {
      throw new BridgeError(
        'CREDENTIAL_PERMISSIONS',
        'Use a private regular credential file (chmod 600, at most 4 KiB).',
      );
    }
    return credentialSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
  } finally {
    closeSync(fd);
  }
}

export function clientState(
  root: string,
  device: string,
  url: string,
  policy: string,
  home = stateHome(),
): string {
  const key = createHash('sha256')
    .update(JSON.stringify([root, device, url, policy]))
    .digest('hex')
    .slice(0, 32);
  return join(home, 'workspaces', key);
}

export function assertOutsideWorkspace(root: string, state: string): void {
  const child = relative(realpathSync(root), realpathSync(state));
  if (child === '' || (child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child))) {
    throw new BridgeError('STATE_IN_WORKSPACE', 'Store client state outside the workspace.');
  }
}
